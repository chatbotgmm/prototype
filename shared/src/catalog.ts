// 60종 카탈로그 형식과 전투 개체(Fighter) 만들기, 장착 기술(조합 기술 계승 반영).
// 출처: GMM110 src/roster60-battle.ts fighter(), src/roster60-skill-inheritance.ts equippedSkills() (커밋 0b0fb8b5).
import {fail} from './errors.js';
import {skillElements,validateRosterDefinition,type Defense,type ElementProfile,type GrowthPoint,type ReincarnationXpPolicy,type SkillElement} from './rules.js';
import {fiveRebirthStats,validateFiveStats,type FiveCombatPolicy,type FiveStats} from './combat.js';

export type CatalogSkill={id:string;name:string;element:SkillElement;power:number;mpCost:number;learnLevel?:number};
export type CatalogUnit={
  id:string;name:string;rarity:string;role:string;
  stats:FiveStats;levelOneStats:FiveStats;combatGrowth:FiveStats[];growth:GrowthPoint[];
  attack:CatalogSkill;skills:CatalogSkill[];
  suitability:ElementProfile<number>;defense:ElementProfile<Defense>;reincarnationXpPolicy?:ReincarnationXpPolicy;
};
export type Recipe={resultId:string;ingredients:{unitId:string;count:number;minLevel?:number}[];visibility:string};
export type Catalog={
  version:string;profileKind:string;approved:boolean;productionBalanceApproved:boolean;
  statSchema:'gmm-five-stats-v1';rebirthPolicy:string;combatPolicy:FiveCombatPolicy;
  characters:CatalogUnit[];recipes:Recipe[];skillLibrary:unknown;notes:string[];
};
export type Skill={id:string;name:string;element:SkillElement;mpCost:number;power:number;learnLevel?:number};
export type Fighter={ownedId?:string;id:string;speciesId:string;name:string;level:number;stats:FiveStats;hp:number;mp:number;attack:Skill;skills:Skill[];suitability:ElementProfile<number>;defense:ElementProfile<Defense>};

export const skillInheritanceVersion='roster60-skill-inheritance-v1';
export type StoredSkillInheritance={version:typeof skillInheritanceVersion;replaceSlot:number;skillId:string;sourceSpeciesId:string;sourceSlot:number;requiredLevel:number;catalogVersion:string};
export type EquippedSkill={slot:number;skill:Skill;origin:{sourceSpeciesId:string;sourceSlot:number;requiredLevel:number}};

const isLevel=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=1&&Number(n)<=99;
const isSlot=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<6;

export function unitDefinition(c:Catalog,id:string,code='BATTLE_UNIT_DATA_PENDING'){
  const matches=c.characters.filter(u=>u.id===id);if(matches.length!==1)return fail(code);
  return matches[0];
}
function checkedSkill(value:CatalogSkill):Skill{
  if(!value.id||!value.name||!skillElements.includes(value.element)||!Number.isSafeInteger(value.mpCost)||value.mpCost<0||!Number.isFinite(value.power)||value.power<0||!isLevel(value.learnLevel??1)||'effects' in value||'priority' in value)return fail('INHERITANCE_SKILL_POLICY_INVALID');
  return {...value,learnLevel:value.learnLevel??1};
}
export function readSkillInheritance(raw?:string|null):StoredSkillInheritance|null{
  if(raw==null)return null;
  let data:any;try{data=JSON.parse(raw);}catch{return fail('INHERITANCE_STATE_INVALID');}
  const keys=['version','replaceSlot','skillId','sourceSpeciesId','sourceSlot','requiredLevel','catalogVersion'];
  if(!data||Array.isArray(data)||Object.keys(data).length!==keys.length||Object.keys(data).some(k=>!keys.includes(k))||data.version!==skillInheritanceVersion||!isSlot(data.replaceSlot)||!isSlot(data.sourceSlot)||typeof data.skillId!=='string'||!data.skillId||typeof data.sourceSpeciesId!=='string'||!isLevel(data.requiredLevel)||typeof data.catalogVersion!=='string'||!data.catalogVersion)return fail('INHERITANCE_STATE_INVALID');
  return data;
}
/** 종 기본 기술 + (있으면) 조합으로 물려받은 기술 한 칸. 물려받은 기술의 필요 레벨은 원래 필요 레벨보다 낮아지지 않음. */
export function equippedSkills(c:Catalog,speciesId:string,raw?:string|null):EquippedSkill[]{
  const unit=unitDefinition(c,speciesId,'INHERITANCE_CATALOG_INVALID');
  try{validateRosterDefinition(unit);}catch{fail('INHERITANCE_CATALOG_INVALID');}
  const entries=unit.skills.map((value,index)=>{const s=checkedSkill(value);return {slot:index,skill:s,origin:{sourceSpeciesId:speciesId,sourceSlot:index,requiredLevel:s.learnLevel!}};});
  const inherited=readSkillInheritance(raw);if(!inherited)return entries;
  if(inherited.replaceSlot>=entries.length)return fail('INHERITANCE_STATE_INVALID');
  const origin=unitDefinition(c,inherited.sourceSpeciesId,'INHERITANCE_CATALOG_INVALID'),source=origin.skills[inherited.sourceSlot];
  if(!source||source.id!==inherited.skillId)return fail('INHERITANCE_SOURCE_CHANGED');
  const s=checkedSkill(source),requiredLevel=Math.max(inherited.requiredLevel,s.learnLevel!);
  entries[inherited.replaceSlot]={slot:inherited.replaceSlot,skill:{...s,learnLevel:requiredLevel},origin:{sourceSpeciesId:inherited.sourceSpeciesId,sourceSlot:inherited.sourceSlot,requiredLevel}};
  if(new Set(entries.map(e=>e.skill.id)).size!==entries.length)return fail('INHERITANCE_STATE_INVALID');
  return entries;
}
/** 전투 개체: 그 레벨의 능력치 표(+환생 보너스), 체력·MP 가득, 해금된 기술만. */
export function makeFighter(c:Catalog,speciesId:string,level:number,id:string,cycle=0,skillInheritanceJson?:string|null):Fighter{
  const u=unitDefinition(c,speciesId);
  try{validateRosterDefinition(u);}catch{fail('BATTLE_UNIT_DATA_INVALID');}
  const stats=u.combatGrowth?.[level-1];
  try{validateFiveStats(stats);}catch{fail('BATTLE_GROWTH_PENDING');}
  if(stats!.mp!==u.growth[level-1]?.maxMp)fail('BATTLE_MP_GROWTH_MISMATCH');
  const skills=equippedSkills(c,speciesId,skillInheritanceJson).map(e=>e.skill);
  for(const sk of [u.attack,...skills]){
    if(!Number.isFinite(sk.power)||sk.power<0||'effects' in sk||'priority' in sk)fail('BATTLE_SKILL_POLICY_PENDING');
  }
  const final=fiveRebirthStats(u.levelOneStats??stats!,stats!,cycle);
  return {id,speciesId,name:u.name,level,stats:final,hp:final.hp,mp:final.mp,attack:structuredClone(u.attack),
    skills:structuredClone(skills.filter(s=>(s.learnLevel??1)<=level)),suitability:structuredClone(u.suitability),defense:structuredClone(u.defense)};
}
