// data/ 읽기. 서버를 켤 때 한 번 읽고 검사한다(틀리면 켜지지 않음).
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateRosterDefinition,validateFiveStats,validateFiveCombatPolicy,validateUnitXpPacing,validateRecruitPolicy,validateStoryContent,validateStoryVillainProfiles,validateStoryUnitXpPolicy,storySpeakerNames,
  type Catalog,type BattlePolicy,type ItemDefinition,type UnitXpPacing,type RecruitPolicy,type StoryContent,type StoryVillainDocument,type StoryUnitXpPolicy} from '../../shared/src/index.js';

export type Story={content:StoryContent;villains:StoryVillainDocument;unitXpPolicy:StoryUnitXpPolicy;speakerNames:Record<string,string>};
export type Content={catalog:Catalog;policy:BattlePolicy;xpPacing:UnitXpPacing;items:Record<string,ItemDefinition>;recruit:RecruitPolicy;story:Story};
export function loadContent(root:string):Content{
  const read=(p:string)=>JSON.parse(readFileSync(resolve(root,'data',p),'utf8'));
  const catalog:Catalog=read('catalog.json'),policy:BattlePolicy=read('battle-policy.json'),items=read('items.json').items;
  if(catalog.statSchema!=='gmm-five-stats-v1'||catalog.approved!==true)throw Error('CATALOG_INVALID');
  validateFiveCombatPolicy(catalog.combatPolicy);
  for(const u of catalog.characters){validateRosterDefinition(u);validateFiveStats(u.levelOneStats);}
  if(policy.approved!==true||policy.catalogVersion!==catalog.version)throw Error('BATTLE_POLICY_INVALID');
  validateFiveCombatPolicy(policy.calculation);
  const xpPacing=validateUnitXpPacing(read('unit-xp-pacing-policy.json'),catalog.version);
  const recruit=validateRecruitPolicy(read('recruit-policy.json'));
  // 스토리(시험 콘텐츠): 원본 story/routes.ts·story-unit-xp.ts와 같은 검사
  const story=validateStoryContent(read('story/story-mode-v1.json')),villains=read('story/villains-test-v1.json');
  validateStoryVillainProfiles(villains);
  const unitXpPolicy=validateStoryUnitXpPolicy(read('story-unit-xp-policy.json'),catalog.version,story.version,[...new Set(story.quests.flatMap(q=>q.objective.encounterIds))]);
  return {catalog,policy,xpPacing,items,recruit,story:{content:story,villains,unitXpPolicy,speakerNames:storySpeakerNames(story,villains)}};
}
