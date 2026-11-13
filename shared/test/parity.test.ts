// GMM110 원본을 실제로 돌려 만든 기준 결과(fixtures/gmm110-parity.json)와 새 shared의 결과를 비교한다.
// 기준 결과 다시 만들기: tools/parity/generate.ts 맨 위 설명.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {growthAt,focusMp,instanceGrowthCurve} from '../src/rules.js';
import {fiveStatAttack,decideTurnOrder,fiveRebirthStats,requiredReincarnationLevel} from '../src/combat.js';
import {makeFighter,type Catalog,type Fighter} from '../src/catalog.js';
import {createBattleState,applyAction,selectEnemySpecies,adventureEscapeSucceeds,type BattlePolicy,type BattleState,type ItemDefinition} from '../src/battle.js';
import {RuleError} from '../src/errors.js';
import {grantXp,pacedUnitWin,createPacedBattleXpPlan,calculatePacedBattleXp,unitXpProgress,type UnitXpPacing} from '../src/xp.js';
import {observedOpponentIntel,battleKnowledge,opponentFighter,publicDefenseSafe,type DefenseObservation} from '../src/intel.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-parity.json');
const catalog:Catalog=read('../../data/catalog.json');
const policy:BattlePolicy=read('../../data/battle-policy.json');
const items:Record<string,ItemDefinition>=read('../../data/items.json').items;
const xpPacing:UnitXpPacing=read('../../data/unit-xp-pacing-policy.json');
const run=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:e instanceof RuleError?e.code:(e as Error).message};}};
// 원본 JSON 왕복과 같은 모양으로 맞춤(undefined 필드 제거)
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));

describe('순수 함수가 GMM110과 같다',()=>{
  it('growthAt',()=>{for(const c of fx.pure.growthAt){const u=catalog.characters.find(x=>x.id===c.id)!;expect(json(run(()=>growthAt(c.xp,u.growth,c.rc,u.reincarnationXpPolicy))),`${c.id} rc${c.rc} xp${c.xp}`).toEqual(c.r);}});
  it('fiveStatAttack',()=>{for(const c of fx.pure.attack)expect(json(run(()=>fiveStatAttack(c.inp,catalog.combatPolicy,(b,f)=>b*f)))).toEqual(c.r);});
  it('decideTurnOrder',()=>{for(const c of fx.pure.order)expect(json(run(()=>decideTurnOrder(c.bid,c.turn,[{id:'self',baseSpeed:c.a,modifiers:[]},{id:'enemy',baseSpeed:c.b,modifiers:[]}],c.seed)))).toEqual(c.r);});
  it('fiveRebirthStats',()=>{for(const c of fx.pure.rebirth){const u=catalog.characters.find(x=>x.id===c.id)!;expect(json(run(()=>fiveRebirthStats(u.levelOneStats,u.combatGrowth[29],c.c)))).toEqual(c.r);}});
  it('전투 개체 만들기(60종 × 레벨 × 환생)',()=>{for(const c of fx.pure.fighters)expect(json(run(()=>makeFighter(catalog,c.id,c.lv,'self',c.rc))),`${c.id} Lv${c.lv} rc${c.rc}`).toEqual(c.r);});
  it('상대 종 고르기',()=>{for(const c of fx.pure.enemy){const e=policy.encounters.find(x=>x.id===c.id)!;expect(run(()=>selectEnemySpecies(e,policy.encounters,c.seed))).toEqual(c.r);}});
  it('모험 도망 판정',()=>{for(const c of fx.pure.escape)expect(run(()=>adventureEscapeSucceeds(c.seed,c.bid,c.turn))).toEqual(c.r);});
  it('집중 MP 회복',()=>{for(const c of fx.pure.focus)expect(json(run(()=>focusMp(c.mp,c.max)))).toEqual(c.r);});
  it('경험치 지급(상한에서 버림)',()=>{for(const c of fx.pure.grant){const u=catalog.characters.find(x=>x.id===c.id)!;expect(json(run(()=>grantXp({startingXp:String(c.start),growth:u.growth,reincarnation:c.rc,reincarnationXpPolicy:u.reincarnationXpPolicy},c.req))),`${c.id} rc${c.rc} ${c.start}+${c.req}`).toEqual(c.r);}});
  it('1승 경험치(두 번 이기면 한 레벨)',()=>{for(const c of fx.pure.pacedWin){const u=catalog.characters.find(x=>x.id===c.id)!;expect(run(()=>pacedUnitWin({startingXp:String(c.start),growth:u.growth,reincarnation:c.rc,reincarnationXpPolicy:u.reincarnationXpPolicy},c.enemyLevel,xpPacing))).toEqual(c.r);}});
  it('환생 필요 레벨',()=>{for(const c of fx.pure.reincarnationLevel)expect(run(()=>requiredReincarnationLevel(c.n))).toEqual(c.r);});
});

