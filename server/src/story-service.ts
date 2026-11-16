// 스토리·주민 의뢰(계정 단위 진행). 원본: GMM110 src/story/service.ts·settlement.ts (커밋 0b0fb8b5).
// 계산(의뢰 상태·장면·상대·흑화 재료)은 shared/src/story.ts, 여기는 저장·잠금·영수증만.
// 원본과 다르게 한 것(같은 결과, 단순한 방법):
//  - 원본은 출항을 「출발 예약(departure) → 모험 시작 → 연결 → 전투 만들기」 여러 거래로 나누고, 중간에 끊겨도 이어 가도록 예약을 저장했어요.
//    새 서버는 DB 한 대·플레이어별 직렬 처리라 이 모두를 거래 하나로 처리해요. 그래서 pendingDeparture는 늘 null이고, revision이 오르는 횟수가 원본과 달라요.
//  - 방범대장 경험치: 수락 때 정책을 고정하고, 귀환 장면을 끝내 의뢰를 완료하면 지급(원본과 같음).
import {randomUUID} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  initialStoryProgress,questStatus,storyOpen,storyAdvance,storyAccept,storyClose,storyView,storyBattleTarget,storyBattlePolicy,storyEnemy,storyBattleContext,
  storyDarkGangAward,checkStoryBattleContext,findQuest,type StoryProgress,type StoryQuest,type SceneProgress,type BattleState,type StoryBattleContext,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {withReceipt} from './receipts.js';
import type {BattleService} from './battle-service.js';
import type {AdventureService} from './adventure-service.js';
import {awardCommanderXp,readCommanderState,type CommanderXpResult} from './progression-service.js';
import type {CommanderPolicy} from '../../shared/src/index.js';

type Tx=Prisma.TransactionClient;
type Account={playerId:string;contentVersion:string;state:string;darkGangBalance:number;darkGangLifetime:number;revision:number};

