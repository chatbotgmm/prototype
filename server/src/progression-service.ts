// 방범대장 경험치 지급·읽기, 환생 미리보기·확정. 원본: src/progression/commander.ts(awardCommanderXp·readCommanderState), src/roster60-reincarnation.ts.
// 계산은 shared/src/progression.ts, 여기는 저장·장부·영수증만.
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  validateCommanderPolicy,commanderPolicyFingerprint,commanderAccountState,commanderEmptyState,commanderEventReward,commanderEventFingerprint,commanderXpProgress,commanderSigned64Maximum,
  rebirthPlan,publicDefenseSafe,type CommanderPolicy,type CommanderEvent,type CommanderState,type RebirthCharacter,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {withReceipt} from './receipts.js';

type Tx=Prisma.TransactionClient|PrismaClient;
export type CommanderXpResult={status:'APPLIED'|'RECORDED_ZERO'|'POLICY_PENDING';reason:string;xpAwarded:number;recordedXp:number;requestedXp:number;level:number|null;totalXp:string|null;policyVersion:string|null;
  rewardScheduleVersion?:string;replayed:boolean;commander:CommanderState;xpProgress?:ReturnType<typeof commanderXpProgress>};

/** 읽기만: 개체 경험치로 추측하거나 예전 기록을 되살리지 않음(원본 readCommanderState) */
export async function readCommanderState(tx:Tx,playerId:string,policy:CommanderPolicy|null):Promise<CommanderState>{
  if(policy===null)return commanderEmptyState();validateCommanderPolicy(policy);
  return commanderAccountState(await tx.commanderAccount.findUnique({where:{playerId}}),policy);
}
/**
 * 사건 하나를 지급(원본 awardCommanderXp). 부르는 쪽의 거래 안에서. 같은 사건은 장부로 한 번만(다시 오면 처음 결과, 지급 0).
 * policy가 null이면(수락·출발 때 정책이 없던 의뢰·모험) 기록하지 않음.
 */
export async function awardCommanderXp(tx:Prisma.TransactionClient,playerId:string,event:CommanderEvent,policy:CommanderPolicy|null):Promise<CommanderXpResult>{
  const fingerprint=commanderEventFingerprint(event),where={playerId_eventKind_eventId:{playerId,eventKind:event.kind,eventId:event.eventId}};
  const old=await tx.commanderXpLedger.findUnique({where});
  if(old){if(old.fingerprint!==fingerprint)return apiFail(409,'COMMANDER_EVENT_CONFLICT');return {...JSON.parse(old.result),xpAwarded:0,recordedXp:old.appliedXp,replayed:true};}
  if(policy===null)return {status:'POLICY_PENDING',reason:'COMMANDER_POLICY_PENDING',xpAwarded:0,recordedXp:0,requestedXp:0,level:null,totalXp:null,policyVersion:null,replayed:false,commander:commanderEmptyState()};
  validateCommanderPolicy(policy);
  const reward=commanderEventReward(event,policy),policyFingerprint=commanderPolicyFingerprint(policy);
  const account=await tx.commanderAccount.upsert({where:{playerId},create:{playerId,totalXp:0n,policyVersion:policy.version,policyFingerprint},update:{}});
  const before=commanderAccountState(account,policy);
  if(before.status==='POLICY_MISMATCH')return apiFail(503,'COMMANDER_ACCOUNT_POLICY_MISMATCH');if(before.status==='DATA_INVALID')return apiFail(503,'COMMANDER_XP_DATA_INVALID');
  const ending=account.totalXp+BigInt(reward.requestedXp);if(ending>commanderSigned64Maximum)return apiFail(503,'COMMANDER_XP_STORAGE_LIMIT');
  const changed=await tx.commanderAccount.updateMany({where:{playerId,policyVersion:policy.version,policyFingerprint,revision:account.revision,totalXp:account.totalXp},data:{totalXp:ending,revision:{increment:1}}});
  if(changed.count!==1)return apiFail(409,'COMMANDER_CONCURRENT_WRITE');
  const commander=commanderAccountState({totalXp:ending,revision:account.revision+1,policyVersion:policy.version,policyFingerprint},policy);
  const result:CommanderXpResult={status:reward.requestedXp?'APPLIED':'RECORDED_ZERO',reason:reward.reason,xpAwarded:reward.requestedXp,recordedXp:reward.requestedXp,requestedXp:reward.requestedXp,level:commander.level,totalXp:commander.totalXp,
    policyVersion:policy.version,...(policy.rewardSchedule?{rewardScheduleVersion:policy.rewardSchedule.version}:{}),replayed:false,commander,xpProgress:commanderXpProgress(account.totalXp,ending,policy)};
  await tx.commanderXpLedger.create({data:{playerId,eventKind:event.kind,eventId:event.eventId,fingerprint,policyVersion:policy.version,policyFingerprint,outcome:event.outcome,reason:event.reason??'',status:result.status,
    requestedXp:reward.requestedXp,appliedXp:reward.requestedXp,startingXp:account.totalXp,endingXp:ending,result:JSON.stringify(result,(_k,v)=>typeof v==='bigint'?v.toString():v)}});
  return result;
}

