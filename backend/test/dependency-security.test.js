const express=require('express');
const http=require('node:http');
const {gzipSync}=require('node:zlib');
const bcrypt=require('bcrypt');
const {of,firstValueFrom}=require('rxjs');
const {installJsonBodies}=require('../dist/src/infrastructure/http/json-body');
const {ChatUploadInterceptor}=require('../dist/src/modules/chat/chat-upload.interceptor');
const {ResourceUploadInterceptor}=require('../dist/src/modules/resources/resource-upload.interceptor');

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

test.each([['private line',ChatUploadInterceptor],['resources',ResourceUploadInterceptor]])('%s upload accepts flat fields and rejects nested multipart fields',async(_name,Interceptor)=>{
 const app=express();const interceptor=new Interceptor();
 app.post('/upload',async(req,res,next)=>{
  try {const stream=await interceptor.intercept({switchToHttp:()=>({getRequest:()=>req,getResponse:()=>res})},{handle:()=>of({ok:true})});res.json(await firstValueFrom(stream));}catch(error){next(error);}
 });
 app.use((error,_req,res,_next)=>res.status(error.getStatus?.()||500).json({message:error.message}));
 const {server,url}=await serve(app);
 try {
  const flat=new FormData();flat.append('caption','synthetic');
  expect((await fetch(url+'/upload',{method:'POST',body:flat})).status).toBe(200);
  const nested=new FormData();nested.append('caption[a][b]','synthetic');
  const response=await fetch(url+'/upload',{method:'POST',body:nested});
  expect(response.status).toBe(400);expect((await response.json()).message).toContain('LIMIT_FIELD_NESTING');
 }finally{await close(server);}
});

test('bcrypt upgrade keeps a published legacy 2a test vector and native password round trips',async()=>{
 // Public compatibility vector from bcrypt's upstream tests; not a user credential.
 expect(await bcrypt.compare('envy1362987212538','$2a$10$XOPbrlUPQdwdJUpSrIF6X.LbE14qsMmKGhM1A8W9iqaG3vv1BD7WC')).toBe(true);
 const hash=await bcrypt.hash('synthetic compatibility fixture',4);
 expect(await bcrypt.compare('synthetic compatibility fixture',hash)).toBe(true);
 expect(await bcrypt.compare('incorrect fixture',hash)).toBe(false);
});
