// PvE 전투 서비스: 만들기·읽기·행동·정산. 계산은 shared, 여기는 저장·잠금·영수증만.
// 원본 흐름: GMM110 src/roster60-battle.ts RosterBattle (커밋 0b0fb8b5).
// 모험 안 전투(adventureId)·스토리 전투(story)도 여기서 만들고 정산한다(6단계).
import {randomBytes,randomUUID} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  growthAt,makeFighter,createBattleState,applyAction,selectEnemySpecies,grantXp,createPacedBattleXpPlan,calculatePacedBattleXp,unitXpProgress,
  observedOpponentIntel,battleKnowledge,opponentFighter,publicDefenseSafe,publicDefenseObservation,snapshotProfiles,observedDefenseVersion,
  fiveRebirthPolicy,skillElements,battleXpPlanOptions,type BattlePolicy,type StoryBattleContext,type AdventureRewards,type BattleState,type BattleAction,type DefenseSnapshot,type DefenseObservation,type PacedBattleXpPlan,type Encounter,type Fighter,type SkillElement,type Defense,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {withReceipt} from './receipts.js';
import {AcquisitionService} from './acquisition-service.js';
import {settleAdventureBattle,type AdventureState} from './adventure-service.js';
import {settleStoryBattle} from './story-service.js';

export const partyPolicy={version:'single-active-party-3-v1',minParty:1,maxParty:3,activeSlots:1,sizeRule:'up-to-max'} as const;
export function isValidParty(ids:unknown):ids is string[]{
  return Array.isArray(ids)&&ids.length>=partyPolicy.minParty&&ids.length<=partyPolicy.maxParty&&ids.every(id=>typeof id==='string'&&id.length>0)&&new Set(ids).size===ids.length;
}
type Snapshot={policyVersion:string;encounter:Encounter;observedDefense:DefenseSnapshot;unitXpPacing:PacedBattleXpPlan;members:{ownedId:string;startingXp:string}[];xpRecipient?:string;adventureId?:string;story?:StoryBattleContext};
type AdventureRow={id:string;revision:number;status:string;activeBattleId:string|null;catalogVersion:string;state:string;pendingRewards:string};
type Row={id:string;playerId:string;ownedId:string;revision:number;status:string;seed:string;snapshot:string;state:string;settlement:string|null};

export class BattleService{
  constructor(private db:PrismaClient,private content:Content){}

