const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function storage(){const rows=new Map();return {getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,String(v)),removeItem:k=>rows.delete(k)};}
function loadSource(file,mocks,globals={}){
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../apps/web/src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(name in mocks)return mocks[name];throw Error('Unexpected import '+name);},AbortSignal,crypto:globalThis.crypto,console,...globals},{filename:file});
 return module.exports;
}
const profile={owner:'synthetic-a:HK',name:'Synthetic A',market:'HK',mode:'game'};
const snapshot={protocolVersion:2,worldVersion:1,events:[],accounts:{},orders:[],trades:[]};
function transportFixture(){
 const streams=[],timers=new Map(),calls=[];let nextTimer=0;
 const logout=deferred();
 class EventSource{constructor(){this.handlers={};this.closed=false;streams.push(this);}addEventListener(k,fn){this.handlers[k]=fn;}close(){this.closed=true;}}
 const response=data=>({ok:true,status:200,json:async()=>data});
 const transport=loadSource('transport.ts',{'react':{useSyncExternalStore:(_subscribe,read)=>read()},'socket.io-client':{io:()=>{throw Error('SSE fixture expected');}},'./base':{base:'/'}},{EventSource,localStorage:storage(),sessionStorage:storage(),navigator:{onLine:true},indexedDB:{open(){throw Error('Cache disabled in fixture');}},setInterval:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),fetch:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/config'))return response({sandbox:false,unified:true,transport:'sse'});
  if(url.endsWith('/auth/session'))return response(profile);
  if(url.endsWith('/auth/logout'))return logout.promise;
  if(url.endsWith('/auth/login'))return response({...profile,owner:'synthetic-b:HK',name:'Synthetic B'});
  if(url.endsWith('/state'))return response(snapshot);
  throw Error('Unexpected URL '+url);
 }});
 return {transport,streams,timers,calls,logout,response};
}

test('logout stops streams and polling before waiting, and ignores late snapshots',async()=>{
 const f=transportFixture();await f.transport.boot();await flush();
 const operation=f.transport.logout();
 assert.equal(f.streams[0].closed,true);
 assert.equal(f.timers.size,0);
 assert.equal(f.transport.useSession().connection,'offline');
 f.streams[0].handlers.snapshot({data:JSON.stringify({...snapshot,worldVersion:999})});
 assert.notEqual(f.transport.useSession().snapshot.worldVersion,999);
 await assert.rejects(()=>f.transport.command({kind:'order'}));
 f.logout.resolve(f.response({success:true}));await operation;
 assert.equal(f.transport.useSession().phase,'login');
});

test('a late logout response cannot erase a later authenticated session',async()=>{
 const f=transportFixture();await f.transport.boot();await flush();
 const operation=f.transport.logout();
 await f.transport.gameCredentials('synthetic','synthetic','HK');
 f.logout.resolve(f.response({success:true}));await operation;await flush();
 assert.equal(f.transport.useSession().principal.owner,'synthetic-b:HK');
 assert.equal(f.streams[1].closed,false);
});

test('failed logout leaves trading disabled instead of continuing the old stream',async()=>{
 const f=transportFixture();await f.transport.boot();await flush();
 const operation=f.transport.logout();f.logout.reject(Error('synthetic network failure'));
 await assert.rejects(()=>operation);
 assert.equal(f.streams[0].closed,true);assert.equal(f.timers.size,0);
 await assert.rejects(()=>f.transport.command({kind:'order'}));
});

test('order controls and command gate share the same fifteen-second freshness boundary',()=>{
 const {isSessionFresh}=transportFixture().transport;
 const session={connection:'live',lastReceived:100000};
 assert.equal(isSessionFresh(session,115000),true);
 assert.equal(isSessionFresh(session,115001),false);
 assert.equal(isSessionFresh({...session,connection:'stale'},100000),false);
 assert.equal(isSessionFresh({...session,lastReceived:0},1),false);
});

function chartFixture(){
 const effects=[],timers=[],writes=[],requests=[],cached=[];let stateIndex=0,nullRefs=0;
 const bars=[{time:Date.UTC(2026,9,29,2),open:1000,high:1002,low:999,close:1001,volume:100}];
 const refs=[];let previous={dataZoom:[{start:20,end:80}],legend:[{selected:{MA5:false}}]};
 const chart={getOption:()=>previous,setOption:option=>{writes.push(option);previous=option;},resize(){},dispose(){}};
 const react={useEffect:fn=>effects.push(fn),useRef:value=>{const ref={current:value===null&&nullRefs++===0?{}:value};refs.push(ref);return ref;},useState:value=>{const index=stateIndex++;return [index===3?bars:value,()=>{}];}};
 const transport={useSession:()=>({principal:profile}),cachedCandles:async()=>[],cacheCandles:async(...args)=>cached.push(args),request:()=>{const d=deferred();requests.push(d);return d.promise;}};
 const {Chart}=loadSource('Chart.tsx',{'react':react,'react/jsx-runtime':{jsx:()=>null,jsxs:()=>null},'./localization':{translate:t=>t},'./transport':transport,'./workspace':{useWorkspace:()=>({theme:'dark',upIsRed:true,reducedMotion:false,language:'en',market:'HK'})},'./ui':{useTranslate:()=>t=>t,Empty:()=>null},'echarts/core':{use(){},init:()=>chart},'echarts/charts':{},'echarts/components':{},'echarts/renderers':{}},{ResizeObserver:class{observe(){}disconnect(){}},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){}});
 Chart({symbol:'H1'});
 return {effects,timers,writes,requests,cached,bars,setPrevious:value=>{previous=value;}};
}

test('chart polling has at most one pending request and releases the guard after failure',async()=>{
 const f=chartFixture();const cleanup=f.effects[0]();
 f.timers[0]();f.timers[0]();assert.equal(f.requests.length,1);
 f.requests[0].reject(Error('synthetic timeout'));await flush();f.timers[0]();
 assert.equal(f.requests.length,2);cleanup();f.requests[1].resolve(f.bars);await flush();
 assert.equal(f.cached.length,0);
});

test('chart refresh retains the legend selection and zoom for the same stock and period',()=>{
 const f=chartFixture();f.effects[1]();f.effects[2]();
 f.setPrevious({dataZoom:[{start:20,end:80}],legend:[{selected:{MA5:false}}]});
 f.effects[2]();const option=f.writes.at(-1);
 assert.equal(option.legend.selected?.MA5,false);
 assert.equal(option.dataZoom[0].start,20);assert.equal(option.dataZoom[0].end,80);
});
