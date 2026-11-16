// 서버 API 묶음(Godot의 autoload 싱글턴에 해당). 화면은 이 모듈로만 서버와 이야기한다.
import {BASE} from './dom.js';

export class ApiError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
// 오류 코드 → 화면 문구. 코드는 서버(=GMM110)와 같은 문자열.
const MESSAGES:Record<string,string>={
  LOGIN_REQUIRED:'로그인이 필요해요.',LOGIN_CODE_INVALID:'코드가 맞지 않거나 이미 쓴 코드예요.',INVALID_PARTY:'편성은 1~3마리예요.',
  UNIT_UNAVAILABLE:'지금 쓸 수 없는 갈매미가 있어요(전투 중일 수 있어요).',INSUFFICIENT_MP:'MP가 모자라요.',HP_FULL:'체력이 가득해요.',
  ITEM_UNAVAILABLE:'아이템이 없어요.',INVALID_ITEM_TARGET:'그 대상에는 쓸 수 없어요.',NO_STATUS_TO_CLEANSE:'풀 상태 이상이 없어요.',
  FORCED_SWITCH_REQUIRED:'쓰러진 대원을 먼저 교체해 주세요.',STALE_REVISION:'화면이 오래됐어요. 다시 불러올게요.',BATTLE_FINISHED:'이미 끝난 전투예요.',
  INVALID_SWITCH:'교체할 수 없는 대원이에요.',SKILL_NOT_EQUIPPED:'쓸 수 없는 기술이에요.',NETWORK:'서버에 연결할 수 없어요.',
  PARTY_REQUIRED:'대전 편성을 먼저 저장해 주세요.',PVP_BUSY:'대전 대기 중이거나 확인하지 않은 대전이 있어요.',RANK_ACCOUNT_LEVEL_REQUIRED:'랭크는 방범대장 Lv.60부터예요.',
  RANK_UNIT_LEVEL_REQUIRED:'랭크 출전 대원은 모두 Lv.60 이상이어야 해요.',ACTION_ALREADY_SUBMITTED:'이미 행동을 골랐어요. 상대를 기다려요.',OPPONENT_FORCED_SWITCH:'상대가 교체할 때까지 기다려요.',
  BATTLE_ACTIVE:'대전 대기 중이거나 대전 중이라 지금은 할 수 없어요.',MATCH_POOL_CLASS_CHANGED:'환생 상태가 바뀌었어요. 매칭을 취소하고 다시 참가해 주세요.',
  REINCARNATION_REQUIREMENTS_NOT_MET:'레벨이 모자라요.',REINCARNATION_GRADE_NOT_ALLOWED:'제한·초월·불멸·영원 등급만 환생할 수 있어요.',REINCARNATION_LIMIT:'환생은 5번까지예요.',
  INSUFFICIENT_PEANUT:'땅콩이 모자라요.',PREVIEW_CHANGED:'정보가 바뀌었어요. 다시 확인해 주세요.',
  STORY_STALE_REVISION:'이야기 화면이 오래됐어요. 다시 불러올게요.',STORY_SCENE_LOCKED:'아직 들을 수 없는 이야기예요.',STORY_SCENE_ACTIVE:'읽던 이야기를 마치거나 닫은 뒤 열 수 있어요.',
  STORY_ACCEPT_NOT_READY:'이야기를 끝까지 들은 뒤 수락할 수 있어요.',STORY_ACCEPT_REQUIRED:'의뢰를 수락해 주세요.',STORY_OBJECTIVE_INCOMPLETE:'아직 의뢰를 마치지 않았어요.',
  STORY_QUEST_NOT_ACTIVE:'지금 출항할 수 있는 의뢰가 아니에요.',STORY_OBJECTIVE_AWAITING_RETURN:'이미 이겼어요. 모험에서 귀환하면 이야기가 이어져요.',STORY_BATTLE_ACTIVE:'끝나지 않은 스토리 전투가 있어요.',
  STORY_ENCOUNTER_LOCKED:'아직 열리지 않은 모험이에요.',ADVENTURE_BATTLE_ACTIVE:'모험 전투가 진행 중이에요.',RETURN_ONLY_OUTSIDE_BATTLE:'전투가 끝난 뒤 귀환할 수 있어요.',
  ACTIVE_UNIT_FAINTED:'쓰러진 대원은 먼저 나갈 수 없어요.',ADVENTURE_REQUIRED:'모험을 먼저 출발해 주세요.',ADVENTURE_NOT_FOUND:'모험을 찾을 수 없어요.',
};
export const message=(e:unknown)=>e instanceof ApiError?(MESSAGES[e.code]??`오류: ${e.code}`):MESSAGES.NETWORK;
let seq=0;
export const requestId=()=>`${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2,8)}`;

