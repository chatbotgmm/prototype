// 일반전·랭크전(원본 GMM110 src/roster60-pvp.ts, ranked/settlement.ts, progression/normal-xp.ts 저장 부분).
// 계산은 shared/src/pvp.ts, 여기는 저장·잠금·영수증·시간 처리만.
// 흐름: 편성 저장 → 대기열 참가 → 매칭(사람끼리, 일반전은 30초 뒤 AI) → 10초 안에 둘 다 수락 → 턴마다 30초 → 끝 → 정산 확인.
// 원본과 다르게 한 것(같은 결과, 단순한 방법):
//  - 모든 대전 쓰기를 서버 하나의 직렬 처리(serial 'pvp')로 함. 원본은 DB 잠금 행으로 같은 효과를 냈어요.
//  - 일반전 경험치 장부(Roster60NormalXpLedger) 대신, 방이 FINISHED로 바뀌는 쓰기 안에서 한 번만 지급(방 상태가 두 번 지급을 막음).
//  - 아이템 예약 표(RealtimeItemEscrow) 대신, 고른 아이템을 방 상태(pending.heldItem)에 적고 개수에서 1 빼 둠. 취소·끝나면 돌려줌.
//  - 플레이 패스 점수(사람끼리 정상 승리 3점)는 8단계(상점·패스)에서 연결해요.
//  - 예전 체계 기록(예전 랭크 점수·예전 환생)은 새 프로젝트에 없어서, 환생 이력 묶음은 새 기록만으로 계산해요.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {
  PVP_LIMITS,RANK_BATTLE_LEVEL,RANK_TIER_NAMES,DEFAULT_RANKED_CONFIG,defaultPresencePolicy,monitorObservation,initializePresence,decidePresence,observePresence,validatePresenceForfeitProof,
  applyRankedResult,unchangedRankedResult,initialRankedSnapshot,rankedMatchmakingMmr,casualNext,isVoidedFinish,normalXpPlan,normalXpTerminal,settleNormalXpPlayer,validateNormalXpPolicy,
  rankUnitEligibility,rankLevelEligibility,rebirthHistory,validRebirthCountPin,roster60RankPolicyVersion,roster60MatchPoolPolicyVersion,pickMatches,
  pvpValidate,pvpSwitch,pvpPrimeBot,pvpResolve,pvpTurnDeadline,capturePresentation,presentStep,presentationForViewer,lossFeedback,
  growthAt,makeFighter,selectEnemySpecies,snapshotProfiles,skillElements,observedOpponentIntel,battleKnowledge,opponentFighter,publicDefenseSafe,publicDefenseObservation,observedDefenseVersion,unitXpProgress,
  type PvpState,type PvpSide,type PvpAction,type PvpSnap,type PresenceState,type PresenceMonitor,type PresenceForfeitProof,type RankedSnapshot,type NormalXpPlayerPlan,type CommanderPolicy,
  type Fighter,type DefenseSnapshot,type DefenseObservation,type SkillElement,type Defense,type QueueRow,
} from '../../shared/src/index.js';
import type {Content} from './content.js';
import {apiFail} from './errors.js';
import {serial} from './receipts.js';
import {awardCommanderXp,readCommanderState,type CommanderXpResult} from './progression-service.js';

type Tx=Prisma.TransactionClient;
type Mode='normal'|'rank';
type Room={id:string;player0Id:string;player1Id:string;mode:string;status:string;revision:number;seed:string;snapshot:string;state:string;presence:string|null;deadline:Date;settlement:string|null;createdAt:Date};
type Queue=NonNullable<Awaited<ReturnType<Tx['pvpQueue']['findUnique']>>>;
type MatchPoolPlayer={playerId:string;pool:'FIRST_LIFE'|'REBORN';count:number|null;countSource:string;historyStamp:string};
type RankAdmission={playerId:string;pool:'FIRST_LIFE'|'REBORN';accountLevel:number;ownedIds:string[];catalogVersion:string};
type Snapshot={commanderPolicies?:{playerId:string;policy:CommanderPolicy|null}[];matchPool:{version:string;players:MatchPoolPlayer[]};rankAdmission?:{version:string;players:RankAdmission[]};
  normalXp?:{version:'normal-xp-room-v1';players:NormalXpPlayerPlan[]};catalogVersion:string;observedDefense:DefenseSnapshot;members:{id:string;playerId:string;xp:string}[];queues:{rating:number;tierIndex:number;queuedAt:string}[]};
type FinishReason='BATTLE'|'SURRENDER'|'TIMEOUT'|'DOUBLE_TIMEOUT'|'MATCH_TIMEOUT'|'MATCH_DECLINED'|'SERVER_ABORT';
const sides=[0,1] as const;
const MONITOR_KEY='roster60-presence-monitor-v1';

export class PvpService{
  constructor(private db:PrismaClient,private content:Content,private now:()=>number=()=>Date.now()){}
  private get policy(){return this.content.policy;}
  private snapPvp(snap:Snapshot):PvpSnap{return {policy:this.policy,items:this.content.items,observedDefense:snap.observedDefense};}
  /** 모든 대전 쓰기: 직렬 + 거래, 시작할 때 접속 관측 기록 갱신(원본 tx + observePresenceMonitor) */
  private tx<T>(run:(tx:Tx)=>Promise<T>){
    return serial('pvp',()=>this.db.$transaction(async tx=>{
      const old=await tx.keyValue.findUnique({where:{key:MONITOR_KEY}});let prev:unknown=null;try{prev=old?JSON.parse(old.value):null;}catch{prev={invalid:true};}
      const {monitor}=monitorObservation(prev,this.now(),defaultPresencePolicy),value=JSON.stringify(monitor);
      await tx.keyValue.upsert({where:{key:MONITOR_KEY},create:{key:MONITOR_KEY,value},update:{value}});
      return run(tx);
    },{timeout:20000}));
  }
  private async monitor(tx:Tx):Promise<PresenceMonitor>{return JSON.parse((await tx.keyValue.findUnique({where:{key:MONITOR_KEY}}))?.value??'null');}
  /** 같은 requestId는 처음 결과(원본 request). 다시 온 행동·수락이면 방도 한 번 진행해 봄. */
  private request(id:string,requestId:string,payload:unknown[],run:(tx:Tx)=>Promise<unknown>){
    if(typeof requestId!=='string'||!requestId||requestId.length>100)return apiFail(400,'INVALID_REQUEST');
    return this.tx(async tx=>{
      const fingerprint=createHash('sha256').update(JSON.stringify(['roster-human-v1',payload])).digest('hex');
      const old=await tx.receipt.findUnique({where:{playerId_scope_requestId:{playerId:id,scope:'pvp',requestId}}});
      if(old){if(old.fingerprint!==fingerprint)return apiFail(409,'REQUEST_ID_REUSED');
        if(['action','accept'].includes(String(payload[0]))&&typeof payload[1]==='string'){const row=await tx.pvpMatch.findUnique({where:{id:payload[1]}});if(row&&row.status==='ACTIVE'&&(row.player0Id===id||row.player1Id===id))await this.advance(tx,row,id);}
        return publicDefenseSafe(JSON.parse(old.result));}
      const result=await run(tx);
      await tx.receipt.create({data:{playerId:id,scope:'pvp',requestId,fingerprint,result:JSON.stringify(result)}});
      return result;
    });
  }
  private parse(r:Room){return JSON.parse(r.state) as PvpState;}
  private snap(r:Room){return JSON.parse(r.snapshot) as Snapshot;}
  private ids(r:Room):[string,string]{return [r.player0Id,r.player1Id];}
  private side(r:Room,id:string):PvpSide{if(r.player0Id===id)return 0;if(r.player1Id===id&&this.parse(r).botSide!==1)return 1;return apiFail(404,'BATTLE_NOT_FOUND');}
  private async room(tx:Tx,id:string,battleId:string){const r=await tx.pvpMatch.findUnique({where:{id:battleId}});if(!r)return apiFail(404,'BATTLE_NOT_FOUND');this.side(r,id);return r;}
  private presenceValue(r:Room):unknown{try{return r.presence?JSON.parse(r.presence):null;}catch{return null;}}

