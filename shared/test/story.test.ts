// 6단계(스토리·주민 의뢰·모험) 규칙이 GMM110과 같은지: fixtures/gmm110-story.json(원본 실행 기록)과 비교.
// 기준 결과 다시 만들기: tools/parity/generate-story.ts 맨 위 설명.
// 방법: 원본이 실제로 거친 요청 순서를 새 shared 함수로 그대로 다시 밟으며, 매 단계 화면용 상태·오류 코드·전투 상대·경험치·흑화 재료를 비교한다.
// 전투 한 판의 진행(턴 계산)은 2단계 비교 시험이 맡고, 여기서는 원본 전투가 끝난 상태를 입력으로 쓴다.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {
  validateStoryContent,storyVillainFighter,storySpeakerNames,questStatus,storyOpen,storyAdvance,storyAccept,storyClose,storyView,storyBattleTarget,storyBattlePolicy,storyEnemy,storyBattleContext,
  battleXpPlanOptions,storyDarkGangAward,adventureBattleXp,initialStoryProgress,validateStoryUnitXpPolicy,findQuest,type StoryContent,type StoryProgress,type StoryVillainDocument,type StoryQuest,
} from '../src/story.js';
import {createPacedBattleXpPlan,calculatePacedBattleXp} from '../src/xp.js';
import type {Catalog} from '../src/catalog.js';
import type {BattlePolicy} from '../src/battle.js';
import {RuleError} from '../src/errors.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-story.json');
const catalog:Catalog=read('../../data/catalog.json');
const policy:BattlePolicy=read('../../data/battle-policy.json');
const content:StoryContent=read('../../data/story/story-mode-v1.json');
const villains:StoryVillainDocument=read('../../data/story/villains-test-v1.json');
const unitXpPolicy=read('../../data/story-unit-xp-policy.json');
const run=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:e instanceof RuleError?e.code:(e as Error).message};}};
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));
// 기준 결과에서 줄여 적은 성장 곡선(growth:uXX)을 다시 펼침
const expand=(v:any):any=>JSON.parse(JSON.stringify(v),(k,x)=>k==='growth'&&typeof x==='string'&&x.startsWith('growth:')?catalog.characters.find(c=>c.id===x.slice(7))!.growth:x);
const speakers=storySpeakerNames(content,villains);
// 생성기와 같은 모양으로 줄인 화면 상태. revision은 뺀다(원본은 출발 예약·연결 단계마다 revision을 올리고, 새 서버는 한 번에 처리해서 횟수가 다름 — docs/ARCHITECTURE.md 6단계 기록).
const compact=(d:any)=>({contentVersion:d.contentVersion,statue:d.statue,currentQuest:d.currentQuest?.id??null,
  quests:d.quests.map((q:any)=>[q.id,q.status,q.objective.wins,q.objective.requiredWins,q.canDepart,q.adventureId,q.battleId]),
  residents:d.residents.map((r:any)=>[r.id,r.status,r.questId]),history:d.history.map((h:any)=>h.questId),adventures:d.adventures,
  pendingDeparture:d.pendingDeparture,materialAdventure:d.materialAdventure?{...d.materialAdventure,revision:undefined}:null,nextStoryHint:d.nextStoryHint,scene:d.scene});
const fromFixture=(v:any)=>({...compact({...v,quests:[],residents:[],history:[],currentQuest:null}),quests:v.quests,residents:v.residents,history:v.history,currentQuest:v.currentQuest,materialAdventure:v.materialAdventure?{...v.materialAdventure,revision:undefined}:null});

