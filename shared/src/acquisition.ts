// 획득 규칙: 첫 갈매미 선택지, 모집(확률표·후보·지급 레벨), 조합(재료 검사·결과 성장·기술 계승·미리보기 지문), 조합 선택지, 보유 개체 상세.
// 출처: GMM110(커밋 0b0fb8b5) src/roster60-onboarding.ts, roster60-recruit-session.ts, roster60-library.ts,
//       roster60-craft.ts, roster60-skill-inheritance.ts, roster60-owned.ts. 계산·오류 코드는 그대로, DB 부분만 뺐어요.
import {sha256} from './hash.js';
import {fail} from './errors.js';
import {combinationGrowth,growthAt,rosterMaxLevel,validateRosterDefinition} from './rules.js';
import {fiveStatKeys,type FiveStats} from './combat.js';
import {equippedSkills,makeFighter,readSkillInheritance,skillInheritanceVersion,unitDefinition,type Catalog,type CatalogUnit,type Skill,type StoredSkillInheritance} from './catalog.js';

// ── 첫 갈매미: 갈매미맨(u01)을 뺀 커먼 7종 중 하나(원본 commonChoices)
export const commonChoices=['u02','u03','u04','u05','u06','u07','u08'] as const;
export const rosterGrades={COMMON:'커먼',UNCOMMON:'언커먼',RARE:'레어',EPIC:'에픽',LEGEND:'전설',HIDDEN:'히든',LIMITED:'제한',TRANSCEND:'초월',IMMORTAL:'불멸',ETERNAL:'영원'} as const;

// ── 모집
/** 모집으로 들어올 때 레벨(원본에 "Approved grant levels"로 표시) */
export const recruitGrantLevels=Object.freeze({COMMON:1,UNCOMMON:1,RARE:10,EPIC:15,LEGEND:20,HIDDEN:20});
export type RecruitPolicy={version:string;offers:{kind:string;label:string;cost:number;weights:Record<string,number>}[];halfRounding:'ceil'|'floor'|null;pity:'none'|null};
export function recruitmentGrowth(unit:CatalogUnit){
  const level=recruitGrantLevels[unit.rarity as keyof typeof recruitGrantLevels];
  if(level===undefined)return fail('RECRUIT_LEVEL_POLICY_PENDING');
  const point=unit.growth?.[level-1];if(!point)return fail('RECRUIT_GROWTH_INVALID');
  try{const state=growthAt(point.totalXp,unit.growth);if(state.level!==level)throw Error('level');return state;}
  catch{return fail('RECRUIT_GROWTH_INVALID');}
}
/** 새로고침 비용 = 모집 비용의 절반(홀수면 정책의 올림/내림, 정책 없으면 거절) */
export function halfRecruitCost(cost:number,rounding:RecruitPolicy['halfRounding']){
  if(!Number.isSafeInteger(cost)||cost<=0)return fail('RECRUIT_POLICY_INVALID');
  if(cost%2&&!rounding)return fail('RECRUIT_ROUNDING_PENDING');
  return rounding==='floor'?Math.floor(cost/2):Math.ceil(cost/2);
}
/** 확률(%)을 1만 분율 정수 칸으로. 합이 정확히 10000이어야 함. */
export function recruitWeightTickets(weights:Record<string,number>):[string,number][]{
  if(!weights||typeof weights!=='object'||Array.isArray(weights))return fail('RECRUIT_POLICY_INVALID');
  const entries=Object.entries(weights).map(([g,w]):[string,number]=>{
    const scaled=w*100,tickets=Math.round(scaled);
    if(typeof w!=='number'||!Number.isFinite(w)||w<=0||w>100||!Number.isSafeInteger(tickets)||Math.abs(scaled-tickets)>1e-8)return fail('RECRUIT_POLICY_INVALID');
    return [g,tickets];
  });
  if(!entries.length||entries.reduce((s,[,n])=>s+n,0)!==10000)return fail('RECRUIT_POLICY_INVALID');
  return entries;
}
/** 모집 정책 검사(최신 모집풀: 중급에 커먼 없음, 고급에 커먼·언커먼 없음, 최상위 4등급 제외) */
export function validateRecruitPolicy(p:RecruitPolicy|null){
  if(!p||p.pity===null)return fail('RECRUIT_SESSION_POLICY_PENDING');
  if(p.pity!=='none'||!p.version||!Array.isArray(p.offers)||![null,'ceil','floor'].includes(p.halfRounding))return fail('RECRUIT_POLICY_INVALID');
  const allowed:Record<string,string[]>={LOW:['COMMON','UNCOMMON','RARE'],MID:['UNCOMMON','RARE','EPIC'],HIGH:['RARE','EPIC','LEGEND','HIDDEN']};
  if(new Set(p.offers.map(o=>o.kind)).size!==p.offers.length||p.offers.some(o=>!allowed[o.kind]||Object.keys(o.weights).some(g=>!allowed[o.kind].includes(g))))return fail('RECRUIT_POLICY_INVALID');
  for(const o of p.offers){halfRecruitCost(o.cost,p.halfRounding);recruitWeightTickets(o.weights);}
  return p;
}
export type RecruitCandidate={speciesId:string;name:string;rarity:string}&ReturnType<typeof recruitmentGrowth>;
/** 등급 굴림(0~9999) → 그 등급 후보 목록 → 후보 굴림. roll(max)는 0~max−1 정수(서버는 crypto.randomInt). */
export function drawRecruitCandidate(c:Catalog,weights:[string,number][],roll:(max:number)=>number){
  let n=roll(10000),grade=weights[0][0];
  for(const [g,w] of weights){if(n<w){grade=g;break;}n-=w;}
  const pool:RecruitCandidate[]=c.characters.filter(u=>u.rarity===grade).map(u=>({speciesId:u.id,name:u.name,rarity:u.rarity,...recruitmentGrowth(u)}));
  if(!pool.length)return fail('RECRUIT_POLICY_INVALID');
  return {candidate:pool[roll(pool.length)],pool};
}
/** 불합격 환급을 막는 이유(빈 문자열이면 환급 가능). 실제 낸 후보당 비용 증거가 있어야 하고, 2장 미만이면 이득이 생겨 막음. */
export function recruitRefundBlock(paidBaseCost:number|undefined){
  if(typeof paidBaseCost!=='number'||!Number.isSafeInteger(paidBaseCost))return 'PAYMENT_PROOF_UNAVAILABLE';
  if(paidBaseCost===0)return 'FREE_GENERATION';
  if(paidBaseCost<2)return 'REFUND_COST_TOO_LOW';
  return '';
}

