// 같은 requestId 재전송 처리 + 플레이어별 직렬 처리(SQLite 한 대 서버 기준).
import {createHash} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {apiFail} from './errors.js';

const locks=new Map<string,Promise<unknown>>();
/** 같은 플레이어의 쓰기를 차례로 실행. */
export async function serial<T>(key:string,run:()=>Promise<T>):Promise<T>{
  const prev=locks.get(key)??Promise.resolve();
  const next=prev.catch(()=>{}).then(run);locks.set(key,next);
  try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}
}
export function withReceipt<T>(db:PrismaClient,playerId:string,scope:string,requestId:string,payload:unknown,run:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>{
  if(typeof requestId!=='string'||!requestId||requestId.length>100)return apiFail(400,'INVALID_REQUEST');
  const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return serial(playerId,()=>db.$transaction(async tx=>{
    const prior=await tx.receipt.findUnique({where:{playerId_scope_requestId:{playerId,scope,requestId}}});
    if(prior){if(prior.fingerprint!==fingerprint)return apiFail(409,'REQUEST_ID_REUSED');return JSON.parse(prior.result) as T;}
    const result=await run(tx);
    await tx.receipt.create({data:{playerId,scope,requestId,fingerprint,result:JSON.stringify(result)}});
    return result;
  },{timeout:15000}));
}
