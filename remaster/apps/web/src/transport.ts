import { MarketId } from '../../../packages/domain/types';
import { io, Socket } from 'socket.io-client';
import { base } from './base';
import { useSyncExternalStore } from 'react';
import { Snapshot } from '../../../packages/protocol/snapshot';
export interface Principal {owner:string;name:string;market:MarketId;mode:'sandbox'|'site'|'game';token?:string;rememberMe?:boolean}
export interface Session {phase:'loading'|'login'|'ready'|'offline';principal:Principal|null;snapshot:Snapshot|null;connection:'connecting'|'live'|'stale'|'offline';error:string|null;lastReceived:number;config:{sandbox:boolean;unified?:boolean;transport?:'sse'|'socket.io'}|null}
export function isSessionFresh(session:Pick<Session,'connection'|'lastReceived'>,now=Date.now()):boolean{return session.connection==='live'&&session.lastReceived>0&&now-session.lastReceived<=15000;}
class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
class RuleRejected extends Error {}
let bearer='';
export async function request<T=any>(path:string,body?:unknown,extraHeaders:Record<string,string>={},signal?:AbortSignal):Promise<T> {
  const timeout=AbortSignal.timeout(10000);
  const response=await fetch(base+'api/v2'+path,{method:body===undefined?'GET':'POST',credentials:'include',headers:{'X-Game-Realm':state.principal?.market??sessionStorage.getItem('rgp.realm')??localStorage.getItem('rgp.remembered-realm')??'CN',...(body===undefined?{}:{'Content-Type':'application/json'}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...extraHeaders},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  const result=await response.json().catch(()=>({}));if(!response.ok) throw new ApiError(result.error??(typeof result.message==='string'?result.message:'请求失败'),response.status);return result;
}
let state:Session={phase:'loading',principal:null,snapshot:null,connection:'connecting',error:null,lastReceived:0,config:null};
const listeners=new Set<()=>void>();let socket:Socket|null=null;let stream:EventSource|null=null;let booting:Promise<void>|null=null;let poll:ReturnType<typeof setInterval>|null=null;let renew:ReturnType<typeof setInterval>|null=null;let generation=0;let pending=new Map<string,{key:string;body:unknown}>();let detachWake=()=>{};
function update(patch:Partial<Session>){state={...state,...patch};for(const listener of listeners) listener();}
export function useSession(){return useSyncExternalStore(listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},()=>state);}
function accept(snapshot:Snapshot){if(snapshot.protocolVersion!==2)return;if(state.snapshot&&state.lastReceived>0&&snapshot.worldVersion<state.snapshot.worldVersion)return;update({snapshot,connection:'live',lastReceived:Date.now(),error:null});void publicCache(snapshot);}
function connect(principal:Principal){
  const current=++generation;detachWake();socket?.disconnect();socket=null;stream?.close();stream=null;if(poll)clearInterval(poll);if(renew)clearInterval(renew);bearer=principal.token??'';sessionStorage.setItem('rgp.realm',principal.market);if(principal.rememberMe)localStorage.setItem('rgp.remembered-realm',principal.market);else localStorage.removeItem('rgp.remembered-realm');update({principal,phase:'ready',snapshot:null,connection:'connecting',error:null,lastReceived:0});
  void readPublicCache(principal.market).then(cached=>{if(cached&&current===generation&&state.lastReceived===0)update({snapshot:cached});});
  try{pending=new Map(JSON.parse(sessionStorage.getItem('rgp.pending:'+principal.owner)??'[]'));}catch{pending=new Map();}
  if(state.config?.transport==='sse'){
    stream=new EventSource(base+'api/v2/events?market='+principal.market,{withCredentials:true});
    stream.addEventListener('snapshot',event=>{if(current!==generation)return;try{accept(JSON.parse((event as MessageEvent).data));}catch{update({connection:'stale'});}});
    stream.addEventListener('session-expired',()=>{if(current===generation)void logout(false);});
    stream.addEventListener('backend-unavailable',()=>{if(current===generation)update({connection:'stale'});});
    stream.onerror=()=>{if(current===generation)update({connection:navigator.onLine?'stale':'offline'});};
  }else{
    socket=io('/v2',{path:base+'socket.io',auth:bearer?{token:bearer,market:principal.market}:{market:principal.market},withCredentials:true,transports:['websocket'],reconnection:true,reconnectionDelay:1000,reconnectionDelayMax:6000});
    socket.on('snapshot',value=>{if(current===generation)accept(value);});socket.on('disconnect',()=>{if(current===generation)update({connection:'stale'});});socket.on('connect_error',()=>{if(current===generation)update({connection:'stale'});});socket.on('session-expired',()=>{if(current===generation)void logout(false);});
  }
  let refreshing=false;
  const refresh=async(force=false)=>{if(refreshing||current!==generation||(!force&&state.connection==='live'&&Date.now()-state.lastReceived<6000))return;refreshing=true;
    try{const value=await request<Snapshot>('/state');if(current===generation)accept(value);}catch(error){if(current!==generation)return;if(error instanceof ApiError&&error.status===401)void logout(false);else update({connection:navigator.onLine?'stale':'offline'});}finally{refreshing=false;}};
  void refresh(true);poll=setInterval(()=>void refresh(),1500);
  const wake=()=>{if(typeof document==='undefined'||!document.hidden)void refresh(true);};
  if(typeof window!=='undefined'){window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);detachWake=()=>{window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};}

}
export function boot():Promise<void>{if(booting)return booting;booting=(async()=>{try {const [configured,authenticated]=await Promise.allSettled([request('/config'),request<Principal>('/auth/session')]);if(configured.status==='rejected')throw configured.reason;update({config:configured.value});if(authenticated.status==='rejected')throw authenticated.reason;connect(authenticated.value);}catch(error){if(error instanceof ApiError&&error.status===401)update({phase:'login',connection:'offline'});else{const cached=await readPublicCache();update({phase:cached?'offline':'login',snapshot:cached,connection:'offline',error:'连接暂不可用，恢复后重试'});}}})();return booting;}
export async function loginDemo(name:string,market:MarketId){const principal=await request<Principal>('/auth/demo',{name,market});connect(principal);}
export async function gameCredentials(username:string,password:string,market:MarketId,register=false,rememberMe=false){bearer='';const principal=await request<Principal>('/auth/'+(register?'register':'login'),{username,password,market,rememberMe});connect(principal);}
export async function siteSession(create=false,createRemaster=false,market:MarketId='CN',rememberMe=false){bearer='';const result=await request('/auth/site-session',{create,createRemaster,market,rememberMe});if(result.needsAccountSetup||result.needsRemasterAccount)return result;connect(result);return result;}
export async function siteLink(username:string,password:string){return request('/auth/site-link',{username,password});}
export async function logout(remote=true){
  const owner=state.principal?.owner;const current=++generation;
  detachWake();detachWake=()=>{};socket?.disconnect();socket=null;stream?.close();stream=null;if(poll)clearInterval(poll);if(renew)clearInterval(renew);poll=null;renew=null;
  update({connection:'offline'});
  try{if(remote)await request('/auth/logout',{});}catch(error){if(current===generation)update({error:'退出未完成，请恢复连接后重试'});throw error;}
  if(current!==generation)return;
  localStorage.removeItem('rgp.remembered-realm');bearer='';pending.clear();if(owner)sessionStorage.removeItem('rgp.pending:'+owner);
  update({phase:'login',principal:null,snapshot:null,connection:'offline',error:null});
}
export async function command(body:unknown):Promise<any>{
  if(!isSessionFresh(state)||!state.principal)throw new Error('行情尚未同步，请连接后再操作');const current=generation;const identity=JSON.stringify(body);if(pending.size&&!pending.has(identity))throw new Error('存在结果未知的请求，请先重试原操作');const pendingCommand=pending.get(identity)??{key:crypto.randomUUID(),body};pending.set(identity,pendingCommand);savePending();
  try{
    const result=await request('/commands',body,{'Idempotency-Key':pendingCommand.key});return await finish(result);
  }catch(error){if(current!==generation)throw new RuleRejected('账号已切换，原操作结果可在原账户记录中查看');if(error instanceof RuleRejected)throw error;if(error instanceof ApiError&&error.status<500){pending.delete(identity);savePending();throw error;}
    try {const queried=await request('/commands/'+pendingCommand.key);if(queried.found)return await finish(queried.result);}catch(lookupError){if(lookupError instanceof RuleRejected)throw lookupError;}
    throw new Error(error instanceof Error?error.message+'；可用同一按钮安全重试':'结果未知，请安全重试');
  }
  async function finish(result:any){if(current!==generation)throw new RuleRejected('账号已切换，原操作结果可在原账户记录中查看');pending.delete(identity);savePending();if(!result.success)throw new RuleRejected(result.error??'操作被拒绝');try{const fresh=await request<Snapshot>('/state');if(current===generation)accept(fresh);}catch{if(current===generation)update({connection:'stale'});}return result;}
}
function savePending(){if(state.principal)sessionStorage.setItem('rgp.pending:'+state.principal.owner,JSON.stringify([...pending.entries()].slice(-20)));}
// Cache persistence is best effort. Only live snapshots enable trading.
async function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const operation = indexedDB.open('stockgame-public-cache', 2);
        let settled = false;
        const fail = (reason: unknown) => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(reason);
        } };
        const timer = setTimeout(() => fail(new Error('Cache open timed out')), 1000);
        operation.onupgradeneeded = () => { for (const store of ['snapshots', 'candles'])
            if (!operation.result.objectStoreNames.contains(store))
                operation.result.createObjectStore(store); };
        operation.onsuccess = () => { if (settled) {
            operation.result.close();
            return;
        } settled = true; clearTimeout(timer); resolve(operation.result); };
        operation.onerror = () => fail(operation.error ?? new Error('Cache unavailable'));
        operation.onblocked = () => fail(new Error('Cache blocked'));
    });
}
const candleMemory = new Map<string, unknown[]>();
function rememberCandles(key: string, bars: unknown[]): unknown[] { const values = bars.slice(-600); candleMemory.delete(key); candleMemory.set(key, values); if (candleMemory.size > 48)
    candleMemory.delete(candleMemory.keys().next().value!); return values; }