describe('스토리 콘텐츠·악당 검사가 GMM110과 같다',()=>{
  it('콘텐츠 검사(원본 그대로 + 한 군데씩 틀린 17가지)',()=>{
    const muts:Record<string,(c:any)=>void>={ok:()=>{},approved:c=>{c.productionBalanceApproved=true;},dropZero:c=>{c.policy.darkGangPerWin=0;},dupQuest:c=>{c.quests.push(structuredClone(c.quests[0]));},emptyLine:c=>{c.scenes[0].lines[0].text='';},
      lvl61:c=>{c.encounters[0].level=61;},hp2:c=>{c.encounters[0].hpMultiplier=2;},loss1:c=>{c.encounters[0].lossXp=1;},blackVillain:c=>{c.encounters[0].villainProfileId='record';},badUnlock:c=>{c.quests[1].unlockAfter=['NOPE'];},
      winsMismatch:c=>{c.quests[0].objective.wins=2;},sceneWins:c=>{c.quests.find((q:any)=>q.objective.kind==='scene').objective.wins=1;},statue6:c=>{c.quests[0].statueStageAfter=6;},bundle0:c=>{c.quests[0].fragmentBundle.count=0;},
      gateUnknown:c=>{c.policy.mainLifetimeGates.NOPE=1;},lifetimeOver:c=>{c.quests[0].darkGangLifetimeRequired=c.policy.maxBalance+1;},noScene:c=>{c.quests[0].acceptScene='nope';}};
    expect(fx.pure.content.length).toBe(Object.keys(muts).length);
    for(const c of fx.pure.content){const x=structuredClone(content);muts[c.name](x);expect(run(()=>{validateStoryContent(x);return true;}),c.name).toEqual(c.r);}
  });
  it('악당 전투 개체(프로필 7 × 레벨 7)',()=>{for(const c of fx.pure.villain)expect(json(run(()=>storyVillainFighter(catalog,villains,c.id,c.lv,'enemy'))),`${c.id} Lv${c.lv}`).toEqual(c.r);});
  it('모험 기본 경험치(출전 100%·대기 50%)',()=>{for(const c of fx.pure.adventureXp)expect(run(()=>adventureBattleXp(c.base,c.owned,c.entered))).toEqual(c.r);});
  it('스토리 전투 경험치 정책은 유효',()=>expect(()=>validateStoryUnitXpPolicy(unitXpPolicy,catalog.version,content.version,[...new Set(content.quests.flatMap(q=>q.objective.encounterIds))])).not.toThrow());
});

/** 원본 전투가 끝난 상태(줄여 적은 것)를 경험치 계산 입력 모양으로 */
const finalState=(f:any)=>({outcome:f.outcome,surrendered:f.surrendered,participation:f.participation,fighters:f.fighters,reserves:f.reserves,rounds:[{turn:0,events:f.switches.map((s:any)=>({actor:'self',...s}))}]}) as any;
const planFields=(p:any)=>({sourceWinXp:p.sourceWinXp,sourceLossXp:p.sourceLossXp,baseline:p.baseline,reserveHalf:p.reserveHalf,recipientMode:p.recipientMode,requireSurvivor:p.requireSurvivor});

