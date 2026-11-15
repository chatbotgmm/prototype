// 모험(탐험): 출발 → 전투 여러 번(보상은 쌓아 둠) → 정상 귀환 때 받음. 전멸하면 쌓인 보상을 잃고 돌아옴.
// 원본: GMM110 src/roster60-adventure.ts (커밋 0b0fb8b5). 계산은 shared(경험치 조절·보상 검사), 여기는 저장·잠금·영수증만.
// 원본과 다르게 한 것: 방범대장 경험치(귀환 100)는 7단계, 일일 미션(EXPEDITION) 집계는 8단계에서 연결해요. 귀환 승리 기록(commanderReturnEvidence)은 지금부터 원본과 같이 남겨요.
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  growthAt,unitXpProgress,calculatePacedBattleXp,checkedAdventureRewards,publicDefenseSafe,adventureEscapePolicy,adventureCommanderEvidenceVersion,
  type BattleState,type Fighter,type PacedBattleXpPlan,type AdventureRewards,type ItemDefinition,type GrowthPoint,type ReincarnationXpPolicy,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {withReceipt} from './receipts.js';
import {isValidParty} from './battle-service.js';

export type AdventureMember={ownedId:string;startingXp:string;growth:GrowthPoint[];reincarnation:number;reincarnationXpPolicy?:ReincarnationXpPolicy};
export type AdventureState={party:Fighter[];members:AdventureMember[];storyQuestId?:string;material?:boolean;commanderReturnEvidence:{version:string;wins:number}};
type Row={id:string;playerId:string;revision:number;status:string;activeBattleId:string|null;state:string;pendingRewards:string;settlement:string|null};

/** 화면용 모험 상태(원본 adventureDto). 상대 방어 표는 넣지 않음. */
export function adventureView(row:Row){
  const state=JSON.parse(row.state) as AdventureState;
  return publicDefenseSafe({adventureId:row.id,revision:row.revision,status:row.status,activeBattleId:row.activeBattleId,kind:state.storyQuestId?'quest':state.material?'material':'free',questId:state.storyQuestId??null,
    party:state.party.map(f=>({ownedId:f.ownedId,speciesId:f.speciesId,name:f.name,level:f.level,hp:f.hp,maxHp:f.stats.hp})),pendingRewards:JSON.parse(row.pendingRewards),settlement:row.settlement?JSON.parse(row.settlement):null,escapePolicy:adventureEscapePolicy});
}

