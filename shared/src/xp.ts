// 개체 경험치: 상한까지만 지급(넘는 양은 버림), PvE 경험치 속도 조절(xpPacing), 화면용 진행 표시.
// 출처: GMM110 src/progression/normal-xp.ts normalXpGrant(), unit-xp-pacing.ts, xp-progress.ts (커밋 0b0fb8b5).
import {fail} from './errors.js';
import {growthAt,instanceGrowthCurve,rosterMaxLevel,type GrowthPoint,type ReincarnationXpPolicy} from './rules.js';
import type {BattleState} from './battle.js';

export type UnitXpPacing={approved:true;version:string;catalogVersion:string;winsPerLevel:2;difficulty:'owned-level-capped-by-enemy';distribution:'equal-actually-entered';existingRewards:'keep-higher';capOverflow:'discard-overflow'};
export type PacingMember={ownedId:string;playerId:string;startingXp:string;growth:GrowthPoint[];reincarnation:number;reincarnationXpPolicy?:ReincarnationXpPolicy};
export type PacedBattleXpPlan={version:'paced-battle-xp-v1';battleId:string;playerId:string;policy:UnitXpPacing;enemyLevel:number;sourceWinXp:number;sourceLossXp:number;baseline:'total'|'per-entered';reserveHalf:boolean;recipientMode?:'initial-owned'|'entered';requireSurvivor?:boolean;members:PacingMember[]};
type Grown=Pick<PacingMember,'startingXp'|'growth'|'reincarnation'|'reincarnationXpPolicy'>;

const safeXp=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=2_000_000_000;
const amount=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=2_000_000_000;
const level=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=1&&Number(n)<=99;
const pacingFail=(code='UNIT_XP_PACING_INVALID'):never=>fail(code);

/** 상한(환생 전 60·환생 뒤 99)까지만 더하고 넘는 양은 버림. 보관·자동 환생 없음(원본 확정 규칙). */
export function grantXp(member:Grown,requestedXp:number){
  if(!safeXp(requestedXp)||!/^\d+$/.test(member.startingXp))return fail('NORMAL_XP_SNAPSHOT_INVALID');
  const start=BigInt(member.startingXp);if(start>BigInt(Number.MAX_SAFE_INTEGER))return fail('NORMAL_XP_SNAPSHOT_INVALID');
  growthAt(Number(start),member.growth,member.reincarnation,member.reincarnationXpPolicy);
  const curve=instanceGrowthCurve(member.growth,member.reincarnation,member.reincarnationXpPolicy),maximum=rosterMaxLevel(member.reincarnation);
  if(curve.length<maximum)return fail('NORMAL_XP_GROWTH_INCOMPLETE');
  const cap=BigInt(curve[maximum-1].totalXp),next=start+BigInt(requestedXp),ending=next>cap?cap:next;
  const appliedXp=Number(ending-start);if(appliedXp<0)return fail('NORMAL_XP_SNAPSHOT_INVALID');
  growthAt(Number(ending),member.growth,member.reincarnation,member.reincarnationXpPolicy);
  return {requestedXp,appliedXp,deferredXp:0,endingXp:ending.toString(),status:appliedXp<requestedXp?'CAP_CLAMPED':'APPLIED'};
}
export function validateUnitXpPacing(raw:unknown,catalogVersion:string):UnitXpPacing{
  const p=raw as UnitXpPacing;const keys=['approved','version','catalogVersion','winsPerLevel','difficulty','distribution','existingRewards','capOverflow'];
  if(!p||Array.isArray(p)||Object.keys(p).sort().join()!==keys.sort().join()||p.approved!==true||typeof p.version!=='string'||!p.version||p.catalogVersion!==catalogVersion||p.winsPerLevel!==2||p.difficulty!=='owned-level-capped-by-enemy'||p.distribution!=='equal-actually-entered'||p.existingRewards!=='keep-higher'||p.capOverflow!=='discard-overflow')return pacingFail();
  return p;
}
/**
 * 한 번 이길 때 받을 양 = (난이도 레벨에서 다음 레벨까지 필요량) ÷ 2(올림). 즉 "두 번 이기면 한 레벨".
 * 난이도 레벨 = min(내 레벨, 상대 레벨). 상한 레벨이면 0.
 */