for(const rec of fx.runs)describe(`원본 진행 다시 밟기: ${rec.name} 파티 (${rec.ops.length}단계)`,()=>{
  it('매 단계 상태·오류·전투 상대·경험치·흑화 재료가 같다',()=>{
    const p:StoryProgress=initialStoryProgress();let lifetime=0,tokenNo=0;
    const adv=new Map<string,string>(),pending=new Map<string,Record<string,number>>();
    const statusOf=(q:StoryQuest)=>questStatus(content,p,lifetime,q,id=>adv.get(id));
    const view=()=>compact(storyView(content,p,{revision:0,contentVersion:content.version,lifetime,adventureStatus:id=>adv.get(id),latestBattle:()=>null,
      materialAdventure:p.materialAdventureId&&adv.get(p.materialAdventureId)==='ACTIVE'?{adventureId:p.materialAdventureId,status:'ACTIVE',activeBattleId:null,revision:0}:null,speakerNames:speakers}));
    for(const [i,op] of rec.ops.entries()){
      const at=`${i}: ${op.op} ${op.questId??op.encounterId??''}`;
      const mutate=(fn:()=>void)=>{const before=structuredClone(p);const r=run(fn);if('error' in r)Object.assign(p,before);return r;};
      let r:{ok?:unknown;error?:string}={ok:true};
      if(op.op==='state'){expect(view(),at).toEqual(fromFixture(op.view));continue;}
      if(op.op==='open-stale'){expect(op.error,at).toBe('STORY_STALE_REVISION');continue;} // 낡은 revision 거절은 서버 시험에서 확인
      if(op.op==='open')r=mutate(()=>{const q=findQuest(content,op.questId);storyOpen(content,p,statusOf(q),op.questId,op.phase);});
      else if(op.op==='advance')r=mutate(()=>{storyAdvance(content,p,op.cursor,statusOf);});
      else if(op.op==='accept')r=mutate(()=>{const q=findQuest(content,op.questId);storyAccept(content,p,statusOf(q),op.questId,'t'+(tokenNo++),unitXpPolicy);});
      else if(op.op==='close')r=mutate(()=>storyClose(p));
      else if(op.op==='battle'||op.op==='material'){
        if(op.op==='material'&&op.error==='INVALID_PARTY'){expect(op.ownedIds.length,at).toBe(0);continue;}
        const target=run(()=>storyBattleTarget(content,p,op.op==='battle'?{questId:op.questId}:{encounterId:op.encounterId},statusOf)) as any;
        if(op.error){expect(target.error??'(통과)',at).toBe(op.error);continue;}
        expect(target.error,at).toBeUndefined();const {encounter,quest}=target.ok;const b=op.battle;
        expect(encounter.id,at).toBe(b.encounter.id);
        expect(storyBattlePolicy(policy,encounter).encounters[0],at).toEqual(b.encounter);
        const enemy=storyEnemy(catalog,villains,encounter);
        expect(json(enemy),`${at} 상대`).toEqual(b.enemy);
        const accepted=quest?p.accepted[quest.id]:undefined;
        const ctx=storyBattleContext(content,encounter,quest?.id,undefined,accepted?.unitXpPolicy??null);
        expect(json({...ctx,acceptToken:undefined}),`${at} 스토리 기록`).toEqual(b.story);expect(b.hasToken,at).toBe(!!quest);
        const inAdventure=!!b.adventureId,opts=battleXpPlanOptions({inAdventure,story:ctx,encounter:b.encounter});
        expect(planFields(opts),`${at} 경험치 계획`).toEqual(planFields(b.unitXpPacing));expect(opts.xpRecipient,at).toBe(b.xpRecipient);
        // 전투 연결
        if(accepted){accepted.battles.push('B');if(b.adventureId)accepted.adventureId=b.adventureId;}
        if(!quest&&b.adventureId)p.materialAdventureId=b.adventureId;
        if(b.adventureId&&!adv.has(b.adventureId)){adv.set(b.adventureId,'ACTIVE');pending.set(b.adventureId,{});}
        // 정산
        const fin=op.final,award=storyDarkGangAward(ctx,fin.outcome,fin.surrendered);
        lifetime+=award;expect(lifetime,`${at} 흑화 재료 누적`).toBe(op.account.darkGangLifetime);expect(op.settlement.story.darkGangAwarded,at).toBe(award);
        if(accepted&&fin.outcome==='win'&&!fin.surrendered)accepted.wins++;
        const plan=createPacedBattleXpPlan(expand({...b.unitXpPacing,version:undefined}));
        const before=b.adventureId?pending.get(b.adventureId)!:{};
        const effective=b.adventureId?Object.fromEntries(plan.members.map(m=>[m.ownedId,(BigInt(m.startingXp)+BigInt(before[m.ownedId]??0)).toString()])):undefined;
        const reward=calculatePacedBattleXp(plan,b.self[0].ownedId,finalState(fin),effective);
        expect(reward.xpByOwnedId,`${at} 경험치`).toEqual(op.settlement.xpByOwnedId);
        if(b.adventureId){
          const lost=[...fin.fighters.slice(0,1),...fin.reserves].every((f:any)=>f.hp<=0);
          const next=lost?{}:Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(reward.xpByOwnedId)])].map(id=>[id,(before[id]??0)+(reward.xpByOwnedId[id]??0)]));
          pending.set(b.adventureId,next);adv.set(b.adventureId,lost?'LOST':'ACTIVE');
          expect(op.adventure.status,at).toBe(lost?'LOST':'ACTIVE');expect(op.adventure.pendingRewards.xp,`${at} 귀환 때 받을 경험치`).toEqual(next);
        }
        continue;
      }
      else if(op.op==='return'){
        expect(op.error,at).toBeUndefined();expect(op.result.status,at).toBe('RETURNED');
        expect(op.result.settlement.rewards.xp,`${at} 귀환 보상`).toEqual(pending.get(op.adventureId));
        adv.set(op.adventureId,'RETURNED');pending.set(op.adventureId,{});continue;
      }
      else throw Error('모르는 단계 '+op.op);
      expect(r.error,at).toBe(op.error);
      if(!op.error)expect(view(),at).toEqual(fromFixture(op.view));
    }
    expect(view()).toEqual(fromFixture(rec.final));
  });
});