export class AdventureService{
  constructor(private db:PrismaClient,private content:Content,private fighter:(u:{id:string;speciesId:string;totalXp:bigint;reincarnation:number;skillInheritanceJson:string|null})=>Fighter){}
  async active(playerId:string){return {adventures:(await this.db.adventure.findMany({where:{playerId,status:'ACTIVE'},orderBy:{createdAt:'desc'}})).map(adventureView)};}
  async read(playerId:string,id:string){const row=await this.db.adventure.findFirst({where:{id,playerId}});if(!row)return apiFail(404,'ADVENTURE_NOT_FOUND');return adventureView(row);}
  async start(playerId:string,b:{requestId:string;ownedIds:string[]}){
    return withReceipt(this.db,playerId,'adventure',b.requestId,['start',b.ownedIds],async tx=>adventureView(await this.startIn(tx,playerId,b.ownedIds)));
  }
  /** 출발: 개체를 모험 중(ADVENTURE)으로 잠그고 출발 때 경험치를 기록(원본 start). 스토리 출항도 이 함수를 쓴다. */
  async startIn(tx:Prisma.TransactionClient,playerId:string,ownedIds:string[],extra:Partial<Pick<AdventureState,'storyQuestId'|'material'>>={}){
    if(!isValidParty(ownedIds))return apiFail(400,'INVALID_PARTY');
    const {catalog}=this.content,party:Fighter[]=[],members:AdventureMember[]=[];
    for(const id of ownedIds){
      const u=await tx.owned.findFirst({where:{id,playerId,status:'AVAILABLE',locked:false}});if(!u)return apiFail(409,'UNIT_UNAVAILABLE');
      const d=catalog.characters.find(x=>x.id===u.speciesId);if(!d)return apiFail(503,'BATTLE_UNIT_DATA_PENDING');
      party.push(this.fighter(u));members.push({ownedId:id,startingXp:u.totalXp.toString(),growth:d.growth,reincarnation:u.reincarnation,reincarnationXpPolicy:d.reincarnationXpPolicy});
      const changed=await tx.owned.updateMany({where:{id,playerId,status:'AVAILABLE',locked:false,totalXp:u.totalXp},data:{status:'ADVENTURE'}});if(changed.count!==1)return apiFail(409,'UNIT_UNAVAILABLE');
    }
    const state:AdventureState={party,members,...extra,commanderReturnEvidence:{version:adventureCommanderEvidenceVersion,wins:0}};
    return tx.adventure.create({data:{playerId,catalogVersion:catalog.version,state:JSON.stringify(state),pendingRewards:JSON.stringify({xp:{}})}});
  }
  /** 정상 귀환: 쌓인 보상을 개체에 지급하고 모험 잠금을 푼다(원본 return). 전투 중에는 못 함. */
  async return(playerId:string,b:{requestId:string;adventureId:string;revision:number}){
    return withReceipt(this.db,playerId,'adventure',b.requestId,['return',b.adventureId,b.revision],async tx=>{
      const row=await tx.adventure.findFirst({where:{id:b.adventureId,playerId}});if(!row)return apiFail(404,'ADVENTURE_NOT_FOUND');
      if(row.status!=='ACTIVE')return adventureView(row);
      if(row.revision!==b.revision)return apiFail(409,'STALE_REVISION');if(row.activeBattleId)return apiFail(409,'RETURN_ONLY_OUTSIDE_BATTLE');
      const state=JSON.parse(row.state) as AdventureState;
      const rewards=checkedAdventureRewards(JSON.parse(row.pendingRewards),Object.keys(this.content.items));
      if(Object.keys(rewards.xp).some(id=>!state.members.some(m=>m.ownedId===id)))return apiFail(409,'INVALID_REWARD_RECIPIENT');
      // 지금 쌓이는 보상은 경험치뿐(원본 정산도 경험치만 넣음). 재화·아이템 칸은 검사만 하고 있으면 거절.
      if(Object.keys(rewards.currencies??{}).length||Object.keys(rewards.items??{}).length)return apiFail(409,'INVALID_REWARD');
      const xpProgressByOwnedId:Record<string,unknown>={};
      for(const m of state.members){
        const amount=rewards.xp[m.ownedId]??0,next=BigInt(m.startingXp)+BigInt(amount);
        if(next>BigInt(Number.MAX_SAFE_INTEGER))return apiFail(409,'INVALID_XP');
        growthAt(Number(next),m.growth,m.reincarnation,m.reincarnationXpPolicy);
        const p=unitXpProgress(m,next.toString());if(p)xpProgressByOwnedId[m.ownedId]=p;
        const changed=await tx.owned.updateMany({where:{id:m.ownedId,playerId,status:'ADVENTURE',totalXp:BigInt(m.startingXp)},data:{status:'AVAILABLE',totalXp:next}});
        if(changed.count!==1)return apiFail(409,'UNIT_STATE_CHANGED');
      }
      const settlement={kind:'normal-return',rewards,winsThisRun:state.commanderReturnEvidence?.wins??0,...(Object.keys(xpProgressByOwnedId).length?{xpProgressByOwnedId}:{})};
      const changed=await tx.adventure.updateMany({where:{id:row.id,playerId,revision:row.revision,status:'ACTIVE',activeBattleId:null},data:{status:'RETURNED',revision:{increment:1},pendingRewards:JSON.stringify({xp:{}}),settlement:JSON.stringify(settlement)}});
      if(changed.count!==1)return apiFail(409,'STALE_REVISION');
      await tx.player.update({where:{id:playerId},data:{revision:{increment:1}}});
      return adventureView({...row,status:'RETURNED',revision:row.revision+1,pendingRewards:JSON.stringify({xp:{}}),settlement:JSON.stringify(settlement)});
    });
  }
}

