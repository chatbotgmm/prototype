// 60종 기본 규칙: 기술 속성, 방어 상성, 레벨·경험치, MP, 속성 피해 처리.
// 출처: GMM110 src/battle/roster60-rules.ts (커밋 0b0fb8b5). 계산은 바꾸지 않고 옮김.
import {fail} from './errors.js';

export const skillElements=['NORMAL','FIRE','WATER','LIGHTNING','ICE','NATURE','HOLY','DARK'] as const;
export type SkillElement=typeof skillElements[number];
export type Defense='weak'|'normal'|'resist'|'immune'|'reflect';
export type ElementProfile<T>=Record<SkillElement,T>;
export type SkillDefinition={id:string;name:string;element:SkillElement;mpCost:number;power?:number;learnLevel?:number};
export type ReincarnationXpPolicy={earlyRequiredPercent:number;throughLevel:number};
export type GrowthPoint={totalXp:number;maxMp:number};
export type RosterDefinition={
  id:string;name:string;skills:SkillDefinition[];attack:SkillDefinition;
  suitability:ElementProfile<number>;defense:ElementProfile<Defense>;growth:GrowthPoint[];reincarnationXpPolicy?:ReincarnationXpPolicy;
};

// 원본에 "확정"으로 표시: 환생 뒤 목표 레벨 2~60은 필요 경험치 70%, 61~99는 100%.
export const confirmedReincarnationXpPolicy:Readonly<ReincarnationXpPolicy>=Object.freeze({earlyRequiredPercent:70,throughLevel:60});

function integer(n:number,label:string){if(!Number.isSafeInteger(n)||n<0)fail(`INVALID_${label}`);}
function finite(n:number,label:string){if(!Number.isFinite(n))fail(`INVALID_${label}`);}