  // ── 대원·자격 ──
  private level(u:{speciesId:string;totalXp:bigint;reincarnation:number}){const d=this.content.catalog.characters.find(x=>x.id===u.speciesId);if(!d)return apiFail(503,'BATTLE_UNIT_DATA_PENDING');
    if(u.totalXp<0n||u.totalXp>BigInt(Number.MAX_SAFE_INTEGER))return apiFail(409,'INVALID_XP');return growthAt(Number(u.totalXp),d.growth,u.reincarnation,d.reincarnationXpPolicy).level;}
  /** 출전 대원(원본 members). 랭크는 모두 Lv30으로 맞춤. */
  private async members(tx:Tx,id:string,ids:string[],status:string,mode:Mode){
    if(!(Array.isArray(ids)&&ids.length>=1&&ids.length<=3&&new Set(ids).size===ids.length))return apiFail(400,'INVALID_PARTY');
    const fighters:Fighter[]=[],members:Snapshot['members']=[],rows=[];
    for(const ownedId of ids){const u=await tx.owned.findFirst({where:{id:ownedId,playerId:id}});if(!u)return apiFail(404,'UNIT_NOT_FOUND');if(u.status!==status||u.locked)return apiFail(409,'UNIT_UNAVAILABLE');
      const lv=mode==='rank'?RANK_BATTLE_LEVEL:this.level(u);
      fighters.push({...makeFighter(this.content.catalog,u.speciesId,lv,ownedId,u.reincarnation,u.skillInheritanceJson),ownedId});members.push({id:ownedId,playerId:id,xp:u.totalXp.toString()});rows.push(u);}
    return {fighters,members,rows};
  }
  private async accountLevel(tx:Tx,id:string){const s=await readCommanderState(tx,id,this.content.commander);return s.status==='READY'||s.status==='CURVE_EXTENSION_PENDING'?s.level:null;}
  /** 환생 이력 묶음(원본 readRoster60RebirthHistory를 새 기록으로) */
  private async history(tx:Tx,id:string){
    const account=await tx.rebirthAccount.findUnique({where:{playerId:id}});
    const owned=await tx.owned.findFirst({where:{playerId:id,reincarnation:{gt:0}},select:{id:true,reincarnation:true},orderBy:{id:'asc'}});
    const receipts=(await tx.receipt.findMany({where:{playerId:id,scope:'rebirth'},select:{result:true}})).map(r=>r.result);
    return rebirthHistory({successes:account?.successes??null,reincarnatedOwned:owned,receipts});
  }
  /** 랭크 자격(원본 evaluateRoster60Rank): 방범대장 Lv60 + 출전 대원 모두 Lv60 + 환생 이력 확인 */
  async rankEligibility(tx:Tx,id:string,ownedIds:string[],allowed?:string[]){
    const accountLevel=await this.accountLevel(tx,id),units:{ownedId:string;level:number;rankEligible:boolean;rankReason:string}[]=[];
    const base={accountLevel,requiredAccountLevel:60 as const,requiredUnitLevel:60 as const,pool:null as 'FIRST_LIFE'|'REBORN'|null,scope:'rank-only' as const,policyVersion:roster60RankPolicyVersion,units};
    if(new Set(ownedIds).size!==ownedIds.length||ownedIds.length>6)return {...base,eligible:false,reason:'INVALID_PARTY'};
    for(const ownedId of ownedIds){const u=await tx.owned.findFirst({where:{id:ownedId,playerId:id}});if(!u)return {...base,eligible:false,reason:'UNIT_NOT_FOUND'};
      if(u.locked||allowed&&!allowed.includes(u.status))return {...base,eligible:false,reason:'UNIT_UNAVAILABLE'};const level=this.level(u);units.push({ownedId,level,...rankUnitEligibility(level)});}
    const gate=rankLevelEligibility(accountLevel,units);if(!gate.eligible)return {...base,...gate};
    const pool=(await this.history(tx,id)).pool;if(!pool)return {...base,eligible:false,reason:'RANK_REBIRTH_HISTORY_PENDING'};
    return {...base,eligible:true,reason:'',pool};
  }
  private async requireRank(tx:Tx,id:string,ids:string[],allowed:string[]){const r=await this.rankEligibility(tx,id,ids,allowed);if(!r.eligible)return apiFail(r.reason.endsWith('_PENDING')?503:409,r.reason);return r;}
  private async matchPoolCondition(tx:Tx,id:string,pool:string|null|undefined,version:string|null|undefined,count:number|null|undefined,source:string|null|undefined,stamp:string|null|undefined){
    if(version!==roster60MatchPoolPolicyVersion||!validRebirthCountPin(pool,count,source)||typeof stamp!=='string'||!/^[a-f0-9]{64}$/.test(stamp))return 'MATCH_POOL_QUEUE_POLICY_PENDING';
    const h=await this.history(tx,id);
    return h.pool===null?'MATCH_POOL_POLICY_PENDING':h.pool!==pool?'MATCH_POOL_CLASS_CHANGED':h.count!==count||h.countSource!==source||h.historyStamp!==stamp?'MATCH_POOL_HISTORY_CHANGED':'';
  }
  private async rankPinCondition(tx:Tx,id:string,ownedIds:string[],pin:RankAdmission|null,status:string){
    if(!pin||pin.playerId!==id||pin.ownedIds.length!==ownedIds.length||pin.ownedIds.some(o=>!ownedIds.includes(o)))return 'RANK_QUEUE_POLICY_PENDING';
    if(pin.catalogVersion!==this.content.catalog.version)return 'RANK_CATALOG_CHANGED';
    const r=await this.rankEligibility(tx,id,ownedIds,[status]);return !r.eligible?r.reason:r.pool!==pin.pool?'RANK_QUEUE_CLASS_CHANGED':'';
  }
  private readPin(raw:string|null|undefined):RankAdmission|null{if(!raw)return null;try{const p=JSON.parse(raw);return typeof p.playerId==='string'&&['FIRST_LIFE','REBORN'].includes(p.pool)&&Number.isSafeInteger(p.accountLevel)&&p.accountLevel>=60&&Array.isArray(p.ownedIds)?p:null;}catch{return null;}}
  private async queueCondition(tx:Tx,q:Queue){
    const ids=JSON.parse(q.ownedIds);if(!(Array.isArray(ids)&&ids.length>=1&&ids.length<=3))return 'PARTY_RESELECTION_REQUIRED';
    const pool=await this.matchPoolCondition(tx,q.playerId,q.pool,roster60MatchPoolPolicyVersion,q.rebirthCount,q.countSource,q.historyStamp);if(pool)return pool;
    if(q.mode==='rank'){const pin=this.readPin(q.rankAdmission);if(!pin||pin.pool!==q.pool)return 'RANK_QUEUE_POLICY_PENDING';return this.rankPinCondition(tx,q.playerId,ids,pin,'PVP_QUEUE');}
    return '';
  }
  /** 수락 대기 중 자격·묶음이 바뀌었는지(원본 matchRoomConditions·rankRoomConditions) */
  private async roomConditions(tx:Tx,r:Room){
    const snap=this.snap(r),s=this.parse(r),pool:Record<string,string>={},rank:Record<string,string>={};
    for(const id of this.ids(r)){if(s.botSide===1&&id===r.player1Id)continue;const p=snap.matchPool.players.find(x=>x.playerId===id);
      const c=await this.matchPoolCondition(tx,id,p?.pool,snap.matchPool.version,p?.count,p?.countSource,p?.historyStamp);if(c)pool[id]=c;}
    if(!Object.keys(pool).length&&s.botSide!==1&&snap.matchPool.players[0]?.pool!==snap.matchPool.players[1]?.pool)for(const id of this.ids(r))pool[id]='MATCH_POOL_CLASS_CHANGED';
    if(r.mode==='rank'){for(const id of this.ids(r)){const pin=snap.rankAdmission?.players.find(p=>p.playerId===id)??null;
        const c=await this.rankPinCondition(tx,id,snap.members.filter(m=>m.playerId===id).map(m=>m.id),pin,'PVP');if(c)rank[id]=c;}
      if(!Object.keys(rank).length&&snap.rankAdmission!.players[0].pool!==snap.rankAdmission!.players[1].pool)for(const id of this.ids(r))rank[id]='RANK_QUEUE_CLASS_CHANGED';}
    return {pool,rank};
  }