async function call<T>(method:'GET'|'POST',path:string,body?:unknown):Promise<T>{
  let r:Response;
  try{r=await fetch(`${BASE}/api/v1${path}`,{method,credentials:'same-origin',headers:{'x-gmm':'1',...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});}
  catch{throw new ApiError(0,'NETWORK');}
  const data=await r.json().catch(()=>({error:'BAD_RESPONSE'}));
  if(!r.ok)throw new ApiError(r.status,data.error??'UNKNOWN');
  return data as T;
}
export type Stats={hp:number;mp:number;durability:number;statusResistance:number;speed:number};
export type OwnedUnit={ownedId:string;speciesId:string;name:string;rarity:string;level:number;maxLevel:number;stats:Stats;reincarnation:number;status:string;locked:boolean};
export type Skill={id:string;name:string;element:string;power:number;mpCost:number;learnLevel?:number};
export type Fighter={ownedId?:string;artVariant?:'black';speciesId:string;name:string;level:number;hp:number;mp:number;stats:Partial<Stats>&{hp:number;mp:number};attack:Skill;skills:Skill[];ownResistance?:Record<string,string>};
export type BattleView={battleId:string;revision:number;status:'ACCEPTING'|'ACTIVE'|'FINISHED'|'SETTLED';testBaseline:boolean;
  pvp?:boolean;mode?:string;opponentKind?:'AI'|'HUMAN';deadline?:number;serverNow?:number;accepted?:boolean;opponentAccepted?:boolean;submitted?:boolean;waitingForOpponent?:boolean;requeued?:boolean;presence?:{status:string;ownGraceUntil?:number;opponentGraceUntil?:number};adventureId:string|null;story:{questId:string|null;encounterId:string;kind:string}|null;
  state:{mode:string|null;turn:number;outcome:string|null;surrendered:boolean;self:Fighter;reserves:Fighter[];enemy:Fighter;
    opponentIntel:{statsKnown:boolean;defenses:Record<string,string>;knownDefenseCount:number;totalDefenseCount:number;defenseKnowledgeScope:string};
    rounds:{turn:number;events:any[]}[]};
  settlement:any;inventory:{itemId:string;count:number}[];itemDefinitions:Record<string,{name:string;heal?:number;revive?:number;cleanse?:boolean;desc:string}>;disabledCommands:Record<string,string>};

export type Candidate={speciesId:string;name:string;rarity:string;level:number;totalXp:number};
export type RecruitSession={sessionId:string;batchId:string;batchIndex:number;revision:number;status:string;kind:string;baseCost:number;rerollCost:number;rerolls:number;candidate:Candidate;ownedId?:string;ownedSpecies:boolean;canReject:boolean;rejectReason:string};
export type RecruitState={credits:number;pendingSessions:RecruitSession[]};
export type Onboarding={started:boolean;starter?:{id:string;speciesId:string;name:string};tutorialVerified?:boolean;tutorialComplete?:boolean;ticket?:{ticketId:string;name:string;status:'used'|'unused';characterId:string|null}|null};
export type OwnedDetail={ownedId:string;speciesId:string;name:string;rarity:string;level:number;maxLevel:number;reincarnation:number;status:string;stats:Stats;
  growth:{xp:number;xpToNext:number|null;levelStartTotalXp:number;nextLevelTotalXp:number|null;totalXp:number};statBreakdown:{base:Stats;growth:Stats;rebirth:Stats;total:Stats};
  aptitude:Record<string,number>;ownResistance:Record<string,string>;
  skills:{attack:Skill;slots:(Skill&{slot:number;learnLevel:number;unlocked:boolean;inherited:boolean})[];inheritance:{skillId:string;sourceSpeciesId:string;replaceSlot:number}|null;nextLearn:{level:number;skills:Skill[]}|null};party:{pvp:{position:number|null}}};
export type Recipe={resultId:string;name:string;discovered:boolean;nameVisible:boolean;materialsReady:boolean;craftable:boolean;levelRestricted:boolean;hidden:boolean;
  ingredients:{unitId:string;count:number;minLevel:number;name:string;imageVisible:boolean;availableCount:number;readyCount:number}[]};
export type CraftUnit={ownedId:string;speciesId:string;name:string;level:number;reincarnation:number};
export type InheritanceView={status:'selected'|'selection-required';candidates:{skillId:string;name:string;element:string;power:number;mpCost:number;requiredLevel:number;source:{name:string;level:number};allowedReplaceSlots:number[]}[];
  resultSkillSlots:{slot:number;skillId:string;name:string;element:string;power:number;mpCost:number;requiredLevel:number;unlockedAtResultLevel:boolean}[];selected:any};
export type CraftPreview={resultId:string;resultName:string;resultRarity:string;expectedLevel:number;maxLevel:number;previewFingerprint:string;inheritance:InheritanceView;materialIds:string[]};
export type Collection={catalogVersion:string;characters:{id:string;name:string;rarity:string;role:string;levelOneStats:Stats;suitability:Record<string,number>;skills:Skill[];ownedCount:number;discovered:boolean;
  defenseKnowledge:{defenses:Record<string,string>;knownDefenseCount:number;totalDefenseCount:number}}[]};

export type QuestStatus='LOCKED'|'AVAILABLE'|'ACTIVE'|'READY'|'COMPLETED';
export type StoryQuest={id:string;title:string;kind:'main'|'resident';chapter:number;status:QuestStatus;recommendedLevel:[number,number];npcId?:string;objective:{kind:string;wins:number;requiredWins:number};canDepart:boolean;adventureId:string|null;battleId:string|null};
export type StoryState={contentVersion:string;revision:number;testValues:boolean;statue:{stage:number;fragments:number;hatched:boolean};currentQuest:StoryQuest|null;quests:StoryQuest[];
  residents:{id:string;name:string;role:string;status:QuestStatus;questId:string|null;dailyDialogue:string}[];history:{questId:string;title:string}[];adventures:{id:string;name:string;level:number}[];
  materialAdventure:{adventureId:string;status:string;activeBattleId:string|null;revision:number}|null;nextStoryHint:string|null;
  scene:{id:string;questId:string;phase:'intro'|'return'|'replay';cursor:number;line:{speakerId:string;text:string;speakerName:string};last:boolean;background:string;camera:string|null}|null};
export type Adventure={adventureId:string;revision:number;status:'ACTIVE'|'RETURNED'|'LOST';activeBattleId:string|null;kind:'free'|'material'|'quest';questId:string|null;
  party:{ownedId:string;speciesId:string;name:string;level:number;hp:number;maxHp:number}[];pendingRewards:{xp:Record<string,number>};settlement:any};

export type Commander={name:string;level:number|null;totalXp:string|null;nextLevelXp:string|null;xpToNext:string|null;maxLevel:number|null;status:string;testValues:boolean};
export type RebirthCandidate={ownedId:string;speciesId:string;name:string;eligible:boolean;reason:string;requiredLevel?:number;costPeanut?:number;accountFreeAvailable?:boolean;previewFingerprint?:string;
  preview:{beforeLevel:number;baselineLevelOneStats:Stats;afterLevelOneStats:Stats;next:{level:number;maxLevel:number;reincarnation:number}}|null};
export type RebirthPreview={catalogVersion:string;peanut:number;candidates:RebirthCandidate[]};
export type PvpCurrent={status:'idle'|'waiting'|'matched';mode?:'normal'|'rank';partyIds?:string[];queuedAt?:number|null;aiAvailableAt?:number|null;cancelAllowed?:boolean;serverNow:number;battle?:BattleView;matchPoolCondition?:string|null;rankCondition?:string|null};
export type RankEligibility={eligible:boolean;reason:string;accountLevel:number|null;requiredAccountLevel:60;requiredUnitLevel:60;pool:string|null};
export type PvpOptions={units:{ownedId:string;speciesId:string;name:string;rarity:string;level:number;rankEligible:boolean}[];partyIds:string[];rankEligibility:RankEligibility;commander:Commander};
export type RankSummary={me:{point:number;tierName:string;tierIndex:number;wins:number;losses:number;draws:number;rank:number|null;promotion:{active:boolean;wins:number;losses:number;requiredWins:number;maxGames:number}};win:number;lose:number;
  top:{rank:number;nickname:string;point:number;tierName:string;wins:number;losses:number}[]};
export const api={
  login:(code:string)=>call<{ok:true}>('POST','/auth/code',{code}),
  logout:()=>call<{ok:true}>('POST','/auth/logout',{}),
  me:()=>call<{playerId:string;nickname:string|null;credits:number;peanut:number;items:{itemId:string;count:number}[];commander:Commander;testBaseline:boolean}>('GET','/me'),
  commander:()=>call<Commander>('GET','/commander'),
  rebirth:()=>call<RebirthPreview>('GET','/rebirth'),
  rebirthConfirm:(c:RebirthCandidate,catalogVersion:string)=>call<RebirthCandidate&{completed:true;paidPeanut:number}>('POST','/rebirth/confirm',{requestId:requestId(),ownedId:c.ownedId,catalogVersion,previewFingerprint:c.previewFingerprint}),
  owned:()=>call<{units:OwnedUnit[]}>('GET','/owned'),
  ownedDetail:(id:string)=>call<{unit:OwnedDetail}>('GET',`/owned/${encodeURIComponent(id)}`).then(r=>r.unit),
  onboarding:()=>call<Onboarding>('GET','/onboarding'),
  onboardingStart:()=>call<Onboarding>('POST','/onboarding/start',{}),
  onboardingComplete:()=>call<Onboarding>('POST','/onboarding/complete',{}),
  onboardingPreview:(ticketId:string)=>call<Onboarding&{catalogVersion:string;characters:{id:string;name:string;role:string;levelOneStats:Stats;suitability:Record<string,number>;skills:Skill[]}[]}>('POST','/onboarding/preview',{ticketId}),
  onboardingConfirm:(ticketId:string,characterId:string,catalogVersion:string)=>call<Onboarding>('POST','/onboarding/confirm',{ticketId,characterId,catalogVersion}),
  recruit:()=>call<RecruitState&{catalogVersion:string;offers:{kind:string;label:string;cost:number;rerollCost:number;weights:Record<string,number>}[]}>('GET','/recruit'),
  recruitStart:(kind:string,times:number,catalogVersion:string)=>call<RecruitState&{sessions:RecruitSession[]}>('POST','/recruit/start',{requestId:requestId(),kind,times,catalogVersion}),
  recruitAction:(s:RecruitSession,action:'reroll'|'claim'|'reject')=>call<RecruitState>('POST','/recruit/action',{requestId:requestId(),sessionId:s.sessionId,revision:s.revision,action}),
  recruitClaimAll:(list:RecruitSession[])=>call<RecruitState>('POST','/recruit/claim-all',{requestId:requestId(),sessions:list.map(s=>({sessionId:s.sessionId,revision:s.revision}))}),
  collection:()=>call<Collection>('GET','/collection'),
  craftOptions:()=>call<{catalogVersion:string;units:CraftUnit[];recipes:Recipe[]}>('GET','/craft/options?discovery=1'),
  craftPreview:(body:{resultId:string;materialIds:string[];catalogVersion:string;inheritance?:{skillId:string;replaceSlot:number}})=>call<CraftPreview>('POST','/craft/preview',body),
  craftConfirm:(body:{resultId:string;materialIds:string[];catalogVersion:string;inheritance:{skillId:string;replaceSlot:number};previewFingerprint:string})=>call<CraftPreview&{ownedId:string}>('POST','/craft/confirm',{...body,requestId:requestId()}),
  party:()=>call<{ownedIds:string[]}>('GET','/party'),
  saveParty:(ownedIds:string[])=>call<{ownedIds:string[]}>('POST','/party',{ownedIds}),
  battleOptions:()=>call<{encounters:{id:string;name:string;level:number;tutorial:boolean;mode:string|null}[]}>('GET','/battle/options'),
  activeBattles:()=>call<{battles:BattleView[]}>('GET','/battle/active'),
  createBattle:(ownedId:string,encounterId:string,reserveIds:string[],adventureId?:string)=>call<BattleView>('POST','/battle',{requestId:requestId(),ownedId,encounterId,reserveIds,...(adventureId?{adventureId}:{})}),
  pvpOptions:()=>call<PvpOptions>('GET','/pvp/options'),
  pvpParty:(ownedIds:string[],mode?:'normal'|'rank')=>call<{partyIds:string[]}>('POST','/pvp/party',{ownedIds,...(mode?{mode}:{})}),
  pvpJoin:(mode:'normal'|'rank')=>call<PvpCurrent>('POST','/pvp/join',{requestId:requestId(),mode}),
  pvpCancel:()=>call<PvpCurrent>('POST','/pvp/cancel',{requestId:requestId()}),
  pvpCurrent:()=>call<PvpCurrent>('GET','/pvp/current'),
  pvpAccept:(b:BattleView,accept:boolean)=>call<BattleView>('POST','/pvp/accept',{requestId:requestId(),battleId:b.battleId,revision:b.revision,accept}),
  pvpAct:(b:BattleView,action:Record<string,unknown>)=>call<BattleView>('POST','/pvp/action',{requestId:requestId(),battleId:b.battleId,revision:b.revision,action}),
  pvpSettle:(b:BattleView)=>call<BattleView>('POST','/pvp/settle',{requestId:requestId(),battleId:b.battleId,revision:b.revision}),
  pvpRank:()=>call<RankSummary>('GET','/pvp/rank'),
  story:()=>call<StoryState>('GET','/story'),
  storyMaterials:()=>call<{name:string;balance:number;lifetimeEarned:number}>('GET','/story/materials'),
  storyOpen:(s:StoryState,questId:string,phase:'intro'|'return'|'replay')=>call<StoryState>('POST','/story/open',{requestId:requestId(),revision:s.revision,questId,phase}),
  storyAdvance:(s:StoryState)=>call<StoryState>('POST','/story/advance',{requestId:requestId(),revision:s.revision,cursor:s.scene!.cursor}),
  storyAccept:(s:StoryState,questId:string)=>call<StoryState>('POST','/story/accept',{requestId:requestId(),revision:s.revision,questId}),
  storyClose:(s:StoryState)=>call<StoryState>('POST','/story/close',{requestId:requestId(),revision:s.revision}),
  storyBattle:(questId:string,ownedIds:string[],adventureId?:string)=>call<BattleView>('POST','/story/battle',{requestId:requestId(),questId,ownedIds,...(adventureId?{adventureId}:{})}),
  materialBattle:(encounterId:string,ownedIds:string[],adventureId?:string)=>call<BattleView>('POST','/story/material-battle',{requestId:requestId(),encounterId,ownedIds,...(adventureId?{adventureId}:{})}),
  adventures:()=>call<{adventures:Adventure[]}>('GET','/adventure/active'),
  adventure:(id:string)=>call<Adventure>('GET',`/adventure/${id}`),
  adventureStart:(ownedIds:string[])=>call<Adventure>('POST','/adventure/start',{requestId:requestId(),ownedIds}),
  adventureReturn:(a:Adventure)=>call<Adventure>('POST',`/adventure/${a.adventureId}/return`,{requestId:requestId(),revision:a.revision}),
  battle:(id:string)=>call<BattleView>('GET',`/battle/${id}`),
  act:(b:BattleView,action:Record<string,unknown>)=>call<BattleView>('POST',`/battle/${b.battleId}/action`,{requestId:requestId(),revision:b.revision,action}),
  settle:(b:BattleView)=>call<BattleView>('POST',`/battle/${b.battleId}/settle`,{requestId:requestId(),revision:b.revision}),
};