const lean=(f:Fighter)=>({ownedId:f.ownedId,id:f.id,speciesId:f.speciesId,level:f.level,hp:f.hp,mp:f.mp});
describe('전투 진행·관측·정산이 GMM110과 같다(원본 전투 서비스 기록 재생)',()=>{
  const battles=fx.battles.filter((b:any)=>!b.createError);
  it('기록이 있다',()=>expect(battles.length).toBeGreaterThan(0));
  // 플레이어별로 저장되는 방어 관측(원본 Roster60ObservedDefense: 같은 열쇠면 마지막 반응으로 덮어씀)
  const stored=new Map<number,Map<string,{speciesId:string;profileKey:string;element:string;reaction:string}>>();
  for(const [n,rec] of battles.entries()){
    it(`전투 ${n+1}: 플레이어 ${rec.player} ${rec.round+1}판째, ${rec.encounterId}, ${rec.units.length}마리, 행동 ${rec.steps.length}개`,()=>{
      const encounter=policy.encounters.find(e=>e.id===rec.encounterId)!;
      const defOf=(id:string)=>catalog.characters.find(c=>c.id===id)!;
      const fighterOf=(u:any)=>{const def=defOf(u.speciesId);const lv=growthAt(u.totalXp,def.growth,u.reincarnation,def.reincarnationXpPolicy).level;return {...makeFighter(catalog,u.speciesId,lv,'self',u.reincarnation),ownedId:u.id};};
      const enemy=makeFighter(catalog,selectEnemySpecies(encounter,policy.encounters,rec.seed),encounter.level,'enemy');
      // 저장된 관측에서 이번 상대 종의 시작 지식(원본 captureDefenseSnapshot과 같은 규칙)
      const mine=stored.get(rec.player)??new Map();
      const initial:Record<string,Record<string,string>>={};
      for(const o of mine.values())if(rec.observedDefense.profiles[o.speciesId]===o.profileKey&&o.speciesId===enemy.speciesId)(initial[o.speciesId]??={})[o.element]=o.reaction;
      expect(json(rec.observedDefense.initial.self??{}),'시작 지식').toEqual(initial);
      const snapshot=rec.observedDefense;
      let state:BattleState=createBattleState({battleId:rec.battleId,seed:rec.seed,mode:encounter.mode,self:fighterOf(rec.units[0]),reserves:rec.units.slice(1).map(fighterOf),enemy,policy});
      expect(json({mode:state.mode,decision:state.decision,fighters:state.fighters,reserves:state.reserves,participation:state.participation})).toEqual(rec.initial);
      const intelNow=()=>json(observedOpponentIntel(state.fighters[1],state.turn,snapshot,battleKnowledge(snapshot,state.rounds,'self'),catalog));
      expect(intelNow(),'시작 공개 정보').toEqual(rec.initialIntel);
      const inventory:Record<string,number>={...rec.items};
      const observations:DefenseObservation[]=[];
      for(const [t,step] of rec.steps.entries()){
        const label=`턴 ${t} ${JSON.stringify(step.action)}`;
        const r=run(()=>applyAction(state,step.action,{policy,items,itemCount:id=>inventory[id]??0,defense:{snapshot,catalog}}));
        if(step.error){expect(r,label).toEqual({error:step.error});continue;}
        expect(r.error,label).toBeUndefined();
        const result=(r as any).ok;state=result.state;observations.push(...result.observations);
        if(result.consumedItem)inventory[result.consumedItem]--;
        expect(json({turn:state.turn,outcome:state.outcome,surrendered:state.surrendered,decision:state.decision,participation:state.participation,
          fighters:state.fighters.map(lean),reserves:state.reserves.map(lean),lastRound:state.rounds.at(-1),rounds:state.rounds.length}),label).toEqual(step.state);
        expect(inventory,label+' 아이템 수').toEqual(step.inventory);
        expect(result.finished,label+' 끝남').toBe(step.status==='FINISHED');
        const intel=observedOpponentIntel(state.fighters[1],state.turn,snapshot,battleKnowledge(snapshot,state.rounds,'self'),catalog);
        expect(json(intel),label+' 공개 정보').toEqual(step.intel);
        expect(json(publicDefenseSafe(opponentFighter(state.fighters[1],intel))),label+' 공개 상대').toEqual(step.publicEnemy);
      }
      // 정산: 같은 계획·같은 분배
      const members=rec.units.map((u:any)=>({ownedId:u.id,playerId:'P',startingXp:String(u.totalXp),growth:defOf(u.speciesId).growth,reincarnation:u.reincarnation,reincarnationXpPolicy:defOf(u.speciesId).reincarnationXpPolicy}));
      const plan=createPacedBattleXpPlan({battleId:rec.battleId,playerId:'P',policy:xpPacing,enemyLevel:enemy.level,sourceWinXp:encounter.winXp,sourceLossXp:encounter.lossXp,baseline:'total',reserveHalf:false,recipientMode:'initial-owned',requireSurvivor:false,members});
      const strip=(p:any)=>({...p,playerId:'P',members:p.members.map((m:any)=>({...m,playerId:'P'}))});
      expect(json(plan),'경험치 계획').toEqual(strip(rec.unitXpPacing));
      const reward=calculatePacedBattleXp(plan,rec.units[0].id,state);
      const units=reward.units.map(u=>{const m=plan.members.find(x=>x.ownedId===u.ownedId)!,xpProgress=unitXpProgress(m,u.endingXp,u.startingXp);return {...u,...(xpProgress?{xpProgress}:{})};});
      const primary=reward.units.find(u=>u.ownedId===rec.units[0].id)!;
      expect(json({outcome:state.outcome,xpAwarded:reward.xpAccepted,xpDiscarded:reward.xpDiscarded,xpDeferred:0,xpByOwnedId:reward.xpByOwnedId,totalXp:primary.endingXp,policyVersion:plan.policy.version,unitXp:{...reward,units,delivery:'immediate'}}),'정산').toEqual(rec.settlement);
      expect(rec.ownedAfter.map((o:any)=>o.totalXp),'정산 뒤 경험치').toEqual(reward.units.map(u=>Number(u.endingXp)));
      // 저장되는 관측(열쇠가 있는 것만)
      for(const o of observations)if(o.profileKey)mine.set([o.speciesId,o.profileKey,o.element].join('|'),{speciesId:o.speciesId,profileKey:o.profileKey,element:o.element,reaction:o.reaction});
      stored.set(rec.player,mine);
      const sorted=[...mine.values()].sort((a,b)=>a.speciesId.localeCompare(b.speciesId)||a.element.localeCompare(b.element));
      expect(sorted,'저장된 관측').toEqual(rec.observedAfter);
    });
  }
});

describe('환생 성장 곡선',()=>{
  it('환생 0이면 원래 곡선과 같다',()=>{const u=catalog.characters[0];expect(instanceGrowthCurve(u.growth,0)).toEqual(u.growth);});
});
