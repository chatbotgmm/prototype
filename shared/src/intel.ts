// 상대 정보 공개 규칙과 방어 상성 관측(한 번 맞혀 본 종의 반응을 기억).
// 출처: GMM110 src/battle/roster60-opponent-intel.ts, roster60-observed-defense.ts, roster60-appearance.ts (커밋 0b0fb8b5).
// DB 읽기·쓰기(captureDefenseSnapshot, persistDefenseObservations)는 서버에 있고, 여기는 계산만.
import {sha256} from './hash.js';
import {skillElements,type Defense,type SkillElement} from './rules.js';
import type {Catalog,Fighter} from './catalog.js';

// ── 외형(꾸밈 전용): 흑화 그림을 쓸 수 있는 종
export type BattleArtVariant='black';
const blackSpecies=new Set(['u01','u02','u06','u07','u14','u23','u28','u31']);
export function publicBattleAppearance(f:{speciesId:string;artVariant?:unknown}):{artVariant?:BattleArtVariant}{
  return f.artVariant==='black'&&blackSpecies.has(f.speciesId)?{artVariant:'black'}:{};
}

// ── 상대 정보: 능력치는 한 턴이 끝난 뒤 공개, 방어 상성은 관측한 것만
export const opponentIntelTuning=Object.freeze({statsAfterCompletedTurns:1});
export type OpponentIntel={
  version:'opponent-intel-v2';speciesId:string;name:string;level:number;completedTurns:number;
  defenseKnowledgeScope:'base-observed'|'battle-observed'|'unverified';
  statsKnown:boolean;stats:Fighter['stats']|null;
  defenses:Record<SkillElement,Defense|'unknown'>;knownDefenseCount:number;totalDefenseCount:number;
};
export function opponentIntel(enemy:Fighter,completedTurns:number,known:Partial<Record<SkillElement,Defense>>={},scope:OpponentIntel['defenseKnowledgeScope']='unverified'):OpponentIntel{
  const turns=Math.max(0,Math.floor(completedTurns));
  const count=skillElements.filter(e=>known[e]!==undefined).length,statsKnown=turns>=opponentIntelTuning.statsAfterCompletedTurns;
  return {version:'opponent-intel-v2',speciesId:enemy.speciesId,name:enemy.name,level:enemy.level,completedTurns:turns,defenseKnowledgeScope:scope,
    statsKnown,stats:statsKnown?{...enemy.stats}:null,
    defenses:Object.fromEntries(skillElements.map(e=>[e,known[e]??'unknown'])) as OpponentIntel['defenses'],
    knownDefenseCount:count,totalDefenseCount:skillElements.length};
}
/** 화면에 보내는 상대: 공개 범위만(능력치는 공개 전엔 체력·MP 최대치만). */
export function opponentFighter(enemy:Fighter&{artVariant?:unknown},intel:OpponentIntel){
  return {id:'enemy',...publicBattleAppearance(enemy),speciesId:enemy.speciesId,name:enemy.name,level:enemy.level,hp:enemy.hp,mp:enemy.mp,
    stats:intel.statsKnown?{...enemy.stats}:{hp:enemy.stats.hp,mp:enemy.stats.mp},
    attack:{...enemy.attack},skills:enemy.skills.map(s=>({...s}))};
}

// ── 방어 관측
export const observedDefenseVersion='observed-defense-v1' as const;
export type KnownDefenses=Partial<Record<SkillElement,Defense>>;
type SpeciesKnowledge=Record<string,KnownDefenses>;
export type DefenseSnapshot={version:typeof observedDefenseVersion;profiles:Record<string,string>;initial:Record<string,SpeciesKnowledge>};
export type DefenseObservation={viewer:string;speciesId:string;element:SkillElement;reaction:Defense;targetKey:string;profileKey?:string;baseConflict?:boolean};
export type DefenseKnowledge={base:SpeciesKnowledge;battle:Record<string,KnownDefenses>;conflicts:Record<string,boolean>};
const reactions=new Set(['weak','normal','resist','immune','reflect']);
const digest=(value:unknown)=>sha256(JSON.stringify(value)).toString('hex');