// ── 조합 기술 계승
type DefinedSkill=Skill&{learnLevel?:number};
export type InheritanceChoice={skillId:string;replaceSlot:number};
export type InheritanceMaterial={id:string;speciesId:string;level:number;skillInheritanceJson?:string|null};
export type InheritanceCandidate={skillId:string;name:string;element:Skill['element'];mpCost:number;power:number;requiredLevel:number;source:{ownedId:string;speciesId:string;name:string;level:number;sourceSpeciesId:string;sourceName:string;sourceSlot:number;materialSkillSlot:number};allowedReplaceSlots:number[]};
const isSlot=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<6;
const definition=(c:Catalog,id:string)=>{const u=unitDefinition(c,id,'INHERITANCE_CATALOG_INVALID');try{validateRosterDefinition(u);}catch{fail('INHERITANCE_CATALOG_INVALID');}return u;};
function display(v:DefinedSkill){return {skillId:v.id,name:v.name,element:v.element,mpCost:v.mpCost,power:v.power,requiredLevel:v.learnLevel??1};}
/** 재료들이 지금 쓸 수 있는(해금된) 기술 중 하나를 결과의 한 칸과 바꿈. 일반 공격은 후보가 아님. */
export function inheritancePreview(c:Catalog,resultId:string,resultLevel:number,materials:InheritanceMaterial[],choice?:InheritanceChoice){
  const target=equippedSkills(c,resultId),resultSkillSlots=target.map(e=>({slot:e.slot,...display(e.skill),unlockedAtResultLevel:e.origin.requiredLevel<=resultLevel}));
  const sources=materials.flatMap(material=>equippedSkills(c,material.speciesId,material.skillInheritanceJson).filter(e=>e.origin.requiredLevel<=material.level).map(entry=>({material,entry})));
  sources.sort((a,b)=>a.entry.origin.requiredLevel-b.entry.origin.requiredLevel||a.material.id.localeCompare(b.material.id)||a.entry.slot-b.entry.slot);
  const candidates:InheritanceCandidate[]=[],seen=new Map<string,DefinedSkill>();
  for(const {material,entry} of sources){
    const prior=seen.get(entry.skill.id);
    if(prior){if(JSON.stringify(display({...prior,learnLevel:1}))!==JSON.stringify(display({...entry.skill,learnLevel:1})))return fail('INHERITANCE_SKILL_AMBIGUOUS');continue;}
    seen.set(entry.skill.id,entry.skill);
    const matching=target.filter(v=>v.skill.id===entry.skill.id).map(v=>v.slot);
    candidates.push({...display(entry.skill),source:{ownedId:material.id,speciesId:material.speciesId,name:definition(c,material.speciesId).name,level:material.level,sourceSpeciesId:entry.origin.sourceSpeciesId,sourceName:definition(c,entry.origin.sourceSpeciesId).name,sourceSlot:entry.origin.sourceSlot,materialSkillSlot:entry.slot},allowedReplaceSlots:matching.length?matching:target.map(v=>v.slot)});
  }
  if(!candidates.length||!target.length)return fail('INHERITANCE_POLICY_UNAVAILABLE');
  let selected=null,stored:StoredSkillInheritance|null=null;
  if(choice){
    if(typeof choice.skillId!=='string'||!isSlot(choice.replaceSlot))return fail('INVALID_INHERITANCE_SLOT');
    const candidate=candidates.find(v=>v.skillId===choice.skillId);if(!candidate)return fail('INVALID_INHERITANCE_SKILL');
    const replacedSkill=resultSkillSlots[choice.replaceSlot];if(!replacedSkill)return fail('INVALID_INHERITANCE_SLOT');
    if(!candidate.allowedReplaceSlots.includes(choice.replaceSlot))return fail('DUPLICATE_INHERITANCE_SKILL');
    selected={...candidate,replaceSlot:choice.replaceSlot,replacedSkill,unlockedAtResultLevel:candidate.requiredLevel<=resultLevel,kindUnchanged:replacedSkill.skillId===candidate.skillId,requiredLevelChanged:replacedSkill.requiredLevel!==candidate.requiredLevel};
    stored={version:skillInheritanceVersion,replaceSlot:choice.replaceSlot,skillId:candidate.skillId,sourceSpeciesId:candidate.source.sourceSpeciesId,sourceSlot:candidate.source.sourceSlot,requiredLevel:candidate.requiredLevel,catalogVersion:c.version};
    equippedSkills(c,resultId,JSON.stringify(stored));
  }
  return {view:{version:skillInheritanceVersion,status:selected?'selected' as const:'selection-required' as const,candidates,resultSkillSlots,selected},stored};
}