describe('직접 만든 시작 상태(흑화 재료 누적 조건·석상 단계·조각·부화)가 GMM110과 같다',()=>{
  for(const c of fx.pure.crafted)it(c.name,()=>{
    const p:StoryProgress=structuredClone(c.progress);
    const statusOf=(q:StoryQuest)=>questStatus(content,p,c.lifetime,q,()=>undefined);
    const view=()=>compact(storyView(content,p,{revision:0,contentVersion:content.version,lifetime:c.lifetime,adventureStatus:()=>undefined,latestBattle:()=>null,materialAdventure:null,speakerNames:speakers}));
    expect(view()).toEqual(fromFixture(c.views[0]));
    if(c.finish){storyOpen(content,p,statusOf(findQuest(content,c.finish)),c.finish,'return');while(p.scene)storyAdvance(content,p,p.scene.cursor,statusOf);expect(view()).toEqual(fromFixture(c.views[1]));}
  });
});

describe('일반 모험(스토리 아님)이 GMM110과 같다',()=>{
  for(const [n,g] of fx.pure.generic.entries())it(`모험 ${n+1}: ${g.units.length}마리, 전투 ${g.battles.length}판`,()=>{
    let pending:Record<string,number>={};let lost=false;
    for(const b of g.battles){
      if(b.error)continue;
      const opts=battleXpPlanOptions({inAdventure:true,story:null,encounter:policy.encounters.find(e=>e.id==='adventure-1')!});
      expect(planFields(opts)).toEqual(planFields(b.unitXpPacing));expect(opts.xpRecipient).toBe(b.xpRecipient);
      const plan=createPacedBattleXpPlan(expand({...b.unitXpPacing,version:undefined}));
      const effective=Object.fromEntries(plan.members.map(m=>[m.ownedId,(BigInt(m.startingXp)+BigInt(pending[m.ownedId]??0)).toString()]));
      const start=b.final.participation[0].ownedId,reward=calculatePacedBattleXp(plan,start,finalState(b.final),effective);
      expect(reward.xpByOwnedId).toEqual(b.settlement.xpByOwnedId);
      lost=[b.final.fighters[0],...b.final.reserves].every((f:any)=>f.hp<=0);
      pending=lost?{}:Object.fromEntries([...new Set([...Object.keys(pending),...Object.keys(reward.xpByOwnedId)])].map(id=>[id,(pending[id]??0)+(reward.xpByOwnedId[id]??0)]));
      expect(b.adventure.pendingRewards.xp).toEqual(pending);expect(b.adventure.status).toBe(lost?'LOST':'ACTIVE');
    }
    if(g.returned){expect(g.returned.settlement.rewards.xp).toEqual(pending);
      for(const u of g.units)expect(g.ownedAfter.find((o:any)=>o.id===u.id).totalXp).toBe(u.totalXp+(pending[u.id]??0));}
  });
});
