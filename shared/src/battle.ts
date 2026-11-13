// 60종 PvE 전투 한 턴 처리(순수 함수). DB·네트워크·아이템 차감은 서버가 맡는다.
// 출처: GMM110 src/roster60-battle.ts RosterBattle.action()의 계산 부분 (커밋 0b0fb8b5).
// 원본은 계산과 DB 쓰기가 한 함수에 섞여 있었다. 여기서는 계산만 떼어 냈고, 순서·수식·오류 코드는 같다.
// 방어 관측은 ctx.defense를 넘길 때만 기록(intel.ts). 아직 옮기지 않은 것: 연출용 presentation 스냅샷(화면이 사건으로 직접 그림).
import {fail} from './errors.js';
import {sha256,hmacHex} from './hash.js';
import {focusMp,spendMp} from './rules.js';
import {fiveStatAttack,decideTurnOrder,reuseTurnOrder,validateFiveCombatPolicy,type FiveCombatPolicy,type TurnOrderDecision} from './combat.js';
import type {Catalog,Fighter,Skill} from './catalog.js';
import {battleKnowledge,resolvedDefenseObservation,addDefenseObservation,type DefenseObservation,type DefenseSnapshot} from './intel.js';

export type BattleMode='story'|'duel'|'adventure';
export type Encounter={id:string;speciesId:string;level:number;tutorial:boolean;winXp:number;lossXp:number;mode?:BattleMode;enemySpeciesIds?:string[];fixedEnemy?:boolean};
export type BattlePolicy={approved:boolean;version:string;catalogVersion:string;calculation:FiveCombatPolicy;reflection:'return-post-durability';enemyStrategy:'first-affordable'|'best-affordable';maxRounds:number;encounters:Encounter[]};
export type ItemDefinition={name:string;price:number;heal?:number;revive?:number;cleanse?:boolean;desc:string};
export type BattleAction={kind:'attack'|'skill'|'focus'|'switch'|'item'|'escape';skillId?:string;targetOwnedId?:string;itemId?:string};
export type BattleEvent=
  |{actor:'self';kind:'surrender'|'escape-success'|'escape-failed'}
  |{actor:'self';kind:'switch'|'forced-switch';from?:string;to?:string}
  |{actor:'self';kind:'item';itemId:string;targetOwnedId?:string;recovered:number}
  |{actor:'self'|'enemy';kind:'focus';recovered:number}
  |({actor:'self'|'enemy';kind:'skill';skillId:string;defenseObservation?:DefenseObservation}&ReturnType<typeof fiveStatAttack>);
export type Round={turn:number;decision?:TurnOrderDecision;events:BattleEvent[]};
export type Outcome='win'|'loss'|'draw'|'escaped';
export type BattleState={
  version:'five-battle-v1';battleId:string;seed:string;mode?:BattleMode;
  turn:number;fighters:[Fighter,Fighter];reserves:Fighter[];decision:TurnOrderDecision;
  outcome:Outcome|null;surrendered?:boolean;rounds:Round[];
  participation:{ownedId:string;kind:'start'|'switch'|'forced-switch';turn:number}[];
};
export type TurnContext={policy:BattlePolicy;items:Record<string,ItemDefinition>;
  /** 서버가 확인한 보유 수량. 0이면 ITEM_UNAVAILABLE. */
  itemCount:(itemId:string)=>number;
  /** 방어 관측(선택). 없으면 관측을 기록하지 않음. */
  defense?:{snapshot?:DefenseSnapshot;catalog:Catalog|null}};
export type TurnResult={state:BattleState;consumedItem?:string;finished:boolean;observations:DefenseObservation[]};

