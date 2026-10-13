const {test}=require('node:test');const assert=require('node:assert/strict');
const Database=require('better-sqlite3');const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');
const {RoleSessions,REMEMBER_SECONDS}=require('../dist/apps/game-api/role-sessions');
const {AuthBridge}=require('../dist/apps/game-api/auth');
const {UnifiedController}=require('../dist/apps/game-api/unified-controller');
const config={sandbox:false,identityBaseUrl:'http://127.0.0.1',origin:'http://localhost',allowedOrigins:[]};
function bridge(store){const auth=new AuthBridge(config,store);auth.resolveOwner=(_subject,market,id)=>id+':'+market;auth.request=async()=>({token:'synthetic',subject:'game:fixture',user:{id:'fixture',username:'Fixture',isActive:true}});return auth;}

test('remembered roles survive server restart; hashed tokens and encrypted backend credentials; logout revokes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'stockgame-roles-'));const dbfile=join(directory,'roles.sqlite'),keyfile=join(directory,'key');
 let db;
 try {
  db=new Database(dbfile);let auth=bridge(new RoleSessions(db,keyfile));
  const session=await auth.createGameSession('synthetic-backend-secret','HK',true);
  const row=db.prepare('SELECT * FROM remembered_roles').get();assert.notEqual(row.digest,session.token);assert(!row.sealed.includes('synthetic-backend-secret'));
  assert(row.expires-Date.now()<=REMEMBER_SECONDS*1000);assert(row.expires-Date.now()>REMEMBER_SECONDS*1000-1000);
  db.close();db=new Database(dbfile);auth=bridge(new RoleSessions(db,keyfile));
  assert.equal((await auth.authenticate(session.token)).owner,session.principal.owner);
  assert.equal(auth.backendToken(session.token),'synthetic-backend-secret');auth.revoke(session.token);
  await assert.rejects(()=>auth.authenticate(session.token));assert.equal(db.prepare('SELECT COUNT(*) n FROM remembered_roles').get().n,0);
  const normal=await auth.createGameSession('synthetic-backend-secret','CN',false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM remembered_roles').get().n,0);
  await assert.rejects(()=>bridge(new RoleSessions(db,keyfile)).authenticate(normal.token));
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('expired and tampered remembered sessions are rejected',async()=>{
 const db=new Database(':memory:');const store=new RoleSessions(db);const auth=bridge(store);
 try {
  const s=await auth.createGameSession('synthetic','US',true);
  db.prepare('UPDATE remembered_roles SET expires=?').run(Date.now()-1);
  await assert.rejects(()=>bridge(store).authenticate(s.token));
  const t=await auth.createGameSession('synthetic','US',true);db.prepare("UPDATE remembered_roles SET sealed='broken'").run();
  await assert.rejects(()=>bridge(store).authenticate(t.token));
 }finally{db.close();}
});

test('remembered site roles refresh short JWTs without extending TTL or accepting another parent identity',async()=>{
 const db=new Database(':memory:'),store=new RoleSessions(db);const auth=bridge(store);
 const makeToken=(sub,sid,exp)=>'header.'+Buffer.from(JSON.stringify({sub,sid,exp})).toString('base64url')+'.signature';
 const old=makeToken('site-user','parent-session',Math.floor(Date.now()/1000)+30);
 const fresh=makeToken('site-user','parent-session',Math.floor(Date.now()/1000)+600);
 auth.verifySiteToken=async token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
 try{
  const session=await auth.createSiteSession(old,'HK','Fixture','game:fixture',true);
  const expires=db.prepare('SELECT expires FROM remembered_roles').get().expires;
  auth.request=async(_path,_body,cookie)=>{assert.equal(cookie,'sid=synthetic-parent');return {token:fresh,user:{id:'fixture'}};};
  assert.equal((await auth.authenticate(session.token,'sid=synthetic-parent')).owner,session.principal.owner);
  assert.equal(auth.backendToken(session.token),fresh);assert.equal(db.prepare('SELECT expires FROM remembered_roles').get().expires,expires);
  const other=await auth.createSiteSession(old,'HK','Fixture','game:fixture',true);
  auth.request=async()=>({token:makeToken('other-user','other-parent',Math.floor(Date.now()/1000)+600),user:{id:'fixture'}});
  await assert.rejects(()=>auth.authenticate(other.token,'sid=synthetic-parent'));
  assert.equal(store.load(other.token),null);
 }finally{db.close();}
});

test('only opted-in login gets persistent HttpOnly cookie; malformed remember flag is rejected',async()=>{
 const auth=bridge();const c=new UnifiedController(auth,{});const req={headers:{},ip:'fixture'};
 let cookie;const res={setHeader:(name,value)=>{if(name==='Set-Cookie')cookie=value;}};
 await c.login({username:'fixture',password:'synthetic',market:'HK'},req,res);
 assert(cookie.includes('HttpOnly'));assert(!cookie.includes('Max-Age'));
 await c.login({username:'fixture',password:'synthetic',market:'HK',rememberMe:true},req,res);
 assert(cookie.includes('Max-Age=604800'));assert(cookie.includes('SameSite=Strict'));
 await assert.rejects(()=>c.login({username:'fixture',password:'synthetic',market:'HK',rememberMe:'true'},req,res));
});
