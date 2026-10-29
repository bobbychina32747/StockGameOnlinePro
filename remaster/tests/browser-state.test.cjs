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
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(name in mocks)return mocks[name];throw Error('Unexpected import '+name);},AbortSignal,AbortController,crypto:globalThis.crypto,console,...globals},{filename:file});
 return module.exports;
}
const profile={owner:'synthetic-a:HK',name:'Synthetic A',market:'HK',mode:'game'};
const snapshot={protocolVersion:2,worldVersion:1,events:[],accounts:{},orders:[],trades:[]};
function transportFixture(settings={}){
 const streams=[],timers=new Map(),calls=[];let nextTimer=0;
 const logout=deferred();
 class EventSource{constructor(){this.handlers={};this.closed=false;streams.push(this);}addEventListener(k,fn){this.handlers[k]=fn;}close(){this.closed=true;}}
 const response=data=>({ok:true,status:200,json:async()=>data});
 const transport=loadSource('transport.ts',{'react':{useSyncExternalStore:(_subscribe,read)=>read()},'socket.io-client':{io:()=>{throw Error('SSE fixture expected');}},'./base':{base:'/'}},{EventSource,localStorage:storage(),sessionStorage:storage(),navigator:{onLine:true},indexedDB:{open(){throw Error('Cache disabled in fixture');}},setInterval:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),fetch:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/config'))return settings.config?settings.config.promise:response({sandbox:false,unified:true,transport:'sse'});
  if(url.endsWith('/auth/session'))return settings.session?settings.session.promise:response(profile);
  if(url.endsWith('/auth/logout'))return logout.promise;
  if(url.endsWith('/auth/login'))return response({...profile,owner:'synthetic-b:HK',name:'Synthetic B'});
  if(url.endsWith('/state'))return settings.state?settings.state(options):response(snapshot);
  throw Error('Unexpected URL '+url);
 },...(settings.globals??{})});
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

function chartFixture(page='trade'){
 const effects=[],timers=[],writes=[],requests=[],cached=[];let stateIndex=0,nullRefs=0;
 const bars=[{time:Date.UTC(2026,9,29,2),open:1000,high:1002,low:999,close:1001,volume:100}];
 const refs=[];let previous={dataZoom:[{start:20,end:80}],legend:[{selected:{MA5:false}}]};
 const chart={getOption:()=>previous,setOption:option=>{writes.push(option);previous=option;},resize(){},dispose(){}};
 const react={useEffect:fn=>effects.push(fn),useRef:value=>{const ref={current:value===null&&nullRefs++===0?{}:value};refs.push(ref);return ref;},useState:value=>{const index=stateIndex++;return [index===3?{key:'HK:H1:day:false',bars}:value,()=>{}];}};
 const transport={useSession:()=>({principal:profile}),peekCachedCandles:()=>[],cachedCandles:async()=>[],cacheCandles:async(...args)=>cached.push(args),request:(_path,_body,_headers,signal)=>{const d=deferred();requests.push({...d,signal});return d.promise;}};
 const {Chart}=loadSource('Chart.tsx',{'react':react,'react/jsx-runtime':{jsx:()=>null,jsxs:()=>null},'./localization':{translate:t=>t},'./transport':transport,'./workspace':{useWorkspace:()=>({theme:'dark',upIsRed:true,reducedMotion:false,language:'en',market:'HK',page})},'./ui':{useTranslate:()=>t=>t,Empty:()=>null},'echarts/core':{use(){},init:()=>chart},'echarts/charts':{},'echarts/components':{},'echarts/renderers':{}},{ResizeObserver:class{observe(){}disconnect(){}},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){}});
 Chart({symbol:'H1'});
 return {effects,timers,writes,requests,cached,bars,setPrevious:value=>{previous=value;}};
}

test('chart polling has at most one pending request and releases the guard after failure',async()=>{
 const f=chartFixture();const cleanup=f.effects[0]();
 f.timers[0]();f.timers[0]();assert.equal(f.requests.length,1);
 f.requests[0].reject(Error('synthetic timeout'));await flush();f.timers[0]();
 assert.equal(f.requests.length,2);cleanup();assert.equal(f.requests[1].signal.aborted,true);f.requests[1].resolve(f.bars);await flush();
 assert.equal(f.cached.length,0);
});