  // ── 점수 프로필 ──
  private async casual(tx:Tx,id:string){return (await tx.casualRating.findUnique({where:{playerId:id}}))??tx.casualRating.create({data:{playerId:id}});}
  private async ranked(tx:Tx,id:string){const found=await tx.rankedProfile.findUnique({where:{playerId:id}});if(found)return found;const c=await tx.casualRating.findUnique({where:{playerId:id}});
    return tx.rankedProfile.create({data:{playerId:id,...initialRankedSnapshot(c?{mmr:c.mmr,games:c.games}:undefined)}});}
  private rs(row:{tierIndex:number;lp:number;promotionActive:boolean;promotionWins:number;promotionLosses:number;rankedMmr:number;casualPriorOffset:number;games:number;wins:number;losses:number;draws:number}):RankedSnapshot{
    const {tierIndex,lp,promotionActive,promotionWins,promotionLosses,rankedMmr,casualPriorOffset,games,wins,losses,draws}=row;return {tierIndex,lp,promotionActive,promotionWins,promotionLosses,rankedMmr,casualPriorOffset,games,wins,losses,draws};}
  /** 매칭 점수(원본 matchmakingRating): 일반전은 일반 점수, 랭크는 랭크 점수(첫 랭크 경기 전에는 일반전 점수 반영값을 새로 고침) */
  private async rating(tx:Tx,id:string,mode:Mode){
    if(mode==='normal')return (await this.casual(tx,id)).mmr;
    const p=await this.ranked(tx,id),cur=this.rs(p);
    if(p.games===0){const c=await tx.casualRating.findUnique({where:{playerId:id}}),offset=initialRankedSnapshot(c?{mmr:c.mmr,games:c.games}:undefined).casualPriorOffset;
      if(offset!==p.casualPriorOffset){await tx.rankedProfile.update({where:{playerId:id},data:{casualPriorOffset:offset,version:{increment:1}}});cur.casualPriorOffset=offset;}}
    return rankedMatchmakingMmr(cur);
  }

  // ── 조회 ──
  async options(id:string){
    const own=await this.db.owned.findMany({where:{playerId:id,status:'AVAILABLE',locked:false},orderBy:{id:'asc'}});
    const party=await this.db.pvpParty.findUnique({where:{playerId:id}}),partyIds=party?JSON.parse(party.ownedIds):[];
    const rankEligibility=await this.db.$transaction(tx=>this.rankEligibility(tx,id,[]));
    return {units:own.map(u=>{const d=this.content.catalog.characters.find(c=>c.id===u.speciesId)!,level=this.level(u);return {ownedId:u.id,speciesId:u.speciesId,name:d.name,rarity:d.rarity,level,...rankUnitEligibility(level)};}),
      partyIds,partySelectionRequired:!(partyIds.length>=1&&partyIds.length<=3),rankEligibility,commander:await readCommanderState(this.db,id,this.content.commander)};
  }
  async party(id:string,ownedIds:string[],mode?:Mode){
    return this.tx(async tx=>{await this.expireQueue(tx);
      if(await this.busy(tx,id))return apiFail(409,'PVP_BUSY');
      await this.members(tx,id,ownedIds,'AVAILABLE','normal');
      const rankEligibility=mode==='rank'?await this.requireRank(tx,id,ownedIds,['AVAILABLE']):null;
      await tx.pvpParty.upsert({where:{playerId:id},create:{playerId:id,ownedIds:JSON.stringify(ownedIds)},update:{ownedIds:JSON.stringify(ownedIds)}});
      return {partyIds:ownedIds,partySelectionRequired:false,...(rankEligibility?{mode:'rank',rankEligibility}:{})};
    });
  }
  /** 대기 중이거나 끝을 확인하지 않은 방이 있으면 바쁨(원본 realtimeActivity) */
  private async busy(tx:Tx,id:string){return !!(await tx.pvpQueue.findUnique({where:{playerId:id}}))||!!(await this.findRoom(tx,id));}
  private async findRoom(tx:Tx,id:string){const rooms=await tx.pvpMatch.findMany({where:{OR:[{player0Id:id},{player1Id:id}]},orderBy:{createdAt:'desc'},take:20});return rooms.find(r=>!this.parse(r).ack[this.side(r,id)]);}
  async current(id:string){return this.tx(tx=>this.currentIn(tx,id));}
  private async currentIn(tx:Tx,id:string){
    await this.expireQueue(tx);const q=await tx.pvpQueue.findUnique({where:{playerId:id}});
    if(q){await tx.pvpQueue.update({where:{playerId:id},data:{leaseUntil:new Date(this.now()+PVP_LIMITS.queueLeaseMs)}});await this.match(tx,q.mode as Mode);}
    const r=await this.findRoom(tx,id);
    if(r)return {status:'matched',mode:r.mode,serverNow:this.now(),battle:await this.view(tx,await this.advance(tx,r,id),id)};
    const q2=await tx.pvpQueue.findUnique({where:{playerId:id}}),saved=q2?null:await tx.pvpParty.findUnique({where:{playerId:id}});
    const ids=q2?JSON.parse(q2.ownedIds):saved?JSON.parse(saved.ownedIds):[];
    const matchPoolCondition=q2?await this.matchPoolCondition(tx,id,q2.pool,roster60MatchPoolPolicyVersion,q2.rebirthCount,q2.countSource,q2.historyStamp):null;
    const rankCondition=q2?.mode==='rank'?await this.queueCondition(tx,q2):null;
    return {status:q2?'waiting':'idle',partyIds:ids,partySelectionRequired:!(ids.length>=1&&ids.length<=3),mode:q2?.mode,queuedAt:q2?.queuedAt.getTime()??null,
      aiAvailableAt:q2?.mode==='normal'?q2.queuedAt.getTime()+PVP_LIMITS.casualAiAfterMs:null,matchPoolCondition,matchPool:q2?.pool??null,...(q2?.mode==='rank'?{rankCondition,rankPool:q2.pool}:{}),cancelAllowed:!!q2,serverNow:this.now()};
  }
  async rank(id:string){
    return this.tx(async tx=>{
      const row=await this.ranked(tx,id),c=DEFAULT_RANKED_CONFIG,me=await tx.player.findUniqueOrThrow({where:{id}});
      const rows=await tx.rankedProfile.findMany({where:{games:{gt:0}},include:{player:{select:{nickname:true}}},orderBy:[{tierIndex:'desc'},{lp:'desc'},{wins:'desc'},{playerId:'asc'}],take:20});
      const ahead=await tx.rankedProfile.count({where:{games:{gt:0},OR:[{tierIndex:{gt:row.tierIndex}},{tierIndex:row.tierIndex,lp:{gt:row.lp}},{tierIndex:row.tierIndex,lp:row.lp,wins:{gt:row.wins}},{tierIndex:row.tierIndex,lp:row.lp,wins:row.wins,playerId:{lt:row.playerId}}]}});
      return {me:{point:row.lp,tier:c.tiers[row.tierIndex],tierName:RANK_TIER_NAMES[row.tierIndex],tierIndex:row.tierIndex,nickname:me.nickname,wins:row.wins,losses:row.losses,draws:row.draws,rank:row.games>0?ahead+1:null,
          promotion:{active:row.promotionActive,wins:row.promotionWins,losses:row.promotionLosses,requiredWins:Math.floor(c.promotionBestOf/2)+1,maxGames:c.promotionBestOf}},win:c.winLp,lose:c.lossLp,
        top:rows.map((r,i)=>({rank:i+1,playerId:r.playerId,nickname:r.player.nickname??'이름 없는 갈매미',point:r.lp,tier:c.tiers[r.tierIndex],tierName:RANK_TIER_NAMES[r.tierIndex],tierIndex:r.tierIndex,wins:r.wins,losses:r.losses})),
        tiers:c.tiers.map((name,index)=>({name,tierName:RANK_TIER_NAMES[index],index,promotionLp:index===c.tiers.length-1?null:c.promotionLp}))};
    });
  }

