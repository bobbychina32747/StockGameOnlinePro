import 'reflect-metadata';
import { Module, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Server } from 'socket.io';
import { resolve } from 'node:path';
import { RoleSessions } from './role-sessions';
import { mkdirSync } from 'node:fs';
import { AuthBridge, tokenFrom } from './auth';
import { UnifiedLedger } from './unified-ledger';
import { UnifiedController } from './unified-controller';
export async function createUnifiedApplication(options:{port?:number;identityBaseUrl?:string;database?:string}={}){
  const port=options.port??Number(process.env.REMASTER_PORT??8321);
  const origins=(process.env.REMASTER_ALLOWED_ORIGINS??`http://127.0.0.1:${port},http://localhost:${port}`).split(',');
  const root=resolve(__dirname,'../../..');mkdirSync(resolve(root,'data'),{recursive:true});
  const Database=require('better-sqlite3');const db=new Database(options.database??process.env.UNIFIED_COMMAND_DB??resolve(root,'data/formal-commands.sqlite'));db.pragma('journal_mode = WAL');
  const auth=new AuthBridge({sandbox:false,identityBaseUrl:options.identityBaseUrl??process.env.REMASTER_IDENTITY_URL??'http://127.0.0.1:8000',origin:process.env.REMASTER_SITE_ORIGIN??'https://game.bobbycn.cc',allowedOrigins:origins},new RoleSessions(db,options.database===':memory:'?undefined:resolve(options.database??process.env.UNIFIED_COMMAND_DB??resolve(root,'data/formal-commands.sqlite'))+'.session-key'));
  // Native credentials and linked site identity always point to the same original game user.
  auth.resolveOwner=(subject,market,gameSubject)=>(gameSubject??subject)+':'+market;
  const ledger=new UnifiedLedger(auth,db);
  @Module({controllers:[UnifiedController],providers:[{provide:'AUTH',useValue:auth},{provide:'LEDGER',useValue:ledger}]})class FormalModule{}
  const app=await NestFactory.create(FormalModule,{logger:['error','warn']});app.setGlobalPrefix('api');
  const express=require('express');const adapter=app.getHttpAdapter().getInstance();adapter.set('trust proxy',process.env.REMASTER_TRUST_PROXY==='1'?1:0);
  app.enableCors({origin:origins,credentials:true,allowedHeaders:['Content-Type','Authorization','Idempotency-Key','X-Game-Realm']});
  app.use((req:any,res:any,next:any)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
  app.use('/api',express.json({limit:'64kb'}));app.use(express.static(resolve(root,'apps/web/dist')));
  adapter.get(['/login','/login/'],(_req:any,res:any)=>res.sendFile(resolve(root,'apps/web/dist/index.html')));
  const socketServer=new Server(app.getHttpServer(),{cors:{origin:origins,credentials:true},maxHttpBufferSize:100000});const ns=socketServer.of('/v2');
  ns.use(async(socket,next)=>{try{auth.assertOrigin(socket.handshake.headers.origin);const token=socket.handshake.auth?.token||tokenFrom({headers:{...socket.handshake.headers,'x-game-realm':socket.handshake.auth?.market??'CN'}});socket.data.token=token;socket.data.principal=await auth.authenticate(token,String(socket.handshake.headers.cookie??''));next();}catch{next(new Error('请登录当前区服'));}});
  let publishing=false;
  const publish=async()=>{if(publishing)return;publishing=true;try{await Promise.all([...ns.sockets.values()].map(async socket=>{try{const p=await auth.authenticate(socket.data.token,String(socket.handshake.headers.cookie??''));socket.emit('snapshot',await ledger.snapshot(socket.data.token,p));}catch(error){if(error instanceof HttpException&&error.getStatus()===401){socket.emit('session-expired');socket.disconnect(true);}}}));}finally{publishing=false;}};
  ns.on('connection',()=>void publish());const timer=setInterval(()=>void publish(),2000);
  await app.listen(port,process.env.REMASTER_HOST??'127.0.0.1');
  return {app,auth,ledger,url:`http://127.0.0.1:${(app.getHttpServer().address() as any).port}`,async close(){clearInterval(timer);await socketServer.close();await app.close();db.close();}};
}
if(require.main===module)void createUnifiedApplication().then(server=>{console.log('Unified StockGame: '+server.url);const stop=()=>void server.close().then(()=>process.exit(0));process.once('SIGTERM',stop);process.once('SIGINT',stop);}).catch(error=>{console.error(error);process.exitCode=1;});
