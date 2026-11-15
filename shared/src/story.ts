// 스토리·주민 의뢰·모험 규칙(순수 함수). DB·네트워크 없음. 서버는 저장·잠금만 맡는다.
// 원본(GMM110 0b0fb8b5): src/story/{types,content,villains,settlement,service}.ts, src/roster60-adventure.ts,
//   src/progression/story-unit-xp.ts(정책 검사), src/roster60-battle.ts(스토리 전투 만들기 경로).
// 이야기 수치·주민/악당 이름은 원본에서도 시험용 콘텐츠다(productionBalanceApproved:false, thresholdsAreTestValues:true).
import {fail} from './errors.js';
import {makeFighter,type Catalog,type Fighter} from './catalog.js';
import {skillElements,type SkillElement} from './rules.js';
import type {BattlePolicy,Encounter} from './battle.js';

export type StoryLine={speakerId:string;text:string;pose?:string};
export type StoryScene={id:string;background:string;lines:StoryLine[];camera?:string};
export type StoryQuest={id:string;kind:'main'|'resident';chapter:number;recommendedLevel:[number,number];title:string;unlockAfter:string[];npcId?:string;acceptScene:string;
  objective:{kind:'adventure_win'|'scene';encounterIds:string[];wins:number};returnScene:string;statueStageAfter?:number;fragmentBundle?:{id:string;count:number};
  statueStageOnAccept?:number;fragmentBundleOnAccept?:{id:string;count:number};darkGangLifetimeRequired?:number};
export type StoryEncounter={id:string;speciesId:string;level:number;kind:'black'|'villain'|'ordinary';mode:'adventure'|'story';winXp?:number;lossXp?:number;villainProfileId?:string;hpMultiplier?:number;powerMultiplier?:number};
export type StoryResident={id:string;name:string;role:string;dailyDialogue:string;proposal?:boolean};
export type StoryContent={version:string;productionBalanceApproved:false;chapters:{id?:string|number;number?:number;title:string;recommendedLevel?:[number,number]}[];residents:StoryResident[];scenes:StoryScene[];quests:StoryQuest[];encounters:StoryEncounter[];
  policy:{darkGangPerWin:number;maxBalance:number;mainLifetimeGates:Record<string,number>;thresholdsAreTestValues:true}};
export type StoryUnitXpPolicy={approved:true;version:string;profileKind:'user-authorized-test-baseline';productionBalanceApproved:false;testValues:true;catalogVersion:string;contentVersion:string;scope:'accepted-quest-battles-only';
  distribution:'equal-actually-entered';loss:'zero-existing-story';surrender:'zero';draw:'zero';capOverflow:'discard-overflow';questCompletionUnitXp:'none';rewards:Record<string,{winXp:number;lossXp:0}>;notes?:string[]};
export type AcceptedQuest={token:string;wins:number;adventureId?:string;battles:string[];unitXpPolicy?:StoryUnitXpPolicy|null};
export type SceneProgress={questId:string;phase:'intro'|'return'|'replay';cursor:number};
export type StoryProgress={version:1;completed:string[];accepted:Record<string,AcceptedQuest>;scene:SceneProgress|null;checkpoints:Record<string,number>;readScenes:string[];fragments:Record<string,number>;statueStage:number;hatched:boolean;materialAdventureId?:string};
export type QuestStatus='LOCKED'|'AVAILABLE'|'ACTIVE'|'READY'|'COMPLETED';
export type StoryVillainSkill={id:string;name:string;element:SkillElement;power:number;mpCost:number;learnLevel:number};
export type StoryVillainDocument={productionBalanceApproved:false;statSchema:'gmm-five-stats-v1';namesAreProposals:true;numericValuesAreTestValues:true;
  profiles:{id:string;name:string;baselineSpeciesId:string;combatAllowed:boolean;classification:'unique-villain'|'human-villain';skills:StoryVillainSkill[]}[]};
