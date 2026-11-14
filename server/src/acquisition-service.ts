// 획득 서비스: 첫 갈매미, 모집(후보 세션), 조합, 도감, 보유 개체. 계산은 shared/acquisition.ts, 여기는 저장·잠금·영수증.
// 원본 흐름: GMM110 roster60-onboarding.ts, roster60-recruit-session.ts, roster60-craft.ts, roster60-library.ts, roster60-owned.ts (커밋 0b0fb8b5)
// 원본과 다른 점(의도): 커먼 선택지급권은 우편함(8단계) 대신 첫 갈매미 상태에 바로 둠. 일일 미션 집계(recordRosterDailyProgress)는 8단계에서 연결.
import {randomInt,randomUUID} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  commonChoices,rosterGrades,recruitWeightTickets,halfRecruitCost,drawRecruitCandidate,recruitRefundBlock,craftPlan,craftOptions,ownedSummary,ownedDetail,
  validateRosterDefinition,publicDefenseSafe,baseDefenseKey,skillElements,type CraftSelection,type OwnedRow,type RecruitCandidate,type SkillElement,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {serial,withReceipt} from './receipts.js';

type Tx=Prisma.TransactionClient;
type RecruitSnapshot={batchId:string;batchIndex:number;batchSize:number;catalogVersion:string;policyVersion:string;kind:string;baseCost:number;rerollCost:number;rerolls:number;original:RecruitCandidate;candidate:RecruitCandidate;pool:RecruitCandidate[];ownedId?:string;paidBaseCost:number;refundedTickets?:number};

export class AcquisitionService{
  constructor(private db:PrismaClient,private content:Content,private roll:(max:number)=>number=randomInt){}

  // ── 첫 갈매미
  private onboardingView(s:{starterId:string;completedAt:Date|null;ticketId:string|null;selectedId:string|null;rewardOwnedId:string|null;catalogVersion:string|null;tutorialProof:string|null}){
    return {flow:'roster60-v1',started:true,starter:{id:s.starterId,speciesId:'u01',name:'갈매미맨',permanent:true},tutorialVerified:!!s.tutorialProof,tutorialComplete:s.completedAt!==null,
      ticket:s.ticketId?{ticketId:s.ticketId,name:'커먼 선택지급권',quantity:s.selectedId?0:1,status:s.selectedId?'used':'unused',characterId:s.selectedId,ownedId:s.rewardOwnedId,catalogVersion:s.catalogVersion}:null};
  }
  async onboarding(playerId:string){const s=await this.db.onboardingState.findUnique({where:{playerId}});return s?this.onboardingView(s):{flow:'roster60-v1',started:false};}
  /** 시작: 갈매미맨(u01) 한 마리를 영구 지급(한 번만) */
  onboardingStart(playerId:string){return serial(playerId,()=>this.db.$transaction(async tx=>{
    const old=await tx.onboardingState.findUnique({where:{playerId}});if(old)return this.onboardingView(old);
    const starter=await tx.owned.create({data:{playerId,speciesId:'u01',source:'tutorial-starter'}});
    return this.onboardingView(await tx.onboardingState.create({data:{playerId,starterId:starter.id}}));
  }));}
  /** 튜토리얼 전투 정산 안에서만 부름(요청으로 완료를 주장할 수 없음, 원본 verifyRosterTutorial) */
  static async verifyTutorial(tx:Tx,playerId:string,battleId:string){await tx.onboardingState.updateMany({where:{playerId,tutorialProof:null},data:{tutorialProof:battleId}});}
  /** 완료: 튜토리얼 승리 증거가 있으면 커먼 선택지급권 */
  onboardingComplete(playerId:string){return serial(playerId,()=>this.db.$transaction(async tx=>{
    const s=await tx.onboardingState.findUnique({where:{playerId}});
    if(!s?.tutorialProof)return apiFail(409,'TUTORIAL_NOT_VERIFIED');if(s.completedAt)return this.onboardingView(s);
    return this.onboardingView(await tx.onboardingState.update({where:{playerId},data:{ticketId:'roster60-'+randomUUID(),completedAt:new Date()}}));
  }));}
  private choices(){
    const c=this.content.catalog;
    return {statSchema:c.statSchema,catalogVersion:c.version,characters:commonChoices.map(id=>{const m=c.characters.filter(u=>u.id===id);if(m.length!==1)return apiFail(503,'ROSTER_CATALOG_INVALID');
      validateRosterDefinition(m[0]);if(m[0].rarity!=='COMMON')return apiFail(503,'ROSTER_CATALOG_INVALID');return publicDefenseSafe(structuredClone(m[0]));})};
  }
  async onboardingPreview(playerId:string,ticketId:string){
    const s=await this.db.onboardingState.findFirst({where:{playerId,ticketId,completedAt:{not:null}}});if(!s)return apiFail(404,'TICKET_NOT_FOUND');
    return s.selectedId?this.onboardingView(s):{...this.onboardingView(s),...this.choices()};
  }
  onboardingConfirm(playerId:string,b:{ticketId:string;characterId:string;catalogVersion:string}){
    if(!(commonChoices as readonly string[]).includes(b.characterId))return apiFail(400,'INVALID_CHOICE');
    return serial(playerId,()=>this.db.$transaction(async tx=>{
      const s=await tx.onboardingState.findFirst({where:{playerId,ticketId:b.ticketId,completedAt:{not:null}}});if(!s)return apiFail(404,'TICKET_NOT_FOUND');
      if(s.selectedId){if(s.selectedId!==b.characterId)return apiFail(409,'ALREADY_REDEEMED');return this.onboardingView(s);}
      if(this.content.catalog.version!==b.catalogVersion)return apiFail(409,'CATALOG_CHANGED');
      const ownedId=randomUUID();
      const updated=await tx.onboardingState.updateMany({where:{playerId,ticketId:b.ticketId,selectedId:null},data:{selectedId:b.characterId,rewardOwnedId:ownedId,catalogVersion:b.catalogVersion}});
      if(updated.count!==1)return apiFail(409,'ALREADY_REDEEMED');
      await tx.owned.create({data:{id:ownedId,playerId,speciesId:b.characterId,source:'tutorial-common-choice'}});
      return this.onboardingView(await tx.onboardingState.findUniqueOrThrow({where:{playerId}}));
    }));
  }