export class StoryService{
  constructor(private db:PrismaClient,private content:Content,private battles:BattleService,private adventures:AdventureService){}
  private get story(){return this.content.story;}
  private async account(tx:Tx|PrismaClient,playerId:string):Promise<Account>{
    return tx.storyAccount.upsert({where:{playerId},create:{playerId,contentVersion:this.story.content.version,state:JSON.stringify(initialStoryProgress())},update:{}});
  }
  /** 의뢰 상태 계산에 필요한 DB 값(연결된 모험 상태)을 미리 읽어 둠 */
  private async lookups(tx:Tx|PrismaClient,a:Account,p:StoryProgress){
    const advIds=[...new Set([...Object.values(p.accepted).map(x=>x.adventureId).filter((x):x is string=>!!x),...(p.materialAdventureId?[p.materialAdventureId]:[])])];
    const runs=advIds.length?await tx.adventure.findMany({where:{playerId:a.playerId,id:{in:advIds}}}):[];
    const battleIds=Object.values(p.accepted).flatMap(x=>x.battles);
    const live=battleIds.length?await tx.battle.findMany({where:{playerId:a.playerId,id:{in:battleIds},status:{in:['ACTIVE','FINISHED']}},orderBy:{createdAt:'desc'},select:{id:true}}):[];
    const status=new Map(runs.map(r=>[r.id,r.status]));
    return {runs,adventureStatus:(id:string)=>status.get(id),latestBattle:(_q:string,ids:string[])=>live.find(b=>ids.includes(b.id))?.id??null};
  }
  private async view(tx:Tx|PrismaClient,a:Account){
    if(a.contentVersion!==this.story.content.version)return apiFail(409,'STORY_CONTENT_CHANGED');
    const p=JSON.parse(a.state) as StoryProgress,l=await this.lookups(tx,a,p);
    const material=p.materialAdventureId?l.runs.find(r=>r.id===p.materialAdventureId&&r.status==='ACTIVE'):undefined;
    const commander=await readCommanderState(tx,a.playerId,this.content.commander);
    return {...storyView(this.story.content,p,{revision:a.revision,contentVersion:a.contentVersion,lifetime:a.darkGangLifetime,adventureStatus:l.adventureStatus,latestBattle:l.latestBattle,
      materialAdventure:material?{adventureId:material.id,status:material.status,activeBattleId:material.activeBattleId,revision:material.revision}:null,speakerNames:this.story.speakerNames}),commander};
  }
  async state(playerId:string){return this.view(this.db,await this.account(this.db,playerId));}
  /** 흑화 재료 잔액(원본 materials). 쓰는 곳(강화)은 원본에서도 아직 없음. */
  async materials(playerId:string){const a=await this.account(this.db,playerId);
    return {currency:'dark-shrimp-gang',name:'어둠의 새우Gang',balance:a.darkGangBalance,lifetimeEarned:a.darkGangLifetime,enhancement:{enabled:false,eligibilityPolicy:'PENDING',automaticConsumption:false}};}
  private mutate(playerId:string,b:{requestId:string;revision:number},payload:unknown,run:(p:StoryProgress,statusOf:(q:StoryQuest)=>ReturnType<typeof questStatus>,tx:Tx)=>void|Promise<CommanderXpResult|void>){
    return withReceipt(this.db,playerId,'story',b.requestId,payload,async tx=>{
      const a=await this.account(tx,playerId);
      if(a.revision!==b.revision)return apiFail(409,'STORY_STALE_REVISION');if(a.contentVersion!==this.story.content.version)return apiFail(409,'STORY_CONTENT_CHANGED');
      const p=JSON.parse(a.state) as StoryProgress,l=await this.lookups(tx,a,p);
      const commanderReward=await run(p,q=>questStatus(this.story.content,p,a.darkGangLifetime,q,l.adventureStatus),tx);
      const changed=await tx.storyAccount.updateMany({where:{playerId,revision:a.revision},data:{state:JSON.stringify(p),revision:{increment:1}}});
      if(changed.count!==1)return apiFail(409,'STORY_STALE_REVISION');
      return {...await this.view(tx,{...a,state:JSON.stringify(p),revision:a.revision+1}),...(commanderReward?{commanderReward}:{})};
    });
  }
  open(playerId:string,b:{requestId:string;revision:number;questId:string;phase:SceneProgress['phase']}){
    return this.mutate(playerId,b,['open',b.questId,b.phase,b.revision],(p,statusOf)=>storyOpen(this.story.content,p,statusOf(findQuest(this.story.content,b.questId)),b.questId,b.phase));
  }
  advance(playerId:string,b:{requestId:string;revision:number;cursor:number}){
    return this.mutate(playerId,b,['advance',b.cursor,b.revision],async(p,statusOf,tx)=>{
      // 완료되면 accepted가 지워지므로 수락 때 고정한 정책을 먼저 꺼내 둠
      const questId=p.scene?.questId,pin=questId?(p.accepted[questId]?.commanderPolicy??null) as CommanderPolicy|null:null;
      const {completedQuestId}=storyAdvance(this.story.content,p,b.cursor,statusOf);
      if(!completedQuestId)return;
      const q=findQuest(this.story.content,completedQuestId);
      return awardCommanderXp(tx,playerId,{kind:q.kind==='resident'?'RESIDENT_QUEST':'STORY_QUEST',eventId:this.story.content.version+':'+q.id,outcome:'completed',linkedQuestId:q.id},pin);
    });
  }
  accept(playerId:string,b:{requestId:string;revision:number;questId:string}){
    return this.mutate(playerId,b,['accept',b.questId,b.revision],(p,statusOf)=>{storyAccept(this.story.content,p,statusOf(findQuest(this.story.content,b.questId)),b.questId,randomUUID(),this.story.unitXpPolicy);
      p.accepted[b.questId].commanderPolicy=structuredClone(this.content.commander);});
  }
  close(playerId:string,b:{requestId:string;revision:number}){return this.mutate(playerId,b,['close',b.revision],p=>storyClose(p));}

