// data/ 검사: 60종 정의, 조합식 참조, 전투 정책, 시험값 표시. 틀린 곳을 한국어로 알려 준다.
// 사용: npm run data:check
import {readFileSync} from 'node:fs';
import {validateRosterDefinition} from '../shared/src/rules.js';
import {validateFiveStats,validateFiveCombatPolicy} from '../shared/src/combat.js';
import {makeFighter,type Catalog} from '../shared/src/catalog.js';
import type {BattlePolicy} from '../shared/src/battle.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(`../data/${p}`,import.meta.url),'utf8'));
const problems:string[]=[],notes:string[]=[];
const c:Catalog=read('catalog.json'),p:BattlePolicy=read('battle-policy.json');
const ids=new Set(c.characters.map(u=>u.id));
if(c.characters.length!==60)problems.push(`60종이어야 하는데 ${c.characters.length}종이에요.`);
for(const u of c.characters){
  try{validateRosterDefinition(u);validateFiveStats(u.levelOneStats);if(u.growth[0].maxMp!==u.levelOneStats.mp)throw Error('BASE_MP_MISMATCH');makeFighter(c,u.id,1,'self');}
  catch(e){problems.push(`${u.id}(${u.name}): ${(e as Error).message}`);}
}
for(const r of c.recipes){
  if(!ids.has(r.resultId))problems.push(`조합식 결과 ${r.resultId}가 60종에 없어요.`);
  for(const i of r.ingredients)if(!ids.has(i.unitId))problems.push(`조합식 ${r.resultId}의 재료 ${i.unitId}가 60종에 없어요.`);
}
try{validateFiveCombatPolicy(c.combatPolicy);}catch(e){problems.push(`전투 계수: ${(e as Error).message}`);}
if(p.catalogVersion!==c.version)problems.push(`전투 정책(${p.catalogVersion})과 카탈로그(${c.version}) 버전이 달라요.`);
for(const e of p.encounters){
  if(!ids.has(e.speciesId))problems.push(`조우 ${e.id}의 상대 ${e.speciesId}가 60종에 없어요.`);
  for(const s of e.enemySpeciesIds??[])if(!ids.has(s))problems.push(`조우 ${e.id}의 후보 ${s}가 60종에 없어요.`);
}
for(const f of ['catalog.json','battle-policy.json','commander-policy.json','normal-xp-policy.json','story-unit-xp-policy.json','story/story-mode-v1.json']){
  const d=read(f);if(d.productionBalanceApproved===false)notes.push(`${f}: 시험값(productionBalanceApproved=false)`);
}
for(const n of notes)console.log('ℹ️ '+n);
if(problems.length){for(const x of problems)console.log('❌ '+x);process.exit(1);}
console.log(`✅ 데이터 검사 통과: 60종, 조합식 ${c.recipes.length}개, 조우 ${p.encounters.length}개`);