  // ── 모집
  private recruitView(row:{id:string;revision:number;status:string;snapshot:string}){const s:RecruitSnapshot=JSON.parse(row.snapshot);
    return {batchId:s.batchId,batchIndex:s.batchIndex,batchSize:s.batchSize,sessionId:row.id,revision:row.revision,status:row.status,kind:s.kind,baseCost:s.baseCost,rerollCost:s.rerollCost,rerolls:s.rerolls,candidate:s.candidate,ownedId:s.ownedId,catalogVersion:s.catalogVersion};}
  private async recruitState(tx:Tx,playerId:string){
    const [player,owned,rows]=await Promise.all([tx.player.findUniqueOrThrow({where:{id:playerId},select:{credits:true}}),
      tx.owned.findMany({where:{playerId,status:{not:'CONSUMED'}},select:{speciesId:true},distinct:['speciesId']}),
      tx.recruitSession.findMany({where:{playerId,status:'PENDING'},orderBy:[{createdAt:'asc'},{id:'asc'}]})]);
    const species=new Set(owned.map(o=>o.speciesId)),sources=new Map(rows.map(r=>[r.id,JSON.parse(r.snapshot) as RecruitSnapshot]));
    const decorate=(v:ReturnType<AcquisitionService['recruitView']>)=>{const ownedSpecies=species.has(v.candidate?.speciesId),source=sources.get(v.sessionId);
      const rejectReason=v.status!=='PENDING'||!source?'NOT_PENDING':!ownedSpecies?'NOT_OWNED_SPECIES':recruitRefundBlock(source.paidBaseCost);
      return {...v,ownedSpecies,canReject:rejectReason==='',rejectRefund:rejectReason===''?1:0,rejectReason};};
    const pendingSessions=rows.map(r=>decorate(this.recruitView(r))).sort((a,b)=>a.batchId===b.batchId?a.batchIndex-b.batchIndex:0);
    return {credits:player.credits,balances:{applicationTickets:player.credits},pendingSessions,decorate};
  }
  private async recruitResponse(tx:Tx,playerId:string,result:Record<string,any>){const {decorate,...state}=await this.recruitState(tx,playerId);
    return {...result,...(result.candidate?decorate(result as any):{}),...(Array.isArray(result.sessions)?{sessions:result.sessions.map(decorate)}:{}),...state};}
  async recruitInfo(playerId:string){const p=this.content.recruit;return this.db.$transaction(async tx=>{const {decorate,...state}=await this.recruitState(tx,playerId);
    return {catalogVersion:this.content.catalog.version,enabled:true,offers:p.offers.map(o=>({kind:o.kind,label:o.label,cost:o.cost,weights:{...o.weights},rerollCost:halfRecruitCost(o.cost,p.halfRounding)})),grades:rosterGrades,...state};});}
  private async charge(tx:Tx,playerId:string,cost:number){
    const p=await tx.player.findUniqueOrThrow({where:{id:playerId}});if(p.credits<cost)return apiFail(409,'INSUFFICIENT_CREDITS');
    const changed=await tx.player.updateMany({where:{id:playerId,revision:p.revision,credits:{gte:cost}},data:{credits:{decrement:cost},revision:{increment:1}}});
    if(changed.count!==1)return apiFail(409,'RECRUIT_RETRY');return {credits:p.credits-cost,charged:cost};
  }
  recruitStart(playerId:string,b:{requestId:string;kind:string;catalogVersion:string;times?:number}){
    const times=b.times??1;if(!Number.isSafeInteger(times)||times<1||times>50)return apiFail(400,'INVALID_REQUEST');
    return withReceipt(this.db,playerId,'recruit',b.requestId,['start',b.kind,b.catalogVersion,times],async tx=>{
      const p=this.content.recruit,c=this.content.catalog;
      if(c.version!==b.catalogVersion)return apiFail(409,'CATALOG_CHANGED');
      if(!await tx.onboardingState.findUnique({where:{playerId}}))return apiFail(409,'ROSTER_START_REQUIRED');
      const o=p.offers.find(o=>o.kind===b.kind);if(!o)return apiFail(409,'RECRUIT_GRADE_POLICY_PENDING');
      const rerollCost=halfRecruitCost(o.cost,p.halfRounding),weights=recruitWeightTickets(o.weights),total=o.cost*times;
      const charged=await this.charge(tx,playerId,total);
      if(await tx.recruitSession.findFirst({where:{playerId,status:'PENDING'}}))return apiFail(409,'RECRUIT_SESSION_PENDING');
      const sessions=[];
      for(let index=0;index<times;index++){const {candidate,pool}=drawRecruitCandidate(c,weights,this.roll);
        const snapshot:RecruitSnapshot={batchId:b.requestId,batchIndex:index,batchSize:times,catalogVersion:c.version,policyVersion:p.version,kind:b.kind,baseCost:o.cost,rerollCost,rerolls:0,original:candidate,candidate,pool,paidBaseCost:o.cost};
        sessions.push(this.recruitView(await tx.recruitSession.create({data:{playerId,snapshot:JSON.stringify(snapshot)}})));}
      return this.recruitResponse(tx,playerId,{...sessions[0],sessions,credits:charged.credits,receipt:{requestId:b.requestId,action:'start',chargedTickets:charged.charged,refundedTickets:0,grantedOwnedIds:[],sessionIds:sessions.map(s=>s.sessionId)}});
    });
  }
  private async grant(tx:Tx,playerId:string,sessionId:string,s:RecruitSnapshot){
    const owned=await tx.owned.create({data:{playerId,speciesId:s.candidate.speciesId,totalXp:BigInt(s.candidate.totalXp),source:'recruit-session:'+sessionId}});s.ownedId=owned.id;
  }
  recruitAction(playerId:string,b:{requestId:string;sessionId:string;revision:number;action:'reroll'|'claim'|'reject'}){
    return withReceipt(this.db,playerId,'recruit',b.requestId,[b.action,b.sessionId,b.revision],async tx=>{
      const row=await tx.recruitSession.findFirst({where:{id:b.sessionId,playerId}});if(!row)return apiFail(404,'RECRUIT_SESSION_NOT_FOUND');
      if(row.revision!==b.revision||row.status!=='PENDING')return apiFail(409,'STALE_REVISION');
      const s:RecruitSnapshot=JSON.parse(row.snapshot);
      if(b.action==='reroll'&&s.rerolls!==0)return apiFail(409,'RECRUIT_REROLL_USED');
      if(b.action==='reject'){
        if(!await tx.owned.findFirst({where:{playerId,speciesId:s.candidate.speciesId,status:{not:'CONSUMED'}},select:{id:true}}))return apiFail(409,'RECRUIT_NOT_OWNED_SPECIES');
        if(recruitRefundBlock(s.paidBaseCost))return apiFail(409,'RECRUIT_REFUND_UNAVAILABLE');
        const lock=await tx.recruitSession.updateMany({where:{id:row.id,playerId,revision:b.revision,status:'PENDING'},data:{revision:{increment:1},status:'REJECTED'}});if(lock.count!==1)return apiFail(409,'STALE_REVISION');
        // 환급은 지원서 1장 고정(모집·새로고침 값이 아님, 원본 규칙)
        const refund=await tx.player.updateMany({where:{id:playerId,credits:{lt:2147483647}},data:{credits:{increment:1},revision:{increment:1}}});if(refund.count!==1)return apiFail(409,'RECRUIT_BALANCE_LIMIT');
        s.refundedTickets=1;const next=await tx.recruitSession.update({where:{id:row.id},data:{snapshot:JSON.stringify(s)}});
        return this.recruitResponse(tx,playerId,{...this.recruitView(next),receipt:{requestId:b.requestId,action:'reject',chargedTickets:0,refundedTickets:1,grantedOwnedIds:[],sessionIds:[row.id]}});
      }
      const lock=await tx.recruitSession.updateMany({where:{id:row.id,playerId,revision:b.revision,status:'PENDING'},data:{revision:{increment:1}}});if(lock.count!==1)return apiFail(409,'STALE_REVISION');
      let chargedTickets=0;
      if(b.action==='reroll'){const charged=await this.charge(tx,playerId,s.rerollCost);chargedTickets=charged.charged;s.candidate=s.pool[this.roll(s.pool.length)];s.rerolls=1;}
      else await this.grant(tx,playerId,row.id,s);
      const next=await tx.recruitSession.update({where:{id:row.id},data:{snapshot:JSON.stringify(s),status:b.action==='claim'?'CLAIMED':'PENDING'}});
      return this.recruitResponse(tx,playerId,{...this.recruitView(next),receipt:{requestId:b.requestId,action:b.action,chargedTickets,refundedTickets:0,grantedOwnedIds:s.ownedId?[s.ownedId]:[],sessionIds:[row.id]}});
    });
  }
  recruitClaimAll(playerId:string,b:{requestId:string;sessions:{sessionId:string;revision:number}[]}){
    if(!Array.isArray(b.sessions)||b.sessions.length<1||b.sessions.length>50||new Set(b.sessions.map(s=>s.sessionId)).size!==b.sessions.length)return apiFail(400,'INVALID_REQUEST');
    return withReceipt(this.db,playerId,'recruit',b.requestId,['claimAll',b.sessions],async tx=>{
      const results=[];let batch:string|undefined;
      for(const item of b.sessions){
        const row=await tx.recruitSession.findFirst({where:{id:item.sessionId,playerId}});if(!row)return apiFail(404,'RECRUIT_SESSION_NOT_FOUND');
        if(row.status!=='PENDING'||row.revision!==item.revision)return apiFail(409,'STALE_REVISION');
        const s:RecruitSnapshot=JSON.parse(row.snapshot);if(batch!==undefined&&batch!==s.batchId)return apiFail(400,'INVALID_REQUEST');batch=s.batchId;
        const lock=await tx.recruitSession.updateMany({where:{id:row.id,playerId,revision:item.revision,status:'PENDING'},data:{revision:{increment:1},status:'CLAIMED'}});if(lock.count!==1)return apiFail(409,'STALE_REVISION');
        await this.grant(tx,playerId,row.id,s);results.push(this.recruitView(await tx.recruitSession.update({where:{id:row.id},data:{snapshot:JSON.stringify(s)}})));
      }
      return this.recruitResponse(tx,playerId,{sessions:results,receipt:{requestId:b.requestId,action:'claim-all',chargedTickets:0,refundedTickets:0,grantedOwnedIds:results.map(s=>s.ownedId!),sessionIds:results.map(s=>s.sessionId)}});
    });
  }