/** 서버만 정해 전투 기록에 넣는 스토리 정보(원본 StoryBattleContext). 화면에서 받는 값이 아니다. */
export type StoryBattleContext={version:'story-battle-v1';contentVersion:string;encounterId:string;speciesId:string;kind:'black'|'villain'|'ordinary';mode:'story'|'adventure';questId?:string;acceptToken?:string;dropAmount:number;maxBalance:number;unitXpPolicy?:StoryUnitXpPolicy|null};

export const initialStoryProgress=():StoryProgress=>({version:1,completed:[],accepted:{},scene:null,checkpoints:{},readScenes:[],fragments:{},statueStage:1,hatched:false});
const unitId=/^u(0[1-9]|[1-5][0-9]|60)$/;
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** 콘텐츠 검사(원본 validateStoryContent). 틀리면 STORY_CONTENT_INVALID. */
export function validateStoryContent(c:StoryContent):StoryContent{
  const bad=()=>fail('STORY_CONTENT_INVALID');
  if(!c||!c.version||c.productionBalanceApproved!==false||c.policy?.thresholdsAreTestValues!==true||!Number.isSafeInteger(c.policy.darkGangPerWin)||c.policy.darkGangPerWin<1||c.policy.darkGangPerWin>1000||!Number.isSafeInteger(c.policy.maxBalance)||c.policy.maxBalance<1||c.policy.maxBalance>2_000_000_000)return bad();
  for(const list of [c.quests,c.scenes,c.encounters,c.residents])if(!Array.isArray(list)||new Set(list.map(x=>x.id)).size!==list.length)return bad();
  for(const scene of c.scenes)if(!scene.id||!scene.background||!scene.lines?.length||scene.lines.some(line=>typeof line.text!=='string'||!line.text||line.text.length>1000||typeof line.speakerId!=='string'))return bad();
  for(const e of c.encounters){
    if(!e.id||!Number.isInteger(e.level)||e.level<1||e.level>60||!['black','villain','ordinary'].includes(e.kind)||!['adventure','story'].includes(e.mode)||e.kind==='black'&&(!unitId.test(e.speciesId)||!!e.villainProfileId)||(e.winXp??0)<0||(e.lossXp??0)!==0)return bad();
    for(const n of [e.hpMultiplier??1,e.powerMultiplier??1])if(!Number.isFinite(n)||n<1||n>1.5)return bad();
  }
  for(const q of c.quests){
    if(!q.id||!['main','resident'].includes(q.kind)||q.unlockAfter.some(id=>!c.quests.some(x=>x.id===id))||!c.scenes.some(s=>s.id===q.acceptScene)||!c.scenes.some(s=>s.id===q.returnScene)||!Number.isSafeInteger(q.objective.wins)||q.objective.wins<0||q.objective.encounterIds.some(id=>!c.encounters.some(e=>e.id===id))
      ||q.objective.kind==='adventure_win'&&(!q.objective.encounterIds.length||q.objective.wins!==q.objective.encounterIds.length)||q.objective.kind==='scene'&&(q.objective.wins!==0||q.objective.encounterIds.length))return bad();
    for(const stage of [q.statueStageAfter,q.statueStageOnAccept])if(stage!==undefined&&(!Number.isInteger(stage)||stage<1||stage>5))return bad();
    for(const b of [q.fragmentBundle,q.fragmentBundleOnAccept])if(b&&(!b.id||!Number.isSafeInteger(b.count)||b.count<1||b.count>1000))return bad();
    if(q.darkGangLifetimeRequired!==undefined&&(!Number.isSafeInteger(q.darkGangLifetimeRequired)||q.darkGangLifetimeRequired<0||q.darkGangLifetimeRequired>c.policy.maxBalance))return bad();
  }
  for(const [questId,amount] of Object.entries(c.policy.mainLifetimeGates))if(!c.quests.some(q=>q.id===questId)||!Number.isSafeInteger(amount)||amount<0||amount>c.policy.maxBalance)return bad();
  return c;
}