export function peekCachedCandles<T>(key: string): T[] { const bars = candleMemory.get(key); if (!bars)
    return []; candleMemory.delete(key); candleMemory.set(key, bars); return bars as T[]; }
export async function cacheCandles(key: string, bars: unknown[]): Promise<void> { const values = rememberCandles(key, bars); try {
    const db = await database();
    const transaction = db.transaction('candles', 'readwrite');
    const store = transaction.objectStore('candles');
    store.put(values, key);
    const keys = store.getAllKeys();
    keys.onsuccess = () => { if (keys.result.length > 120)
        for (const old of keys.result.slice(0, keys.result.length - 120))
            store.delete(old); };
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => db.close();
}
catch { } }
export async function cachedCandles<T>(key: string): Promise<T[]> { const memory = peekCachedCandles<T>(key); if (memory.length)
    return memory; try {
    const db = await database();
    return await new Promise(resolve => { const transaction = db.transaction('candles'); const store = transaction.objectStore('candles'); const operation = store.get(key); transaction.oncomplete = () => db.close(); transaction.onabort = () => { db.close(); resolve([]); }; const accept = (result: unknown) => { const values = peekCachedCandles<T>(key); resolve(values.length ? values : Array.isArray(result) ? rememberCandles(key, result) as T[] : []); }; operation.onsuccess = () => { const legacyKey = key.replace(/^(CN|HK|US):/, ''); if (operation.result == null && legacyKey !== key) {
        const legacy = store.get(legacyKey);
        legacy.onsuccess = () => accept(legacy.result);
        legacy.onerror = () => resolve([]);
    }
    else
        accept(operation.result); }; operation.onerror = () => resolve([]); });
}
catch {
    return [];
} }
const marketMemory = new Map<MarketId, Snapshot>();
const marketPersisted = new Map<MarketId, number>();
function publicOnly(snapshot: Snapshot, market?: MarketId): Snapshot | null {
    if (snapshot?.protocolVersion !== 2 || !Array.isArray(snapshot.instruments))
        return null;
    const instruments = market ? snapshot.instruments.filter(item => item.market === market) : snapshot.instruments;
    if (!instruments.length)
        return null;
    const quotes = Object.fromEntries(instruments.filter(item => snapshot.quotes?.[item.symbol]).map(item => [item.symbol, snapshot.quotes[item.symbol]]));
    if (Object.keys(quotes).length !== instruments.length)
        return null;
    return { ...snapshot, instruments, quotes, formal: undefined, accounts: { CN: null, HK: null, US: null }, orders: [], trades: [], rankings: [], seasons: [], events: (snapshot.events ?? []).filter(event => event.kind !== 'risk') };
}
async function publicCache(snapshot: Snapshot) { const market = state.principal?.market; if (!market)
    return; const preview = publicOnly(snapshot, market); if (!preview)
    return; marketMemory.set(market, preview); const stamp = Date.now(); if (stamp - (marketPersisted.get(market) ?? 0) < 15000)
    return; marketPersisted.set(market, stamp); try {
    const db = await database();
    const transaction = db.transaction('snapshots', 'readwrite');
    transaction.objectStore('snapshots').put(preview, 'realm:' + market);
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => { db.close(); marketPersisted.delete(market); };
}
catch {
    marketPersisted.delete(market);
} }
async function readPublicCache(market?: MarketId): Promise<Snapshot | null> { market ??= (sessionStorage.getItem('rgp.realm') ?? localStorage.getItem('rgp.remembered-realm') ?? 'CN') as MarketId; const memory = marketMemory.get(market); if (memory)
    return memory; try {
    const db = await database();
    return await new Promise(resolve => { const transaction = db.transaction('snapshots'); const store = transaction.objectStore('snapshots'); const operation = store.get('realm:' + market); transaction.oncomplete = () => db.close(); transaction.onabort = () => { db.close(); resolve(null); }; const accept = (value: Snapshot) => { const preview = publicOnly(value, market); if (preview)
        marketMemory.set(market!, preview); resolve(preview); }; operation.onsuccess = () => { if (operation.result)
        accept(operation.result);
    else {
        const legacy = store.get('latest');
        legacy.onsuccess = () => accept(legacy.result);
        legacy.onerror = () => resolve(null);
    } }; operation.onerror = () => resolve(null); });
}
catch {
    return null;
} }
