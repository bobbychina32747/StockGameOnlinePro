const express=require('express');
const http=require('node:http');
const {gzipSync}=require('node:zlib');
const bcrypt=require('bcrypt');
const {installJsonBodies}=require('../dist/src/infrastructure/http/json-body');

async function serve(app){const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:'http://127.0.0.1:'+server.address().port};}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('compressed JSON with trailing bytes cannot kill the request parser or following requests',async()=>{
 const app=express();installJsonBodies(app);
 app.post('/json',(_req,res)=>res.json({ok:true}));app.get('/health',(_req,res)=>res.json({ok:true}));
 app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:'rejected'}));
 const {server,url}=await serve(app);
 try {
  const payload=Buffer.concat([gzipSync(Buffer.from('{"fixture":true}')),Buffer.from('invalid-trailing-frame')]);
  const response=await fetch(url+'/json',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:payload,signal:AbortSignal.timeout(3000)});
  expect([200,400]).toContain(response.status);await response.text();
  await new Promise(resolve=>setTimeout(resolve,50));
  expect((await fetch(url+'/health')).status).toBe(200);
 }finally{await close(server);}
});

test('bcrypt upgrade keeps a published legacy 2a test vector and native password round trips',async()=>{
 // Public compatibility vector from bcrypt's upstream tests; not a user credential.
 expect(await bcrypt.compare('envy1362987212538','$2a$10$XOPbrlUPQdwdJUpSrIF6X.LbE14qsMmKGhM1A8W9iqaG3vv1BD7WC')).toBe(true);
 const hash=await bcrypt.hash('synthetic compatibility fixture',4);
 expect(await bcrypt.compare('synthetic compatibility fixture',hash)).toBe(true);
 expect(await bcrypt.compare('incorrect fixture',hash)).toBe(false);
});
