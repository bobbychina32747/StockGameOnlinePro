import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const workspace=resolve(__dirname,'../..');const legacy=resolve(workspace,'../frontend/node_modules');
const installed=resolve(workspace,'node_modules');const source=existsSync(resolve(installed,'react/package.json'))?installed:legacy;
export default defineConfig({base:process.env.REMASTER_WEB_BASE??'/',root:__dirname,resolve:{alias:{react:resolve(source,'react'),'react-dom':resolve(source,'react-dom'),echarts:resolve(source,'echarts'),'socket.io-client':resolve(source,'socket.io-client')}},server:{host:'127.0.0.1',port:3320,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:8320'},'/socket.io':{target:'http://127.0.0.1:8320',ws:true}}},build:{outDir:'dist',emptyOutDir:true,sourcemap:false,rollupOptions:{output:{manualChunks:{charts:['echarts/core','echarts/charts','echarts/components','echarts/renderers']}}}}});
