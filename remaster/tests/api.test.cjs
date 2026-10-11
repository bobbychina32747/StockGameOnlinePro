const {test}=require('node:test');const assert=require('node:assert/strict');const {io}=require('socket.io-client');
const {createApplication}=require('../dist/apps/game-api/main');
const {ServiceUnavailableException,UnauthorizedException}=require('@nestjs/common');
test('socket keeps authentication during an identity outage, resumes, and disconnects on confirmed revocation',async()=>{
 const server=await createApplication({port:0,database:':memory:',sandbox:true,tickMs:60000});let socket;
 try{
  const session=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'会话恢复测试',market:'CN'})}).then(r=>r.json());
  await new Promise(resolve=>setTimeout(resolve,250));
  socket=io(server.url+'/v2',{auth:{token:session.token},transports:['websocket'],reconnection:false});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('initial snapshot timeout')),3000);socket.once('snapshot',()=>{clearTimeout(timer);resolve();});socket.once('connect_error',reject);});
  let snapshots=0,expired=0;socket.on('snapshot',()=>snapshots++);socket.on('session-expired',()=>expired++);
  const authenticate=server.auth.authenticate.bind(server.auth);
  server.auth.authenticate=async()=>{throw new ServiceUnavailableException('fixture outage');};
  await server.game.execute({kind:'tick'},'outage-tick-0001');await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(socket.connected,true);assert.equal(expired,0);assert.equal(snapshots,0);
  server.auth.authenticate=authenticate;
  const resumed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('resumed snapshot timeout')),3000);socket.once('snapshot',()=>{clearTimeout(timer);resolve();});});
  await server.game.execute({kind:'tick'},'recovered-tick-0001');await resumed;
  server.auth.authenticate=async()=>{throw new UnauthorizedException('fixture revoked');};
  const revoked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('revocation timeout')),3000);socket.once('session-expired',()=>{clearTimeout(timer);resolve();});});
  await server.game.execute({kind:'tick'},'revoked-tick-0001');await revoked;assert.equal(expired,1);
 }finally{socket?.disconnect();await server.close();}
});
test('local API + real socket: isolated auth, all markets, idempotent order, logout revokes',async()=>{
 const server=await createApplication({port:0,database:':memory:',sandbox:true,tickMs:60000});let socket;
 try {
  const anonymous=await fetch(server.url+'/api/v2/state');assert.equal(anonymous.status,401);
  const hostile=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.invalid'},body:'{}'});assert.equal(hostile.status,401);
  const login=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'API测试员',market:'US'})});const session=await login.json();assert.equal(login.status,201);assert(session.token);assert(login.headers.get('set-cookie').includes('HttpOnly'));
  const headers={Authorization:'Bearer '+session.token,'Content-Type':'application/json'};
  await new Promise(resolve=>setTimeout(resolve,250));
  const state=await fetch(server.url+'/api/v2/state',{headers}).then(response=>response.json());assert.equal(state.instruments.length,138);assert.equal(state.accounts.US.cash,100000000);assert.equal(state.accounts.US.positions.length,0);assert.equal(state.accounts.CN,null);assert(state.instruments.every(item=>item.market==='US'));
  socket=io(server.url+'/v2',{auth:{token:session.token},transports:['websocket'],reconnection:false});const received=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Socket snapshot timeout')),3000);socket.once('snapshot',value=>{clearTimeout(timer);resolve(value);});socket.once('connect_error',reject);});assert.equal(received.protocolVersion,2);
  const symbol=state.instruments.filter(item=>item.market==='US').sort((left,right)=>left.initialPrice-right.initialPrice)[0].symbol;
  const command={kind:'order',owner:'someone-else',market:'US',input:{symbol,side:'buy',type:'market',quantity:10}};
  const first=await fetch(server.url+'/api/v2/commands',{method:'POST',headers:{...headers,'Idempotency-Key':'api-order-0001'},body:JSON.stringify(command)}).then(response=>response.json());assert.equal(first.success,true);assert.equal(first.order.filled,10);
  const second=await fetch(server.url+'/api/v2/commands',{method:'POST',headers:{...headers,'Idempotency-Key':'api-order-0001'},body:JSON.stringify(command)}).then(response=>response.json());assert.equal(first.order.id,second.order.id);
  const updated=await fetch(server.url+'/api/v2/state',{headers}).then(response=>response.json());assert.equal(updated.accounts.US.positions[0].quantity,10);assert.equal(updated.accounts.US.owner,session.owner);
  const ledger=await fetch(server.url+'/api/v2/activity/ledger?market=US',{headers}).then(response=>response.json());assert(ledger.some(entry=>entry.kind==='trade'));
  const logout=await fetch(server.url+'/api/v2/auth/logout',{method:'POST',headers});assert.equal(logout.status,201);assert.equal((await fetch(server.url+'/api/v2/state',{headers})).status,401);
 } finally {socket?.disconnect();await server.close();}
});