/** 악당 프로필 검사(원본 validateStoryVillainProfiles). 지금 엔진에 없는 효과를 조용히 통과시키지 않는다. */
export function validateStoryVillainProfiles(input:unknown):asserts input is StoryVillainDocument{
  const bad=()=>fail('STORY_VILLAIN_PROFILE_INVALID');
  if(!record(input)||input.productionBalanceApproved!==false||input.statSchema!=='gmm-five-stats-v1'||input.namesAreProposals!==true||input.numericValuesAreTestValues!==true||!Array.isArray(input.profiles)||!input.profiles.length)bad();
  const ids=new Set<string>();
  for(const p of (input as any).profiles){
    if(!record(p)||typeof p.id!=='string'||!/^[a-z_]+$/.test(p.id)||ids.has(p.id)||typeof p.name!=='string'||!p.name||typeof p.baselineSpeciesId!=='string'||!unitId.test(p.baselineSpeciesId)||typeof p.combatAllowed!=='boolean'||!['unique-villain','human-villain'].includes(String(p.classification))||!Array.isArray(p.skills)||p.skills.length!==4||Object.keys(p).some(k=>!['id','name','baselineSpeciesId','combatAllowed','classification','skills'].includes(k)))bad();
    ids.add(p.id);const skills=new Set<string>();
    for(const k of p.skills){
      if(!record(k)||typeof k.id!=='string'||!k.id||skills.has(k.id)||typeof k.name!=='string'||!k.name||!skillElements.includes(k.element as SkillElement)||typeof k.power!=='number'||!Number.isFinite(k.power)||k.power<=0||k.power>10000||!Number.isSafeInteger(k.mpCost)||Number(k.mpCost)<0||Number(k.mpCost)>10000||!Number.isInteger(k.learnLevel)||Number(k.learnLevel)<1||Number(k.learnLevel)>60||Object.keys(k).some(x=>!['id','name','element','power','mpCost','learnLevel'].includes(x)))bad();
      skills.add(k.id);
    }
    if(p.skills[0].mpCost!==0||p.skills[0].learnLevel!==1)bad();
  }
}
/** 악당 전투 개체: 기준 종으로 성장·능력치를 만들고 공격·기술만 전용으로 바꾼다(원본 storyVillainFighter). */
export function storyVillainFighter(c:Catalog,doc:unknown,profileId:string,level:number,id:string):Fighter{
  validateStoryVillainProfiles(doc);
  const profile=doc.profiles.find(p=>p.id===profileId);
  if(!profile||!profile.combatAllowed)return fail('STORY_VILLAIN_PROFILE_PENDING');
  const enemy=makeFighter(c,profile.baselineSpeciesId,level,id);
  enemy.speciesId='story_'+profile.id;enemy.name=profile.name;
  enemy.attack=structuredClone(profile.skills[0]);
  enemy.skills=structuredClone(profile.skills.slice(1).filter(s=>s.learnLevel<=level));
  return enemy;
}
/** 대화 화자 이름표(원본 storySpeakerNames). 역할 이름 → 악당 이름 → 주민 이름 순으로 덮어쓴다. */
export function storySpeakerNames(content:StoryContent,villains:StoryVillainDocument):Record<string,string>{
  const roles:Record<string,string>={narrator:'',hero:'주인공',companion:'동료',resident:'마을 주민',traveler:'행인',pictureKeeper:'그림 소유자',messenger:'전달자',cregals:'크레갈스',first:'',darkFirst:'',recordVillain:'',engineerVillain:'',escortVillain:'',guideVillain:''};
  const villainSpeakers:Record<string,string>={first:'first',darkFirst:'dark_first',recordVillain:'record',engineerVillain:'engineer',escortVillain:'escort',guideVillain:'guide'};
  return {...roles,...Object.fromEntries(Object.entries(villainSpeakers).map(([speaker,profile])=>[speaker,villains.profiles.find(p=>p.id===profile)!.name])),...Object.fromEntries(content.residents.map(r=>[r.id,r.name]))};
}