/** 모험 안 전투 정산(원본 settleAdventureBattle, 경험치 조절 정책 경로). 전투 정산 거래 안에서만 부른다. 화면에서 보상 값을 받지 않는다. */
export async function settleAdventureBattle(tx:Prisma.TransactionClient,row:{id:string;playerId:string;ownedId:string},state:BattleState,adventureId:string,plan:PacedBattleXpPlan,items:Record<string,ItemDefinition>){
  const run=await tx.adventure.findFirst({where:{id:adventureId,playerId:row.playerId,status:'ACTIVE',activeBattleId:row.id}});if(!run)return apiFail(409,'ADVENTURE_STATE_CHANGED');
  const saved=JSON.parse(run.state) as AdventureState,pending:AdventureRewards=checkedAdventureRewards(JSON.parse(run.pendingRewards),Object.keys(items));
  const party=[state.fighters[0],...state.reserves];
  if(saved.party.length!==party.length||saved.party.some(f=>!party.some(x=>x.ownedId===f.ownedId)))return apiFail(409,'ADVENTURE_STATE_CHANGED');
  const lost=party.every(f=>f.hp<=0),won=state.outcome==='win'&&!state.surrendered;
  if(!lost&&won){const wins=saved.commanderReturnEvidence?.version===adventureCommanderEvidenceVersion?saved.commanderReturnEvidence.wins:0;saved.commanderReturnEvidence={version:adventureCommanderEvidenceVersion,wins:wins+1};}
  // 이번 전투 전까지 쌓인 경험치를 더한 값에서 상한을 따짐(원본 effective starting XP)
  const effective:Record<string,string>={};
  for(const m of plan.members){const original=saved.members.find(x=>x.ownedId===m.ownedId);if(!original||original.startingXp!==m.startingXp||original.reincarnation!==m.reincarnation)return apiFail(409,'ADVENTURE_STATE_CHANGED');
    effective[m.ownedId]=(BigInt(m.startingXp)+BigInt(pending.xp[m.ownedId]??0)).toString();}
  const reward=calculatePacedBattleXp(plan,row.ownedId,state,effective);
  if(!lost)for(const [id,amount] of Object.entries(reward.xpByOwnedId)){pending.xp[id]=(pending.xp[id]??0)+amount;if(!Number.isSafeInteger(pending.xp[id])||pending.xp[id]>2_000_000_000)return apiFail(409,'INVALID_REWARD');}
  for(const m of saved.members){const changed=await tx.owned.updateMany({where:{id:m.ownedId,playerId:row.playerId,status:'BATTLE',totalXp:BigInt(m.startingXp)},data:{status:lost?'AVAILABLE':'ADVENTURE'}});if(changed.count!==1)return apiFail(409,'UNIT_STATE_CHANGED');}
  const settlement=lost?{kind:'forced-return',lostRewards:pending}:null;
  const changed=await tx.adventure.updateMany({where:{id:run.id,playerId:row.playerId,revision:run.revision,status:'ACTIVE',activeBattleId:row.id},
    data:{activeBattleId:null,revision:{increment:1},state:JSON.stringify({...saved,party}),pendingRewards:JSON.stringify(lost?{xp:{}}:pending),status:lost?'LOST':'ACTIVE',settlement:settlement?JSON.stringify(settlement):null}});
  if(changed.count!==1)return apiFail(409,'ADVENTURE_STATE_CHANGED');
  return {outcome:state.outcome,xpAwarded:0,xpEscrowed:reward.xpAccepted,xpByOwnedId:reward.xpByOwnedId,xpPolicy:plan.policy.version,xpDiscarded:reward.xpDiscarded,xpDeferred:0,unitXp:{...reward,delivery:'pending-return'},
    adventureId:run.id,adventureStatus:lost?'LOST':'ACTIVE',pendingRewards:lost?{xp:{}}:pending};
}