// ── 조합
export type CraftSelection={resultId:string;materialIds:string[];catalogVersion:string;inheritance?:InheritanceChoice};
export type OwnedRow={id:string;speciesId:string;totalXp:bigint;reincarnation:number;status:string;locked:boolean;skillInheritanceJson:string|null};
const hash=(v:unknown)=>sha256(JSON.stringify(v)).toString('hex');
const canonical=(b:CraftSelection)=>b.inheritance?[b.resultId,[...b.materialIds].sort(),b.catalogVersion,b.inheritance.skillId,b.inheritance.replaceSlot]:[b.resultId,[...b.materialIds].sort(),b.catalogVersion];
const storedXp=(v:bigint)=>{if(v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_STORED_XP');return Number(v);};
/** 조합 계획(미리보기·확인 공통). materials = 요청한 ID 중 서버가 찾은 "쓸 수 있는(AVAILABLE·잠금 아님)" 개체(ID 오름차순). */
export function craftPlan(c:Catalog,input:CraftSelection,materials:OwnedRow[]){
  if(!input.materialIds.length||input.materialIds.length>6||new Set(input.materialIds).size!==input.materialIds.length)return fail('INVALID_MATERIALS');
  if(c?.approved!==true||!Array.isArray(c.characters)||!Array.isArray(c.recipes))return fail('ROSTER_CATALOG_PENDING');
  if(c.version!==input.catalogVersion)return fail('CATALOG_CHANGED');
  const matching=c.recipes.filter(r=>r.resultId===input.resultId);if(matching.length!==1)return fail('INVALID_RECIPE');
  const recipe=matching[0];
  if(!Array.isArray(recipe.ingredients)||!recipe.ingredients.length||recipe.ingredients.some(i=>!Number.isSafeInteger(i.count)||i.count<1||!Number.isSafeInteger(i.minLevel)||i.minLevel!<1))return fail('ROSTER_CATALOG_INVALID');
  if(new Set(recipe.ingredients.map(i=>i.unitId)).size!==recipe.ingredients.length)return fail('ROSTER_CATALOG_INVALID');
  const def=(id:string)=>{const found=c.characters.filter(u=>u.id===id);if(found.length!==1)return fail('ROSTER_CATALOG_INVALID');try{validateRosterDefinition(found[0]);}catch{fail('ROSTER_CATALOG_INVALID');}return found[0];};
  const target=def(input.resultId);
  if(materials.length!==input.materialIds.length)return fail('MATERIALS_UNAVAILABLE');
  if(materials.some(m=>m.reincarnation!==0))return fail('CRAFT_REINCARNATION_POLICY_REQUIRED');
  if(recipe.ingredients.reduce((n,i)=>n+i.count,0)!==materials.length)return fail('INVALID_RECIPE');
  for(const ing of recipe.ingredients){
    const group=materials.filter(m=>m.speciesId===ing.unitId);if(group.length!==ing.count)return fail('INVALID_RECIPE');
    const curve=def(ing.unitId).growth;if(group.some(m=>growthAt(storedXp(m.totalXp),curve).level<ing.minLevel!))return fail('MATERIAL_LEVEL_REQUIRED');
  }
  let result:ReturnType<typeof combinationGrowth>;
  try{result=combinationGrowth(materials.map(m=>storedXp(m.totalXp)),target.growth);}catch(e){if((e as Error).message==='CAP_XP_POLICY_REQUIRED')return fail('CAP_XP_POLICY_REQUIRED');throw e;}
  const inheritance=inheritancePreview(c,target.id,result.level,materials.map(m=>({id:m.id,speciesId:m.speciesId,level:growthAt(storedXp(m.totalXp),def(m.speciesId).growth).level,skillInheritanceJson:m.skillInheritanceJson})),input.inheritance);
  // 지문: 요청·각 재료의 현재 값(계승 기록 포함)·결과·계승 화면까지. 클라이언트 숫자가 아니라 서버 값으로 만듦(원본과 같은 구성)
  const previewFingerprint=hash([canonical(input),materials.map(m=>[m.id,m.speciesId,m.totalXp.toString(),m.reincarnation,m.skillInheritanceJson]),target.name,target.rarity,recipe,result,inheritance.view]);
  const view={resultId:target.id,resultName:target.name,resultRarity:target.rarity,catalogVersion:c.version,materialIds:materials.map(m=>m.id),
    inheritedTotalXp:result.totalXp,remainingXp:result.xp,xpToNext:result.xpToNext,expectedLevel:result.level,maxLevel:result.maxLevel,reincarnation:0,previewFingerprint,inheritance:inheritance.view};
  return {view,stored:inheritance.stored};
}
/** 조합 화면 선택지: 보유(AVAILABLE·잠금 아님) 개체 요약 + 조합식별 재료 준비 상태. discovery면 숨은 조합식도(이름은 가림). */
export function craftOptions(c:Catalog,rows:OwnedRow[],discovered:Set<string>,discovery:boolean){
  if(c?.approved!==true||!Array.isArray(c.characters)||!Array.isArray(c.recipes))return fail('ROSTER_CATALOG_PENDING');
  const defs=new Map(c.characters.map(u=>[u.id,u]));
  try{for(const u of c.characters)validateRosterDefinition(u);}catch{fail('ROSTER_CATALOG_INVALID');}
  const units=rows.slice(0,1000).map(u=>{const d=defs.get(u.speciesId);if(!d)return fail('ROSTER_CATALOG_INVALID');
    if(u.totalXp<0n||u.totalXp>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_STORED_XP');
    let level:number;try{level=growthAt(Number(u.totalXp),d.growth,u.reincarnation,d.reincarnationXpPolicy).level;}catch(e){return fail((e as Error).message);}
    return {ownedId:u.id,speciesId:u.speciesId,name:d.name,totalXp:u.totalXp.toString(),level,maxLevel:rosterMaxLevel(u.reincarnation),reincarnation:u.reincarnation};});
  const recipes=c.recipes.filter(r=>discovery||r.visibility==='public').map((r,index)=>{
    const ingredients=r.ingredients.map(ing=>{const available=units.filter(u=>u.speciesId===ing.unitId&&u.reincarnation===0),ready=available.filter(u=>u.level>=ing.minLevel!);
      return {...ing,name:discovered.has(ing.unitId)?(defs.get(ing.unitId)?.name??ing.unitId):'???',imageVisible:discovered.has(ing.unitId),availableCount:available.length,readyCount:ready.length};});
    const materialsReady=ingredients.every(i=>i.availableCount>=i.count),craftable=ingredients.every(i=>i.readyCount>=i.count);
    const found=discovered.has(r.resultId),nameVisible=!discovery||found||materialsReady;
    return {resultId:r.resultId,name:nameVisible?(defs.get(r.resultId)?.name??r.resultId):'???',discovered:found,imageVisible:found,nameVisible,materialsReady,craftable,
      levelRestricted:ingredients.some(i=>Math.min(i.availableCount,i.count)>i.readyCount),hidden:r.visibility==='hidden',ingredients,index};
  }).sort((a,b)=>discovery?(Number(b.materialsReady)-Number(a.materialsReady)||Number(b.craftable)-Number(a.craftable)||a.index-b.index):a.index-b.index).map(({index,...recipe})=>recipe);
  return {catalogVersion:c.version,discoveryVersion:discovery?'craft-discovery-v1':undefined,truncated:rows.length>1000,units,recipes,
    inheritancePolicy:{version:skillInheritanceVersion,required:true,maxSkills:6,ordinaryAttackSeparate:true,unlockRule:'SOURCE_REQUIRED_LEVEL'}};
}

// ── 보유 개체 상세(원본 RosterOwned.projection/read)
const difference=(after:FiveStats,before:FiveStats)=>Object.fromEntries(fiveStatKeys.map(k=>[k,after[k]-before[k]])) as FiveStats;
export function ownedSummary(c:Catalog,row:OwnedRow){
  const d=c.characters.find(u=>u.id===row.speciesId);if(!d)return fail('BATTLE_UNIT_DATA_PENDING');
  if(row.totalXp<0n||row.totalXp>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_XP');
  if(row.reincarnation&&c.rebirthPolicy!=='hp-mp-durability-additive-v1')return fail('FIVE_STAT_REBIRTH_POLICY_PENDING');
  const grown=growthAt(Number(row.totalXp),d.growth,row.reincarnation,d.reincarnationXpPolicy);
  const current=makeFighter(c,row.speciesId,grown.level,row.id,row.reincarnation,row.skillInheritanceJson);
  return {definition:d,grown,current,summary:{ownedId:row.id,speciesId:row.speciesId,name:current.name,rarity:d.rarity,level:grown.level,maxLevel:grown.maxLevel,reincarnation:row.reincarnation,status:row.status,locked:row.locked,stats:current.stats}};
}
export function ownedDetail(c:Catalog,row:OwnedRow,partyIds:string[]){
  const {definition,grown,current,summary}=ownedSummary(c,row);
  const base=definition.levelOneStats,levelStats=makeFighter(c,row.speciesId,grown.level,row.id,0).stats;
  const skill=(v:DefinedSkill)=>({id:v.id,name:v.name,element:v.element,power:v.power,mpCost:v.mpCost,learnLevel:v.learnLevel??1,effectText:'위력 '+v.power,effectsStatus:'POWER_ONLY_NO_ADDITIONAL_EFFECTS'});
  const slots=equippedSkills(c,row.speciesId,row.skillInheritanceJson);
  const future=slots.map(e=>e.skill).filter(v=>(v.learnLevel??1)>grown.level&&(v.learnLevel??1)<=grown.maxLevel);
  const nextLevel=future.length?Math.min(...future.map(v=>v.learnLevel??1)):null;
  return {...summary,growth:{level:grown.level,maxLevel:grown.maxLevel,reincarnation:grown.reincarnation,totalXp:grown.totalXp,xp:grown.xp,xpToNext:grown.xpToNext,levelStartTotalXp:grown.totalXp-grown.xp,nextLevelTotalXp:grown.xpToNext===null?null:grown.totalXp+grown.xpToNext},
    statBreakdown:{base:{...base},growth:difference(levelStats,base),rebirth:difference(current.stats,levelStats),total:{...current.stats},other:null,otherStatus:'NO_OTHER_BONUS_MODEL'},
    aptitude:structuredClone(current.suitability),ownResistance:structuredClone(current.defense),
    skills:{attack:skill(current.attack),current:current.skills.map(skill),
      slots:slots.map(e=>({slot:e.slot,...skill(e.skill),unlocked:(e.skill.learnLevel??1)<=grown.level,inherited:readSkillInheritance(row.skillInheritanceJson)?.replaceSlot===e.slot})),inheritance:readSkillInheritance(row.skillInheritanceJson),
      nextLearn:nextLevel===null?null:{level:nextLevel,skills:future.filter(v=>(v.learnLevel??1)===nextLevel).map(skill)},
      growth:{status:'DESIGN_NEEDED',reason:'NO_PER_INDIVIDUAL_SKILL_GROWTH_MODEL'}},
    party:{pvp:{position:partyIds.includes(row.id)?partyIds.indexOf(row.id)+1:null,size:partyIds.length},activity:row.status}};
}