  // ── 발견·도감
  /** 발견한 종: 가진 적 있는 종 + 방어를 관측한 종 + 전투에서 만난 상대 종(원본 discoveredRosterSpecies, 대전은 7단계) */
  async discovered(db:Tx|PrismaClient,playerId:string){
    const [owned,observed,battles]=await Promise.all([db.owned.findMany({where:{playerId},select:{speciesId:true},distinct:['speciesId']}),
      db.observedDefense.findMany({where:{playerId},select:{speciesId:true},distinct:['speciesId']}),db.battle.findMany({where:{playerId},select:{state:true}})]);
    const set=new Set([...owned,...observed].map(r=>r.speciesId));
    for(const b of battles){try{const s=JSON.parse(b.state);if(typeof s?.fighters?.[1]?.speciesId==='string')set.add(s.fighters[1].speciesId);}catch{/* 깨진 기록은 건너뜀 */}}
    return set;
  }
  async collection(playerId:string){
    const c=this.content.catalog,[owned,observed,discovered]=await Promise.all([this.db.owned.findMany({where:{playerId}}),this.db.observedDefense.findMany({where:{playerId}}),this.discovered(this.db,playerId)]);
    const known:Record<string,Partial<Record<SkillElement,string>>>={};
    for(const r of observed)if(baseDefenseKey(c,r.speciesId)===r.profileKey&&skillElements.includes(r.element as SkillElement))(known[r.speciesId]??={})[r.element as SkillElement]=r.reaction;
    return {flow:'roster60-v1',catalogVersion:c.version,testBaseline:c.profileKind==='user-authorized-test-baseline',grades:rosterGrades,
      characters:c.characters.map(u=>({id:u.id,name:u.name,rarity:u.rarity,role:u.role,levelOneStats:u.levelOneStats,suitability:u.suitability,
        defenseKnowledge:{speciesId:u.id,defenses:Object.fromEntries(skillElements.map(e=>[e,known[u.id]?.[e]??'unknown'])),knownDefenseCount:Object.keys(known[u.id]??{}).length,totalDefenseCount:skillElements.length},
        skills:u.skills,ownedCount:owned.filter(o=>o.speciesId===u.id&&o.status!=='CONSUMED').length,discovered:discovered.has(u.id)}))};
  }

