// GMM110 원본을 실제로 돌려 만든 기준 결과(fixtures/gmm110-parity.json)와 새 shared의 결과를 비교한다.
// 기준 결과 다시 만들기: tools/parity/generate.ts 맨 위 설명.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {growthAt,focusMp,instanceGrowthCurve} from '../src/rules.js';
import {fiveStatAttack,decideTurnOrder,fiveRebirthStats,requiredReincarnationLevel} from '../src/combat.js';
import {makeFighter,type Catalog,type Fighter} from '../src/catalog.js';
import {createBattleState,applyAction,selectEnemySpecies,adventureEscapeSucceeds,type BattlePolicy,type BattleState,type ItemDefinition} from '../src/battle.js';
import {RuleError} from '../src/errors.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-parity.json');
const catalog:Catalog=read('../../data/catalog.json');
const policy:BattlePolicy=read('../../data/battle-policy.json');
const items:Record<string,ItemDefinition>=read('../../data/items.json').items;
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
  it('환생 필요 레벨',()=>{for(const c of fx.pure.reincarnationLevel)expect(run(()=>requiredReincarnationLevel(c.n))).toEqual(c.r);});
});

const lean=(f:Fighter)=>({ownedId:f.ownedId,id:f.id,speciesId:f.speciesId,level:f.level,hp:f.hp,mp:f.mp});
describe('전투 진행이 GMM110과 같다(원본 전투 서비스 기록 재생)',()=>{
  const battles=fx.battles.filter((b:any)=>!b.createError);
  it('기록이 있다',()=>expect(battles.length).toBeGreaterThan(0));
  for(const [n,rec] of battles.entries()){
    it(`전투 ${n+1}: ${rec.encounterId}, ${rec.units.length}마리, 행동 ${rec.steps.length}개`,()=>{
      const encounter=policy.encounters.find(e=>e.id===rec.encounterId)!;
      const fighterOf=(u:any)=>{const def=catalog.characters.find(c=>c.id===u.speciesId)!;const lv=growthAt(u.totalXp,def.growth,u.reincarnation,def.reincarnationXpPolicy).level;return {...makeFighter(catalog,u.speciesId,lv,'self',u.reincarnation),ownedId:u.id};};
      const enemy=makeFighter(catalog,selectEnemySpecies(encounter,policy.encounters,rec.seed),encounter.level,'enemy');
      let state:BattleState=createBattleState({battleId:rec.battleId,seed:rec.seed,mode:encounter.mode,self:fighterOf(rec.units[0]),reserves:rec.units.slice(1).map(fighterOf),enemy,policy});
      // 시작 상태: 원본과 개체·순서가 같아야 함
      expect(json({mode:state.mode,decision:state.decision,fighters:state.fighters,reserves:state.reserves,participation:state.participation})).toEqual(rec.initial);
      const inventory:Record<string,number>={...rec.items};
      for(const [t,step] of rec.steps.entries()){
        const r=run(()=>applyAction(state,step.action,{policy,items,itemCount:id=>inventory[id]??0}));
        if(step.error){expect(r,`턴 ${t} ${JSON.stringify(step.action)}`).toEqual({error:step.error});continue;}
        expect(r.error,`턴 ${t} ${JSON.stringify(step.action)}`).toBeUndefined();
        const result=(r as any).ok;state=result.state;
        if(result.consumedItem)inventory[result.consumedItem]--;
        const last=state.rounds.at(-1)!;
        expect(json({turn:state.turn,outcome:state.outcome,surrendered:state.surrendered,decision:state.decision,participation:state.participation,
          fighters:state.fighters.map(lean),reserves:state.reserves.map(lean),lastRound:{...last},rounds:state.rounds.length}),`턴 ${t} ${JSON.stringify(step.action)}`)
          .toEqual(json({...step.state,lastRound:step.state.lastRound}));
        expect(inventory,`턴 ${t} 아이템 수`).toEqual(step.inventory);
        expect(result.finished,`턴 ${t} 끝남`).toBe(step.status==='FINISHED');
      }
    });
  }
});

describe('환생 성장 곡선',()=>{
  it('환생 0이면 원래 곡선과 같다',()=>{const u=catalog.characters[0];expect(instanceGrowthCurve(u.growth,0)).toEqual(u.growth);});
});