  // ── 대기열 ──
  private async expireQueue(tx:Tx){for(const q of await tx.pvpQueue.findMany({where:{leaseUntil:{lte:new Date(this.now())}}}))await this.removeQueue(tx,q.playerId);}
  private async removeQueue(tx:Tx,id:string){const q=await tx.pvpQueue.findUnique({where:{playerId:id}});if(!q)return;
    await tx.owned.updateMany({where:{playerId:id,id:{in:JSON.parse(q.ownedIds)},status:'PVP_QUEUE'},data:{status:'AVAILABLE'}});await tx.pvpQueue.delete({where:{playerId:id}});}
  async cancel(id:string,b:{requestId:string}){return this.request(id,b.requestId,['cancel'],async tx=>{await this.removeQueue(tx,id);return this.currentIn(tx,id);});}
  async join(id:string,b:{requestId:string;mode:Mode}){
    return this.request(id,b.requestId,['join',b.mode],async tx=>{
      await this.expireQueue(tx);
      const active=await this.findRoom(tx,id);if(active)return {status:'matched',mode:active.mode,serverNow:this.now(),battle:await this.view(tx,await this.advance(tx,active,id),id)};
      if(await tx.pvpQueue.findUnique({where:{playerId:id}}))return this.currentIn(tx,id);
      const saved=await tx.pvpParty.findUnique({where:{playerId:id}});if(!saved)return apiFail(409,'PARTY_REQUIRED');
      const ids:string[]=JSON.parse(saved.ownedIds);if(!(ids.length>=1&&ids.length<=3))return apiFail(409,'PARTY_RESELECTION_REQUIRED');
      const units=await this.members(tx,id,ids,'AVAILABLE',b.mode);
      const elig=b.mode==='rank'?await this.requireRank(tx,id,ids,['AVAILABLE']):null;
      const admission:RankAdmission|null=elig&&elig.eligible&&elig.pool&&elig.accountLevel!==null?{playerId:id,pool:elig.pool,accountLevel:elig.accountLevel,ownedIds:[...ids],catalogVersion:this.content.catalog.version}:null;
      const history=await this.history(tx,id);if(history.pool===null)return apiFail(503,'MATCH_POOL_POLICY_PENDING');
      if(elig&&elig.pool!==history.pool)return apiFail(409,'MATCH_POOL_CLASS_CHANGED');
      const xpPlan=b.mode==='normal'?normalXpPlan(id,units.rows.map(u=>({id:u.id,speciesId:u.speciesId,totalXp:u.totalXp,reincarnation:u.reincarnation})),this.content.catalog,this.policy,this.content.normalXp):null;
      const commanderPin=b.mode==='normal'?structuredClone(this.content.commander):null;
      if(commanderPin){const acc=await readCommanderState(tx,id,commanderPin);if(acc.status==='POLICY_MISMATCH')return apiFail(503,'COMMANDER_ACCOUNT_POLICY_MISMATCH');if(acc.status==='DATA_INVALID')return apiFail(503,'COMMANDER_XP_DATA_INVALID');}
      for(const m of units.members){const n=await tx.owned.updateMany({where:{id:m.id,playerId:id,status:'AVAILABLE',locked:false},data:{status:'PVP_QUEUE'}});if(n.count!==1)return apiFail(409,'UNIT_UNAVAILABLE');}
      const rating=await this.rating(tx,id,b.mode),rank=await tx.rankedProfile.findUnique({where:{playerId:id}});
      await tx.pvpQueue.create({data:{playerId:id,mode:b.mode,rating:Math.round(rating),tierIndex:rank?.tierIndex??0,ownedIds:JSON.stringify(ids),queuedAt:new Date(this.now()),leaseUntil:new Date(this.now()+PVP_LIMITS.queueLeaseMs),
        normalXp:xpPlan?JSON.stringify(xpPlan):null,commander:b.mode==='normal'?JSON.stringify({playerId:id,policy:commanderPin}):null,rankAdmission:admission?JSON.stringify(admission):null,
        pool:history.pool,rebirthCount:history.count,countSource:history.countSource,historyStamp:history.historyStamp}});
      await this.match(tx,b.mode);
      return this.currentIn(tx,id);
    });
  }
  /** 매칭 한 번(원본 match): 조건 통과한 대기열 → 사람끼리 짝, 일반전은 30초 넘게 기다린 사람을 AI와 */
  private async match(tx:Tx,mode:Mode){
    const all=await tx.pvpQueue.findMany({where:{mode,leaseUntil:{gt:new Date(this.now())},pool:{in:['FIRST_LIFE','REBORN']},countSource:{not:null},historyStamp:{not:null},...(mode==='rank'?{rankAdmission:{not:null}}:{normalXp:{not:null}})},orderBy:[{queuedAt:'asc'},{playerId:'asc'}],take:PVP_LIMITS.maxWaiting});
    const rows:Queue[]=[];for(const q of all)if(!await this.queueCondition(tx,q))rows.push(q);
    const active=await tx.pvpMatch.count({where:{status:{in:['ACTIVE','ACCEPTING']}}});
    const picked=pickMatches(rows.map(q=>({...q,reincarnationPool:q.pool,reincarnationCount:q.rebirthCount}) as QueueRow&Queue),this.now(),mode,PVP_LIMITS.maxRooms-active);
    for(const [a,b] of picked.pairs)await this.createRoom(tx,a as unknown as Queue,b as unknown as Queue,mode);
    for(const q of picked.bots)await this.createBotRoom(tx,q as unknown as Queue);
  }
  /** 두 사람이 서로의 상대 종에 대해 이미 아는 방어 반응(원본 captureDefenseSnapshot, 보는 쪽 '0'·'1') */
  private async defenseSnapshot(tx:Tx,viewers:Record<string,{playerId:string;targets:Fighter[]}>):Promise<DefenseSnapshot>{
    const all=Object.values(viewers).flatMap(v=>v.targets),profiles=snapshotProfiles(this.content.catalog,all),initial:DefenseSnapshot['initial']={};
    for(const [viewer,v] of Object.entries(viewers)){initial[viewer]={};const species=[...new Set(v.targets.map(t=>t.speciesId).filter(s=>profiles[s]))];
      if(species.length)for(const r of await tx.observedDefense.findMany({where:{playerId:v.playerId,speciesId:{in:species}}}))
        if(profiles[r.speciesId]===r.profileKey&&skillElements.includes(r.element as SkillElement))(initial[viewer][r.speciesId]??={})[r.element as SkillElement]=r.reaction as Defense;}
    return {version:observedDefenseVersion,profiles,initial};
  }
  private poolPin(q:Queue):MatchPoolPlayer{return {playerId:q.playerId,pool:q.pool as 'FIRST_LIFE'|'REBORN',count:q.rebirthCount,countSource:q.countSource!,historyStamp:q.historyStamp!};}
  private plan(q:Queue,members:Snapshot['members']):NormalXpPlayerPlan|null{if(!q.normalXp)return null;const p=JSON.parse(q.normalXp) as NormalXpPlayerPlan;validateNormalXpPolicy(p.policy,this.content.catalog.version);
    if(p.playerId!==q.playerId||p.members.length!==members.length||p.members.some(m=>!members.some(r=>r.id===m.id&&r.xp===m.startingXp)))return apiFail(409,'NORMAL_XP_SNAPSHOT_INVALID');return p;}
  private commanderPin(q:Queue):CommanderPolicy|null{if(!q.commander)return null;const pin=JSON.parse(q.commander);return pin.playerId===q.playerId?pin.policy:null;}
  private async createRoom(tx:Tx,a:Queue,b:Queue,mode:Mode){
    if(await this.queueCondition(tx,a)||await this.queueCondition(tx,b))return;
    const p0=await this.members(tx,a.playerId,JSON.parse(a.ownedIds),'PVP_QUEUE',mode),p1=await this.members(tx,b.playerId,JSON.parse(b.ownedIds),'PVP_QUEUE',mode);
    const id=randomUUID(),state:PvpState={entered:[[p0.fighters[0].ownedId!],[p1.fighters[0].ownedId!]],turn:0,parties:[p0.fighters,p1.fighters],pending:[null,null],accepted:[false,false],ack:[false,false],misses:[0,0],winner:null,events:[]};
    const observedDefense=await this.defenseSnapshot(tx,{'0':{playerId:a.playerId,targets:p1.fighters},'1':{playerId:b.playerId,targets:p0.fighters}});
    const plans=mode==='normal'?[this.plan(a,p0.members),this.plan(b,p1.members)].filter((p):p is NormalXpPlayerPlan=>!!p).map(p=>p.policy.xpPacing?{...p,enemyLevel:Math.max(...(p.playerId===a.playerId?p1:p0).fighters.map(f=>f.level))}:p):undefined;
    const snapshot:Snapshot={commanderPolicies:mode==='normal'?[a,b].map(q=>({playerId:q.playerId,policy:this.commanderPin(q)})):undefined,matchPool:{version:roster60MatchPoolPolicyVersion,players:[this.poolPin(a),this.poolPin(b)]},
      rankAdmission:mode==='rank'?{version:roster60RankPolicyVersion,players:[this.readPin(a.rankAdmission)!,this.readPin(b.rankAdmission)!]}:undefined,normalXp:plans?{version:'normal-xp-room-v1',players:plans}:undefined,
      catalogVersion:this.content.catalog.version,observedDefense,members:[...p0.members,...p1.members],queues:[a,b].map(q=>({rating:q.rating,tierIndex:q.tierIndex,queuedAt:q.queuedAt.toISOString()}))};
    await tx.pvpMatch.create({data:{id,player0Id:a.playerId,player1Id:b.playerId,mode,seed:randomBytes(32).toString('hex'),snapshot:JSON.stringify(snapshot),state:JSON.stringify(state),
      presence:JSON.stringify(initializePresence(await this.monitor(tx),this.now(),defaultPresencePolicy)),deadline:new Date(this.now()+PVP_LIMITS.acceptMs),createdAt:new Date(this.now())}});
    for(const q of [a,b]){await tx.owned.updateMany({where:{playerId:q.playerId,id:{in:JSON.parse(q.ownedIds)},status:'PVP_QUEUE'},data:{status:'PVP'}});await tx.pvpQueue.delete({where:{playerId:q.playerId}});}
  }
  /** AI 방(원본 createBotRoom): 내 대원마다 레벨이 가장 가까운 연습 상대 조우에서 종을 골라 같은 수만큼 */
  private async createBotRoom(tx:Tx,q:Queue){
    if(q.mode!=='normal'||this.now()<q.queuedAt.getTime()+PVP_LIMITS.casualAiAfterMs||q.leaseUntil.getTime()<=this.now())return;
    if(await this.queueCondition(tx,q))return;
    const human=await this.members(tx,q.playerId,JSON.parse(q.ownedIds),'PVP_QUEUE','normal'),encounters=this.policy.encounters.filter(e=>e.mode==='duel'&&!e.tutorial);
    if(!encounters.length)return apiFail(503,'AI_POLICY_PENDING');
    const id=randomUUID(),seed=randomBytes(32).toString('hex');
    const bot=human.fighters.map((f,i)=>{const e=[...encounters].sort((x,y)=>Math.abs(x.level-f.level)-Math.abs(y.level-f.level)||x.id.localeCompare(y.id))[0],key='AI:'+id+':'+i;
      return {...makeFighter(this.content.catalog,selectEnemySpecies(e,this.policy.encounters,seed+':'+i),e.level,key),ownedId:key};});
    const state:PvpState={entered:[[human.fighters[0].ownedId!],[bot[0].ownedId!]],botSide:1,turn:0,parties:[human.fighters,bot],pending:[null,null],accepted:[false,true],ack:[false,true],misses:[0,0],winner:null,events:[]};
    const plan=this.plan(q,human.members);
    const snapshot:Snapshot={commanderPolicies:[{playerId:q.playerId,policy:this.commanderPin(q)}],matchPool:{version:roster60MatchPoolPolicyVersion,players:[this.poolPin(q)]},
      normalXp:{version:'normal-xp-room-v1',players:plan?[plan.policy.xpPacing?{...plan,enemyLevel:Math.max(...bot.map(f=>f.level))}:plan]:[]},catalogVersion:this.content.catalog.version,
      observedDefense:await this.defenseSnapshot(tx,{'0':{playerId:q.playerId,targets:bot}}),members:human.members,queues:[{rating:q.rating,tierIndex:q.tierIndex,queuedAt:q.queuedAt.toISOString()}]};
    await tx.pvpMatch.create({data:{id,player0Id:q.playerId,player1Id:'AI:'+id,mode:'normal',seed,snapshot:JSON.stringify(snapshot),state:JSON.stringify(state),
      presence:JSON.stringify(initializePresence(await this.monitor(tx),this.now(),defaultPresencePolicy,1)),deadline:new Date(this.now()+PVP_LIMITS.acceptMs),createdAt:new Date(this.now())}});
    await tx.owned.updateMany({where:{playerId:q.playerId,id:{in:JSON.parse(q.ownedIds)},status:'PVP_QUEUE'},data:{status:'PVP'}});await tx.pvpQueue.delete({where:{playerId:q.playerId}});
  }