  // ── 조합
  async craftOptions(playerId:string,discovery:boolean){
    const [rows,discovered]=await Promise.all([this.db.owned.findMany({where:{playerId,status:'AVAILABLE',locked:false},orderBy:{id:'asc'},take:1001}),discovery?this.discovered(this.db,playerId):Promise.resolve(new Set<string>())]);
    return craftOptions(this.content.catalog,rows as OwnedRow[],discovered,discovery);
  }
  private async materials(tx:Tx|PrismaClient,playerId:string,ids:string[]){return await tx.owned.findMany({where:{id:{in:ids},playerId,status:'AVAILABLE',locked:false},orderBy:{id:'asc'}}) as OwnedRow[];}
  async craftPreview(playerId:string,input:CraftSelection){return craftPlan(this.content.catalog,input,await this.materials(this.db,playerId,input.materialIds)).view;}
  craftConfirm(playerId:string,input:CraftSelection&{requestId:string;previewFingerprint:string}){
    return withReceipt(this.db,playerId,'craft',input.requestId,[input.resultId,[...input.materialIds].sort(),input.catalogVersion,input.inheritance??null,input.previewFingerprint],async tx=>{
      const materials=await this.materials(tx,playerId,input.materialIds),plan=craftPlan(this.content.catalog,input,materials);
      if(!plan.stored||plan.view.inheritance.status!=='selected')return apiFail(409,'INHERITANCE_SELECTION_REQUIRED');
      if(plan.view.previewFingerprint!==input.previewFingerprint)return apiFail(409,'PREVIEW_CHANGED');
      for(const m of materials){const consumed=await tx.owned.updateMany({where:{id:m.id,playerId,status:'AVAILABLE',locked:false,totalXp:m.totalXp,reincarnation:m.reincarnation,skillInheritanceJson:m.skillInheritanceJson},data:{status:'CONSUMED'}});
        if(consumed.count!==1)return apiFail(409,'MATERIALS_UNAVAILABLE');}
      const unit=await tx.owned.create({data:{id:randomUUID(),playerId,speciesId:plan.view.resultId,totalXp:BigInt(plan.view.inheritedTotalXp),source:'craft:'+input.requestId,skillInheritanceJson:JSON.stringify(plan.stored)}});
      // 편성에서 재료로 쓴 개체를 뺌
      const party=await tx.party.findUnique({where:{playerId}});
      if(party){const ids=(JSON.parse(party.ownedIds) as string[]).filter(id=>!input.materialIds.includes(id));await tx.party.update({where:{playerId},data:{ownedIds:JSON.stringify(ids)}});}
      return {...plan.view,ownedId:unit.id};
    });
  }

  // ── 보유 개체
  async ownedList(playerId:string){
    const rows=await this.db.owned.findMany({where:{playerId,status:{not:'CONSUMED'}},orderBy:{id:'asc'}}) as OwnedRow[];
    return {flow:'roster60-owned-v1',catalogVersion:this.content.catalog.version,units:rows.map(r=>ownedSummary(this.content.catalog,r).summary).sort((a,b)=>b.level-a.level||a.ownedId.localeCompare(b.ownedId))};
  }
  async ownedRead(playerId:string,ownedId:string){
    const row=await this.db.owned.findFirst({where:{id:ownedId,playerId,status:{not:'CONSUMED'}}}) as OwnedRow|null;if(!row)return apiFail(404,'UNIT_NOT_FOUND');
    const party=await this.db.party.findUnique({where:{playerId}});
    return {flow:'roster60-owned-v1',catalogVersion:this.content.catalog.version,unit:ownedDetail(this.content.catalog,row,party?JSON.parse(party.ownedIds):[])};
  }
}
