const {test}=require('node:test');const assert=require('node:assert/strict');const {io}=require('socket.io-client');
const {createApplication}=require('../dist/apps/game-api/main');
test('local API + real socket: isolated auth, all markets, idempotent order, logout revokes',async()=>{
 const server=await createApplication({port:0,database:':memory:',sandbox:true,tickMs:60000});let socket;
 try {
  const anonymous=await fetch(server.url+'/api/v2/state');assert.equal(anonymous.status,401);
  const hostile=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.invalid'},body:'{}'});assert.equal(hostile.status,401);
  const login=await fetch(server.url+'/api/v2/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'API测试员'})});const session=await login.json();assert.equal(login.status,201);assert(session.token);assert(login.headers.get('set-cookie').includes('HttpOnly'));
  const headers={Authorization:'Bearer '+session.token,'Content-Type':'application/json'};
  await new Promise(resolve=>setTimeout(resolve,250));
  const state=await fetch(server.url+'/api/v2/state',{headers}).then(response=>response.json());assert.equal(state.instruments.length,138);assert.equal(state.accounts.CN.cash,100000000);assert.equal(state.accounts.US.positions.length,0);
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
