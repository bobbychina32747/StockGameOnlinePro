const {test}=require('node:test'),assert=require('node:assert/strict');const {createServer}=require('node:http');
const {createApplication}=require('../dist/apps/game-api/main');const {accountId}=require('../dist/packages/engine/world');
test('password accounts verify through the existing backend and keep one funded role per realm',async()=>{
 const users=new Map(),tokens=new Map();let active=true;let profileCalls=0;let subject='game:fixture-game-id';
 const identity=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');let data;
  if(req.url==='/api/auth/register'){if(users.has(body.username)){data={success:false,error:'注册失败，请更换用户名'};}else{const user={id:'fixture-game-id',username:body.username,isActive:true};users.set(body.username,{user,password:body.password});tokens.set('verified-game-token',user);data={token:'verified-game-token',user};}}
  else if(req.url==='/api/auth/login'){const found=users.get(body.username);if(!found||found.password!==body.password){res.statusCode=401;data={message:'用户名或密码错误'};}else data={token:'verified-game-token',user:found.user};}
  else if(req.url==='/api/auth/game-profile'){profileCalls++;const user=tokens.get(String(req.headers.authorization||'').replace('Bearer ',''));if(!user||!active){res.statusCode=401;data={message:'游戏账号不可用'};}else data={user,subject};}
  else{res.statusCode=404;data={};}res.end(JSON.stringify(data));
 });await new Promise(resolve=>identity.listen(0,'127.0.0.1',resolve));
 const server=await createApplication({port:0,database:':memory:',sandbox:true,authSandbox:false,tickMs:60000,identityBaseUrl:'http://127.0.0.1:'+identity.address().port});
 const post=(path,body,headers={})=>fetch(server.url+'/api/v2'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const credentials={username:'game-only-player',password:'fixture-password',market:'HK'};
 try{
  assert.equal((await post('/auth/register',{...credentials,password:'short'})).status,400);
  assert.equal((await post('/auth/register',credentials,{Origin:'https://evil.invalid'})).status,401);
  const created=await post('/auth/register',credentials);assert.equal(created.status,201);const first=await created.json();assert.equal(first.mode,'game');assert.equal(first.market,'HK');assert.match(created.headers.get('set-cookie'),/rgp-role-HK=.*HttpOnly/);
  const held=server.game.world.accounts[accountId(first.owner,'HK')];const cash=held.cash;assert.equal(server.game.world.accounts[accountId(first.owner,'CN')],undefined);
  assert.equal((await post('/auth/register',credentials)).status,400);assert.equal((await post('/auth/login',{...credentials,password:'wrong-password'})).status,401);
  const again=await post('/auth/login',credentials).then(r=>r.json());assert.equal(first.owner,again.owner);assert.notEqual(first.token,again.token);assert.equal(server.game.world.accounts[held.id].cash,cash);
  const us=await post('/auth/login',{...credentials,market:'US'}).then(r=>r.json());assert.notEqual(first.owner,us.owner);assert.equal(server.game.world.accounts[held.id].cash,cash);
  const headers={Authorization:'Bearer '+again.token};const state=await fetch(server.url+'/api/v2/state',{headers}).then(r=>r.json());assert.equal(state.instruments.length,138);assert.equal(state.accounts.US,null);
  assert.equal((await post('/commands',{kind:'order',market:'US',input:{symbol:'U1',side:'buy',type:'market',quantity:1}},{...headers,'Idempotency-Key':'game-foreign-0001'})).status,400);
  await post('/auth/logout',{},headers);assert.equal((await fetch(server.url+'/api/v2/auth/session',{headers})).status,401);assert.equal((await fetch(server.url+'/api/v2/auth/session',{headers:{Authorization:'Bearer '+us.token}})).status,200);
  subject='site:fixture-linked-identity';const linked=await post('/auth/login',credentials).then(r=>r.json());assert.equal(linked.owner,first.owner);assert.equal(server.game.world.accounts[held.id].cash,cash);
  assert.equal(server.auth.resolveOwner(subject,'HK','game:fixture-game-id'),first.owner);
  assert.equal((await fetch(server.url+'/api/v2/auth/session',{headers:{Authorization:'Bearer '+us.token}})).status,200);
  active=false;assert.equal((await fetch(server.url+'/api/v2/auth/session',{headers:{Authorization:'Bearer '+us.token}})).status,401);assert(profileCalls>=5);
 }finally{await server.close();await new Promise(resolve=>identity.close(resolve));}
});
