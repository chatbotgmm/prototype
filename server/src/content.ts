// data/ 읽기. 서버를 켤 때 한 번 읽고 검사한다(틀리면 켜지지 않음).
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateRosterDefinition,validateFiveStats,validateFiveCombatPolicy,validateUnitXpPacing,type Catalog,type BattlePolicy,type ItemDefinition,type UnitXpPacing} from '../../shared/src/index.js';

export type Content={catalog:Catalog;policy:BattlePolicy;xpPacing:UnitXpPacing;items:Record<string,ItemDefinition>};
export function loadContent(root:string):Content{
  const read=(p:string)=>JSON.parse(readFileSync(resolve(root,'data',p),'utf8'));
  const catalog:Catalog=read('catalog.json'),policy:BattlePolicy=read('battle-policy.json'),items=read('items.json').items;
  if(catalog.statSchema!=='gmm-five-stats-v1'||catalog.approved!==true)throw Error('CATALOG_INVALID');
  validateFiveCombatPolicy(catalog.combatPolicy);
  for(const u of catalog.characters){validateRosterDefinition(u);validateFiveStats(u.levelOneStats);}
  if(policy.approved!==true||policy.catalogVersion!==catalog.version)throw Error('BATTLE_POLICY_INVALID');
  validateFiveCombatPolicy(policy.calculation);
  const xpPacing=validateUnitXpPacing(read('unit-xp-pacing-policy.json'),catalog.version);
  return {catalog,policy,xpPacing,items};
}