  // ── 방 진행 ──
  async accept(id:string,b:{requestId:string;battleId:string;revision:number;accept:boolean}){
    return this.request(id,b.requestId,['accept',b.battleId,b.revision,b.accept],async tx=>{
      let r=await this.advance(tx,await this.room(tx,id,b.battleId),id);
      if(r.status!=='ACCEPTING')return this.view(tx,r,id);
      if(r.revision!==b.revision)return apiFail(409,'STALE_REVISION');
      const s=this.parse(r),side=this.side(r,id);
      if(!b.accept){s.accepted[side]=false;r=await this.finish(tx,r,s,null,'MATCH_DECLINED');return this.view(tx,r,id);}
      s.accepted[side]=true;
      if(s.accepted.every(Boolean)){pvpPrimeBot(s,this.snapPvp(this.snap(r)));
        if(r.mode==='rank')for(const pid of this.ids(r))await this.ranked(tx,pid); // 원본 registerRankedMatch: 두 사람 랭크 프로필 준비
        r=await tx.pvpMatch.update({where:{id:r.id},data:{status:'ACTIVE',revision:{increment:1},state:JSON.stringify(s),deadline:new Date(this.now()+PVP_LIMITS.turnMs)}});}
      else r=await tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s)}});
      return this.view(tx,r,id);
    });
  }
  async action(id:string,b:{requestId:string;battleId:string;revision:number;action:PvpAction}){
    return this.request(id,b.requestId,['action',b.battleId,b.revision,b.action.kind,b.action.skillId??null,b.action.itemId??null,b.action.targetOwnedId??null],async tx=>{
      const before=await this.room(tx,id,b.battleId);let r=await this.advance(tx,before,id);
      if(r.status!=='ACTIVE'||r.revision!==before.revision)return this.view(tx,r,id);
      if(r.revision!==b.revision)return apiFail(409,'STALE_REVISION');
      const s=this.parse(r),side=this.side(r,id),snap=this.snap(r),ps=this.snapPvp(snap);
      pvpValidate(s,side,b.action,ps);
      if(s.connectionPause)return this.view(tx,r,id);
      const knowledge=sides.map(v=>battleKnowledge(snap.observedDefense,s.events,String(v)));
      const intels=()=>sides.map(v=>observedOpponentIntel(s.parties[1-v][0],s.turn,snap.observedDefense,knowledge[v],this.content.catalog));
      if(b.action.kind==='escape'){const pair=s.parties.map(p=>p[0]),intelBefore=intels();
        s.events.push({turn:s.turn,events:[{side,kind:'surrender',presentation:presentStep(capturePresentation(pair),pair),intelBefore,intelAfter:intels()}]});
        r=await this.finish(tx,r,s,(1-side) as PvpSide,'SURRENDER');return this.view(tx,r,id);}
      if(s.parties[side][0].hp<=0){const stepBefore=capturePresentation(s.parties.map(p=>p[0])),intelBefore=intels();s.misses[side]=0;pvpSwitch(s,side,b.action.targetOwnedId!);pvpPrimeBot(s,ps);
        s.events.push({turn:s.turn,events:[{side,kind:'forced-switch',presentation:presentStep(stepBefore,s.parties.map(p=>p[0])),intelBefore,intelAfter:intels()}]});
        r=await tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s),revision:{increment:1},deadline:new Date(this.now()+PVP_LIMITS.turnMs)}});return this.view(tx,r,id);}
      if(s.parties.some(p=>p[0].hp<=0))return apiFail(409,'OPPONENT_FORCED_SWITCH');
      if(s.pending[side])return apiFail(409,'ACTION_ALREADY_SUBMITTED');
      const action={...b.action} as PvpState['pending'][0]&{};
      if(action.kind==='item'){const n=await tx.playerItem.updateMany({where:{playerId:id,itemId:action.itemId!,count:{gt:0}},data:{count:{decrement:1}}});if(n.count!==1)return apiFail(409,'ITEM_UNAVAILABLE');action.heldItem=action.itemId;}
      s.pending[side]=action;s.misses[side]=0;
      r=await tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s)}});
      if(s.pending.every(Boolean))r=await this.resolve(tx,r,s);
      return this.view(tx,r,id);
    });
  }
  private async refund(tx:Tx,r:Room,side:PvpSide,itemId:string){const pid=this.ids(r)[side];await tx.playerItem.upsert({where:{playerId_itemId:{playerId:pid,itemId}},create:{playerId:pid,itemId,count:1},update:{count:{increment:1}}});}
  private async resolve(tx:Tx,r:Room,s:PvpState,timeoutGenerated=false):Promise<Room>{
    const snap=this.snap(r),res=pvpResolve(r.id,r.seed,s,this.snapPvp(snap),this.content.catalog);
    for(const op of res.itemOps)if(op.op==='REFUNDED')await this.refund(tx,r,op.side,op.itemId);
    const claimed=await tx.pvpMatch.updateMany({where:{id:r.id,revision:r.revision,status:'ACTIVE'},data:{state:JSON.stringify(s)}});if(claimed.count!==1)return apiFail(409,'STALE_REVISION');
    await this.persistObservations(tx,s.botSide===1?{'0':r.player0Id}:{'0':r.player0Id,'1':r.player1Id},res.observations);
    if(res.finished)return this.finish(tx,r,s,res.finished.winner,'BATTLE',timeoutGenerated);
    return tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s),revision:{increment:1},deadline:new Date(this.now()+PVP_LIMITS.turnMs)}});
  }
  private async persistObservations(tx:Tx,players:Record<string,string>,list:DefenseObservation[]){
    for(const o of list){const playerId=players[o.viewer];if(!playerId||!o.profileKey)continue;
      await tx.observedDefense.upsert({where:{playerId_speciesId_profileKey_element:{playerId,speciesId:o.speciesId,profileKey:o.profileKey,element:o.element}},create:{playerId,speciesId:o.speciesId,profileKey:o.profileKey,element:o.element,reaction:o.reaction},update:{reaction:o.reaction}});}
  }
  /** 시간·접속에 따라 방을 진행(원본 advance): 수락 시간, 자격 변화, 접속 판정(재접속 유예·증명된 이탈), 턴 제한 시간 */
  private async advance(tx:Tx,r:Room,observerId?:string):Promise<Room>{
    if(!['ACTIVE','ACCEPTING'].includes(r.status))return r;
    const state=this.parse(r),now=this.now();
    if(r.status==='ACCEPTING'){const c=await this.roomConditions(tx,r);if(Object.keys(c.rank).length||Object.keys(c.pool).length)return this.finish(tx,r,state,null,'SERVER_ABORT',false,c.rank,c.pool);}
    if(now-r.createdAt.getTime()>=PVP_LIMITS.roomMaxMs)return this.finish(tx,r,state,null,r.status==='ACCEPTING'?'MATCH_TIMEOUT':'SERVER_ABORT');
    if(r.status==='ACCEPTING'&&r.deadline.getTime()<=now)return this.finish(tx,r,state,null,'MATCH_TIMEOUT');
    const monitor=await this.monitor(tx);let presence=this.presenceValue(r),decision=decidePresence(presence,monitor,now);
    if(r.status==='ACTIVE'){
      if(decision.kind==='FORFEIT_PROVEN'){if(!validatePresenceForfeitProof(decision.proof,{state:presence,monitor}))return this.finish(tx,r,state,null,'SERVER_ABORT');return this.finish(tx,r,state,decision.proof.survivorSide,'TIMEOUT',false,{},{},decision.proof);}
      if(decision.kind==='ABORT_NEUTRAL')return this.finish(tx,r,state,null,decision.reason==='SURVIVOR_UNPROVEN'?'DOUBLE_TIMEOUT':'SERVER_ABORT');
    }
    if(observerId){const o=observePresence(presence,this.side(r,observerId),monitor,now);
      if(o.state&&o.decision.kind!=='FORFEIT_PROVEN'&&o.decision.kind!=='ABORT_NEUTRAL'){presence=o.state;decision=o.decision;r=await tx.pvpMatch.update({where:{id:r.id},data:{presence:JSON.stringify(presence)}});}}
    if(r.status==='ACCEPTING')return r;
    const cur=presence as PresenceState;
    const waiting=()=>{const observedAfter=state.connectionPause?.observedAfter??r.deadline.getTime()-PVP_LIMITS.turnMs;if(!state.connectionPause&&now<r.deadline.getTime())return false;
      return sides.some(sd=>sd!==state.botSide&&!state.pending[sd]&&cur.participants[sd]!.lastSeenAt<=observedAfter);};
    if(decision.kind==='RECONNECT_GRACE'||waiting()){
      const wasPaused=!!state.connectionPause;state.connectionPause??={observedAfter:r.deadline.getTime()-PVP_LIMITS.turnMs,startedAt:now};
      const checks=cur.participants.filter((p):p is NonNullable<typeof p>=>p!==null).filter(p=>p.lastSeenAt<=state.connectionPause!.observedAfter||p.leaseUntil<=now).map(p=>p.leaseUntil>now?p.leaseUntil:p.lastSeenAt+cur.policy.totalAbsentMs);
      const deadline=new Date(Math.max(now+1,Math.min(...checks,now+PVP_LIMITS.turnMs)));
      if(!wasPaused||r.deadline.getTime()!==deadline.getTime())r=await tx.pvpMatch.update({where:{id:r.id},data:{...(!wasPaused?{state:JSON.stringify(state)}:{}),deadline}});
      return r;
    }
    if(state.connectionPause){delete state.connectionPause;return tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(state),deadline:new Date(now+PVP_LIMITS.turnMs)}});}
    if(r.deadline.getTime()>now)return r;
    const d=pvpTurnDeadline(state);
    if(d.finish)return this.finish(tx,r,state,d.finish.winner,d.finish.reason);
    if(d.waitForced)return tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(state),deadline:new Date(now+PVP_LIMITS.turnMs)}});
    return this.resolve(tx,r,state,true);
  }
  /** 끝(원본 finish): 아이템 돌려주기, 점수(사람끼리), 일반전 경험치, 방범대장, 대원 풀기, 수락했는데 상대 때문에 안 열린 사람은 대기열로 */
  private async finish(tx:Tx,r:Room,s:PvpState,winner:PvpSide|null,reason:FinishReason,timeoutGenerated=false,rankConditions:Record<string,string>={},matchPoolConditions:Record<string,string>={},proof?:PresenceForfeitProof):Promise<Room>{
    for(const side of sides){const a=s.pending[side];if(a?.heldItem){await this.refund(tx,r,side,a.heldItem);delete a.heldItem;}}
    s.pending=[null,null];s.winner=winner;
    const snap=this.snap(r),ids=this.ids(r),now=new Date(this.now());
    const rated=s.botSide===1||reason==='MATCH_TIMEOUT'||reason==='MATCH_DECLINED'||r.status==='ACCEPTING'&&reason==='SERVER_ABORT'?null:reason as Exclude<FinishReason,'MATCH_TIMEOUT'|'MATCH_DECLINED'>;
    let rating:unknown=null;
    if(rated&&r.mode==='rank'){const p=[await this.ranked(tx,ids[0]),await this.ranked(tx,ids[1])],s0=this.rs(p[0]),s1=this.rs(p[1]),voided=isVoidedFinish(rated);
      const c=[voided?unchangedRankedResult(s0):applyRankedResult(s0,s1,winner===null?0.5:winner===0?1:0),voided?unchangedRankedResult(s1):applyRankedResult(s1,s0,winner===null?0.5:winner===1?1:0)];
      if(!voided)for(const i of [0,1] as const){const n=await tx.rankedProfile.updateMany({where:{playerId:ids[i],version:p[i].version},data:{...c[i].after,version:{increment:1}}});if(n.count!==1)return apiFail(409,'RANKED_CONCURRENT_WRITE');}
      rating={formatVersion:1,configVersion:DEFAULT_RANKED_CONFIG.version,roomId:r.id,winner,reason:rated,voided,finishedAt:now.toISOString(),players:[{playerId:ids[0],...c[0]},{playerId:ids[1],...c[1]}]};}
    else if(rated){const p=[await this.casual(tx,ids[0]),await this.casual(tx,ids[1])],b=p.map(x=>({mmr:x.mmr,games:x.games,wins:x.wins,losses:x.losses,draws:x.draws}));
      const a=[casualNext(b[0],b[1],winner,0,rated),casualNext(b[1],b[0],winner,1,rated)];
      if(!isVoidedFinish(rated))for(const i of [0,1] as const){const n=await tx.casualRating.updateMany({where:{playerId:ids[i],version:p[i].version},data:{...a[i],version:{increment:1}}});if(n.count!==1)return apiFail(409,'RANKED_CONCURRENT_WRITE');}
      rating={formatVersion:1,roomId:r.id,winner,reason:rated,voided:isVoidedFinish(rated),players:[0,1].map(i=>({playerId:ids[i],before:b[i],after:a[i],lpDelta:0,mmrDelta:Math.round((a[i].mmr-b[i].mmr)*1e6)/1e6}))};}
    // 일반전 경험치(랭크는 없음)
    let normalXp:{status:string;players:Record<string,ReturnType<typeof settleNormalXpPlayer>>;appliedByOwnedId:Record<string,number>}|null=null;
    if(r.mode==='normal'){const terminal=normalXpTerminal(reason,winner,timeoutGenerated,proof),plans=snap.normalXp?.players??[];
      normalXp={status:plans.length?terminal.status:'LEGACY_POLICY_UNCONFIGURED',players:{},appliedByOwnedId:{}};
      for(const side of sides){if(side===s.botSide)continue;const pid=ids[side],refs=snap.members.filter(m=>m.playerId===pid);
        const own=settleNormalXpPlayer(plans.find(p=>p.playerId===pid)??null,refs,s.entered?.[side]??[],side,winner,terminal,s.botSide);normalXp.players[pid]=own;
        for(const u of own.units)normalXp.appliedByOwnedId[u.ownedId]=u.appliedXp;}}
    const commanderRewards:Record<string,CommanderXpResult>={};
    if(r.mode==='normal')for(const side of sides){if(side===s.botSide)continue;const pid=ids[side],config=snap.commanderPolicies?.find(p=>p.playerId===pid)?.policy??null;
      const outcome=reason==='SURRENDER'?'surrender':reason==='SERVER_ABORT'||reason==='DOUBLE_TIMEOUT'?'aborted':proof?.departedSide===side?'departed':winner===null?'draw':winner===side?'win':'loss';
      commanderRewards[pid]=await awardCommanderXp(tx,pid,{kind:'NORMAL_PLAY',eventId:r.id,outcome,reason,timeoutGenerated,...(proof?{terminationProof:proof}:{}),side},config);}
    const aborted=r.status==='ACCEPTING'&&(Object.keys(rankConditions).length>0||Object.keys(matchPoolConditions).length>0);
    for(const m of snap.members){const gain=normalXp?.appliedByOwnedId[m.id]??0;
      const n=await tx.owned.updateMany({where:{id:m.id,playerId:m.playerId,status:'PVP',...(!aborted?{totalXp:BigInt(m.xp)}:{})},data:{status:'AVAILABLE',...(gain?{totalXp:BigInt(m.xp)+BigInt(gain)}:{})}});if(n.count!==1)return apiFail(409,'UNIT_STATE_CHANGED');}
    // 수락 시간 초과·거절: 수락했던 사람은 같은 대기 순서로 다시 대기열에(원본 requeue)
    const partyConditions:Record<string,string>={};
    if(reason==='MATCH_TIMEOUT'||reason==='MATCH_DECLINED')for(const side of sides)if(side!==s.botSide&&s.accepted[side]){
      const pid=ids[side],q=snap.queues[side],ownedIds=snap.members.filter(m=>m.playerId===pid).map(m=>m.id);if(!q)continue;
      const pin=snap.matchPool.players.find(p=>p.playerId===pid),pc=await this.matchPoolCondition(tx,pid,pin?.pool,snap.matchPool.version,pin?.count,pin?.countSource,pin?.historyStamp);if(pc){matchPoolConditions[pid]=pc;continue;}
      const rankPin=r.mode==='rank'?snap.rankAdmission?.players.find(p=>p.playerId===pid)??null:null;
      if(r.mode==='rank'){const c=await this.rankPinCondition(tx,pid,ownedIds,rankPin,'AVAILABLE');if(c){rankConditions[pid]=c;continue;}}
      await tx.owned.updateMany({where:{playerId:pid,id:{in:ownedIds},status:'AVAILABLE'},data:{status:'PVP_QUEUE'}});
      const plan=snap.normalXp?.players.find(p=>p.playerId===pid);
      await tx.pvpQueue.create({data:{playerId:pid,mode:r.mode,rating:q.rating,tierIndex:q.tierIndex,ownedIds:JSON.stringify(ownedIds),queuedAt:new Date(q.queuedAt),leaseUntil:new Date(this.now()+PVP_LIMITS.queueLeaseMs),
        normalXp:plan?JSON.stringify(plan):null,commander:r.mode==='normal'?JSON.stringify({playerId:pid,policy:snap.commanderPolicies?.find(p=>p.playerId===pid)?.policy??null}):null,rankAdmission:rankPin?JSON.stringify(rankPin):null,
        pool:pin?.pool??null,rebirthCount:pin?.count??null,countSource:pin?.countSource??null,historyStamp:pin?.historyStamp??null}});
      s.ack[side]=true;}
    const terminationKind=proof?'DISCONNECTED':reason==='TIMEOUT'||reason==='DOUBLE_TIMEOUT'||timeoutGenerated?'TURN_INPUT':reason==='SERVER_ABORT'?'SERVER_OBSERVATION_GAP':undefined;
    const settlement={winner,reason,...(Object.keys(partyConditions).length?{partyConditions}:{}),...(r.mode==='normal'?{commanderRewards}:{}),...(terminationKind?{terminationKind}:{}),...(Object.keys(rankConditions).length?{rankConditions}:{}),
      ...(Object.keys(matchPoolConditions).length?{matchPoolConditions}:{}),xpAwarded:normalXp?Object.values(normalXp.players).reduce((n,p)=>n+p.xpAwarded,0):0,rating,...(normalXp?{normalXp}:{})};
    return tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s),status:'FINISHED',settlement:JSON.stringify(settlement,(_k,v)=>typeof v==='bigint'?v.toString():v),revision:{increment:1}}});
  }
  async settle(id:string,b:{requestId:string;battleId:string;revision:number}){
    return this.request(id,b.requestId,['settle',b.battleId,b.revision],async tx=>{
      let r=await this.advance(tx,await this.room(tx,id,b.battleId),id);if(!['FINISHED','SETTLED'].includes(r.status))return apiFail(409,'BATTLE_NOT_FINISHED');
      const s=this.parse(r);s.ack[this.side(r,id)]=true;r=await tx.pvpMatch.update({where:{id:r.id},data:{state:JSON.stringify(s),status:'SETTLED'}});
      return this.view(tx,r,id);
    });
  }
  /** 1초마다(원본 tick): 대기열 정리, 일반전 매칭(AI 포함), 시간이 지난 방 진행 */
  async tick(){return this.tx(async tx=>{await this.expireQueue(tx);await this.match(tx,'normal');
    for(const row of await tx.pvpMatch.findMany({where:{status:{in:['ACTIVE','ACCEPTING']},deadline:{lte:new Date(this.now())}},take:100,orderBy:{deadline:'asc'}}))await this.advance(tx,row);});}

  // ── 화면용 ──
  private async publicPresence(tx:Tx,r:Room,s:PvpState,side:PvpSide){
    if(r.status!=='ACTIVE')return undefined;const raw=this.presenceValue(r),d=decidePresence(raw,await this.monitor(tx),this.now());
    const out:{status:string;serverNow:number;ownGraceUntil?:number;opponentGraceUntil?:number}={status:'CONNECTED',serverNow:this.now()};
    if(d.kind==='ABORT_NEUTRAL'||d.kind==='FORFEIT_PROVEN')out.status='OBSERVATION_UNAVAILABLE';
    else if(d.kind==='RECONNECT_GRACE'){out.status='RECONNECT_GRACE';for(const a of d.absent)if(a.side===side)out.ownGraceUntil=a.graceUntil;else out.opponentGraceUntil=a.graceUntil;}
    else if(s.connectionPause){out.status='RECONNECT_GRACE';const p=raw as PresenceState;
      for(const i of sides)if(i!==s.botSide&&!s.pending[i]&&p.participants[i]!.lastSeenAt<=s.connectionPause.observedAfter){const until=p.participants[i]!.lastSeenAt+p.policy.totalAbsentMs;if(i===side)out.ownGraceUntil=until;else out.opponentGraceUntil=until;}}
    return out;
  }
  /** 보는 사람 기준 상태(원본 view): 상대의 대기 대원·고른 행동·씨앗은 보이지 않음 */
  private async view(tx:Tx,r:Room,id:string){
    const side=this.side(r,id),other=(1-side) as PvpSide,s=this.parse(r),snap=this.snap(r),alive=s.parties[side][0].hp>0;
    const intel=observedOpponentIntel(s.parties[other][0],s.turn,snap.observedDefense,battleKnowledge(snap.observedDefense,s.events,String(side)),this.content.catalog);
    const own=(f:Fighter)=>publicDefenseSafe({...f,id:'self',ownResistance:{...f.defense}});
    const finished=['FINISHED','SETTLED'].includes(r.status),outcome=finished?(s.winner===null?'draw':s.winner===side?'win':'loss'):null;
    const stored=r.settlement?JSON.parse(r.settlement):null,{normalXp,commanderRewards,rankConditions,matchPoolConditions,partyConditions,...base}=stored??{};
    const ownXp=normalXp?.players?.[id],ownCommander=commanderRewards?.[id];
    const feedback=lossFeedback({state:s,viewerSide:side,mode:r.mode as Mode,outcome,reason:stored?.reason,status:r.status,opponentKind:s.botSide===1?'AI':'HUMAN',terminationKind:stored?.terminationKind});
    const units=ownXp?.units?.map((u:any)=>{const m=snap.normalXp?.players.find(p=>p.playerId===id)?.members.find(x=>x.id===u.ownedId);const xpProgress=m?unitXpProgress(m,u.endingXp,u.startingXp):undefined;return {...u,...(xpProgress?{xpProgress}:{})};});
    const myRating=base.rating?.players?.find((p:any)=>p.playerId===id);
    const settlement=stored?{...base,rating:myRating??null,outcome,...(partyConditions?.[id]?{partyCondition:partyConditions[id],partySelectionRequired:true}:{}),
      ...(ownCommander?{commanderReward:ownCommander,commander:ownCommander.commander,commanderXpAwarded:ownCommander.recordedXp??ownCommander.xpAwarded}:{}),...(feedback?{lossFeedback:feedback}:{}),
      ...(rankConditions&&Object.keys(rankConditions).length?{rankCondition:rankConditions[id]??'RANK_OPPONENT_ELIGIBILITY_CHANGED'}:{}),...(matchPoolConditions&&Object.keys(matchPoolConditions).length?{matchPoolCondition:matchPoolConditions[id]??'MATCH_POOL_OPPONENT_CHANGED'}:{}),
      xpAwarded:r.mode==='normal'?(ownXp?.xpAwarded??0):0,...(r.mode==='normal'?{xpDiscarded:ownXp?.xpDiscarded??0,xpRequested:ownXp?.xpRequested??0,normalXp:ownXp?{status:ownXp.status,units}:null}:{})}:null;
    const requeued=finished&&['MATCH_TIMEOUT','MATCH_DECLINED'].includes(stored?.reason)&&s.ack[side]&&!!(await tx.pvpQueue.findUnique({where:{playerId:id}}));
    const rounds=s.events.map(e=>({turn:e.turn,events:e.events.map((v:any)=>{const {defenseObservation,intelBefore,intelAfter,decision,...visible}=v,presentation=presentationForViewer(v.presentation,side);void intelBefore;void intelAfter;void decision;
      return {...visible,actor:v.side===side?'self':'enemy',side:undefined,targetOwnedId:v.side===side?v.targetOwnedId:undefined,...(v.side===side&&defenseObservation?{observedDefense:publicDefenseObservation(defenseObservation)}:{}),presentation};})}));
    const inventory=(await tx.playerItem.findMany({where:{playerId:id}})).map(i=>({itemId:i.itemId,count:i.count}));
    return publicDefenseSafe({pvp:true,battleId:r.id,revision:r.revision,serverNow:this.now(),presence:await this.publicPresence(tx,r,s,side),status:r.status==='SETTLED'&&!s.ack[side]?'FINISHED':r.status,mode:r.mode,
      opponentKind:s.botSide===1?'AI':'HUMAN',deadline:r.deadline.getTime(),accepted:s.accepted[side],opponentAccepted:s.accepted[other],requeued,submitted:!!s.pending[side],waitingForOpponent:!!s.pending[side]||(!alive?false:s.parties[other][0].hp<=0),
      testBaseline:this.content.catalog.productionBalanceApproved===false,adventureId:null,story:null,
      state:{mode:'duel',turn:s.turn,outcome,surrendered:stored?.reason==='SURRENDER',self:own(s.parties[side][0]),reserves:s.parties[side].slice(1).map(own),enemy:opponentFighter(s.parties[other][0],intel),opponentIntel:intel,
        decision:null,rounds,participation:[]},settlement,itemDefinitions:this.content.items,inventory,disabledCommands:{item:alive?'':'FORCED_SWITCH_REQUIRED',switch:'',escape:''}});
  }
}