const amount=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=2_000_000_000;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const unitXpKeys=['approved','version','profileKind','productionBalanceApproved','testValues','catalogVersion','contentVersion','scope','distribution','loss','surrender','draw','capOverflow','questCompletionUnitXp','rewards'];
/** 스토리 전투 경험치 정책 검사(원본 validateStoryUnitXpPolicy). 지급량은 전투 경험치 조절(두 번 이기면 한 레벨)의 원래 보상으로 쓰인다. */
export function validateStoryUnitXpPolicy(raw:unknown,catalogVersion:string,contentVersion:string,allowedEncounterIds?:string[]):StoryUnitXpPolicy{
  const bad=()=>fail('STORY_UNIT_XP_POLICY_INVALID');
  if(!record(raw)||unitXpKeys.some(k=>!Object.prototype.hasOwnProperty.call(raw,k))||Object.keys(raw).some(k=>![...unitXpKeys,'notes'].includes(k))||raw.approved!==true||!text(raw.version)||raw.profileKind!=='user-authorized-test-baseline'||raw.productionBalanceApproved!==false||raw.testValues!==true
    ||!text(raw.catalogVersion)||raw.catalogVersion!==catalogVersion||!text(raw.contentVersion)||raw.contentVersion!==contentVersion||raw.scope!=='accepted-quest-battles-only'||raw.distribution!=='equal-actually-entered'||raw.loss!=='zero-existing-story'||raw.surrender!=='zero'||raw.draw!=='zero'||raw.capOverflow!=='discard-overflow'||raw.questCompletionUnitXp!=='none'||!record(raw.rewards))return bad();
  const ids=Object.keys(raw.rewards);
  if(!ids.length||ids.some(id=>!text(id)||!/^[A-Za-z0-9_-]+$/.test(id)||['__proto__','constructor','prototype'].includes(id)))return bad();
  for(const r of Object.values(raw.rewards))if(!record(r)||Object.keys(r).sort().join()!=='lossXp,winXp'||!amount(r.winXp)||r.lossXp!==0)return bad();
  if(raw.notes!==undefined&&(!Array.isArray(raw.notes)||raw.notes.length>50||raw.notes.some((n:unknown)=>typeof n!=='string'||!n||n.length>2000)))return bad();
  if(allowedEncounterIds){const allowed=[...new Set(allowedEncounterIds)];if(allowed.length!==ids.length||ids.some(id=>!allowed.includes(id)))return bad();}
  return raw as StoryUnitXpPolicy;
}