  /**
   * 의뢰 출항(questId) 또는 흑화 재료 모험(encounterId). 원본 createBattle + battleHook을 거래 하나로.
   * 모험 조우면: adventureId(이어 가기) → 의뢰·재료 모험에 연결된 진행 중 모험 → 없으면 새로 출발(이 편성으로).
   */
  async createBattle(playerId:string,b:{requestId:string;questId?:string;encounterId?:string;ownedIds:string[];adventureId?:string}){
    return withReceipt(this.db,playerId,'story',b.requestId,['battle',b.questId??null,b.encounterId??null,b.ownedIds,b.adventureId??null],async tx=>{
      const {content}=this.story,a=await this.account(tx,playerId);
      if(a.contentVersion!==content.version)return apiFail(409,'STORY_CONTENT_CHANGED');
      const p=JSON.parse(a.state) as StoryProgress,l=await this.lookups(tx,a,p);
      // 끝난 스토리 전투를 정산하기 전에는 다음 출항 불가(원본과 같음)
      const open=await tx.battle.findMany({where:{playerId,status:{in:['ACTIVE','FINISHED']}},select:{snapshot:true}});
      if(open.some(r=>JSON.parse(r.snapshot).story))return apiFail(409,'STORY_BATTLE_ACTIVE');
      const target=storyBattleTarget(content,p,b,q=>questStatus(content,p,a.darkGangLifetime,q,l.adventureStatus));
      const {encounter,quest}=target,accepted=quest?p.accepted[quest.id]:undefined;
      const policy=storyBattlePolicy(this.content.policy,encounter),enemy=storyEnemy(this.content.catalog,this.story.villains,encounter);
      let run=null as Awaited<ReturnType<typeof tx.adventure.findFirst>>;
      if(encounter.mode==='adventure'){
        const linked=b.adventureId??(quest?accepted!.adventureId:p.materialAdventureId);
        run=linked?await tx.adventure.findFirst({where:{id:linked,playerId,status:'ACTIVE'}}):null;
        if(b.adventureId&&!run)return apiFail(404,'ADVENTURE_NOT_FOUND');
        if(run){const s=JSON.parse(run.state);if(quest?s.storyQuestId!==quest.id:(!s.material||s.storyQuestId))return apiFail(409,'ADVENTURE_STORY_CONTEXT_CHANGED');}
        else run=await this.adventures.startIn(tx,playerId,b.ownedIds,quest?{storyQuestId:quest.id}:{material:true});
      }else if(b.adventureId)return apiFail(404,'ADVENTURE_NOT_FOUND');
      const ctx:StoryBattleContext=storyBattleContext(content,encounter,quest?.id,accepted?.token,accepted?.unitXpPolicy??null);
      const view=await this.battles.createIn(tx,playerId,{ownedIds:b.ownedIds,encounter:policy.encounters[0],policy,adventure:run,enemy,story:ctx});
      if(accepted){accepted.battles.push(view.battleId);if(run)accepted.adventureId=run.id;}
      else if(run)p.materialAdventureId=run.id;
      const changed=await tx.storyAccount.updateMany({where:{playerId,revision:a.revision},data:{state:JSON.stringify(p),revision:{increment:1}}});
      if(changed.count!==1)return apiFail(409,'STORY_STALE_REVISION');
      return view;
    });
  }
}

/** 스토리 전투 정산(원본 settleStoryBattle). 전투 정산 거래 안에서 한 번만 불린다(전투가 SETTLED가 되므로). */
export async function settleStoryBattle(tx:Tx,playerId:string,battleId:string,state:BattleState,ctx:StoryBattleContext,encounterId:string){
  checkStoryBattleContext(ctx,encounterId,state.fighters[1].speciesId,state.mode);
  const a=await tx.storyAccount.findUnique({where:{playerId}});if(!a)return apiFail(409,'STORY_ACCOUNT_NOT_FOUND');
  const p=JSON.parse(a.state) as StoryProgress,amount=storyDarkGangAward(ctx,state.outcome,!!state.surrendered);
  if(a.darkGangBalance+amount>ctx.maxBalance||a.darkGangLifetime+amount>ctx.maxBalance)return apiFail(409,'STORY_MATERIAL_LIMIT');
  let progressed=false;
  if(ctx.questId){const accepted=p.accepted[ctx.questId];
    if(!accepted||accepted.token!==ctx.acceptToken||!accepted.battles.includes(battleId))return apiFail(409,'STORY_BATTLE_LINK_INVALID');
    if(state.outcome==='win'&&!state.surrendered){accepted.wins++;progressed=true;}}
  const changed=await tx.storyAccount.updateMany({where:{playerId,revision:a.revision},data:{state:JSON.stringify(p),revision:{increment:1},darkGangBalance:{increment:amount},darkGangLifetime:{increment:amount}}});
  if(changed.count!==1)return apiFail(409,'STORY_STALE_REVISION');
  return {darkGangAwarded:amount,questId:ctx.questId??null,objectiveProgressed:progressed};
}
