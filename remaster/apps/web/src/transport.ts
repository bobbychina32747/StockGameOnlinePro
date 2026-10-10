import { io, Socket } from 'socket.io-client';
import { base } from './base';
import { useSyncExternalStore } from 'react';
import { Snapshot } from '../../../packages/protocol/snapshot';
export interface Principal {owner:string;name:string;mode:'sandbox'|'site';token?:string}
export interface Session {phase:'loading'|'login'|'ready'|'offline';principal:Principal|null;snapshot:Snapshot|null;connection:'connecting'|'live'|'stale'|'offline';error:string|null;lastReceived:number;config:{sandbox:boolean}|null}
class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
class RuleRejected extends Error {}
let bearer='';
export async function request<T=any>(path:string,body?:unknown,extraHeaders:Record<string,string>={}):Promise<T> {
  const response=await fetch(base+'api/v2'+path,{method:body===undefined?'GET':'POST',credentials:'include',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...extraHeaders},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json().catch(()=>({}));if(!response.ok) throw new ApiError(result.error??(typeof result.message==='string'?result.message:'请求失败'),response.status);return result;
}
let state:Session={phase:'loading',principal:null,snapshot:null,connection:'connecting',error:null,lastReceived:0,config:null};
const listeners=new Set<()=>void>();let socket:Socket|null=null;let booting:Promise<void>|null=null;let poll:ReturnType<typeof setInterval>|null=null;let renew:ReturnType<typeof setInterval>|null=null;let generation=0;let pending=new Map<string,{key:string;body:unknown}>();
function update(patch:Partial<Session>){state={...state,...patch};for(const listener of listeners) listener();}
export function useSession(){return useSyncExternalStore(listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},()=>state);}
function accept(snapshot:Snapshot){if(snapshot.protocolVersion!==2)return;if(state.snapshot&&snapshot.worldVersion<state.snapshot.worldVersion)return;update({snapshot,connection:'live',lastReceived:Date.now(),error:null});void publicCache(snapshot);}
function connect(principal:Principal){
  const current=++generation;socket?.disconnect();if(poll)clearInterval(poll);if(renew)clearInterval(renew);bearer=principal.token??'';update({principal,phase:'ready',snapshot:null,connection:'connecting',error:null});
  try{pending=new Map(JSON.parse(sessionStorage.getItem('rgp.pending:'+principal.owner)??'[]'));}catch{pending=new Map();}
  socket=io('/v2',{path:base+'socket.io',auth:bearer?{token:bearer}:{},withCredentials:true,transports:['websocket'],reconnection:true,reconnectionDelay:1000,reconnectionDelayMax:6000});
  socket.on('snapshot',value=>{if(current===generation)accept(value);});socket.on('disconnect',()=>{if(current===generation)update({connection:'stale'});});socket.on('connect_error',()=>{if(current===generation)update({connection:'stale'});});socket.on('session-expired',()=>{if(current===generation)void logout(false);});
  const refresh=()=>void request<Snapshot>('/state').then(value=>{if(current===generation)accept(value);}).catch(error=>{if(current!==generation)return;if(error instanceof ApiError&&error.status===401)void logout(false);else update({connection:navigator.onLine?'stale':'offline'});});refresh();poll=setInterval(refresh,5000);
  if(principal.mode==='site')renew=setInterval(()=>{void request<Principal>('/auth/site-session',{create:false,createRemaster:false}).then(next=>{if(current===generation&&next.owner===principal.owner&&next.token){bearer=next.token;socket!.auth={token:bearer};socket!.disconnect().connect();update({principal:next});}}).catch(()=>{if(current===generation)update({connection:'stale'});});},240000);
}
export function boot():Promise<void>{if(booting)return booting;booting=(async()=>{try {const config=await request('/config');update({config});const principal=await request<Principal>('/auth/session');connect(principal);}catch(error){if(error instanceof ApiError&&error.status===401)update({phase:'login',connection:'offline'});else{const cached=await readPublicCache();update({phase:cached?'offline':'login',snapshot:cached,connection:'offline',error:'连接暂不可用，恢复后重试'});}}})();return booting;}
export async function loginDemo(name:string){const principal=await request<Principal>('/auth/demo',{name});connect(principal);}
export async function siteSession(create=false,createRemaster=false){bearer='';const result=await request('/auth/site-session',{create,createRemaster});if(result.needsAccountSetup||result.needsRemasterAccount)return result;connect(result);return result;}
export async function siteLink(username:string,password:string){return request('/auth/site-link',{username,password});}
export async function logout(remote=true){const owner=state.principal?.owner;if(remote)await request('/auth/logout',{});generation++;socket?.disconnect();socket=null;if(poll)clearInterval(poll);if(renew)clearInterval(renew);poll=null;renew=null;bearer='';pending.clear();if(owner)sessionStorage.removeItem('rgp.pending:'+owner);update({phase:'login',principal:null,snapshot:null,connection:'offline',error:null});}
export async function command(body:unknown):Promise<any>{
  if(state.connection!=='live'||!state.principal||Date.now()-state.lastReceived>15000)throw new Error('行情尚未同步，请连接后再操作');const current=generation;const identity=JSON.stringify(body);if(pending.size&&!pending.has(identity))throw new Error('存在结果未知的请求，请先重试原操作');const pendingCommand=pending.get(identity)??{key:crypto.randomUUID(),body};pending.set(identity,pendingCommand);savePending();
  try{
    const result=await request('/commands',body,{'Idempotency-Key':pendingCommand.key});return await finish(result);
  }catch(error){if(current!==generation)throw new RuleRejected('账号已切换，原操作结果可在原账户记录中查看');if(error instanceof RuleRejected)throw error;if(error instanceof ApiError&&error.status<500){pending.delete(identity);savePending();throw error;}
    try {const queried=await request('/commands/'+pendingCommand.key);if(queried.found)return await finish(queried.result);}catch(lookupError){if(lookupError instanceof RuleRejected)throw lookupError;}
    throw new Error(error instanceof Error?error.message+'；可用同一按钮安全重试':'结果未知，请安全重试');
  }
  async function finish(result:any){if(current!==generation)throw new RuleRejected('账号已切换，原操作结果可在原账户记录中查看');pending.delete(identity);savePending();if(!result.success)throw new RuleRejected(result.error??'操作被拒绝');try{const fresh=await request<Snapshot>('/state');if(current===generation)accept(fresh);}catch{if(current===generation)update({connection:'stale'});}return result;}
}
function savePending(){if(state.principal)sessionStorage.setItem('rgp.pending:'+state.principal.owner,JSON.stringify([...pending.entries()].slice(-20)));}
async function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const operation=indexedDB.open('stockgame-public-cache',2);operation.onupgradeneeded=()=>{for(const store of ['snapshots','candles'])if(!operation.result.objectStoreNames.contains(store))operation.result.createObjectStore(store);};operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});}
export async function cacheCandles(key:string,bars:unknown[]):Promise<void>{try{const db=await database();const transaction=db.transaction('candles','readwrite');const store=transaction.objectStore('candles');store.put(bars.slice(-600),key);const keys=store.getAllKeys();keys.onsuccess=()=>{if(keys.result.length>120)for(const old of keys.result.slice(0,keys.result.length-120))store.delete(old);};transaction.oncomplete=()=>db.close();}catch{}}
export async function cachedCandles<T>(key:string):Promise<T[]>{try{const db=await database();return await new Promise(resolve=>{const operation=db.transaction('candles').objectStore('candles').get(key);operation.onsuccess=()=>{db.close();resolve(operation.result??[]);};operation.onerror=()=>{db.close();resolve([]);};});}catch{return [];}}
async function publicCache(snapshot:Snapshot){try{const db=await database();const publicOnly={...snapshot,accounts:{CN:null,HK:null,US:null},orders:[],trades:[],rankings:[],seasons:[],events:snapshot.events.filter(event=>event.kind!=='risk')};const operation=db.transaction('snapshots','readwrite');operation.objectStore('snapshots').put(publicOnly,'latest');operation.oncomplete=()=>db.close();}catch{}}
async function readPublicCache():Promise<Snapshot|null>{try{const db=await database();return await new Promise(resolve=>{const operation=db.transaction('snapshots').objectStore('snapshots').get('latest');operation.onsuccess=()=>{db.close();resolve(operation.result??null);};operation.onerror=()=>{db.close();resolve(null);};});}catch{return null;}}