/** 레벨 상한: 환생 전 60, 환생 뒤 99. */
export function rosterMaxLevel(reincarnation=0):60|99{integer(reincarnation,'REINCARNATION');return reincarnation>0?99:60;}
export function validateRosterLevel(level:number,reincarnation=0){
  integer(level,'LEVEL');if(level<1||level>rosterMaxLevel(reincarnation))fail('LEVEL_CAP_EXCEEDED');
}
export function validateGrowth(curve:readonly GrowthPoint[]){
  if(!curve.length||curve.length>99||curve[0].totalXp!==0)fail('INVALID_GROWTH_ORIGIN');
  curve.forEach((p,i)=>{
    integer(p.totalXp,'XP');integer(p.maxMp,'MAX_MP');
    if(i&&(p.totalXp<=curve[i-1].totalXp||p.maxMp<curve[i-1].maxMp))fail('INVALID_GROWTH_ORDER');
  });
}
export function validateRosterDefinition(unit:RosterDefinition){
  if(!/^u(0[1-9]|[1-5][0-9]|60)$/.test(unit.id)||!unit.name.trim())fail('INVALID_ROSTER_ID_OR_NAME');
  if(unit.id==='u01'&&unit.name!=='갈매미맨')fail('INVALID_U01_NAME');
  if('attr' in unit||'element' in unit||'extraAttr' in unit)fail('CREATURE_ELEMENT_REMOVED');
  if(unit.skills.length>6)fail('TOO_MANY_SKILLS');
  if(new Set(unit.skills.map(s=>s.id)).size!==unit.skills.length)fail('DUPLICATE_SKILL');
  for(const skill of [unit.attack,...unit.skills]){
    if(!skill.id||!skill.name||!skillElements.includes(skill.element))fail('INVALID_SKILL');
    integer(skill.mpCost,'MP_COST');
  }
  for(const profile of [unit.suitability,unit.defense]){
    if(Object.keys(profile).sort().join()!==[...skillElements].sort().join())fail('INVALID_ELEMENT_PROFILE');
  }
  for(const element of skillElements){
    finite(unit.suitability[element],'SUITABILITY');
    if(!['weak','normal','resist','immune','reflect'].includes(unit.defense[element]))fail('INVALID_DEFENSE');
  }
  validateGrowth(unit.growth);
}
/** 환생한 개체의 성장 곡선: 필요 경험치만 깎고(레벨마다 올림), 이미 얻은 경험치는 그대로. */
export function instanceGrowthCurve(curve:readonly GrowthPoint[],reincarnation=0,policy?:ReincarnationXpPolicy):GrowthPoint[]{
  validateGrowth(curve);rosterMaxLevel(reincarnation);
  if(!reincarnation)return curve.map(p=>({...p}));
  policy??=confirmedReincarnationXpPolicy;
  if(!Number.isSafeInteger(policy.earlyRequiredPercent)||policy.earlyRequiredPercent<1||policy.earlyRequiredPercent>100||!Number.isSafeInteger(policy.throughLevel)||policy.throughLevel<2||policy.throughLevel>99)fail('INVALID_REINCARNATION_XP_POLICY');
  let totalXp=0;
  return curve.map((p,i)=>{
    if(i){const delta=BigInt(p.totalXp-curve[i-1].totalXp),percent=i<policy!.throughLevel?policy!.earlyRequiredPercent:100;
      totalXp+=Number((delta*BigInt(percent)+99n)/100n);}
    return {totalXp,maxMp:p.maxMp};
  });
}
/** 누적 경험치 → 레벨·다음 레벨까지 남은 양·최대 MP. 상한을 넘는 경험치는 정책 없이는 거절. */
export function growthAt(totalXp:number,curve:readonly GrowthPoint[],reincarnation=0,policy?:ReincarnationXpPolicy){
  curve=instanceGrowthCurve(curve,reincarnation,policy);
  integer(totalXp,'XP');validateGrowth(curve);
  const maxLevel=rosterMaxLevel(reincarnation);
  if(curve.length>=maxLevel&&totalXp>curve[maxLevel-1].totalXp)fail('CAP_XP_POLICY_REQUIRED');
  let index=0;
  while(index+1<Math.min(curve.length,maxLevel)&&curve[index+1].totalXp<=totalXp)index++;
  return {level:index+1,maxLevel,reincarnation,totalXp,xp:totalXp-curve[index].totalXp,maxMp:curve[index].maxMp,
    xpToNext:index+1<Math.min(curve.length,maxLevel)?curve[index+1].totalXp-totalXp:null};
}
/** 조합 결과의 경험치: 재료 누적 경험치의 평균(내림). */
export function combinationGrowth(materialTotalXp:readonly number[],curve:readonly GrowthPoint[]){
  if(!materialTotalXp.length)fail('MATERIALS_REQUIRED');
  let sum=0n;
  for(const xp of materialTotalXp){integer(xp,'XP');sum+=BigInt(xp);}
  return growthAt(Number(sum/BigInt(materialTotalXp.length)),curve);
}
export function startMp(totalXp:number,curve:readonly GrowthPoint[],reincarnation=0,policy?:ReincarnationXpPolicy){
  const {maxMp}=growthAt(totalXp,curve,reincarnation,policy);return {mp:maxMp,maxMp};
}
/** 집중: 최대 MP의 50%(내림)만큼 회복, 최대치를 넘지 않음(원본에 "확정"으로 표시). */
export function focusMp(mp:number,maxMp:number){
  integer(mp,'MP');integer(maxMp,'MAX_MP');if(mp>maxMp)fail('MP_EXCEEDS_MAX');
  const recovered=Math.min(maxMp-mp,Math.floor(maxMp/2));
  return {mp:mp+recovered,recovered};
}
export function spendMp(mp:number,cost:number){
  integer(mp,'MP');integer(cost,'MP_COST');if(cost>mp)fail('INSUFFICIENT_MP');return mp-cost;
}
/**
 * 속성 피해 처리. 적합도 배율 = max(0, 1 + 적합도×0.1).
 * 약점 ×1.5, 보통 ×1, 저항 ×0.5, 무효 0, 반사는 공격자에게(반사 계산은 넘겨받은 함수).
 * 피해는 내림이고, 대상의 남은 체력을 넘지 않음.
 */
export function resolveElementDamage(input:{baseDamage:number;suitability:number;defense:Defense;attackerHp:number;defenderHp:number},
  reflectionDamage?:(baseDamage:number,suitabilityMultiplier:number)=>number){
  const {baseDamage,suitability,defense,attackerHp,defenderHp}=input;
  finite(baseDamage,'BASE_DAMAGE');finite(suitability,'SUITABILITY');
  integer(attackerHp,'HP');integer(defenderHp,'HP');
  if(baseDamage<0)fail('INVALID_BASE_DAMAGE');
  const multiplier=Math.max(0,1+suitability*.1);
  let raw:number;
  switch(defense){
    case 'immune':raw=0;break;
    case 'reflect':
      if(!reflectionDamage)return fail('REFLECTION_POLICY_REQUIRED');
      raw=reflectionDamage(baseDamage,multiplier);break;
    case 'weak':case 'normal':case 'resist':
      raw=baseDamage*multiplier*({weak:1.5,normal:1,resist:.5}[defense]);break;
    default:return fail('INVALID_DEFENSE');
  }
  finite(raw,'RESOLVED_DAMAGE');if(raw<0)fail('INVALID_RESOLVED_DAMAGE');
  const target=defense==='reflect'?'attacker' as const:'defender' as const;
  return {target,damage:Math.min(target==='attacker'?attackerHp:defenderHp,Math.floor(raw)),
    suitabilityMultiplier:multiplier,defense,extraTurn:false as const,
    reflected:defense==='reflect',canReflectAgain:false as const};
}