// ── 의뢰 상태 ──
export const findQuest=(c:StoryContent,id:string)=>c.quests.find(q=>q.id===id)??fail('STORY_QUEST_NOT_FOUND');
export function questUnlocked(c:StoryContent,q:StoryQuest,p:StoryProgress,lifetime:number){
  return q.unlockAfter.every(id=>p.completed.includes(id))&&lifetime>=(q.darkGangLifetimeRequired??c.policy.mainLifetimeGates[q.id]??0);
}
/** 의뢰 상태(원본 status). adventureStatus: 연결된 모험의 상태(없으면 undefined). 모험을 귀환해야 READY가 된다. */
export function questStatus(c:StoryContent,p:StoryProgress,lifetime:number,q:StoryQuest,adventureStatus:(id:string)=>string|undefined):QuestStatus{
  if(p.completed.includes(q.id))return 'COMPLETED';
  const active=p.accepted[q.id];
  if(!active)return questUnlocked(c,q,p,lifetime)?'AVAILABLE':'LOCKED';
  if(q.objective.kind==='scene')return 'READY';
  if(active.wins<q.objective.wins)return 'ACTIVE';
  if(active.adventureId&&adventureStatus(active.adventureId)!=='RETURNED')return 'ACTIVE';
  return 'READY';
}
const checkpointKey=(s:SceneProgress)=>s.questId+':'+s.phase;
/** 장면 내용: 시작(intro)·귀환(return)·다시 보기(replay = 시작 + 귀환) */
export function sceneData(c:StoryContent,scene:SceneProgress):StoryScene{
  const q=findQuest(c,scene.questId),intro=c.scenes.find(s=>s.id===q.acceptScene),outro=c.scenes.find(s=>s.id===q.returnScene);
  if(!intro||!outro)return fail('STORY_SCENE_NOT_FOUND');
  return scene.phase==='replay'?{...intro,id:'replay:'+q.id,lines:[...intro.lines,...outro.lines]}:scene.phase==='return'?outro:intro;
}
/** 장면 열기. 저장해 둔 위치(checkpoint)부터 이어 본다. p를 바꾼다. */
export function storyOpen(c:StoryContent,p:StoryProgress,status:QuestStatus,questId:string,phase:SceneProgress['phase']){
  const q=findQuest(c,questId);
  if(phase==='intro'&&status!=='AVAILABLE'||phase==='return'&&status!=='READY'||phase==='replay'&&status!=='COMPLETED')return fail('STORY_SCENE_LOCKED');
  if(p.scene&&(p.scene.questId!==q.id||p.scene.phase!==phase))return fail('STORY_SCENE_ACTIVE');
  const next:SceneProgress={questId:q.id,phase,cursor:0},data=sceneData(c,next);
  next.cursor=Math.min(p.checkpoints[checkpointKey(next)]??0,data.lines.length-1);p.scene=next;
}
/** 다음 줄. 마지막 줄에서: 시작 장면은 수락 필요, 귀환 장면은 의뢰 완료(보상: 조각·석상 단계). 완료한 의뢰 id를 돌려준다. */
export function storyAdvance(c:StoryContent,p:StoryProgress,cursor:number,statusOf:(q:StoryQuest)=>QuestStatus):{completedQuestId?:string}{
  if(!p.scene||p.scene.cursor!==cursor)return fail('STORY_SCENE_STALE');
  const scene=sceneData(c,p.scene),q=findQuest(c,p.scene.questId);
  if(p.scene.cursor<scene.lines.length-1){p.scene.cursor++;p.checkpoints[checkpointKey(p.scene)]=p.scene.cursor;return {};}
  if(!p.readScenes.includes(scene.id))p.readScenes.push(scene.id);
  if(p.scene.phase==='intro')return fail('STORY_ACCEPT_REQUIRED');
  let completedQuestId:string|undefined;
  if(p.scene.phase==='return'){
    if(statusOf(q)!=='READY')return fail('STORY_OBJECTIVE_INCOMPLETE');
    if(!p.completed.includes(q.id)){p.completed.push(q.id);completedQuestId=q.id;
      if(q.fragmentBundle)p.fragments[q.fragmentBundle.id]=q.fragmentBundle.count;
      if(q.statueStageAfter)p.statueStage=Math.max(p.statueStage,q.statueStageAfter);
      if(q.id==='STORY_21')p.hatched=true;}
    delete p.accepted[q.id];
  }
  delete p.checkpoints[checkpointKey(p.scene)];p.scene=null;
  return {completedQuestId};
}
/** 의뢰 수락: 시작 장면의 마지막 줄에서만. 전투 경험치 정책을 수락 시점 값으로 고정한다. */
export function storyAccept(c:StoryContent,p:StoryProgress,status:QuestStatus,questId:string,token:string,unitXpPolicy:StoryUnitXpPolicy|null){
  const q=findQuest(c,questId);
  if(status!=='AVAILABLE'||p.scene?.phase!=='intro'||p.scene.questId!==q.id||p.scene.cursor!==sceneData(c,p.scene).lines.length-1)return fail('STORY_ACCEPT_NOT_READY');
  p.accepted[q.id]={token,wins:0,battles:[],unitXpPolicy:structuredClone(unitXpPolicy)};
  if(q.fragmentBundleOnAccept)p.fragments[q.fragmentBundleOnAccept.id]=q.fragmentBundleOnAccept.count;
  if(q.statueStageOnAccept)p.statueStage=Math.max(p.statueStage,q.statueStageOnAccept);
  const scene=sceneData(c,p.scene);if(!p.readScenes.includes(scene.id))p.readScenes.push(scene.id);
  delete p.checkpoints[checkpointKey(p.scene)];p.scene=null;
}
/** 장면 닫기: 지금 위치를 저장 */
export function storyClose(p:StoryProgress){if(p.scene){p.checkpoints[checkpointKey(p.scene)]=p.scene.cursor;p.scene=null;}}

