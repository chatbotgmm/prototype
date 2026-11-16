// 방범대장(계정 성장)·환생 규칙(순수 함수).
// 원본(GMM110 0b0fb8b5): src/progression/commander.ts, src/roster60-reincarnation.ts, src/battle/roster60-reincarnation.ts.
// 방범대장 수치(성장 99줄·지급량)는 원본에서도 시험값이에요(productionBalanceApproved:false).
import {createHash} from 'node:crypto';
import {fail} from './errors.js';
import {growthAt,rosterMaxLevel,validateGrowth,type GrowthPoint,type ReincarnationXpPolicy} from './rules.js';
import {fiveRebirthStats,fiveRebirthPolicy,requiredReincarnationLevel,type FiveStats} from './combat.js';
import type {XpProgressPoint} from './xp.js';

// ── 방범대장 ──
export type CommanderRewards={storyQuest:number;residentQuest:number;independentAdventureReturn:number;normalWin:number;normalLoss:number;normalProvenTimeoutSurvivor:number};
export type CommanderRewardSchedule={version:string;rewards:CommanderRewards};
export type CommanderPolicy={approved:true;version:string;profileKind:'user-authorized-test-baseline';productionBalanceApproved:false;testValues:true;name:'방범대장';eventBasis:'one-account-event';
  unitXpRelationship:'independent-not-sum-not-split';unitReincarnation:'account-retained';initialization:'test-only-zero-no-backfill';legacyEvents:'no-retroactive-reconstruction';totalXpPolicy:'retain-lifetime-total';
  curveOverflow:'last-known-level-extension-pending';growth:{level:number;totalXp:number}[];story:{contentVersion:string;mainQuestIds:string[];residentQuestIds:string[]};rewards:CommanderRewards;
  rewardSchedule?:CommanderRewardSchedule;budget:{requiredIndependentAdventures:number};notes?:string[]};
export type CommanderEvent={kind:'STORY_QUEST'|'RESIDENT_QUEST'|'ADVENTURE_RETURN'|'NORMAL_PLAY';eventId:string;outcome:'completed'|'win'|'loss'|'draw'|'surrender'|'departed'|'aborted';
  reason?:string;linkedQuestId?:string|null;timeoutGenerated?:boolean;terminationProof?:unknown;side?:0|1};