export function pacedUnitWin(member:Grown,enemyLevel:number,policy:UnitXpPacing,nearestTierMinimum?:number){
  validateUnitXpPacing(policy,policy.catalogVersion);if(!level(enemyLevel)||nearestTierMinimum!==undefined&&!level(nearestTierMinimum))return pacingFail();
  const grown=growthAt(Number(member.startingXp),member.growth,member.reincarnation,member.reincarnationXpPolicy);
  if(grown.level===grown.maxLevel)return 0;
  const difficulty=nearestTierMinimum!==undefined&&enemyLevel>=nearestTierMinimum?grown.level:Math.min(grown.level,enemyLevel);
  const curve=instanceGrowthCurve(member.growth,member.reincarnation,member.reincarnationXpPolicy);
  if(curve.length<rosterMaxLevel(member.reincarnation)||!curve[difficulty])return pacingFail();
  return Math.ceil((curve[difficulty].totalXp-curve[difficulty-1].totalXp)/policy.winsPerLevel);
}
/** 보상 묶음 = max(원래 보상, 가장 큰 1승 보상 × 인원). */
export function pacedPool(members:(Grown&{nearestTierMinimum?:number})[],enemyLevel:number,legacyPool:number,policy:UnitXpPacing){
  if(!amount(legacyPool)||!members.length)return pacingFail();
  const floor=Math.max(...members.map(m=>pacedUnitWin(m,enemyLevel,policy,m.nearestTierMinimum)))*members.length;
  const total=Math.max(legacyPool,floor);if(!amount(total))return pacingFail();return total;
}
export function createPacedBattleXpPlan(input:Omit<PacedBattleXpPlan,'version'>):PacedBattleXpPlan{
  validateUnitXpPacing(input.policy,input.policy.catalogVersion);
  if(!input.battleId||!input.playerId||!level(input.enemyLevel)||!amount(input.sourceWinXp)||!amount(input.sourceLossXp)||input.sourceLossXp>input.sourceWinXp||!['total','per-entered'].includes(input.baseline)||typeof input.reserveHalf!=='boolean'||input.recipientMode!==undefined&&!['initial-owned','entered'].includes(input.recipientMode)||input.requireSurvivor!==undefined&&typeof input.requireSurvivor!=='boolean'||!input.members.length||input.members.length>6||new Set(input.members.map(m=>m.ownedId)).size!==input.members.length)return pacingFail();
  for(const m of input.members){if(!m.ownedId||m.playerId!==input.playerId||m.ownedId.startsWith('AI:'))return pacingFail();grantXp(m,0);}
  pacedPool(input.members,input.enemyLevel,input.sourceWinXp*(input.baseline==='per-entered'?input.members.length:1),input.policy);
  return {version:'paced-battle-xp-v1',...structuredClone(input)};
}
/** 끝난 전투의 경험치 분배. 항복은 0, 패배는 (승리 묶음 × 원래 패배/승리 비율). 나머지는 ownedId 순으로 1씩. */
export function calculatePacedBattleXp(plan:PacedBattleXpPlan,startOwnedId:string,state:Pick<BattleState,'participation'|'rounds'|'fighters'|'reserves'|'outcome'|'surrendered'>,effectiveStartingXp?:Record<string,string>){
  const allowed=new Set(plan.members.map(m=>m.ownedId)),entered=new Set([startOwnedId,...state.participation.map(p=>p.ownedId)]);
  for(const round of state.rounds)for(const e of round.events as {actor?:string;kind?:string;to?:string}[])if(e.actor==='self'&&['switch','forced-switch'].includes(e.kind??'')&&e.to)entered.add(e.to);
  if([...entered].some(id=>!allowed.has(id)))return pacingFail('UNIT_XP_PACING_PARTICIPATION_INVALID');
  if(plan.recipientMode==='initial-owned'){entered.clear();entered.add(startOwnedId);}
  const ids=[...entered].sort(),members=ids.map(id=>plan.members.find(m=>m.ownedId===id)!);
  const alive=[state.fighters[0],...state.reserves].some(f=>f.hp>0),win=state.outcome==='win'&&!state.surrendered&&(!plan.requireSurvivor||alive),loss=state.outcome==='loss'&&!state.surrendered;
  const legacy=plan.sourceWinXp*(plan.baseline==='per-entered'?ids.length:1),winPool=pacedPool(members,plan.enemyLevel,legacy,plan.policy);
  const total=win?winPool:loss&&plan.sourceWinXp>0?Number(BigInt(winPool)*BigInt(plan.sourceLossXp)/BigInt(plan.sourceWinXp)):0;
  const each=Math.floor(total/ids.length),remainder=total%ids.length,shares=new Map(ids.map((id,index)=>[id,each+(index<remainder?1:0)]));
  const result={policyVersion:plan.policy.version,requestedXp:total,xpAccepted:0,xpDiscarded:0,xpDeferred:0 as const,xpByOwnedId:{} as Record<string,number>,requestedXpByOwnedId:{} as Record<string,number>,units:[] as {ownedId:string;startingXp:string;endingXp:string;requestedXp:number;appliedXp:number;discardedXp:number;status:string}[]};
  for(const member of plan.members){
    const requestedXp=shares.get(member.ownedId)??(win&&plan.reserveHalf?Math.floor(plan.sourceWinXp/2):0),start=effectiveStartingXp?.[member.ownedId]??member.startingXp,grant=grantXp({...member,startingXp:start},requestedXp),discardedXp=grant.requestedXp-grant.appliedXp;
    result.xpAccepted+=grant.appliedXp;result.xpDiscarded+=discardedXp;result.xpByOwnedId[member.ownedId]=grant.appliedXp;result.requestedXpByOwnedId[member.ownedId]=requestedXp;
    result.units.push({ownedId:member.ownedId,startingXp:start,endingXp:grant.endingXp,requestedXp,appliedXp:grant.appliedXp,discardedXp,status:requestedXp?grant.status:entered.has(member.ownedId)?grant.status:'NOT_ENTERED'});
  }
  result.requestedXp=Object.values(result.requestedXpByOwnedId).reduce((a,b)=>a+b,0);return result;
}
export type XpProgressPoint={level:number;totalXp:string;levelStartTotalXp:string;nextLevelTotalXp:string|null;maxLevel:number};
/** 화면 표시용: 정산 전후 레벨·막대 위치. 계산할 수 없으면 undefined. */
export function unitXpProgress(member:Grown,endingXp:string,startingXp=member.startingXp):{before:XpProgressPoint;after:XpProgressPoint}|undefined{
  try{
    const point=(value:string):XpProgressPoint=>{
      if(!/^\d+$/.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('UNAVAILABLE_XP_PROGRESS');
      const g=growthAt(Number(value),member.growth,member.reincarnation,member.reincarnationXpPolicy);
      if(g.xpToNext===null&&g.level<g.maxLevel)throw Error('INCOMPLETE_XP_PROGRESS');
      return {level:g.level,totalXp:g.totalXp.toString(),levelStartTotalXp:(g.totalXp-g.xp).toString(),nextLevelTotalXp:g.xpToNext===null?null:(g.totalXp+g.xpToNext).toString(),maxLevel:g.maxLevel};
    };
    return {before:point(startingXp),after:point(endingXp)};
  }catch{return undefined;}
}
