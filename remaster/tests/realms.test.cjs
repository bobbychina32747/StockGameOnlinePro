const {test}=require('node:test'),assert=require('node:assert/strict');const {generateKeyPairSync,sign}=require('node:crypto');
const {createApplication}=require('../dist/apps/game-api/main');const {WorldRepository}=require('../dist/apps/game-api/repository');const {GameService}=require('../dist/apps/game-api/service');
const {accountId}=require('../dist/packages/engine/world');
test('region-locked sandbox rejects cross-region trades, history and transfers',async()=>{
 const server=await createApplication({port:0,database:':memory:',sandbox:true,tickMs:60000});
 try {
  const session=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'港区测试员',market:'HK'})}).then(r=>r.json());assert.equal(session.market,'HK');const headers={Authorization:'Bearer '+session.token,'Content-Type':'application/json','Idempotency-Key':'realm-order-0001'};
  const state=await fetch(server.url+'/api/v2/state',{headers}).then(r=>r.json());assert.equal(state.instruments.length,138);assert(state.instruments.every(i=>i.market==='HK'));assert.equal(state.accounts.CN,null);assert.equal(state.accounts.US,null);assert.equal(Object.keys(state.quotes).length,138);
  for(const command of [{kind:'order',market:'US',input:{symbol:'U1',side:'buy',type:'market',quantity:1}},{kind:'transfer',from:'HK',to:'US',amount:10000}])assert.equal((await fetch(server.url+'/api/v2/commands',{method:'POST',headers,body:JSON.stringify(command)})).status,400);
  assert.equal((await fetch(server.url+'/api/v2/history/U1',{headers})).status,400);
  assert.equal((await fetch(server.url+'/api/v2/book/U1',{headers})).status,400);
  assert.equal((await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers,body:JSON.stringify({name:'改区',market:'US'})})).status,400);
 }finally{await server.close();}
});
test('one verified site identity binds one stable role per realm with unforgeable game sessions',async()=>{
 const server=await createApplication({port:0,database:':memory:',sandbox:true,authSandbox:false,tickMs:60000});
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');const header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'fixture'})).toString('base64url');const now=Math.floor(Date.now()/1000);const payload=Buffer.from(JSON.stringify({iss:'https://bobbycn.cc',aud:'bobbycn.cc',sub:'fixture-user',sid:'fixture-session',iat:now,exp:now+300})).toString('base64url');const unsigned=header+'.'+payload;const siteToken=unsigned+'.'+sign(null,Buffer.from(unsigned),privateKey).toString('base64url');
 server.auth.request=async path=>{if(path.includes('jwks'))return {keys:[{...publicKey.export({format:'jwk'}),kid:'fixture',alg:'EdDSA'}]};if(path.includes('introspect'))return {active:true,sub:'fixture-user',sid:'fixture-session'};if(path.endsWith('/token'))return {token:siteToken};if(path.endsWith('/me'))return {username:'fixture-user'};throw Error('Unexpected fixture path');};
 try {
  const roles=[];const cookies=new Map();
  for(const market of ['CN','HK','US','CN']){const r=await fetch(server.url+'/api/v2/auth/site-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market,createRemaster:true})});assert.equal(r.status,201);cookies.set(market,r.headers.get('set-cookie').split(';')[0]);roles.push(await r.json());}
  assert.equal(new Set(roles.map(r=>r.owner)).size,3);assert.equal(roles[0].owner,roles[3].owner);assert.notEqual(roles[0].token,siteToken);assert.equal(Object.values(server.game.world.accounts).filter(a=>a.actor==='player').length,3);
  for(const role of roles){const r=await fetch(server.url+'/api/v2/state',{headers:{Authorization:'Bearer '+role.token}});const state=await r.json();assert.equal(state.instruments.length,138);assert(state.instruments.every(i=>i.market===role.market));assert.equal(Object.values(state.accounts).filter(Boolean).length,1);}
  for(const market of ['CN','HK','US']){const r=await fetch(server.url+'/api/v2/auth/session',{headers:{Cookie:[...cookies.values()].join('; '),'X-Game-Realm':market}});assert.equal((await r.json()).market,market);}
  await fetch(server.url+'/api/v2/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+roles[2].token}});assert.equal((await fetch(server.url+'/api/v2/state',{headers:{Authorization:'Bearer '+roles[0].token}})).status,200);assert.equal((await fetch(server.url+'/api/v2/state',{headers:{Authorization:'Bearer '+roles[2].token}})).status,401);
  assert.equal((await fetch(server.url+'/api/v2/state',{headers:{Authorization:'Bearer '+siteToken}})).status,401);
  assert.equal((await fetch(server.url+'/api/v2/auth/site-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:'INVALID',createRemaster:true})})).status,400);
 }finally{await server.close();}
});
test('catalog upgrade preserves existing cash, positions and order history and only runs once',async()=>{
 const repository=new WorldRepository(':memory:');let game=new GameService(repository);await game.execute({kind:'create-player',owner:'migration-player',name:'保留资产',market:'CN'},'migration-create');
 const held=game.world.accounts[accountId('migration-player','CN')];held.cash=123456789;const id=Object.keys(game.world.instruments).find(id=>id.startsWith('RCN'));delete game.world.instruments[id];delete game.world.quotes[id];delete game.world.accounts['maker-CN:CN'].positions[id];repository.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(game.world));const version=game.world.version;
 game=new GameService(repository);assert(game.world.instruments[id]);assert.equal(game.world.accounts[held.id].cash,123456789);assert.equal(game.world.version,version+1);game=new GameService(repository);assert.equal(game.world.version,version+1);repository.close();
});
test('minute history moves out of hot snapshots without losing candles or aggregate volume',()=>{
 const repository=new WorldRepository(':memory:');let game=new GameService(repository);const bars=Array.from({length:300},(_,i)=>({time:Date.parse('2026-09-30T00:00:00Z')+i*60000,day:0,open:4500,high:4501,low:4499,close:4500,volume:10}));game.world.quotes.T1.history=bars;repository.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(game.world));
 game=new GameService(repository);assert.equal(game.world.quotes.T1.history.length,120);assert.deepEqual(repository.candles('T1'),bars);
 const {history}=require('../dist/apps/game-api/read-model');const grouped=history(game.world,'T1','5m',false,false,repository.candles('T1'));assert.equal(grouped.length,60);assert.equal(grouped.reduce((sum,b)=>sum+b.volume,0),3000);
 const version=game.world.version;game=new GameService(repository);assert.equal(game.world.version,version);assert.deepEqual(repository.candles('T1'),bars);repository.close();
});