  /** 보유 개체 → 편성 화면용 요약 */
  formationUnit(u:{id:string;speciesId:string;totalXp:bigint;reincarnation:number;skillInheritanceJson:string|null}){
    const {catalog}=this.content,def=catalog.characters.find(d=>d.id===u.speciesId);if(!def)return apiFail(503,'BATTLE_UNIT_DATA_PENDING');
    const g=growthAt(Number(u.totalXp),def.growth,u.reincarnation,def.reincarnationXpPolicy);
    const f=makeFighter(catalog,u.speciesId,g.level,u.id,u.reincarnation,u.skillInheritanceJson);
    return {ownedId:u.id,speciesId:u.speciesId,name:f.name,rarity:def.rarity,level:g.level,maxLevel:g.maxLevel,stats:f.stats};
  }
  async options(playerId:string){
    const rows=await this.db.owned.findMany({where:{playerId,status:'AVAILABLE',locked:false},orderBy:{id:'asc'},take:1000});
    const {catalog,policy}=this.content;
    return {units:rows.map(u=>this.formationUnit(u)),encounters:policy.encounters.map(e=>({id:e.id,name:catalog.characters.find(u=>u.id===e.speciesId)?.name??e.speciesId,level:e.level,tutorial:e.tutorial,mode:e.mode??null})),
      catalogVersion:catalog.version,partyPolicy};
  }
  ownedFighter(u:{id:string;speciesId:string;totalXp:bigint;reincarnation:number;skillInheritanceJson:string|null}):Fighter{
    const {catalog}=this.content,def=catalog.characters.find(d=>d.id===u.speciesId);if(!def)return apiFail(503,'BATTLE_UNIT_DATA_PENDING');
    if(u.reincarnation&&catalog.rebirthPolicy!==fiveRebirthPolicy)return apiFail(503,'FIVE_STAT_REBIRTH_POLICY_PENDING');
    if(u.totalXp<0n||u.totalXp>BigInt(Number.MAX_SAFE_INTEGER))return apiFail(409,'INVALID_XP');
    const level=growthAt(Number(u.totalXp),def.growth,u.reincarnation,def.reincarnationXpPolicy).level;
    return {...makeFighter(catalog,u.speciesId,level,'self',u.reincarnation,u.skillInheritanceJson),ownedId:u.id};
  }
  /** 전투 정책의 조우로 전투 만들기(훈련·튜토리얼, 모험 중이면 adventureId). 스토리 전투는 StoryService가 createIn을 직접 부른다. */
  async create(playerId:string,b:{requestId:string;ownedId:string;encounterId:string;reserveIds?:string[];adventureId?:string}){
    return withReceipt(this.db,playerId,'battle',b.requestId,['create',b.ownedId,b.encounterId,b.reserveIds??[],b.adventureId??null],async tx=>{
      const encounter=this.content.policy.encounters.find(e=>e.id===b.encounterId);if(!encounter)return apiFail(409,'ENCOUNTER_NOT_ALLOWED');
      const run=b.adventureId?await tx.adventure.findFirst({where:{id:b.adventureId,playerId,status:'ACTIVE'}}):null;
      if(encounter.mode==='adventure'&&!run)return apiFail(409,'ADVENTURE_REQUIRED');
      if(b.adventureId&&(!run||encounter.mode!=='adventure'))return apiFail(404,'ADVENTURE_NOT_FOUND');
      return this.createIn(tx,playerId,{ownedIds:[b.ownedId,...(b.reserveIds??[])],encounter,policy:this.content.policy,adventure:run});
    });
  }
  /**
   * 전투 하나 만들기(원본 RosterBattle.create). 영수증·잠금 안(tx)에서만 부른다.
   * adventure: 모험 안 전투면 모험 기록(편성은 모험 출발 편성 그대로, 체력은 이어 받음). enemy·story: 스토리 전투의 상대와 서버 기록.
   */
  async createIn(tx:Prisma.TransactionClient,playerId:string,spec:{ownedIds:string[];encounter:Encounter;policy:BattlePolicy;adventure?:AdventureRow|null;enemy?:Fighter;story?:StoryBattleContext}){
    const {catalog,xpPacing}=this.content,{encounter,policy,adventure:run}=spec,ids=spec.ownedIds;
    const saved=run?JSON.parse(run.state) as AdventureState:null,pending=run?(JSON.parse(run.pendingRewards) as AdventureRewards).xp:{};
    if(run){
      if(run.activeBattleId)return apiFail(409,'ADVENTURE_BATTLE_ACTIVE');
      if(run.catalogVersion!==catalog.version)return apiFail(409,'CATALOG_CHANGED');
      if(!ids.length||new Set(ids).size!==ids.length||ids.length!==saved!.party.length||saved!.party.some(f=>!ids.includes(f.ownedId!)))return apiFail(400,'INVALID_PARTY');
      if(!(saved!.party.find(f=>f.ownedId===ids[0])?.hp))return apiFail(409,'ACTIVE_UNIT_FAINTED');
    }else if(!isValidParty(ids))return apiFail(400,'INVALID_PARTY');
    const source=run?'ADVENTURE':'AVAILABLE';
    const rows=[] as NonNullable<Awaited<ReturnType<typeof tx.owned.findFirst>>>[];
    for(const id of ids){const u=await tx.owned.findFirst({where:{id,playerId}});if(!u)return apiFail(404,'UNIT_NOT_FOUND');if(u.status!==source||u.locked)return apiFail(409,'UNIT_UNAVAILABLE');rows.push(u);}
    const [self,...reserves]=rows.map(u=>this.ownedFighter(u));
    if(saved)for(const f of [self,...reserves])f.hp=saved.party.find(x=>x.ownedId===f.ownedId)!.hp; // 모험: 체력만 이어 받음(원본과 같음)
    const id=randomUUID(),seed=randomBytes(32).toString('hex');
    const enemy=spec.enemy??makeFighter(catalog,selectEnemySpecies(encounter,policy.encounters,seed),encounter.level,'enemy');
    const members=rows.map(u=>{const def=catalog.characters.find(d=>d.id===u.speciesId)!;return {ownedId:u.id,playerId,startingXp:u.totalXp.toString(),growth:def.growth,reincarnation:u.reincarnation,reincarnationXpPolicy:def.reincarnationXpPolicy};});
    // 상한 넘는 경험치는 버리는 규칙이라 상한 개체도 출전 가능. 저장값이 잘못됐으면 여기서 거절(원본 normalXpGrant 사전 확인).
    for(const m of members)grantXp({...m,startingXp:(BigInt(m.startingXp)+BigInt(pending[m.ownedId]??0)).toString()},Math.max(encounter.winXp,encounter.lossXp));
    const options=battleXpPlanOptions({inAdventure:!!run,story:spec.story??null,encounter});
    const unitXpPacing=createPacedBattleXpPlan({battleId:id,playerId,policy:xpPacing,enemyLevel:enemy.level,sourceWinXp:options.sourceWinXp,sourceLossXp:options.sourceLossXp,baseline:options.baseline,reserveHalf:options.reserveHalf,recipientMode:options.recipientMode,requireSurvivor:options.requireSurvivor,members});
    const observedDefense=await this.defenseSnapshot(tx,playerId,[enemy]);
    const state=createBattleState({battleId:id,seed,mode:encounter.mode,self,reserves,enemy,policy});
    for(const u of rows){const locked=await tx.owned.updateMany({where:{id:u.id,playerId,status:source,locked:false,totalXp:u.totalXp},data:{status:'BATTLE'}});if(locked.count!==1)return apiFail(409,'UNIT_UNAVAILABLE');}
    const snapshot:Snapshot={policyVersion:policy.version,encounter,observedDefense,unitXpPacing,members:members.map(m=>({ownedId:m.ownedId,startingXp:m.startingXp})),xpRecipient:options.xpRecipient,
      ...(run?{adventureId:run.id}:{}),...(spec.story?{story:spec.story}:{})};
    const row=await tx.battle.create({data:{id,playerId,ownedId:ids[0],seed,snapshot:JSON.stringify(snapshot),state:JSON.stringify(state)}});
    if(run){const claimed=await tx.adventure.updateMany({where:{id:run.id,playerId,revision:run.revision,status:'ACTIVE',activeBattleId:null},data:{activeBattleId:id,revision:{increment:1}}});if(claimed.count!==1)return apiFail(409,'ADVENTURE_STATE_CHANGED');}
    return this.view(row,tx);
  }
  /** 이번 상대 종에 대해 이 플레이어가 이미 기억하는 방어 반응(원본 captureDefenseSnapshot) */
  private async defenseSnapshot(tx:Prisma.TransactionClient,playerId:string,targets:Fighter[]):Promise<DefenseSnapshot>{
    const profiles=snapshotProfiles(this.content.catalog,targets),initial:DefenseSnapshot['initial']={self:{}};
    const species=[...new Set(targets.map(t=>t.speciesId).filter(id=>profiles[id]))];
    if(species.length){
      const rows=await tx.observedDefense.findMany({where:{playerId,speciesId:{in:species}}});
      for(const r of rows)if(profiles[r.speciesId]===r.profileKey&&skillElements.includes(r.element as SkillElement))(initial.self[r.speciesId]??={})[r.element as SkillElement]=r.reaction as Defense;
    }
    return {version:observedDefenseVersion,profiles,initial};
  }
  async read(playerId:string,battleId:string){
    const row=await this.db.battle.findFirst({where:{id:battleId,playerId}});if(!row)return apiFail(404,'BATTLE_NOT_FOUND');
    return this.view(row,this.db);
  }
  async active(playerId:string){
    const rows=await this.db.battle.findMany({where:{playerId,status:{in:['ACTIVE','FINISHED']}},orderBy:{createdAt:'desc'},take:20});
    return {battles:await Promise.all(rows.map(r=>this.view(r,this.db)))};
  }
  async action(playerId:string,b:{requestId:string;battleId:string;revision:number;action:BattleAction}){
    return withReceipt(this.db,playerId,'battle',b.requestId,['action',b.battleId,b.revision,b.action],async tx=>{
      const row=await tx.battle.findFirst({where:{id:b.battleId,playerId}});if(!row)return apiFail(404,'BATTLE_NOT_FOUND');
      if(row.revision!==b.revision)return apiFail(409,'STALE_REVISION');if(row.status!=='ACTIVE')return apiFail(409,'BATTLE_FINISHED');
      const state=JSON.parse(row.state) as BattleState,snap=JSON.parse(row.snapshot) as Snapshot;
      const inventory=new Map((await tx.playerItem.findMany({where:{playerId}})).map(i=>[i.itemId,i.count]));
      const result=applyAction(state,b.action,{policy:this.content.policy,items:this.content.items,itemCount:id=>inventory.get(id)??0,defense:{snapshot:snap.observedDefense,catalog:this.content.catalog}});
      if(result.consumedItem){const used=await tx.playerItem.updateMany({where:{playerId,itemId:result.consumedItem,count:{gt:0}},data:{count:{decrement:1}}});if(used.count!==1)return apiFail(409,'ITEM_UNAVAILABLE');}
      const status=result.finished?'FINISHED':'ACTIVE';
      const changed=await tx.battle.updateMany({where:{id:row.id,playerId,revision:row.revision,status:'ACTIVE'},data:{state:JSON.stringify(result.state),revision:{increment:1},status}});
      if(changed.count!==1)return apiFail(409,'STALE_REVISION');
      await this.persistObservations(tx,playerId,result.observations);
      return this.view({...row,state:JSON.stringify(result.state),revision:row.revision+1,status},tx);
    });
  }
  private async persistObservations(tx:Prisma.TransactionClient,playerId:string,list:DefenseObservation[]){
    for(const o of list){if(!o.profileKey)continue;
      await tx.observedDefense.upsert({where:{playerId_speciesId_profileKey_element:{playerId,speciesId:o.speciesId,profileKey:o.profileKey,element:o.element}},create:{playerId,speciesId:o.speciesId,profileKey:o.profileKey,element:o.element,reaction:o.reaction},update:{reaction:o.reaction}});}
  }
  async settle(playerId:string,b:{requestId:string;battleId:string;revision:number}){
    return withReceipt(this.db,playerId,'battle',b.requestId,['settle',b.battleId,b.revision],async tx=>{
      const row=await tx.battle.findFirst({where:{id:b.battleId,playerId}});if(!row)return apiFail(404,'BATTLE_NOT_FOUND');
      if(row.status==='SETTLED')return this.view(row,tx); // 같은 전투는 두 번 정산하지 않음
      if(row.revision!==b.revision)return apiFail(409,'STALE_REVISION');if(row.status!=='FINISHED')return apiFail(409,'BATTLE_NOT_FINISHED');
      const state=JSON.parse(row.state) as BattleState,snap=JSON.parse(row.snapshot) as Snapshot,plan=createPacedBattleXpPlan(snap.unitXpPacing);
      let settlement:Record<string,unknown>;
      if(snap.adventureId){
        // 모험 안 전투: 경험치는 귀환 때 받을 보상으로 쌓고, 전멸이면 쌓인 보상을 잃고 돌아옴(원본 settleAdventureBattle)
        settlement=await settleAdventureBattle(tx,{id:row.id,playerId,ownedId:row.ownedId},state,snap.adventureId,plan,this.content.items);
      }else{
        const reward=calculatePacedBattleXp(plan,row.ownedId,state);
        const units=reward.units.map(u=>{const m=plan.members.find(x=>x.ownedId===u.ownedId)!,xpProgress=unitXpProgress(m,u.endingXp,u.startingXp);return {...u,...(xpProgress?{xpProgress}:{})};});
        const primary=reward.units.find(u=>u.ownedId===row.ownedId)!;
        settlement={outcome:state.outcome,xpAwarded:reward.xpAccepted,xpDiscarded:reward.xpDiscarded,xpDeferred:0,xpByOwnedId:reward.xpByOwnedId,totalXp:primary.endingXp,policyVersion:plan.policy.version,unitXp:{...reward,units,delivery:'immediate'}};
        for(const u of reward.units){const m=plan.members.find(x=>x.ownedId===u.ownedId)!;
          const released=await tx.owned.updateMany({where:{id:u.ownedId,playerId,status:'BATTLE',totalXp:BigInt(m.startingXp),reincarnation:m.reincarnation},data:{status:'AVAILABLE',totalXp:BigInt(u.endingXp)}});
          if(released.count!==1)return apiFail(409,'UNIT_STATE_CHANGED');}
      }
      // 스토리 전투: 흑화 재료·의뢰 승리 수(원본 settleStoryBattle). 같은 거래 안에서 한 번만.
      if(snap.story){const story=await settleStoryBattle(tx,playerId,row.id,state,snap.story,snap.encounter.id);settlement={...settlement,story};}
      const changed=await tx.battle.updateMany({where:{id:row.id,playerId,revision:row.revision,status:'FINISHED'},data:{status:'SETTLED',revision:{increment:1},settlement:JSON.stringify(settlement)}});
      if(changed.count!==1)return apiFail(409,'STALE_REVISION');
      await tx.player.update({where:{id:playerId},data:{revision:{increment:1}}});
      // 튜토리얼 전투를 이겨서 정산하면 첫 갈매미 흐름의 증거로 기록(원본 verifyRosterTutorial)
      if(state.outcome==='win'&&snap.encounter.tutorial)await AcquisitionService.verifyTutorial(tx,playerId,row.id);
      return this.view({...row,revision:row.revision+1,status:'SETTLED',settlement:JSON.stringify(settlement)},tx);
    });
  }
  /** 화면에 보내는 전투 상태. 씨앗·상대 방어 표·관측 열쇠는 넣지 않음. */
  private async view(row:Row,db:Prisma.TransactionClient|PrismaClient){
    const s=JSON.parse(row.state) as BattleState,snap=JSON.parse(row.snapshot) as Snapshot;
    const intel=observedOpponentIntel(s.fighters[1],s.turn,snap.observedDefense,battleKnowledge(snap.observedDefense,s.rounds,'self'),this.content.catalog);
    const {speeds,...decision}=s.decision;
    const rounds=s.rounds.map(r=>({...r,events:r.events.map(e=>{const {defenseObservation,...visible}=e as any;return {...visible,...(defenseObservation?{observedDefense:publicDefenseObservation(defenseObservation)}:{})};})}));
    const own=(f:Fighter)=>publicDefenseSafe({...f,ownResistance:{...f.defense}});
    const inventory=(await db.playerItem.findMany({where:{playerId:row.playerId}})).map(i=>({itemId:i.itemId,count:i.count}));
    const self=s.fighters[0];
    return publicDefenseSafe({testBaseline:this.content.catalog.productionBalanceApproved===false,balanceProfile:snap.policyVersion,battleId:row.id,revision:row.revision,status:row.status,
      adventureId:snap.adventureId??null,story:snap.story?{questId:snap.story.questId??null,encounterId:snap.story.encounterId,kind:snap.story.kind}:null,
      state:{mode:s.mode??null,turn:s.turn,outcome:s.outcome,surrendered:!!s.surrendered,self:own(self),reserves:s.reserves.map(own),enemy:opponentFighter(s.fighters[1],intel),opponentIntel:intel,
        decision:{...decision,...(intel.statsKnown?{speeds}:{})},rounds,participation:s.participation},
      settlement:row.settlement?JSON.parse(row.settlement):null,itemDefinitions:this.content.items,inventory,
      disabledCommands:{item:self.hp<=0?'FORCED_SWITCH_REQUIRED':'',switch:'',escape:self.hp<=0?'FORCED_SWITCH_REQUIRED':['story','duel','adventure'].includes(s.mode??'')?'':'ESCAPE_POLICY_PENDING'}});
  }
}