// ── 화면용 상태(원본 dto) ──
export type StoryViewContext={revision:number;contentVersion:string;lifetime:number;adventureStatus:(id:string)=>string|undefined;
  /** 이 의뢰의 전투 중 ACTIVE·FINISHED인 가장 최근 전투 id */latestBattle:(questId:string,battles:string[])=>string|null;
  materialAdventure:{adventureId:string;status:string;activeBattleId:string|null;revision:number}|null;speakerNames:Record<string,string>};
export function storyView(c:StoryContent,p:StoryProgress,ctx:StoryViewContext){
  const quests=[] as {id:string;title:string;kind:'main'|'resident';chapter:number;status:Exclude<QuestStatus,'LOCKED'>;recommendedLevel:[number,number];npcId?:string;objective:{kind:'adventure_win'|'scene';wins:number;requiredWins:number};canDepart:boolean;adventureId:string|null;battleId:string|null}[];
  for(const q of c.quests){
    const status=questStatus(c,p,ctx.lifetime,q,ctx.adventureStatus);if(status==='LOCKED')continue;
    const active=p.accepted[q.id],battleId=active?.battles.length?ctx.latestBattle(q.id,active.battles):null;
    quests.push({id:q.id,title:q.title,kind:q.kind,chapter:q.chapter,status,recommendedLevel:q.recommendedLevel,npcId:q.npcId,objective:{kind:q.objective.kind,wins:active?.wins??0,requiredWins:q.objective.wins},
      canDepart:status==='ACTIVE'&&q.objective.kind==='adventure_win'&&(active?.wins??0)<q.objective.wins&&!battleId,adventureId:active?.adventureId??null,battleId});
  }
  const currentQuest=quests.find(q=>q.kind==='main'&&q.status!=='COMPLETED')??null;
  const residents=c.residents.map(npc=>{const q=c.quests.find(x=>x.npcId===npc.id),visible=q?quests.find(v=>v.id===q.id):null;
    return {id:npc.id,name:npc.name,role:npc.role,status:(visible?.status??'LOCKED') as QuestStatus,questId:visible?.id??null,dailyDialogue:npc.dailyDialogue,proposal:true};});
  const scene=p.scene?sceneData(c,p.scene):null,line=scene?.lines[p.scene!.cursor];
  const adventures=c.encounters.filter(e=>e.kind==='black'&&e.mode==='adventure'&&c.quests.some(q=>q.objective.encounterIds.includes(e.id)&&(p.accepted[q.id]||p.completed.includes(q.id)))).map(e=>({id:e.id,name:'흑화 갈매미 모험',level:e.level}));
  return {contentVersion:ctx.contentVersion,revision:ctx.revision,testValues:true,productionBalanceApproved:false,levelPolicy:'RECOMMENDATION_ONLY',
    statue:{stage:p.statueStage,fragments:Object.values(p.fragments).reduce((sum,n)=>sum+n,0),hatched:p.hatched,visualAssetStatus:'APPROVED_SHEET_NOT_MATERIALIZED'},
    currentQuest,quests,residents,history:quests.filter(q=>q.status==='COMPLETED').map(q=>({questId:q.id,title:q.title})),adventures,pendingDeparture:null,materialAdventure:ctx.materialAdventure,
    nextStoryHint:!currentQuest&&!p.hatched?'다음 이야기의 준비로, 모험에서 얻은 재료 기록을 확인하세요.':null,
    scene:p.scene&&scene&&line?{id:scene.id,questId:p.scene.questId,phase:p.scene.phase,cursor:p.scene.cursor,line:{...line,speaker:ctx.speakerNames[line.speakerId]??line.speakerId,speakerName:ctx.speakerNames[line.speakerId]??line.speakerId},last:p.scene.cursor===scene.lines.length-1,background:scene.background,camera:scene.camera??null}:null};
}
export type StoryView=ReturnType<typeof storyView>;

