// 다섯 능력치 전투 계산: 피해, 상태 이상 확률, 행동 순서.
// 출처: GMM110 src/battle/roster60-five-combat.ts, roster60-five-stats.ts (커밋 0b0fb8b5). 계산은 바꾸지 않고 옮김.
import {sha256} from './hash.js';
import {fail} from './errors.js';
import {resolveElementDamage,type Defense} from './rules.js';

export type FiveCombatPolicy={model:'linear-level-hyperbolic-v1';version:string;levelSlope:number;durabilityScale:number;resistanceScale:number};
export const fiveStatSchema='gmm-five-stats-v1' as const;
export const fiveStatKeys=['hp','mp','durability','statusResistance','speed'] as const;
export type FiveStats=Record<typeof fiveStatKeys[number],number>;

function nonnegative(n:number,label:string){if(!Number.isFinite(n)||n<0)fail(`INVALID_${label}`);}
export function validateFiveCombatPolicy(p:FiveCombatPolicy){
  if(!p||typeof p.version!=='string'||!p.version.trim())fail('FIVE_COMBAT_POLICY_REQUIRED');
  if(p.model!=='linear-level-hyperbolic-v1')fail('FIVE_COMBAT_MODEL_REQUIRED');
  nonnegative(p.levelSlope,'LEVEL_SLOPE');
  for(const k of ['durabilityScale','resistanceScale'] as const)if(!Number.isFinite(p[k])||p[k]<=0)fail(`INVALID_${k}`);
}
export function validateFiveStats(value:unknown):asserts value is FiveStats{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('FIVE_STATS_REQUIRED');
  const stats=value as Record<string,unknown>;
  if(Object.keys(stats).sort().join()!==[...fiveStatKeys].sort().join())fail('FIVE_STATS_REQUIRED');
  for(const key of fiveStatKeys)if(!Number.isSafeInteger(stats[key])||(stats[key] as number)<(key==='hp'?1:0))fail('INVALID_FIVE_STATS');
}
/**
 * 피해 = 위력 × (1 + 레벨기울기×(레벨−1)) × 1/(1 + 내구/내구척도), 그다음 속성 처리(rules.resolveElementDamage).
 * 시험 프로필 값: 레벨기울기 0.025, 내구척도 50.
 */
export function fiveStatAttack(input:{power:number;level:number;durability:number;suitability:number;defense:Defense;attackerHp:number;defenderHp:number},p:FiveCombatPolicy,reflectionDamage?:(baseDamage:number,suitabilityMultiplier:number)=>number){
  validateFiveCombatPolicy(p);nonnegative(input.power,'POWER');nonnegative(input.durability,'DURABILITY');
  if(!Number.isInteger(input.level)||input.level<1||input.level>99)fail('INVALID_LEVEL');
  const levelMultiplier=1+p.levelSlope*(input.level-1);
  const durabilityMultiplier=1/(1+input.durability/p.durabilityScale);
  const baseDamage=input.power*levelMultiplier*durabilityMultiplier;
  if(!Number.isFinite(baseDamage))fail('INVALID_BASE_DAMAGE');
  if(input.defense==='reflect'&&!reflectionDamage)fail('REFLECTION_POLICY_REQUIRED');
  return {...resolveElementDamage({...input,baseDamage},reflectionDamage),levelMultiplier,durabilityMultiplier,policyVersion:p.version};
}
/** 상태 이상 확률 = 기본 확률 ÷ (1 + 상태저항/저항척도). 지속 시간은 정하지 않음(원본과 같음). */
export function statusChance(baseChance:number,resistance:number,p:FiveCombatPolicy){
  validateFiveCombatPolicy(p);nonnegative(resistance,'STATUS_RESISTANCE');
  if(!Number.isFinite(baseChance)||baseChance<0||baseChance>1)fail('INVALID_STATUS_CHANCE');
  return baseChance/(1+resistance/p.resistanceScale);
}
export type TurnOrderDecision={version:'five-speed-v1';battleId:string;turn:number;fighters:[string,string];speeds:[number,number];order:[string,string];tie:boolean};
/** 행동 순서: 속도가 높은 쪽 먼저. 같으면 서버 씨앗 해시로 정함(같은 입력이면 항상 같은 결과). */
export function decideTurnOrder(battleId:string,turn:number,fighters:[{id:string;baseSpeed:number;modifiers:readonly number[]},{id:string;baseSpeed:number;modifiers:readonly number[]}],serverSeed:string):TurnOrderDecision{
  if(!battleId||!serverSeed||!Number.isSafeInteger(turn)||turn<0||!fighters[0].id||!fighters[1].id||fighters[0].id===fighters[1].id)fail('INVALID_TURN_IDENTITY');
  const sorted=[...fighters].sort((a,b)=>a.id.localeCompare(b.id));
  const speeds=sorted.map(f=>{
    nonnegative(f.baseSpeed,'SPEED');if(!f.modifiers.every(Number.isFinite))fail('INVALID_SPEED_MODIFIER');
    const v=f.modifiers.reduce((a,b)=>a+b,f.baseSpeed);if(!Number.isFinite(v))fail('INVALID_FINAL_SPEED');return Math.max(0,v);
  }) as [number,number];
  const tie=speeds[0]===speeds[1];
  const first=tie?sha256(JSON.stringify([serverSeed,battleId,turn,sorted.map(f=>f.id)]))[0]%2:speeds[0]>speeds[1]?0:1;
  return {version:'five-speed-v1',battleId,turn,fighters:[sorted[0].id,sorted[1].id],speeds,order:[sorted[first].id,sorted[1-first].id],tie};
}
export function reuseTurnOrder(saved:TurnOrderDecision,battleId:string,turn:number){
  if(saved.version!=='five-speed-v1'||saved.battleId!==battleId||saved.turn!==turn)fail('TURN_DECISION_MISMATCH');
  return structuredClone(saved);
}
export const fiveRebirthPolicy='hp-mp-durability-additive-v1';
/** 환생 보너스: 원래 Lv1 기본값의 10%×환생 횟수(반올림)를 체력·MP·내구에 더함. 최대 5회. */
export function fiveRebirthStats(base:FiveStats,levelStats:FiveStats,cycle:number):FiveStats{
  validateFiveStats(base);validateFiveStats(levelStats);
  if(!Number.isInteger(cycle)||cycle<0||cycle>5)fail('REINCARNATION_LIMIT');
  const result={...levelStats};
  for(const k of ['hp','mp','durability'] as const){
    const bonus=Number((BigInt(base[k])*BigInt(cycle*10)+50n)/100n);
    result[k]+=bonus;
  }
  validateFiveStats(result);return result;
}
/** 환생에 필요한 레벨(지금까지 환생 횟수 기준): 60, 70, 80, 90, 99. */
export function requiredReincarnationLevel(currentCount:number){
  if(!Number.isInteger(currentCount)||currentCount<0||currentCount>=5)fail('REINCARNATION_LIMIT');
  return [60,70,80,90,99][currentCount];
}
