// 운영·시험 서버 시작. 필요한 환경 변수: DATABASE_URL, SESSION_SECRET(32자 이상), PORT(기본 3100), BASE_PATH(기본 /proto)
import {resolve} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {buildApp} from './app.js';

const secret=process.env.SESSION_SECRET??'';
if(secret.length<32)throw Error('SESSION_SECRET(32자 이상)이 필요해요.');
const db=new PrismaClient();
const app=await buildApp(db,{root:resolve(import.meta.dirname,'../..'),secret,basePath:process.env.BASE_PATH??'/proto',log:true});
await app.listen({host:'127.0.0.1',port:Number(process.env.PORT??3100)});
const stop=()=>{void app.close().then(()=>db.$disconnect()).then(()=>process.exit(0));};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