// ── 스토리 전투 ──
/** 출전할 조우 고르기(원본 createBattle 앞부분). 의뢰면 지금까지 이긴 수에 맞는 조우, 재료 모험이면 열린 흑화 모험 조우. */
export function storyBattleTarget(c:StoryContent,p:StoryProgress,b:{questId?:string;encounterId?:string},statusOf:(q:StoryQuest)=>QuestStatus):{encounter:StoryEncounter;quest?:StoryQuest;token?:string}{
  if(b.questId){
    const quest=findQuest(c,b.questId);
    if(statusOf(quest)!=='ACTIVE'||quest.objective.kind!=='adventure_win')return fail('STORY_QUEST_NOT_ACTIVE');
    const accepted=p.accepted[quest.id];
    if(accepted.unitXpPolicy&&accepted.wins>=quest.objective.wins)return fail('STORY_OBJECTIVE_AWAITING_RETURN');
    const encounter=c.encounters.find(e=>e.id===quest.objective.encounterIds[Math.min(accepted.wins,quest.objective.encounterIds.length-1)]);
    if(!encounter)return fail('STORY_ENCOUNTER_LOCKED');
    return {encounter,quest,token:accepted.token};
  }
  const encounter=c.encounters.find(e=>e.id===b.encounterId&&e.kind==='black'&&e.mode==='adventure');
  if(!encounter||!c.quests.some(q=>q.objective.encounterIds.includes(encounter.id)&&(p.accepted[q.id]||p.completed.includes(q.id))))return fail('STORY_ENCOUNTER_LOCKED');
  return {encounter};
}
/** 스토리 전투 하나만 담은 전투 정책(원본과 같음: 튜토리얼 아님, 고정 상대, 패배 경험치 0) */
export function storyBattlePolicy(base:BattlePolicy,e:StoryEncounter):BattlePolicy&{encounters:Encounter[]}{
  return {...base,encounters:[{id:e.id,speciesId:e.speciesId,level:e.level,tutorial:false,winXp:e.winXp??0,lossXp:0,mode:e.mode,fixedEnemy:true}]};
}
/** 스토리 상대: 악당은 전용 공격, 흑화는 그림 바꿈·이름 앞 「흑화 」, 체력·기술 위력 배율(반올림). */
export function storyEnemy(c:Catalog,villains:unknown,e:StoryEncounter,id='enemy'):Fighter&{artVariant?:'black'}{
  const enemy:Fighter&{artVariant?:'black'}=e.villainProfileId?storyVillainFighter(c,villains,e.villainProfileId,e.level,id):makeFighter(c,e.speciesId,e.level,id);
  if(e.kind==='black')enemy.artVariant='black';
  enemy.name=(e.kind==='black'?'흑화 ':'')+enemy.name;
  enemy.stats.hp=Math.round(enemy.stats.hp*(e.hpMultiplier??1));enemy.hp=enemy.stats.hp;
  for(const skill of [enemy.attack,...enemy.skills])skill.power=Math.round(skill.power*(e.powerMultiplier??1));
  return enemy;
}
export function storyBattleContext(c:StoryContent,e:StoryEncounter,questId:string|undefined,acceptToken:string|undefined,unitXpPolicy:StoryUnitXpPolicy|null):StoryBattleContext{
  return {version:'story-battle-v1',contentVersion:c.version,encounterId:e.id,speciesId:e.speciesId,kind:e.kind,mode:e.mode,questId,acceptToken,dropAmount:c.policy.darkGangPerWin,maxBalance:c.policy.maxBalance,unitXpPolicy:questId?unitXpPolicy:null};
}
/** 전투 경험치 조절 계획의 선택값(원본 RosterBattle.create). inAdventure: 모험 안 전투, story: 스토리 전투 정보, unitXpPolicy: 의뢰에 고정된 정책. */
export function battleXpPlanOptions(o:{inAdventure:boolean;story:StoryBattleContext|null;encounter:Encounter}){
  const policy=o.story?.unitXpPolicy??null,reward=policy?policy.rewards[o.encounter.id]:undefined;
  if(policy&&!reward)return fail('STORY_UNIT_XP_REWARD_MISSING');
  if(policy&&(o.encounter.winXp!==0||o.encounter.lossXp!==0||o.story!.encounterId!==o.encounter.id||o.story!.mode!==o.encounter.mode))return fail('STORY_UNIT_XP_CONTEXT_INVALID');
  return {sourceWinXp:reward?.winXp??o.encounter.winXp,sourceLossXp:reward?0:o.encounter.lossXp,baseline:(o.inAdventure&&!o.story?'per-entered':'total') as 'per-entered'|'total',
    reserveHalf:o.inAdventure&&!o.story,recipientMode:(o.inAdventure||reward?'entered':'initial-owned') as 'entered'|'initial-owned',requireSurvivor:o.inAdventure||!!reward,
    xpRecipient:o.inAdventure?'adventure-participation-100-reserve-50-v1':'initial-owned-existing-v1'};
}
/** 흑화 재료(어둠의 새우Gang) 지급량: 흑화 상대를 스토리·모험에서 항복 없이 이겼을 때만. 사람 악당·대전은 0. */
export function storyDarkGangAward(ctx:StoryBattleContext,outcome:string|null,surrendered:boolean){
  return outcome==='win'&&!surrendered&&ctx.kind==='black'&&['story','adventure'].includes(ctx.mode)?ctx.dropAmount:0;
}
/** 정산 시 스토리 기록 검사(원본 settleStoryBattle 앞부분) */
export function checkStoryBattleContext(ctx:StoryBattleContext,encounterId:string,enemySpeciesId:string,mode:string|undefined){
  if(ctx.version!=='story-battle-v1'||ctx.encounterId!==encounterId||ctx.speciesId!==enemySpeciesId||ctx.mode!==mode||!Number.isSafeInteger(ctx.dropAmount)||ctx.dropAmount<0||!Number.isSafeInteger(ctx.maxBalance)||ctx.maxBalance<0||ctx.maxBalance>2_000_000_000)return fail('STORY_BATTLE_SNAPSHOT_INVALID');
}

