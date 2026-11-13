// 웹 화면 파일 제공: <기본 경로>/ (index.html), /app.js(묶음), /style.css, /assets/*
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import type {FastifyInstance} from 'fastify';

const TYPES:Record<string,string>={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webp':'image/webp','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8'};
export function registerStatic(app:FastifyInstance,root:string,base:string){
  const file=async(path:string)=>{const body=await readFile(path).catch(()=>null);return body;};
  const send=async(reply:any,path:string,cache:string)=>{const body=await file(path);if(!body)return reply.code(404).send({error:'NOT_FOUND'});
    const ext=path.slice(path.lastIndexOf('.'));return reply.type(TYPES[ext]??'application/octet-stream').header('Cache-Control',cache).send(body);};
  app.get(base||'/',async(_req,reply)=>reply.redirect(`${base}/`));
  app.get(`${base}/`,async(_req,reply)=>{
    const html=await readFile(resolve(root,'web/index.html'),'utf8');
    const v=Math.floor((await stat(resolve(root,'dist/web/app.js')).catch(()=>({mtimeMs:0}))).mtimeMs);
    return reply.type(TYPES['.html']).header('Cache-Control','no-cache').send(html.replaceAll('{{BASE}}',base).replaceAll('{{V}}',String(v)));
  });
  app.get(`${base}/app.js`,async(_req,reply)=>send(reply,resolve(root,'dist/web/app.js'),'no-cache'));
  app.get(`${base}/style.css`,async(_req,reply)=>send(reply,resolve(root,'web/style.css'),'no-cache'));
  const assets=resolve(root,'assets');
  app.get(`${base}/assets/*`,async(req,reply)=>{
    const rel=(req.params as {'*':string})['*'];
    if(!/^[a-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/.test(rel)||rel.includes('..'))return reply.code(404).send({error:'NOT_FOUND'});
    const path=resolve(assets,rel);if(!path.startsWith(assets+sep))return reply.code(404).send({error:'NOT_FOUND'});
    return send(reply,path,'public, max-age=86400');
  });
}