/** 서버 안에서만 쓰는 열쇠. 화면으로 내보내지 않음. */
export function defenseProfileKey(speciesId:string,profile:unknown):string|null{
  if(!profile||typeof profile!=='object'||Object.keys(profile).length!==skillElements.length)return null;
  const values=skillElements.map(e=>(profile as Record<string,unknown>)[e]);
  if(values.some(v=>!reactions.has(String(v))))return null;
  return digest([observedDefenseVersion,speciesId,values]);
}
function targetKey(target:Fighter){return digest(['battle-observed-v1',target.speciesId,target.ownedId??target.id,skillElements.map(e=>target.defense?.[e])]);}
export function baseDefenseKey(c:Catalog|null,speciesId:string){const unit=c?.approved?c.characters.find(u=>u.id===speciesId):undefined;return unit?defenseProfileKey(speciesId,unit.defense):null;}
/** 전투를 만들 때 쓸 상대 종의 프로필 열쇠(카탈로그와 같은 방어 표일 때만). */
export function snapshotProfiles(c:Catalog,targets:Fighter[]){
  const profiles:Record<string,string>={};
  for(const t of targets){const key=baseDefenseKey(c,t.speciesId);if(key&&key===defenseProfileKey(t.speciesId,t.defense))profiles[t.speciesId]=key;}
  return profiles;
}
export function emptyKnowledge(snapshot:DefenseSnapshot|undefined,viewer:string):DefenseKnowledge{
  return {base:structuredClone(snapshot?.initial?.[viewer]??{}),battle:{},conflicts:{}};
}
export function battleKnowledge(snapshot:DefenseSnapshot|undefined,rounds:readonly {events:readonly unknown[]}[],viewer:string):DefenseKnowledge{
  const knowledge=emptyKnowledge(snapshot,viewer);
  for(const round of rounds)for(const event of round.events as any[]){const o=event.defenseObservation as DefenseObservation|undefined;if(o?.viewer===viewer)addDefenseObservation(knowledge,o,snapshot);}
  return knowledge;
}
export function addDefenseObservation(knowledge:DefenseKnowledge,o:DefenseObservation,snapshot:DefenseSnapshot|undefined){
  (knowledge.battle[o.targetKey]??={})[o.element]=o.reaction;
  if(o.baseConflict)knowledge.conflicts[o.targetKey]=true;
  if(o.profileKey&&snapshot?.profiles[o.speciesId]===o.profileKey)(knowledge.base[o.speciesId]??={})[o.element]=o.reaction;
}
/** 실제로 맞은 공격만 관측. 반사는 공격자에게 돌아간 경우만. */
export function resolvedDefenseObservation(target:Fighter,element:SkillElement,hit:unknown,viewer:string,snapshot:DefenseSnapshot|undefined,c:Catalog|null,knowledge?:DefenseKnowledge):DefenseObservation|null{
  if(!skillElements.includes(element)||!hit||typeof hit!=='object')return null;
  const r=hit as Record<string,unknown>;
  if(r.miss===true||r.missed===true||r.cancelled===true||r.hit===false||r.executed===false||(r.outcome!==undefined&&r.outcome!=='hit'))return null;
  if(!reactions.has(String(r.defense))||!Number.isFinite(r.damage)||Number(r.damage)<0)return null;
  const reaction=r.defense as Defense;
  if(r.target!==(reaction==='reflect'?'attacker':'defender'))return null;
  const actual=defenseProfileKey(target.speciesId,target.defense),pinned=snapshot?.profiles[target.speciesId];
  const baseConflict=reaction!==target.defense[element];
  const verified=!baseConflict&&!knowledge?.conflicts[targetKey(target)]&&actual&&pinned===actual&&baseDefenseKey(c,target.speciesId)===actual;
  return {viewer,speciesId:target.speciesId,element,reaction,targetKey:targetKey(target),...(verified?{profileKey:actual}:{}),...(baseConflict?{baseConflict:true}:{})};
}
export function observedOpponentIntel(target:Fighter,turn:number,snapshot:DefenseSnapshot|undefined,knowledge:DefenseKnowledge,c:Catalog|null=null){
  const actual=defenseProfileKey(target.speciesId,target.defense),verified=!!actual&&snapshot?.profiles[target.speciesId]===actual&&baseDefenseKey(c,target.speciesId)===actual&&!knowledge.conflicts[targetKey(target)];
  const local=knowledge.battle[targetKey(target)]??{};
  const known=verified?{...(knowledge.base[target.speciesId]??{}),...local}:local;
  return opponentIntel(target,turn,known,verified?'base-observed':Object.keys(local).length?'battle-observed':'unverified');
}
export function publicDefenseObservation(o:DefenseObservation|undefined){return o?{speciesId:o.speciesId,element:o.element,reaction:o.reaction}:undefined;}
/** 응답 경계: 어떤 깊이에서든 `defense` 객체(방어 표 전체)를 지움. 내 개체의 방어는 ownResistance로 따로 보냄. */
export function publicDefenseSafe<T>(value:T):T{
  if(Array.isArray(value))return value.map(publicDefenseSafe) as T;
  if(!value||typeof value!=='object'||value instanceof Date)return value;
  const object=value as Record<string,unknown>;
  return Object.fromEntries(Object.entries(object).filter(([key,entry])=>key!=='defense'||!entry||typeof entry!=='object').map(([key,entry])=>[key,publicDefenseSafe(entry)])) as T;
}