/** 환생(원본 RosterReincarnation). 첫 성공 무료, 그 뒤 땅콩 1개(원본 ROSTER60_REBIRTH_PEANUT_COST 기본값). */
export const REBIRTH_PEANUT_COST=1;
export class RebirthService{
  constructor(private db:PrismaClient,private content:Content){}
  private async plan(tx:Tx,playerId:string,ownedId:string){
    const c=this.content.catalog,u=await tx.owned.findFirst({where:{id:ownedId,playerId}});if(!u)return apiFail(404,'UNIT_NOT_FOUND');
    const d=c.characters.find(x=>x.id===u.speciesId);if(!d)return apiFail(503,'ROSTER_CATALOG_INVALID');
    const successes=(await tx.rebirthAccount.findUnique({where:{playerId}}))?.successes??0;
    return rebirthPlan(c as any,u,d as unknown as RebirthCharacter,successes,successes===0?0:REBIRTH_PEANUT_COST,publicDefenseSafe);
  }
  async preview(playerId:string){
    const c=this.content.catalog,units=await this.db.owned.findMany({where:{playerId,status:'AVAILABLE'},take:1000,orderBy:{id:'asc'}}),player=await this.db.player.findUniqueOrThrow({where:{id:playerId}});
    const candidates=[];
    for(const u of units){try{candidates.push(await this.plan(this.db,playerId,u.id));}catch(e){candidates.push({ownedId:u.id,name:c.characters.find(d=>d.id===u.speciesId)?.name??u.speciesId,eligible:false,reason:(e as {code?:string}).code??(e as Error).message,preview:null});}}
    return publicDefenseSafe({flow:'roster60-v1',catalogVersion:c.version,peanut:player.peanut,candidates:candidates.map(x=>({...x,speciesId:units.find(u=>u.id===x.ownedId)!.speciesId}))});
  }
  async confirm(playerId:string,b:{requestId:string;ownedId:string;catalogVersion:string;previewFingerprint:string}){
    return withReceipt(this.db,playerId,'rebirth',b.requestId,['confirm',b],async tx=>{
      const p=await this.plan(tx,playerId,b.ownedId);if(!p.eligible)return apiFail(409,p.reason);
      if(b.catalogVersion!==p.catalogVersion||b.previewFingerprint!==p.previewFingerprint)return apiFail(409,'PREVIEW_CHANGED');
      await tx.rebirthAccount.upsert({where:{playerId},create:{playerId},update:{}});
      const account=await tx.rebirthAccount.updateMany({where:{playerId,successes:p.successes},data:{successes:{increment:1}}});if(account.count!==1)return apiFail(409,'PREVIEW_CHANGED');
      const paid=await tx.player.updateMany({where:{id:playerId,peanut:{gte:p.costPeanut}},data:{peanut:{decrement:p.costPeanut},revision:{increment:1}}});if(paid.count!==1)return apiFail(409,'INSUFFICIENT_PEANUT');
      const updated=await tx.owned.updateMany({where:{id:b.ownedId,playerId,status:'AVAILABLE',locked:false,totalXp:BigInt(p.preview.previousCycleTotalXp),reincarnation:p.preview.next.reincarnation-1},data:{reincarnation:p.preview.next.reincarnation,totalXp:0n}});
      if(updated.count!==1)return apiFail(409,'UNIT_CHANGED');
      return publicDefenseSafe({...p,paidPeanut:p.costPeanut,completed:true});
    });
  }
}