// ── 모험 ──
export const adventureCommanderEvidenceVersion='commander-adventure-evidence-v1';
/** 모험 전투 경험치(경험치 조절 정책이 없을 때 쓰는 원본 기본 경로): 출전 개체는 기본값 전부, 나머지는 절반(내림). 파티 수로 나누지 않는다. */
export function adventureBattleXp(baseXp:number,ownedIds:string[],enteredIds:string[]):Record<string,number>{
  if(!Number.isSafeInteger(baseXp)||baseXp<0||!ownedIds.length||new Set(ownedIds).size!==ownedIds.length||!enteredIds.length||enteredIds.some(id=>!ownedIds.includes(id)))return fail('INVALID_PARTICIPATION');
  const entered=new Set(enteredIds);
  return Object.fromEntries(ownedIds.map(id=>[id,entered.has(id)?baseXp:Math.floor(baseXp/2)]));
}
export type AdventureRewards={xp:Record<string,number>;currencies?:Partial<Record<'credits'|'snack'|'peanut',number>>;items?:Record<string,number>};
/** 저장된 모험 보상 검사(원본 checkedAdventureRewards). 화면에서 보상 값을 받지 않는다. */
export function checkedAdventureRewards(raw:unknown,itemIds:readonly string[]):AdventureRewards{
  if(!record(raw)||Object.keys(raw).some(k=>!['xp','currencies','items'].includes(k))||!record(raw.xp))return fail('INVALID_REWARD');
  for(const key of ['xp','currencies','items']){const v=raw[key];if(v===undefined&&key!=='xp')continue;if(!record(v))return fail('INVALID_REWARD');
    for(const [id,n] of Object.entries(v)){if(!id||['__proto__','constructor','prototype'].includes(id)||!Number.isSafeInteger(n)||Number(n)<0||Number(n)>2_000_000_000)return fail('INVALID_REWARD');
      if(key==='currencies'&&!['credits','snack','peanut'].includes(id))return fail('INVALID_REWARD');if(key==='items'&&!itemIds.includes(id))return fail('INVALID_REWARD_ITEM');}}
  return structuredClone(raw) as AdventureRewards;
}