export const commanderSigned64Maximum=9_223_372_036_854_775_807n;
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const safeAmount=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=2_000_000_000;
const idText=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=300;
const rewardKeys=['storyQuest','residentQuest','independentAdventureReturn','normalWin','normalLoss','normalProvenTimeoutSurvivor'] as const;
const validRewards=(raw:unknown):raw is CommanderRewards=>record(raw)&&Object.keys(raw).length===rewardKeys.length&&rewardKeys.every(k=>safeAmount(raw[k]))&&raw.normalLoss===Math.floor(raw.normalWin/2)&&raw.normalProvenTimeoutSurvivor===raw.normalWin;
/** 정책 검사(원본 validateCommanderPolicy). 시험 정책이 운영 승인처럼 보이지 않게 막는다. */
export function validateCommanderPolicy(raw:unknown):CommanderPolicy{
  if(raw===null||raw===undefined)return fail('COMMANDER_POLICY_PENDING');
  const bad=()=>fail('COMMANDER_POLICY_INVALID');
  if(!record(raw)||raw.approved!==true||!idText(raw.version)||raw.profileKind!=='user-authorized-test-baseline'||raw.productionBalanceApproved!==false||raw.testValues!==true||raw.name!=='방범대장'||raw.eventBasis!=='one-account-event'||raw.unitXpRelationship!=='independent-not-sum-not-split'
    ||raw.unitReincarnation!=='account-retained'||raw.initialization!=='test-only-zero-no-backfill'||raw.legacyEvents!=='no-retroactive-reconstruction'||raw.totalXpPolicy!=='retain-lifetime-total'||raw.curveOverflow!=='last-known-level-extension-pending')return bad();
  if(!Array.isArray(raw.growth)||raw.growth.length<60||raw.growth.length>1000)return bad();
  for(const [i,p] of raw.growth.entries())if(!record(p)||p.level!==i+1||typeof p.totalXp!=='number'||!Number.isSafeInteger(p.totalXp)||p.totalXp<0||(i===0?p.totalXp!==0:p.totalXp<=raw.growth[i-1].totalXp))return bad();
  if(!record(raw.story)||!idText(raw.story.contentVersion))return bad();
  const main=raw.story.mainQuestIds,side=raw.story.residentQuestIds;
  if(!Array.isArray(main)||!Array.isArray(side)||!main.length||main.some((x:unknown)=>!idText(x))||side.some((x:unknown)=>!idText(x))||new Set([...main,...side]).size!==main.length+side.length)return bad();
  if(!validRewards(raw.rewards)||!record(raw.budget)||!safeAmount(raw.budget.requiredIndependentAdventures))return bad();
  if(raw.rewardSchedule!==undefined){const s=raw.rewardSchedule;
    if(!record(s)||Object.keys(s).sort().join()!=='rewards,version'||!idText(s.version)||!validRewards(s.rewards))return fail('COMMANDER_REWARD_SCHEDULE_INVALID');
    if(rewardKeys.some(k=>s.rewards[k]<raw.rewards[k]))return fail('COMMANDER_REWARD_SCHEDULE_INVALID');}
  return raw as CommanderPolicy;
}
/** 원본 commanderPolicyReader: 정책 파일 + 보상 일정 파일을 합침(정책 안에 일정이 이미 있으면 충돌) */
export function withRewardSchedule(policy:unknown,schedule:unknown|undefined):CommanderPolicy{
  const p=validateCommanderPolicy(policy);if(schedule===undefined)return p;
  if(p.rewardSchedule!==undefined)return fail('COMMANDER_REWARD_SCHEDULE_CONFLICT');
  return validateCommanderPolicy({...p,rewardSchedule:schedule});
}
/** 계정 기록과 정책이 같은지 확인하는 지문(보상 일정은 빼고 기본 지급량·성장만) */
export function commanderPolicyFingerprint(policy:CommanderPolicy):string{
  validateCommanderPolicy(policy);const r=policy.rewards;
  const semantic=[policy.version,policy.approved,policy.profileKind,policy.productionBalanceApproved,policy.testValues,policy.name,policy.eventBasis,policy.unitXpRelationship,policy.unitReincarnation,policy.initialization,policy.legacyEvents,policy.totalXpPolicy,policy.curveOverflow,
    policy.growth.map(p=>[p.level,p.totalXp]),policy.story.contentVersion,[...policy.story.mainQuestIds].sort(),[...policy.story.residentQuestIds].sort(),[r.storyQuest,r.residentQuest,r.independentAdventureReturn,r.normalWin,r.normalLoss,r.normalProvenTimeoutSurvivor]];
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
/** 누적 경험치 → 레벨. 마지막 줄을 넘으면 「다음 구간 준비 중」(새 상한이 아님). */
export function commanderLevelAt(totalXp:bigint,policy:CommanderPolicy){
  if(totalXp<0n||totalXp>commanderSigned64Maximum)return fail('COMMANDER_XP_DATA_INVALID');
  let index=0;for(let i=1;i<policy.growth.length&&totalXp>=BigInt(policy.growth[i].totalXp);i++)index=i;
  const next=policy.growth[index+1]?.totalXp;
  return {level:policy.growth[index].level,nextLevelXp:next===undefined?null:String(next),xpToNext:next===undefined?null:(BigInt(next)-totalXp).toString(),maxLevel:policy.growth.at(-1)!.level,status:next===undefined?'CURVE_EXTENSION_PENDING' as const:'READY' as const};
}
export function commanderXpProgress(startingXp:bigint,endingXp:bigint,policy:CommanderPolicy):{before:XpProgressPoint;after:XpProgressPoint}{
  const point=(t:bigint):XpProgressPoint=>{const l=commanderLevelAt(t,policy);return {level:l.level,totalXp:t.toString(),levelStartTotalXp:String(policy.growth[l.level-1].totalXp),nextLevelTotalXp:l.nextLevelXp,maxLevel:l.maxLevel};};
  return {before:point(startingXp),after:point(endingXp)};
}
export type CommanderState={name:'방범대장';level:number|null;totalXp:string|null;nextLevelXp:string|null;xpToNext:string|null;maxLevel:number|null;policyVersion:string|null;revision:number|null;initialized:boolean;
  status:'READY'|'POLICY_PENDING'|'POLICY_MISMATCH'|'CURVE_EXTENSION_PENDING'|'DATA_INVALID';testValues:boolean;productionBalanceApproved:boolean;initialization:'TEST_ZERO_NO_BACKFILL'|'UNCONFIGURED';unitXpIndependent:true;totalXpPolicy:'retain-lifetime-total'};
export function commanderEmptyState(status:CommanderState['status']='POLICY_PENDING'):CommanderState{
  return {name:'방범대장',level:null,totalXp:null,nextLevelXp:null,xpToNext:null,maxLevel:null,policyVersion:null,revision:null,initialized:false,status,testValues:false,productionBalanceApproved:false,initialization:'UNCONFIGURED',unitXpIndependent:true,totalXpPolicy:'retain-lifetime-total'};
}
/** 계정 기록(없으면 0) → 화면 상태(원본 accountState) */
export function commanderAccountState(row:{totalXp:bigint;policyVersion:string;policyFingerprint:string;revision:number}|null,policy:CommanderPolicy):CommanderState{
  if(row&&(row.policyVersion!==policy.version||row.policyFingerprint!==commanderPolicyFingerprint(policy)))return {...commanderEmptyState('POLICY_MISMATCH'),policyVersion:row.policyVersion,initialized:true};
  if(row&&(!Number.isSafeInteger(row.revision)||row.revision<0||row.totalXp<0n||row.totalXp>commanderSigned64Maximum))return {...commanderEmptyState('DATA_INVALID'),policyVersion:row.policyVersion,initialized:true};
  const totalXp=row?.totalXp??0n;
  return {...commanderEmptyState(),...commanderLevelAt(totalXp,policy),totalXp:totalXp.toString(),policyVersion:policy.version,revision:row?.revision??0,initialized:!!row,testValues:true,initialization:'TEST_ZERO_NO_BACKFILL'};
}
const kinds=['STORY_QUEST','RESIDENT_QUEST','ADVENTURE_RETURN','NORMAL_PLAY'],outcomes=['completed','win','loss','draw','surrender','departed','aborted'];
export function validateCommanderEvent(e:CommanderEvent){
  if(!record(e)||!kinds.includes(e.kind)||!idText(e.eventId)||!outcomes.includes(e.outcome)||e.reason!==undefined&&(typeof e.reason!=='string'||e.reason.length>100)||e.linkedQuestId!==undefined&&e.linkedQuestId!==null&&!idText(e.linkedQuestId)
    ||e.timeoutGenerated!==undefined&&typeof e.timeoutGenerated!=='boolean'||e.side!==undefined&&e.side!==0&&e.side!==1)return fail('COMMANDER_EVENT_INVALID');
  if(Object.keys(e).some(k=>!['kind','eventId','outcome','reason','linkedQuestId','timeoutGenerated','terminationProof','side'].includes(k)))return fail('COMMANDER_EVENT_INVALID');
}
/**
 * 사건 하나의 지급량(원본 commanderEventReward). 의뢰 완료·독립 모험(이기고 귀환)·일반전 승패만.
 * presenceProofValid: 접속이 끊긴 쪽을 서버가 증명했는지(대전 7-2단계에서 씀). 증명이 없으면 시간 초과 승리는 0.
 */
export function commanderEventReward(event:CommanderEvent,policy:CommanderPolicy,presenceProofValid:(proof:unknown)=>proof is {survivorSide:0|1}=(_p):_p is {survivorSide:0|1}=>false):{requestedXp:number;reason:string}{
  validateCommanderEvent(event);validateCommanderPolicy(policy);
  const rewards=policy.rewardSchedule?.rewards??policy.rewards;
  if(event.kind==='STORY_QUEST'||event.kind==='RESIDENT_QUEST'){
    const keys=event.kind==='STORY_QUEST'?policy.story.mainQuestIds:policy.story.residentQuestIds;
    if(!keys.some(k=>event.eventId===policy.story.contentVersion+':'+k))return fail('COMMANDER_QUEST_SOURCE_INVALID');
    return event.outcome==='completed'?{requestedXp:event.kind==='STORY_QUEST'?rewards.storyQuest:rewards.residentQuest,reason:'QUEST_COMPLETED'}:{requestedXp:0,reason:'QUEST_NOT_COMPLETED'};
  }
  if(event.kind==='ADVENTURE_RETURN'){
    if(event.linkedQuestId)return {requestedXp:0,reason:'QUEST_LINKED_ADVENTURE_ZERO'};
    return event.outcome==='completed'&&event.reason==='WIN_RETURN'?{requestedXp:rewards.independentAdventureReturn,reason:'INDEPENDENT_ADVENTURE_COMPLETED'}:{requestedXp:0,reason:'ADVENTURE_NO_CLEAR_ZERO'};
  }
  if(event.timeoutGenerated)return {requestedXp:0,reason:'AUTOMATIC_TURN_ZERO'};
  if(event.reason==='TIMEOUT'){const proof=event.terminationProof;
    return event.outcome==='win'&&presenceProofValid(proof)&&event.side===proof.survivorSide?{requestedXp:rewards.normalProvenTimeoutSurvivor,reason:'PROVEN_TIMEOUT_SURVIVOR'}:{requestedXp:0,reason:'TIMEOUT_NON_SURVIVOR_ZERO'};}
  if(event.reason==='BATTLE'&&(event.outcome==='win'||event.outcome==='loss'))return {requestedXp:event.outcome==='win'?rewards.normalWin:rewards.normalLoss,reason:event.outcome==='win'?'NORMAL_WIN':'NORMAL_LOSS'};
  return {requestedXp:0,reason:'NORMAL_NON_COMPLETION_ZERO'};
}
/** 같은 사건을 두 번 지급하지 않게 남기는 지문(원본 eventFingerprint). presence: 증명된 접속 끊김이면 그 값들, 아니면 'unproven'. */
export function commanderEventFingerprint(e:CommanderEvent,presence:unknown[]|'unproven'='unproven'){
  return createHash('sha256').update(JSON.stringify([e.kind,e.eventId,e.outcome,e.reason??'',e.linkedQuestId??null,e.timeoutGenerated??false,e.side??null,presence])).digest('hex');
}
/** 지금 콘텐츠로 얻을 수 있는 방범대장 경험치(원본 simulateCommanderBudget) */
export function simulateCommanderBudget(policy:CommanderPolicy,requiredQuestLinkedAdventureReturns=0){
  validateCommanderPolicy(policy);if(!safeAmount(requiredQuestLinkedAdventureReturns))return fail('COMMANDER_BUDGET_INVALID');
  const r=policy.rewardSchedule?.rewards??policy.rewards;
  const mainXp=policy.story.mainQuestIds.length*r.storyQuest,residentXp=policy.story.residentQuestIds.length*r.residentQuest,independentAdventureXp=policy.budget.requiredIndependentAdventures*r.independentAdventureReturn;
  if(!Number.isSafeInteger(mainXp+residentXp+independentAdventureXp))return fail('COMMANDER_BUDGET_INVALID');
  const mainLevel=commanderLevelAt(BigInt(mainXp),policy).level,totalXp=mainXp+residentXp+independentAdventureXp,totalLevel=commanderLevelAt(BigInt(totalXp),policy).level;
  return {testValues:true,productionBalanceApproved:false,mainQuestCount:policy.story.mainQuestIds.length,residentQuestCount:policy.story.residentQuestIds.length,mainXp,residentXp,requiredQuestLinkedAdventureReturns,questLinkedAdventureXp:0,
    requiredIndependentAdventures:policy.budget.requiredIndependentAdventures,independentAdventureXp,totalXp,mainLevel,totalLevel,mainOnlyBelow60:mainLevel<60,completeBudgetReaches60:totalLevel>=60};
}

// ── 환생 ──
/** 환생할 수 있는 등급(원본 rebirthGradePolicy) */
export const rebirthGradePolicy=Object.freeze({version:'limited-transcend-immortal-eternal-v1',grades:Object.freeze(['LIMITED','TRANSCEND','IMMORTAL','ETERNAL'])});
/** 환생 미리보기 계산(원본 previewReincarnation). totalXp는 지금 성장 주기의 누적 경험치(평생 누적이 아님). */
export function previewReincarnation(input:{totalXp:number;reincarnation:number;baseLevelOneStats:Record<string,number>;curve:GrowthPoint[]},policy:{approved:true;version:string;bonusFor:(cycle:number)=>Record<string,number>}|undefined){
  rosterMaxLevel(input.reincarnation);validateGrowth(input.curve);
  if(!Number.isSafeInteger(input.totalXp)||input.totalXp<0)return fail('INVALID_XP');
  if(!policy?.approved||!policy.version)return fail('REINCARNATION_BONUS_POLICY_REQUIRED');
  const cycle=input.reincarnation+1;rosterMaxLevel(cycle);
  const bonus=policy.bonusFor(cycle),base=input.baseLevelOneStats,keys=Object.keys(base);
  if(!keys.length||keys.sort().join()!==Object.keys(bonus).sort().join())return fail('INVALID_REINCARNATION_BONUS');
  const after:Record<string,number>={};let improved=false;
  for(const k of keys){if(!Number.isFinite(base[k])||base[k]<0||!Number.isFinite(bonus[k])||bonus[k]<0)return fail('INVALID_REINCARNATION_BONUS');
    after[k]=base[k]+bonus[k];if(!Number.isFinite(after[k]))return fail('INVALID_REINCARNATION_BONUS');improved||=bonus[k]>0;}
  if(!improved)return fail('REINCARNATION_MUST_IMPROVE_LEVEL_ONE');
  return {policyVersion:policy.version,previousCycleTotalXp:input.totalXp,baselineLevelOneStats:{...base},afterLevelOneStats:after,next:{level:1,maxLevel:rosterMaxLevel(cycle),totalXp:0,reincarnation:cycle,permanentBonusStats:{...bonus}}};
}
export type RebirthUnit={id:string;speciesId:string;totalXp:bigint;reincarnation:number;skillInheritanceJson:string|null;status:string;locked:boolean};
export type RebirthCharacter={id:string;name:string;rarity:string;levelOneStats:FiveStats;growth:GrowthPoint[];reincarnationXpPolicy?:ReincarnationXpPolicy;suitability:unknown;defense:unknown};
/**
 * 개체 하나의 환생 계획(원본 RosterReincarnation.plan). 첫 성공은 계정마다 1번 무료, 그 뒤 땅콩 cost개.
 * 지문은 공개 값만으로 만든다(숨은 방어 표를 맞혀 보는 수단이 되지 않게: publicSafe로 방어 표를 뺀 미리보기).
 */
export function rebirthPlan(c:{version:string;statSchema:string;rebirthPolicy?:string},u:RebirthUnit,d:RebirthCharacter,successes:number,cost:number,publicSafe:(v:unknown)=>unknown){
  if(u.reincarnation>=5)return fail('REINCARNATION_LIMIT');
  if(u.status!=='AVAILABLE'||u.locked)return fail('UNIT_UNAVAILABLE');
  if(c.statSchema==='gmm-five-stats-v1'&&c.rebirthPolicy!==fiveRebirthPolicy)return fail('FIVE_STAT_REBIRTH_POLICY_PENDING');
  const base=d.levelOneStats;if(!base)return fail('LEVEL_ONE_BASE_STATS_REQUIRED');
  if(base.mp!==d.growth[0].maxMp)return fail('BASE_MP_MISMATCH');
  if(u.totalXp<0n||u.totalXp>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_XP');
  const before=growthAt(Number(u.totalXp),d.growth,u.reincarnation,d.reincarnationXpPolicy);
  const after=fiveRebirthStats(base,base,u.reincarnation+1);
  const preview={beforeLevel:before.level,...previewReincarnation({totalXp:Number(u.totalXp),reincarnation:u.reincarnation,baseLevelOneStats:base,curve:d.growth},
    {approved:true,version:fiveRebirthPolicy,bonusFor:()=>Object.fromEntries(Object.keys(base).map(k=>[k,after[k as keyof FiveStats]-base[k as keyof FiveStats]]))}),suitability:structuredClone(d.suitability),defense:structuredClone(d.defense)};
  const requiredLevel=requiredReincarnationLevel(u.reincarnation);
  let reason='';
  if(!rebirthGradePolicy.grades.includes(d.rarity))reason='REINCARNATION_GRADE_NOT_ALLOWED';
  else if(before.level<requiredLevel)reason='REINCARNATION_REQUIREMENTS_NOT_MET';
  const fingerprint=createHash('sha256').update(JSON.stringify([c.version,u.id,u.speciesId,u.totalXp.toString(),u.reincarnation,u.skillInheritanceJson,successes,cost,rebirthGradePolicy,requiredLevel,publicSafe(preview)])).digest('hex');
  return {ownedId:u.id,speciesId:u.speciesId,name:d.name,catalogVersion:c.version,eligible:!reason,reason,requiredLevel,preview,costPeanut:cost,accountFreeAvailable:successes===0,successes,previewFingerprint:fingerprint};
}