// 모험 전투 도망 성공률 70% (GMM110 adventureEscapePolicy)
export const adventureEscapePolicy=Object.freeze({version:'adventure-escape-70-v1',successPercent:70});
export function adventureEscapeSucceeds(seed:string,battleId:string,turn:number){
  if(!seed||!battleId||!Number.isSafeInteger(turn)||turn<0)fail('INVALID_ESCAPE_SEED');
  return sha256(JSON.stringify([adventureEscapePolicy.version,seed,battleId,turn])).readUInt32BE(0)/4294967296<.7;
}
/** 상대 종 고르기: 튜토리얼·스토리·고정 적은 지정 종, 그 밖에는 후보 중 씨앗 해시 순위 1등. */
export function selectEnemySpecies(encounter:Encounter,encounters:readonly Encounter[],seed:string):string{
  if(encounter.tutorial||encounter.mode==='story'||encounter.fixedEnemy||!encounter.mode)return encounter.speciesId;
  const pool=[...new Set(encounter.enemySpeciesIds??encounters.filter(e=>e.mode===encounter.mode&&!e.tutorial&&!e.fixedEnemy).map(e=>e.speciesId))].sort();
  if(!pool.length)fail('ENEMY_POOL_EMPTY');
  return pool.sort((a,b)=>{
    const rank=(species:string)=>hmacHex(seed,JSON.stringify(['random-ai-enemy-v1',encounter.id,species]));
    return rank(a).localeCompare(rank(b));
  })[0];
}
function order(state:Pick<BattleState,'battleId'|'seed'|'turn'|'fighters'>){
  const f=(i:number)=>({id:state.fighters[i].id,baseSpeed:state.fighters[i].stats.speed,modifiers:[] as number[]});
  return decideTurnOrder(state.battleId,state.turn,[f(0),f(1)],state.seed);
}
/** 새 전투 상태. self = 출전 개체(id 'self'), enemy = 상대(id 'enemy'). */
export function createBattleState(input:{battleId:string;seed:string;mode?:BattleMode;self:Fighter;reserves:Fighter[];enemy:Fighter;policy:BattlePolicy}):BattleState{
  validateFiveCombatPolicy(input.policy.calculation);
  if(input.self.id!=='self'||input.enemy.id!=='enemy'||!input.self.ownedId)fail('INVALID_PARTY');
  if(input.reserves.length>2)fail('INVALID_PARTY');
  const base={battleId:input.battleId,seed:input.seed,turn:0,fighters:[structuredClone(input.self),structuredClone(input.enemy)] as [Fighter,Fighter]};
  return {version:'five-battle-v1',...base,mode:input.mode,reserves:structuredClone(input.reserves),decision:order(base),outcome:null,rounds:[],
    participation:[{ownedId:input.self.ownedId!,kind:'start',turn:0}]};
}
/** 상대 AI의 기술 고르기(정책에 고정). undefined면 집중. */
export function chooseEnemySkill(self:Fighter,enemy:Fighter,policy:BattlePolicy):Skill|undefined{
  let enemySkill=[enemy.attack,...enemy.skills].find(s=>s.mpCost<=enemy.mp);
  if(policy.enemyStrategy==='best-affordable'){
    const score=(sk:Skill)=>fiveStatAttack({power:sk.power,level:enemy.level,durability:self.stats.durability,suitability:enemy.suitability[sk.element],defense:self.defense[sk.element],attackerHp:enemy.hp,defenderHp:self.hp},policy.calculation,(b,f)=>b*f);
    const usable=[enemy.attack,...enemy.skills].filter(sk=>sk.mpCost<=enemy.mp);
    usable.sort((a,b)=>{const x=score(a),y=score(b);return (y.reflected?-y.damage:y.damage)-(x.reflected?-x.damage:x.damage)||a.mpCost-b.mpCost;});
    enemySkill=usable[0];
    const bestNow=enemySkill?score(enemySkill).damage:0;
    const afterFocus=focusMp(enemy.mp,enemy.stats.mp).mp;
    // 집중 한 번 뒤에 지금 최선의 두 배보다 센 기술을 쓸 수 있으면 이번 턴은 집중
    if(enemy.skills.some(sk=>sk.mpCost>enemy.mp&&sk.mpCost<=afterFocus&&!score(sk).reflected&&score(sk).damage>2*bestNow))enemySkill=undefined;
  }
  return enemySkill;
}
/** 플레이어 행동 하나를 처리해 다음 상태를 돌려준다. 입력 상태는 바꾸지 않는다. */
export function applyAction(input:BattleState,action:BattleAction,ctx:TurnContext):TurnResult{
  if(input.outcome)fail('BATTLE_FINISHED');
  const state=structuredClone(input);
  if(state.fighters[0].hp<=0&&action.kind!=='switch')fail('FORCED_SWITCH_REQUIRED');
  const events:BattleEvent[]=[];let actionConsumed=false,consumedItem:string|undefined;
  if(action.kind==='escape'){
    if(!['story','duel','adventure'].includes(state.mode??''))fail('ESCAPE_POLICY_PENDING');
    const adventure=state.mode==='adventure';
    if(adventure&&state.fighters[0].hp<=0)fail('FORCED_SWITCH_POLICY_PENDING');
    const escaped=adventure&&adventureEscapeSucceeds(state.seed,state.battleId,state.turn);
    if(!adventure||escaped){
      state.surrendered=!adventure;state.outcome=adventure?'escaped':'loss';
      state.rounds.push({turn:state.turn,events:[{actor:'self',kind:adventure?'escape-success':'surrender'}]});
      return {state,finished:true,observations:[]};
    }
    actionConsumed=true;events.push({actor:'self',kind:'escape-failed'});
  }
  if(action.kind==='switch'){
    const forced=state.fighters[0].hp<=0;
    const ix=state.reserves.findIndex(f=>f.ownedId===action.targetOwnedId);
    if(ix<0||!state.reserves[ix].hp)fail('INVALID_SWITCH');
    const outgoing=state.fighters[0];
    state.fighters[0]=state.reserves[ix];state.reserves[ix]=outgoing;actionConsumed=true;
    state.participation.push({ownedId:state.fighters[0].ownedId!,kind:forced?'forced-switch':'switch',turn:state.turn});
    events.push({actor:'self',kind:forced?'forced-switch':'switch',from:outgoing.ownedId,to:state.fighters[0].ownedId});
    // 쓰러져서 바꾸는 교체는 턴을 쓰지 않음: 순서만 다시 정하고 끝
    if(forced){state.decision=order(state);state.rounds.push({turn:state.turn,events});return {state,finished:false,observations:[]};}
  }
  if(action.kind==='item'){
    const itemId=action.itemId??'',it=Object.prototype.hasOwnProperty.call(ctx.items,itemId)?ctx.items[itemId]:null;
    if(!it)return fail('INVALID_ITEM');
    const active=state.fighters[0],target=it.revive?[active,...state.reserves].find(f=>f.ownedId===action.targetOwnedId):active;
    if(!target||(!it.revive&&action.targetOwnedId&&action.targetOwnedId!==active.ownedId))fail('INVALID_ITEM_TARGET');
    if(it.revive?target!.hp>0:active.hp<=0)fail('INVALID_ITEM_TARGET');
    if(!it.revive&&!it.heal)fail('NO_STATUS_TO_CLEANSE');
    if(it.heal&&active.hp>=active.stats.hp)fail('HP_FULL');
    if(active.hp<=0&&target!==active)fail('ACTIVE_UNIT_FAINTED');
    if(ctx.itemCount(itemId)<=0)fail('ITEM_UNAVAILABLE');
    consumedItem=itemId;
    const before=target!.hp;
    target!.hp=it.revive?Math.round(target!.stats.hp*it.revive/100):Math.min(target!.stats.hp,target!.hp+Math.round(target!.stats.hp*it.heal!/100));
    events.push({actor:'self',kind:'item',itemId,targetOwnedId:target!.ownedId,recovered:target!.hp-before});
    actionConsumed=true;
  }
  const self=state.fighters[0],enemy=state.fighters[1];
  const playerSkill=action.kind==='attack'?self.attack:action.kind==='skill'?self.skills.find(s=>s.id===action.skillId):null;
  if(!actionConsumed&&self.hp<=0)fail('ACTIVE_UNIT_FAINTED');
  if(!actionConsumed&&action.kind!=='focus'&&!playerSkill)fail('SKILL_NOT_EQUIPPED');
  if(playerSkill&&playerSkill.mpCost>self.mp)fail('INSUFFICIENT_MP');
  const enemySkill=chooseEnemySkill(self,enemy,ctx.policy);
  const observations:DefenseObservation[]=[];
  const knowledge=ctx.defense?battleKnowledge(ctx.defense.snapshot,state.rounds,'self'):undefined;
  const decision=reuseTurnOrder(state.decision,state.battleId,state.turn);
  for(const who of decision.order as ('self'|'enemy')[]){
    if(who==='self'&&actionConsumed)continue;
    const actor=who==='self'?self:enemy,target=who==='self'?enemy:self;
    if(!actor.hp||!target.hp)continue;
    const skill=who==='self'?playerSkill:enemySkill;
    if(!skill){const next=focusMp(actor.mp,actor.stats.mp);actor.mp=next.mp;events.push({actor:who,kind:'focus',recovered:next.recovered});continue;}
    actor.mp=spendMp(actor.mp,skill.mpCost);
    const hit=fiveStatAttack({power:skill.power,level:actor.level,durability:target.stats.durability,suitability:actor.suitability[skill.element],defense:target.defense[skill.element],attackerHp:actor.hp,defenderHp:target.hp},ctx.policy.calculation,(base,fit)=>base*fit);
    if(hit.target==='attacker')actor.hp-=hit.damage;else target.hp-=hit.damage;
    const defenseObservation=who==='self'&&ctx.defense?resolvedDefenseObservation(target,skill.element,hit,'self',ctx.defense.snapshot,ctx.defense.catalog,knowledge):null;
    if(defenseObservation){observations.push(defenseObservation);addDefenseObservation(knowledge!,defenseObservation,ctx.defense!.snapshot);}
    events.push({actor:who,kind:'skill',skillId:skill.id,...hit,...(defenseObservation?{defenseObservation}:{})});
  }
  state.rounds.push({turn:state.turn,decision,events});state.turn++;
  state.outcome=self.hp<=0&&!state.reserves.some(f=>f.hp>0)?'loss':enemy.hp<=0?'win':state.turn>=ctx.policy.maxRounds?'draw':null;
  if(!state.outcome)state.decision=order(state);
  return {state,consumedItem,finished:!!state.outcome,observations};
}