test('startup requests session and configuration concurrently',async()=>{
 const config=deferred(),session=deferred();const f=transportFixture({config,session});
 const boot=f.transport.boot();assert.deepEqual(f.calls.map(x=>x.url),['/api/v2/config','/api/v2/auth/session']);
 config.resolve(f.response({sandbox:false,unified:true,transport:'sse'}));session.resolve(f.response(profile));
 await boot;await flush();assert.equal(f.transport.useSession().connection,'live');
});

test('candle memory cache is immediate, bounded, and survives unavailable IndexedDB',async()=>{
 const f=transportFixture();const bars=Array.from({length:700},(_,i)=>({time:i,close:10}));
 const saving=f.transport.cacheCandles('HK:H1:day:false',bars);
 assert.equal(f.transport.peekCachedCandles('HK:H1:day:false').length,600);
 await saving;assert.equal((await f.transport.cachedCandles('HK:H1:day:false'))[0].time,100);
 for(let i=0;i<48;i++)await f.transport.cacheCandles('CN:T'+i+':day:false',[{time:i}]);
 assert.equal(f.transport.peekCachedCandles('HK:H1:day:false').length,0);
 assert.equal(f.transport.peekCachedCandles('CN:T47:day:false').length,1);
});

test('cached market preview contains no private account state and cannot enable trading or reject the fresh snapshot',async()=>{
 const options={};const f=transportFixture(options);await f.transport.boot();await flush();
 f.streams[0].handlers.snapshot({data:JSON.stringify({...snapshot,worldVersion:999,instruments:[{symbol:'H1',market:'HK'}],quotes:{H1:{price:100}},accounts:{CN:null,HK:{equity:123456},US:null},orders:[{id:'private'}],trades:[{id:'private'}],formal:{reviews:[{private:true}]}})});
 await f.transport.logout(false);const fresh=deferred();options.state=()=>fresh.promise;
 await f.transport.gameCredentials('synthetic','synthetic','HK');await flush();
 const preview=f.transport.useSession();assert.equal(preview.snapshot.quotes.H1.price,100);
 assert.equal(preview.snapshot.accounts.HK,null);assert.equal(preview.snapshot.formal,undefined);assert.equal(preview.snapshot.orders.length,0);assert.equal(preview.snapshot.trades.length,0);
 assert.equal(preview.lastReceived,0);assert.equal(f.transport.isSessionFresh(preview),false);
 await assert.rejects(()=>f.transport.command({kind:'order'}));
 fresh.resolve(f.response({...snapshot,worldVersion:1}));await flush();
 assert.equal(f.transport.useSession().snapshot.worldVersion,1);assert.equal(f.transport.useSession().connection,'live');
});

test('chart refresh retains the legend selection and zoom for the same stock and period',()=>{
 const f=chartFixture();f.effects[1]();f.effects[2]();
 f.setPrevious({dataZoom:[{start:20,end:80}],legend:[{selected:{MA5:false}}]});
 f.effects[2]();const option=f.writes.at(-1);
 assert.equal(option.legend.selected?.MA5,false);
 assert.equal(option.dataZoom[0].start,20);assert.equal(option.dataZoom[0].end,80);
});

test('history polling stops when the trading page is hidden',()=>{
 const f=chartFixture('research');assert.equal(f.effects[0](),undefined);assert.equal(f.requests.length,0);assert.equal(f.timers.length,0);
});

test('history request cancellation reaches fetch without removing its timeout',async()=>{
 const settings={state:options=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))))};
 const f=transportFixture(settings),controller=new AbortController();
 const pending=f.transport.request('/state',undefined,{},controller.signal);controller.abort();await assert.rejects(()=>pending,/aborted/);
 assert.equal(f.calls[0].options.signal.aborted,true);
});

test('a blocked public cache fails without hanging the chart or reading a pending IDB error',async()=>{
 let request,closed=false;const f=transportFixture({globals:{setTimeout,clearTimeout,indexedDB:{open(){request={get error(){throw Error('pending error must not be read');},result:{close(){closed=true;}}};queueMicrotask(()=>request.onblocked());return request;}}}});
 assert.equal((await f.transport.cachedCandles('HK:H1:day:false')).length,0);
 request.onsuccess();assert.equal(closed,true);
});
