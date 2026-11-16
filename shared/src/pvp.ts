// 일반전·랭크전 규칙(순수 함수). DB·네트워크·시계 없음: 시각은 인자로 받는다.
// 원본(GMM110 0b0fb8b5): src/roster60-pvp.ts(턴 처리·AI·매칭·시간 초과), src/progression/roster60-presence.ts(접속 판정),
//   src/ranked/rating.ts·settlement.ts(점수), src/progression/normal-xp.ts(일반전 경험치), src/progression/roster60-rank.ts(랭크 자격),
//   src/battle/roster60-presentation.ts(연출 기록), src/battle/roster60-loss-feedback.ts(패배 안내).
// 수치(시간·점수·경험치)는 원본에서도 시험값이에요.
import {createHash} from 'node:crypto';
import {fail} from './errors.js';
import {skillElements,focusMp,spendMp,growthAt,type SkillElement,type GrowthPoint,type ReincarnationXpPolicy} from './rules.js';
import {fiveStatAttack,decideTurnOrder} from './combat.js';
import {publicBattleAppearance,battleKnowledge,observedOpponentIntel,resolvedDefenseObservation,addDefenseObservation,type DefenseSnapshot,type DefenseObservation} from './intel.js';
import {grantXp,pacedPool,validateUnitXpPacing,type UnitXpPacing} from './xp.js';
import type {Catalog,Fighter} from './catalog.js';
import type {BattlePolicy,ItemDefinition} from './battle.js';

// ── 시간 한도(원본 REALTIME_LIMITS) ──
export const PVP_LIMITS=Object.freeze({acceptMs:10_000,casualAiAfterMs:30_000,maxMatchesPerPass:50,turnMs:30_000,queueLeaseMs:45_000,maxWaiting:2000,maxRooms:1000,roomMaxMs:2*3600_000});
/** 랭크전은 모두 이 레벨로 맞춰 싸움(원본 data/economy.yaml pvp.level) */
export const RANK_BATTLE_LEVEL=30;

// ── 접속 판정(원본 roster60-presence.ts 그대로) ──
export type PresenceSide=0|1;
export type PresencePolicy={version:'roster60-presence-policy-v1';leaseMs:number;totalAbsentMs:number;monitorGapMs:number};
export const defaultPresencePolicy:Readonly<PresencePolicy>=Object.freeze({version:'roster60-presence-policy-v1',leaseMs:45_000,totalAbsentMs:90_000,monitorGapMs:45_000});
export type PresenceMonitor={version:'roster60-presence-monitor-v1';generation:number;lastSuccessAt:number;continuousSince:number};
export type PresenceParticipant={lastSeenAt:number;leaseUntil:number;continuousSince:number};
export type PresenceState={version:'roster60-presence-v1';policy:PresencePolicy;monitorGeneration:number;monitorStartedAt:number;initializedAt:number;botSide?:1;participants:[PresenceParticipant|null,PresenceParticipant|null]};
export type PresenceForfeitProof={version:'roster60-presence-proof-v1';departedSide:PresenceSide;graceStartedAt:number;graceUntil:number;survivorSide:PresenceSide;monitorGeneration:number;decisionAt:number};
export type PresenceGrace={side:PresenceSide;graceStartedAt:number;graceUntil:number};
export type PresenceDecision={kind:'CONTINUE'}|{kind:'RECONNECT_GRACE';absent:PresenceGrace[]}|{kind:'FORFEIT_PROVEN';proof:PresenceForfeitProof}
  |{kind:'ABORT_NEUTRAL';reason:'PRESENCE_UNINITIALIZED'|'INVALID_PRESENCE'|'MONITOR_UNAVAILABLE'|'MONITOR_RECOVERY'|'MONITOR_GAP'|'CLOCK_MOVED_BACK'|'SURVIVOR_UNPROVEN'|'INVALID_OBSERVER'};
const sides=[0,1] as const;
const rec=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const positive=(v:unknown):v is number=>time(v)&&v>0;
const isSide=(v:unknown):v is PresenceSide=>v===0||v===1;
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
const abort=(reason:Extract<PresenceDecision,{kind:'ABORT_NEUTRAL'}>['reason']):PresenceDecision=>({kind:'ABORT_NEUTRAL',reason});
function policyValue(raw:unknown):PresencePolicy|null{
  if(!rec(raw)||!exact(raw,['version','leaseMs','totalAbsentMs','monitorGapMs'])||raw.version!=='roster60-presence-policy-v1'||!positive(raw.leaseMs)||!positive(raw.totalAbsentMs)||raw.totalAbsentMs<=raw.leaseMs||!positive(raw.monitorGapMs))return null;
  return {version:raw.version,leaseMs:raw.leaseMs,totalAbsentMs:raw.totalAbsentMs,monitorGapMs:raw.monitorGapMs};
}
function monitorValue(raw:unknown):PresenceMonitor|null{
  if(!rec(raw)||!exact(raw,['version','generation','lastSuccessAt','continuousSince'])||raw.version!=='roster60-presence-monitor-v1'||!positive(raw.generation)||!time(raw.lastSuccessAt)||!time(raw.continuousSince)||raw.continuousSince>raw.lastSuccessAt)return null;
  return {version:raw.version,generation:raw.generation,lastSuccessAt:raw.lastSuccessAt,continuousSince:raw.continuousSince};
}
function stateValue(raw:unknown):PresenceState|null{
  if(!rec(raw)||raw.version!=='roster60-presence-v1'||!positive(raw.monitorGeneration)||!time(raw.monitorStartedAt)||!time(raw.initializedAt)||raw.monitorStartedAt>raw.initializedAt||raw.botSide!==undefined&&raw.botSide!==1||!Array.isArray(raw.participants)||raw.participants.length!==2)return null;
  const policy=policyValue(raw.policy);if(!policy)return null;
  const participants:[PresenceParticipant|null,PresenceParticipant|null]=[null,null];
  for(const i of sides){const p=raw.participants[i];
    if(i===raw.botSide){if(p!==null)return null;continue;}
    if(!rec(p)||!exact(p,['lastSeenAt','leaseUntil','continuousSince'])||!time(p.lastSeenAt)||!time(p.leaseUntil)||!time(p.continuousSince)||p.lastSeenAt<raw.initializedAt||p.continuousSince<raw.initializedAt||p.continuousSince>p.lastSeenAt||!time(p.lastSeenAt+policy.totalAbsentMs)||p.leaseUntil!==p.lastSeenAt+policy.leaseMs)return null;
    participants[i]={lastSeenAt:p.lastSeenAt,leaseUntil:p.leaseUntil,continuousSince:p.continuousSince};}
  return {version:raw.version,policy,monitorGeneration:raw.monitorGeneration,monitorStartedAt:raw.monitorStartedAt,initializedAt:raw.initializedAt,...(raw.botSide===1?{botSide:1 as const}:{}),participants};
}
/** 서버가 DB에 쓰기를 성공할 때마다 관측 기록을 갱신(원본 monitorObservation). 시계가 거꾸로 가거나 45초 넘게 끊기면 새 세대. */
export function monitorObservation(previous:unknown,now:number,config:Readonly<PresencePolicy>=defaultPresencePolicy){
  const policy=policyValue(config);if(!policy||!time(now))throw Error('INVALID_PRESENCE_MONITOR_INPUT');
  const old=monitorValue(previous);
  let reason:'MONITOR_INITIALIZED'|'MONITOR_INVALID'|'MONITOR_GAP'|'CLOCK_MOVED_BACK'|null=null;
  if(!old)reason=previous===null||previous===undefined?'MONITOR_INITIALIZED':'MONITOR_INVALID';
  else if(now<old.lastSuccessAt)reason='CLOCK_MOVED_BACK';
  else if(now-old.lastSuccessAt>policy.monitorGapMs)reason='MONITOR_GAP';
  const priorGeneration=old?.generation??(rec(previous)&&positive(previous.generation)?previous.generation:0);
  const generation=reason?priorGeneration+1:old!.generation;
  if(!positive(generation))throw Error('INVALID_PRESENCE_MONITOR_GENERATION');
  return {monitor:{version:'roster60-presence-monitor-v1' as const,generation,lastSuccessAt:now,continuousSince:reason?now:old!.continuousSince},recovered:reason!==null,reason};
}
export function initializePresence(rawMonitor:unknown,now:number,config:Readonly<PresencePolicy>=defaultPresencePolicy,botSide?:1):PresenceState{
  const policy=policyValue(config),monitor=monitorValue(rawMonitor);
  if(!policy||!time(now)||!time(now+policy.totalAbsentMs)||botSide!==undefined&&botSide!==1)throw Error('INVALID_PRESENCE_INITIALIZATION');
  if(!monitor||monitor.lastSuccessAt>now||now-monitor.lastSuccessAt>policy.monitorGapMs)throw Error('PRESENCE_MONITOR_UNAVAILABLE');
  const participant=():PresenceParticipant=>({lastSeenAt:now,leaseUntil:now+policy.leaseMs,continuousSince:now});
  return {version:'roster60-presence-v1',policy,monitorGeneration:monitor.generation,monitorStartedAt:monitor.continuousSince,initializedAt:now,...(botSide===1?{botSide}:{}),participants:[participant(),botSide===1?null:participant()]};
}
export function validatePresenceForfeitProof(raw:unknown,context?:{state:unknown;monitor:unknown}):raw is PresenceForfeitProof{
  const valid=rec(raw)&&exact(raw,['version','departedSide','graceStartedAt','graceUntil','survivorSide','monitorGeneration','decisionAt'])&&raw.version==='roster60-presence-proof-v1'&&isSide(raw.departedSide)&&isSide(raw.survivorSide)&&raw.departedSide!==raw.survivorSide
    &&time(raw.graceStartedAt)&&time(raw.graceUntil)&&raw.graceUntil>raw.graceStartedAt&&time(raw.decisionAt)&&raw.decisionAt>=raw.graceUntil&&positive(raw.monitorGeneration);
  if(!valid)return false;if(!context)return true;
  const proof=raw as PresenceForfeitProof,d=decidePresence(context.state,context.monitor,proof.decisionAt);
  return d.kind==='FORFEIT_PROVEN'&&(Object.keys(proof) as (keyof PresenceForfeitProof)[]).every(k=>proof[k]===d.proof[k]);
}
/** 접속 판정(원본 decidePresence). 45초 동안 안 보이면 재접속 유예, 90초면 떠난 것으로 증명(남은 쪽이 계속 보였을 때만). */
export function decidePresence(rawState:unknown,rawMonitor:unknown,now:number):PresenceDecision{
  if(rawState===null||rawState===undefined)return abort('PRESENCE_UNINITIALIZED');
  const state=stateValue(rawState);if(!state||!time(now))return abort('INVALID_PRESENCE');
  const monitor=monitorValue(rawMonitor);if(!monitor)return abort('MONITOR_UNAVAILABLE');
  if(now<state.initializedAt||now<monitor.lastSuccessAt||state.participants.some(p=>p!==null&&now<p.lastSeenAt))return abort('CLOCK_MOVED_BACK');
  if(monitor.generation!==state.monitorGeneration||monitor.continuousSince!==state.monitorStartedAt)return abort('MONITOR_RECOVERY');
  if(now-monitor.lastSuccessAt>state.policy.monitorGapMs)return abort('MONITOR_GAP');
  const absent:PresenceGrace[]=sides.filter(i=>i!==state.botSide&&now>=state.participants[i]!.leaseUntil).map(i=>({side:i,graceStartedAt:state.participants[i]!.leaseUntil,graceUntil:state.participants[i]!.lastSeenAt+state.policy.totalAbsentMs}));
  if(!absent.length)return {kind:'CONTINUE'};
  const expired=absent.filter(p=>now>=p.graceUntil);if(!expired.length)return {kind:'RECONNECT_GRACE',absent};
  if(expired.length!==1)return abort('SURVIVOR_UNPROVEN');
  const departed=expired[0],survivorSide=(1-departed.side) as PresenceSide,survivor=state.participants[survivorSide];
  const proven=survivorSide===state.botSide||survivor!==null&&survivor.leaseUntil>now&&survivor.continuousSince<=departed.graceStartedAt;
  if(!proven)return abort('SURVIVOR_UNPROVEN');
  return {kind:'FORFEIT_PROVEN',proof:{version:'roster60-presence-proof-v1',departedSide:departed.side,graceStartedAt:departed.graceStartedAt,graceUntil:departed.graceUntil,survivorSide,monitorGeneration:monitor.generation,decisionAt:now}};
}
/** 그 사람이 방을 읽거나 행동했을 때만 그쪽 접속을 갱신(원본 observePresence) */
export function observePresence(rawState:unknown,observer:PresenceSide,rawMonitor:unknown,now:number):{state:PresenceState|null;decision:PresenceDecision}{
  const state=stateValue(rawState),before=decidePresence(rawState,rawMonitor,now);
  if(before.kind==='ABORT_NEUTRAL'||before.kind==='FORFEIT_PROVEN')return {state,decision:before};
  if(!state||!isSide(observer)||observer===state.botSide)return {state,decision:abort('INVALID_OBSERVER')};
  if(!time(now+state.policy.totalAbsentMs))return {state,decision:abort('INVALID_PRESENCE')};
  const prior=state.participants[observer]!;
  state.participants[observer]={lastSeenAt:now,leaseUntil:now+state.policy.leaseMs,continuousSince:now<=prior.leaseUntil?prior.continuousSince:now};
  return {state,decision:decidePresence(state,rawMonitor,now)};
}

// ── 랭크 점수(원본 ranked/rating.ts 그대로) ──
export type RankedConfig={version:number;tiers:readonly string[];promotionLp:number;promotionBestOf:number;promotionFailureLp:number;demotionLp:number;winLp:number;lossLp:number;tierGapStep:number;tierGapCap:number;
  mmrBase:number;mmrK:number;mmrScale:number;mmrMin:number;mmrMax:number;casualPriorWeight:number;casualPriorMaxGap:number;casualPriorConfidenceGames:number;casualPriorFadeGames:number};
export const DEFAULT_RANKED_CONFIG:Readonly<RankedConfig>=Object.freeze({version:1,tiers:Object.freeze(['Bronze','Silver','Gold','Platinum','Diamond','Master']),promotionLp:100,promotionBestOf:3,promotionFailureLp:75,demotionLp:75,winLp:20,lossLp:15,
  tierGapStep:3,tierGapCap:2,mmrBase:1000,mmrK:32,mmrScale:400,mmrMin:0,mmrMax:4000,casualPriorWeight:0.25,casualPriorMaxGap:200,casualPriorConfidenceGames:20,casualPriorFadeGames:20});
/** 화면 표시용 등급 이름. 원본 랭크 정산은 영어 이름(Bronze…Master)만 돌려주고, 앱에서 한국어로 바꾸는 곳은 찾지 못했어요.
 * 같은 6단계인 원본 data/economy.yaml pvp.tiers의 한국어 이름을 순서대로 붙였어요(이 대응은 새 프로젝트의 선택). */
export const RANK_TIER_NAMES=['브론즈','실버','골드','플래티넘','다이아','갈매미 마스터'];
export type RankedSnapshot={tierIndex:number;lp:number;promotionActive:boolean;promotionWins:number;promotionLosses:number;rankedMmr:number;casualPriorOffset:number;games:number;wins:number;losses:number;draws:number};
export type PromotionChange='NONE'|'STARTED'|'WON_GAME'|'LOST_GAME'|'PROMOTED'|'FAILED'|'DEMOTED';
export type RankedChange={before:RankedSnapshot;after:RankedSnapshot;lpDelta:number;mmrDelta:number;promotionChange:PromotionChange};
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
const rounded=(n:number)=>Math.round(n*1_000_000)/1_000_000;
export function validateRankedConfig(c:RankedConfig):RankedConfig{
  for(const k of ['version','promotionLp','promotionBestOf','promotionFailureLp','demotionLp','winLp','lossLp','tierGapStep','tierGapCap','casualPriorConfidenceGames','casualPriorFadeGames'] as const)if(!Number.isSafeInteger(c[k])||c[k]<0)throw new Error(`잘못된 랭크 설정: ${k}`);
  for(const k of ['mmrBase','mmrK','mmrScale','mmrMin','mmrMax','casualPriorWeight','casualPriorMaxGap'] as const)if(!Number.isFinite(c[k]))throw new Error(`잘못된 랭크 설정: ${k}`);
  if(!Array.isArray(c.tiers)||c.tiers.length<2||c.tiers[0]!=='Bronze'||c.tiers.some(t=>typeof t!=='string'||t.length===0)||new Set(c.tiers).size!==c.tiers.length||c.version<1||c.promotionLp<1||c.promotionBestOf<1||c.promotionBestOf%2!==1
    ||c.promotionFailureLp>=c.promotionLp||c.demotionLp>=c.promotionLp||c.winLp<=c.tierGapStep*c.tierGapCap||c.lossLp<=c.tierGapStep*c.tierGapCap||c.mmrMin>=c.mmrMax||c.mmrBase<c.mmrMin||c.mmrBase>c.mmrMax
    ||c.mmrK<=0||c.mmrScale<=0||c.casualPriorMaxGap<0||c.casualPriorMaxGap>200||c.casualPriorWeight<0||c.casualPriorWeight>0.25||c.casualPriorConfidenceGames<1||c.casualPriorFadeGames<1)throw new Error('랭크 설정의 범위 또는 상호 조건이 올바르지 않습니다.');
  return c;
}
export function assertRankedSnapshot(s:RankedSnapshot,c:RankedConfig=DEFAULT_RANKED_CONFIG):void{
  for(const k of ['tierIndex','lp','promotionWins','promotionLosses','games','wins','losses','draws'] as const)if(!Number.isSafeInteger(s[k])||s[k]<0)throw new Error(`잘못된 랭크 상태: ${k}`);
  const needed=Math.floor(c.promotionBestOf/2)+1;
  if(s.tierIndex>=c.tiers.length||!Number.isFinite(s.rankedMmr)||!Number.isFinite(s.casualPriorOffset)||s.rankedMmr<c.mmrMin||s.rankedMmr>c.mmrMax||s.games!==s.wins+s.losses+s.draws
    ||(s.promotionActive&&(s.tierIndex===c.tiers.length-1||s.lp!==c.promotionLp||s.promotionWins>=needed||s.promotionLosses>=needed))||(!s.promotionActive&&(s.promotionWins!==0||s.promotionLosses!==0))
    ||(!s.promotionActive&&s.tierIndex<c.tiers.length-1&&s.lp>=c.promotionLp))throw new Error('랭크 상태가 설정 또는 누적 기록과 맞지 않습니다. 자동 수정하지 않습니다.');
}
export function casualPriorOffset(mmr:number,games:number,c:RankedConfig=DEFAULT_RANKED_CONFIG):number{
  if(!Number.isFinite(mmr)||!Number.isSafeInteger(games)||games<0)throw new Error('잘못된 일반전 레이팅');
  const confidence=clamp(games/c.casualPriorConfidenceGames,0,1);
  return rounded(clamp(mmr-c.mmrBase,-c.casualPriorMaxGap,c.casualPriorMaxGap)*c.casualPriorWeight*confidence);
}
export function initialRankedSnapshot(casual?:{mmr:number;games:number},c:RankedConfig=DEFAULT_RANKED_CONFIG):RankedSnapshot{
  validateRankedConfig(c);
  return {tierIndex:0,lp:0,promotionActive:false,promotionWins:0,promotionLosses:0,rankedMmr:c.mmrBase,casualPriorOffset:casual?casualPriorOffset(casual.mmr,casual.games,c):0,games:0,wins:0,losses:0,draws:0};
}
export function rankedMatchmakingMmr(s:RankedSnapshot,c:RankedConfig=DEFAULT_RANKED_CONFIG):number{
  const fade=clamp(1-s.games/c.casualPriorFadeGames,0,1);
  return rounded(clamp(s.rankedMmr+s.casualPriorOffset*fade,c.mmrMin,c.mmrMax));
}
export function eloDelta(selfMmr:number,otherMmr:number,score:0|0.5|1,c:RankedConfig=DEFAULT_RANKED_CONFIG):number{
  const expected=1/(1+10**((otherMmr-selfMmr)/c.mmrScale));return rounded(c.mmrK*(score-expected));
}
export function lpForResult(selfTier:number,otherTier:number,won:boolean,c:RankedConfig=DEFAULT_RANKED_CONFIG):number{
  const gap=clamp(otherTier-selfTier,-c.tierGapCap,c.tierGapCap);return won?c.winLp+gap*c.tierGapStep:-(c.lossLp-gap*c.tierGapStep);
}
export function applyRankedResult(self:RankedSnapshot,other:RankedSnapshot,score:0|0.5|1,c:RankedConfig=DEFAULT_RANKED_CONFIG):RankedChange{
  validateRankedConfig(c);assertRankedSnapshot(self,c);assertRankedSnapshot(other,c);
  const before={...self},after={...self,games:self.games+1};
  after.rankedMmr=rounded(clamp(self.rankedMmr+eloDelta(rankedMatchmakingMmr(self,c),rankedMatchmakingMmr(other,c),score,c),c.mmrMin,c.mmrMax));
  let promotionChange:PromotionChange='NONE';
  if(score===0.5)after.draws++;
  else{const won=score===1;if(won)after.wins++;else after.losses++;
    if(self.promotionActive){
      if(won){after.promotionWins++;promotionChange='WON_GAME';}else{after.promotionLosses++;promotionChange='LOST_GAME';}
      const needed=Math.floor(c.promotionBestOf/2)+1;
      if(after.promotionWins>=needed||after.promotionLosses>=needed){const promoted=after.promotionWins>=needed;after.tierIndex+=promoted?1:0;after.lp=promoted?0:c.promotionFailureLp;after.promotionActive=false;after.promotionWins=after.promotionLosses=0;promotionChange=promoted?'PROMOTED':'FAILED';}
    }else if(!won&&self.lp===0&&self.tierIndex>0){after.tierIndex--;after.lp=c.demotionLp;promotionChange='DEMOTED';}
    else{after.lp=Math.max(0,self.lp+lpForResult(self.tierIndex,other.tierIndex,won,c));
      if(after.lp>=c.promotionLp&&self.tierIndex<c.tiers.length-1){after.lp=c.promotionLp;after.promotionActive=true;after.promotionWins=after.promotionLosses=0;promotionChange='STARTED';}}
  }
  assertRankedSnapshot(after,c);
  return {before,after,lpDelta:after.lp-before.lp,mmrDelta:rounded(after.rankedMmr-before.rankedMmr),promotionChange};
}
export function unchangedRankedResult(s:RankedSnapshot):RankedChange{return {before:{...s},after:{...s},lpDelta:0,mmrDelta:0,promotionChange:'NONE'};}
export type FinishReason='BATTLE'|'SURRENDER'|'TIMEOUT'|'DOUBLE_TIMEOUT'|'SERVER_ABORT';
export const isVoidedFinish=(reason:FinishReason)=>reason==='DOUBLE_TIMEOUT'||reason==='SERVER_ABORT';
export const scoreFor=(winner:0|1|null,index:0|1):0|0.5|1=>winner===null?0.5:winner===index?1:0;
export type CasualSnapshot={mmr:number;games:number;wins:number;losses:number;draws:number};
/** 사람끼리 일반전 점수(원본 settleCasualHuman의 계산 부분). 무효 경기면 그대로. */
export function casualNext(self:CasualSnapshot,other:CasualSnapshot,winner:0|1|null,index:0|1,reason:FinishReason,c:RankedConfig=DEFAULT_RANKED_CONFIG):CasualSnapshot{
  if(isVoidedFinish(reason))return {...self};
  const score=scoreFor(winner,index);
  return {mmr:Math.round(Math.max(c.mmrMin,Math.min(c.mmrMax,self.mmr+eloDelta(self.mmr,other.mmr,score,c)))*1_000_000)/1_000_000,games:self.games+1,wins:self.wins+(score===1?1:0),losses:self.losses+(score===0?1:0),draws:self.draws+(score===0.5?1:0)};
}

// ── 일반전 경험치(원본 normal-xp.ts, 지금 정책 normal-xp-v2만) ──
export type NormalXpPolicy={approved:boolean;version:string;catalogVersion:string;profileKind:'user-authorized-test-baseline'|'approved-production';productionBalanceApproved:boolean;testValues:boolean;scope:'normal';
  source:'duel-nearest-owned-start-level';participation:'actually-entered-owned-only';surrender:'confirmed-zero';draw:'undecided-no-award';legacyRoom:'unconfigured-no-retroactive-award';notes?:string[];xpPacing?:UnitXpPacing;
  rulesVersion:'normal-xp-v2';outcomePercent:{win:100;loss:50};distribution:'equal-entered-owned';poolBasis:'highest-entered-start-level';remainder:'owned-id-ascending';capOverflow:'discard-overflow';
  eligibleReason:'BATTLE'|'BATTLE_OR_VALIDATED_GRACE_TIMEOUT';timeout:'undecided-no-award'|'validated-grace-survivor-only';disconnect:'undecided-no-award'|'validated-grace-survivor-only'};
export type NormalXpMember={id:string;playerId:string;startingXp:string;growth:GrowthPoint[];reincarnation:number;reincarnationXpPolicy?:ReincarnationXpPolicy;sourceEncounterId:string;winXp:number;lossXp:number;lossFallbackUsed:boolean;level:number;nearestTierMinimum?:number};
export type NormalXpPlayerPlan={playerId:string;policy:NormalXpPolicy;members:NormalXpMember[];enemyLevel?:number};
const safeXp=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=2_000_000_000;
const compareOwned=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** 새 입장에는 v2 정책만(원본 validateNormalXpPolicy, 예전 v1 고정 기록 읽기 경로는 옮기지 않음: 새 프로젝트에 예전 방이 없음) */
export function validateNormalXpPolicy(p:NormalXpPolicy|null,catalogVersion:string):asserts p is NormalXpPolicy{
  const bad=()=>fail('NORMAL_XP_POLICY_INVALID');
  if(!p||p.approved!==true)return fail('NORMAL_XP_POLICY_PENDING');
  if(!p.version||p.catalogVersion!==catalogVersion||!['user-authorized-test-baseline','approved-production'].includes(p.profileKind)||p.productionBalanceApproved!==(p.profileKind==='approved-production')||p.testValues!==!p.productionBalanceApproved||p.scope!=='normal'||p.source!=='duel-nearest-owned-start-level'
    ||p.participation!=='actually-entered-owned-only'||p.surrender!=='confirmed-zero'||p.draw!=='undecided-no-award'||p.legacyRoom!=='unconfigured-no-retroactive-award')return bad();
  if(p.xpPacing!==undefined)validateUnitXpPacing(p.xpPacing,catalogVersion);
  if(p.rulesVersion!=='normal-xp-v2')return fail('NORMAL_XP_POLICY_PENDING');
  if(p.outcomePercent?.win!==100||p.outcomePercent?.loss!==50||p.distribution!=='equal-entered-owned'||p.poolBasis!=='highest-entered-start-level'||p.remainder!=='owned-id-ascending'||p.capOverflow!=='discard-overflow')return bad();
  if(!(p.eligibleReason==='BATTLE_OR_VALIDATED_GRACE_TIMEOUT'&&p.timeout==='validated-grace-survivor-only'&&p.disconnect==='validated-grace-survivor-only'))return bad();
}
export const normalXpEffectiveVersion=(p:NormalXpPolicy)=>p.version+(p.xpPacing?':'+p.xpPacing.version:'');
/** 원천 = 레벨이 가장 가까운 연습 상대(duel)의 승리 경험치, 패배는 그 절반(내림) */
export function normalXpSource(policy:BattlePolicy,level:number,_config:NormalXpPolicy){
  if(!Number.isSafeInteger(level)||level<1||level>99)return fail('NORMAL_XP_LEVEL_INVALID');
  const sources=policy.encounters.filter(e=>e.mode==='duel'&&!e.tutorial);if(!sources.length)return fail('NORMAL_XP_SOURCE_PENDING');
  if(sources.some(e=>!safeXp(e.winXp)||e.winXp<1||!safeXp(e.lossXp)))return fail('NORMAL_XP_SOURCE_INVALID');
  sources.sort((a,b)=>Math.abs(a.level-level)-Math.abs(b.level-level)||a.level-b.level||compareOwned(a.id,b.id));const s=sources[0];
  return {sourceEncounterId:s.id,winXp:s.winXp,lossXp:Math.floor(s.winXp/2),lossFallbackUsed:false};
}
/** 정산 대상인 끝인지: 정상 전투 승패, 또는 서버가 증명한 접속 끊김의 남은 쪽만. 항복·무승부·자동 행동은 0. */
export function normalXpTerminal(reason:string,winner:0|1|null,timeoutGenerated=false,proof?:unknown):{eligible:boolean;status:string;presence?:PresenceForfeitProof}{
  if(timeoutGenerated)return {eligible:false,status:'TIMEOUT_RESOLUTION_POLICY_PENDING'};
  if(reason==='TIMEOUT'&&validatePresenceForfeitProof(proof)&&winner===proof.survivorSide)return {eligible:true,status:'DISCONNECT_WIN',presence:proof};
  if(reason==='BATTLE'&&winner!==null)return {eligible:true,status:'APPLIED'};
  if(reason==='SURRENDER')return {eligible:false,status:'SURRENDER_ZERO'};
  return {eligible:false,status:reason==='BATTLE'?'DRAW_POLICY_PENDING':'TERMINAL_POLICY_PENDING'};
}
/** 묶음 = 실제 출전 개체 중 가장 높은 시작 레벨의 원천(경험치 조절이 있으면 「두 번 이기면 한 레벨」 하한), 패배는 절반, 출전 개체끼리 나눔(나머지는 id 순서로 1씩) */
export function normalXpShares(members:NormalXpMember[],enteredIds:readonly string[],outcome:'win'|'loss',pacing?:{policy:UnitXpPacing;enemyLevel:number}){
  if(new Set(members.map(m=>m.id)).size!==members.length)return fail('NORMAL_XP_SNAPSHOT_INVALID');
  const ids=[...new Set(enteredIds)].sort(compareOwned),byId=new Map(members.map(m=>[m.id,m]));
  if(ids.some(id=>typeof id!=='string'||!byId.has(id)||id.startsWith('AI:')))return fail('NORMAL_XP_MEMBERS_INVALID');
  const entered=ids.map(id=>byId.get(id)!);
  if(!entered.length)return {baseXp:0,poolXp:0,sourceEncounterId:null as string|null,shares:new Map<string,number>()};
  if(entered.some(m=>m.playerId!==entered[0].playerId||!safeXp(m.winXp)||m.winXp<1||!Number.isSafeInteger(m.level)||m.level<1||m.level>99||!m.sourceEncounterId))return fail('NORMAL_XP_SNAPSHOT_INVALID');
  const basis=[...entered].sort((a,b)=>b.level-a.level||compareOwned(a.id,b.id))[0];
  const baseXp=pacing?pacedPool(entered.map(m=>({...m,ownedId:m.id})),pacing.enemyLevel,basis.winXp,pacing.policy):basis.winXp;
  const poolXp=outcome==='win'?baseXp:Math.floor(baseXp/2),each=Math.floor(poolXp/ids.length),remainder=poolXp%ids.length;
  return {baseXp,poolXp,sourceEncounterId:basis.sourceEncounterId,shares:new Map(ids.map((id,i)=>[id,each+(i<remainder?1:0)]))};
}
/** 대기열에 들어갈 때 경험치 계획 고정(원본 prepareNormalXpPlayer의 계산 부분). members: 그때의 개체 값 */
export function normalXpPlan(playerId:string,members:{id:string;speciesId:string;totalXp:bigint;reincarnation:number}[],catalog:Catalog,battlePolicy:BattlePolicy,config:NormalXpPolicy|null):NormalXpPlayerPlan{
  validateNormalXpPolicy(config,catalog.version);
  if(!members.length||new Set(members.map(m=>m.id)).size!==members.length||members.some(m=>m.id.startsWith('AI:')))return fail('NORMAL_XP_MEMBERS_INVALID');
  const plan:NormalXpMember[]=[];
  for(const m of members){const d=catalog.characters.find(c=>c.id===m.speciesId);if(!d)return fail('BATTLE_UNIT_DATA_PENDING');
    const level=growthAt(Number(m.totalXp),d.growth,m.reincarnation,d.reincarnationXpPolicy).level,source=normalXpSource(battlePolicy,level,config);
    const entry:NormalXpMember={id:m.id,playerId,startingXp:m.totalXp.toString(),growth:structuredClone(d.growth),reincarnation:m.reincarnation,reincarnationXpPolicy:structuredClone(d.reincarnationXpPolicy),level,...source,
      ...(config.xpPacing?{nearestTierMinimum:battlePolicy.encounters.find(e=>e.id===source.sourceEncounterId)!.level}:{})};
    grantXp(entry,source.winXp);grantXp(entry,source.lossXp);plan.push(entry);}
  if(config.xpPacing)pacedPool(plan.map(m=>({...m,ownedId:m.id})),99,Math.max(...plan.map(m=>m.winXp)),config.xpPacing);
  return {playerId,policy:structuredClone(config),members:plan};
}
export type NormalXpUnit={ownedId:string;requestedXp:number;appliedXp:number;deferredXp:number;discardedXp:number;status:string;sourceEncounterId:string|null;startingXp:string;endingXp:string};
/** 한 사람의 일반전 경험치(원본 settleNormalXp의 계산 부분, 장부 저장은 서버) */
export function settleNormalXpPlayer(plan:NormalXpPlayerPlan|null,refs:{id:string;playerId:string;xp:string}[],enteredIds:readonly string[],side:0|1,winner:0|1|null,terminal:ReturnType<typeof normalXpTerminal>,botSide?:1){
  const playerId=refs[0]?.playerId,outcome=winner===null?'draw':winner===side?'win':'loss';
  const effective:typeof terminal=terminal.presence&&terminal.presence.departedSide===botSide?{eligible:false,status:'TERMINAL_POLICY_PENDING'}:terminal;
  const departed=effective.presence?.departedSide===side,eligible=effective.eligible&&!departed,terminalStatus=departed?'DISCONNECTED_ZERO':effective.status,unconfigured=departed?'DISCONNECTED_ZERO':'LEGACY_POLICY_UNCONFIGURED';
  if(new Set(refs.map(m=>m.id)).size!==refs.length||refs.some(m=>m.id.startsWith('AI:')))return fail('NORMAL_XP_MEMBERS_INVALID');
  if(plan&&(new Set(plan.members.map(m=>m.id)).size!==plan.members.length||plan.members.length!==refs.length||plan.members.some(m=>m.playerId!==playerId||!refs.some(r=>r.id===m.id&&r.xp===m.startingXp))))return fail('NORMAL_XP_SNAPSHOT_INVALID');
  const entered=[...new Set(enteredIds)];
  const pool=plan&&eligible&&outcome!=='draw'?normalXpShares(plan.members,entered,outcome,plan.policy.xpPacing?{policy:plan.policy.xpPacing,enemyLevel:plan.enemyLevel??fail('NORMAL_XP_SNAPSHOT_INVALID')}:undefined):null;
  const own={status:plan?terminalStatus:unconfigured,outcome,xpAwarded:0,xpDeferred:0,xpDiscarded:0,xpRequested:0,policyVersion:plan?normalXpEffectiveVersion(plan.policy):null,sourcePolicyVersion:plan?.policy.version??null,rulesVersion:'normal-xp-v2' as const,
    testValues:plan?.policy.testValues??false,participation:'actually-entered-owned-only' as const,units:[] as NormalXpUnit[]};
  for(const ref of refs){
    const pinned=plan?.members.find(m=>m.id===ref.id&&m.playerId===playerId&&m.startingXp===ref.xp);if(plan&&!pinned)return fail('NORMAL_XP_SNAPSHOT_INVALID');
    let status=!plan?unconfigured:!eligible?terminalStatus:!entered.includes(ref.id)?'NOT_ENTERED':'APPLIED';
    const requestedXp=status==='APPLIED'?(pool?.shares.get(ref.id)??0):0;
    const grant=pinned&&status==='APPLIED'?grantXp(pinned,requestedXp):{requestedXp:0,appliedXp:0,deferredXp:0,endingXp:ref.xp,status};
    if(status==='APPLIED'){status=grant.status;if(status==='APPLIED'&&terminalStatus==='DISCONNECT_WIN')status='DISCONNECT_WIN';}
    const discardedXp=Math.max(0,grant.requestedXp-grant.appliedXp-grant.deferredXp);
    own.xpAwarded+=grant.appliedXp;own.xpDeferred+=grant.deferredXp;own.xpDiscarded+=discardedXp;own.xpRequested+=grant.requestedXp;
    if(status==='CAP_CLAMPED')own.status='CAP_CLAMPED';
    own.units.push({ownedId:ref.id,requestedXp:grant.requestedXp,appliedXp:grant.appliedXp,deferredXp:grant.deferredXp,discardedXp,status,sourceEncounterId:pool?.shares.has(ref.id)?pool.sourceEncounterId:pinned?.sourceEncounterId??null,startingXp:ref.xp,endingXp:grant.endingXp});
  }
  return own;
}

// ── 랭크 자격·매칭 묶음(원본 roster60-rank.ts) ──
export const roster60RankPolicyVersion='account60-party60-history-rank-v1';
export const roster60MatchPoolPolicyVersion='account-rebirth-history-count-normal-rank-v2';
export type RankPool='FIRST_LIFE'|'REBORN';
export type RebirthCountSource='NO_REBIRTH_HISTORY'|'ROSTER60_ACCOUNT_SUCCESSES'|'HISTORY_WITHOUT_ACCOUNT_COUNT'|'MIXED_LEGACY_HISTORY'|'INVALID_OR_INCOMPLETE_HISTORY';
export type RebirthHistory={pool:RankPool|null;count:number|null;countSource:RebirthCountSource;historyStamp:string};
export function rankUnitEligibility(level:number){const ok=Number.isSafeInteger(level)&&level>=60;return {rankEligible:ok,rankReason:ok?'':'RANK_UNIT_LEVEL_REQUIRED'};}
export function rankLevelEligibility(accountLevel:number|null,units:{ownedId:string;level:number}[]){
  if(accountLevel==null)return {eligible:false,reason:'ACCOUNT_LEVEL_POLICY_PENDING'};
  if(!Number.isSafeInteger(accountLevel)||accountLevel<1)return {eligible:false,reason:'ACCOUNT_LEVEL_DATA_INVALID'};
  if(accountLevel<60)return {eligible:false,reason:'RANK_ACCOUNT_LEVEL_REQUIRED'};
  if(units.some(u=>!rankUnitEligibility(u.level).rankEligible))return {eligible:false,reason:'RANK_UNIT_LEVEL_REQUIRED'};
  return {eligible:true,reason:''};
}
/**
 * 환생 이력 → 매칭 묶음(원본 readRoster60RebirthHistory). 새 프로젝트에는 예전 체계 기록이 없어서 예전 기록 칸은 늘 없음(null·빈 목록)으로 계산.
 * 환생한 적이 있으면 REBORN, 없으면 FIRST_LIFE. 일반전·랭크전 모두 같은 묶음끼리만 매칭.
 */
export function rebirthHistory(input:{successes:number|null;reincarnatedOwned:{id:string;reincarnation:number}|null;receipts:string[]}):RebirthHistory{
  let uncertain=false,r60Proof=false;const evidence:string[]=[];
  const validCount=input.successes!==null&&Number.isSafeInteger(input.successes)&&input.successes>=0?input.successes:null;
  if(input.successes!==null&&validCount===null)uncertain=true;
  if(validCount!==null&&validCount>0)r60Proof=true;
  if(input.reincarnatedOwned)r60Proof=true;
  for(const raw of input.receipts)try{const v=JSON.parse(raw);
    if(v.completed===true&&Number.isSafeInteger(v.preview?.next?.reincarnation)&&v.preview.next.reincarnation>0){r60Proof=true;evidence.push(raw);}else if(v.completed!==false){uncertain=true;evidence.push(raw);}}catch{uncertain=true;evidence.push(raw);}
  const historyStamp=createHash('sha256').update(JSON.stringify([input.successes,null,input.reincarnatedOwned,null,evidence.sort(),[]])).digest('hex');
  if(r60Proof){
    if(uncertain)return {historyStamp,pool:'REBORN',count:null,countSource:'INVALID_OR_INCOMPLETE_HISTORY'};
    if(validCount!==null&&validCount>0)return {historyStamp,pool:'REBORN',count:validCount,countSource:'ROSTER60_ACCOUNT_SUCCESSES'};
    return {historyStamp,pool:'REBORN',count:null,countSource:'HISTORY_WITHOUT_ACCOUNT_COUNT'};
  }
  return uncertain?{historyStamp,pool:null,count:null,countSource:'INVALID_OR_INCOMPLETE_HISTORY'}:{historyStamp,pool:'FIRST_LIFE',count:0,countSource:'NO_REBIRTH_HISTORY'};
}
/** 같은 묶음 안에서: 환생 횟수가 가까운 상대 먼저, 그다음 점수 차·대기 순(원본 orderRebirthCandidates) */
export function orderRebirthCandidates<T extends {playerId:string;rating:number;queuedAt:Date;reincarnationCount:number|null}>(seeker:{rating:number;reincarnationCount:number|null},candidates:T[]):T[]{
  const baseline=(a:T,b:T)=>Math.abs(seeker.rating-a.rating)-Math.abs(seeker.rating-b.rating)||a.queuedAt.getTime()-b.queuedAt.getTime()||compareOwned(a.playerId,b.playerId);
  const valid=(c:number|null):c is number=>c!==null&&Number.isSafeInteger(c)&&c>=0;
  const known=valid(seeker.reincarnationCount)?candidates.filter(c=>valid(c.reincarnationCount)):[];
  if(!known.length)return [...candidates].sort(baseline);
  return known.sort((a,b)=>Math.abs(seeker.reincarnationCount!-a.reincarnationCount!)-Math.abs(seeker.reincarnationCount!-b.reincarnationCount!)||baseline(a,b));
}
export function validRebirthCountPin(pool:string|null|undefined,count:number|null|undefined,source:string|null|undefined):boolean{
  if(pool==='FIRST_LIFE')return count===0&&source==='NO_REBIRTH_HISTORY';
  if(pool!=='REBORN')return false;
  if(source==='ROSTER60_ACCOUNT_SUCCESSES')return count!==null&&count!==undefined&&Number.isSafeInteger(count)&&count>0;
  return count===null&&['HISTORY_WITHOUT_ACCOUNT_COUNT','MIXED_LEGACY_HISTORY','INVALID_OR_INCOMPLETE_HISTORY'].includes(source??'');
}
export type QueueRow={playerId:string;mode:string;rating:number;tierIndex:number;queuedAt:Date;reincarnationPool:string|null;reincarnationCount:number|null};
/**
 * 매칭 고르기(원본 match). rows: 조건을 통과한 대기열(대기 순). 점수 차 허용은 100에서 5초마다 25씩(최대 1200), 랭크는 등급 차 30초마다 1.
 * 일반전은 30초 넘게 기다린 사람을 AI와 붙임. 랭크는 사람끼리만.
 */
export function pickMatches(rows:QueueRow[],now:number,mode:'normal'|'rank',slots:number){
  const used=new Set<string>(),pairs:[QueueRow,QueueRow][]=[],bots:QueueRow[]=[];let created=0;
  const gap=(x:QueueRow)=>Math.min(1200,100+Math.floor((now-x.queuedAt.getTime())/5000)*25),tierGap=(x:QueueRow)=>Math.floor((now-x.queuedAt.getTime())/30000);
  for(const a of rows){if(used.has(a.playerId))continue;
    const b=orderRebirthCandidates(a,rows.filter(x=>x.playerId!==a.playerId&&!used.has(x.playerId)&&Math.abs(a.rating-x.rating)<=Math.max(gap(a),gap(x))&&a.reincarnationPool===x.reincarnationPool&&(mode!=='rank'||Math.abs(a.tierIndex-x.tierIndex)<=Math.max(tierGap(a),tierGap(x)))))[0];
    if(!b)continue;
    if(created>=Math.min(PVP_LIMITS.maxMatchesPerPass,slots))return {pairs,bots};
    created++;pairs.push([a,b]);used.add(a.playerId);used.add(b.playerId);}
  if(mode==='normal')for(const q of rows){if(used.has(q.playerId)||now<q.queuedAt.getTime()+PVP_LIMITS.casualAiAfterMs)continue;if(created>=Math.min(PVP_LIMITS.maxMatchesPerPass,slots))break;bots.push(q);created++;}
  return {pairs,bots};
}

// ── 연출 기록(원본 roster60-presentation.ts) ──
type FighterView={artVariant?:unknown;speciesId:string;name:string;level:number;hp:number;mp:number;stats:{hp:number;mp:number}};
export type PresentedFighter={id:'self'|'enemy';artVariant?:'black';speciesId:string;name:string;level:number;hp:number;mp:number;stats:{hp:number;mp:number}};
export type Presentation={version:1;before:PresentedFighter[];after:PresentedFighter[];skill?:{id:string;name:string;element:string;mpCost:number}};
export function capturePresentation(fighters:readonly FighterView[]):PresentedFighter[]{
  return fighters.map((f,i)=>({id:i===0?'self':'enemy',...publicBattleAppearance(f),speciesId:f.speciesId,name:f.name,level:f.level,hp:f.hp,mp:f.mp,stats:{hp:f.stats.hp,mp:f.stats.mp}}));
}
export function presentStep(before:PresentedFighter[],fighters:readonly FighterView[],skill?:{id:string;name:string;element:string;mpCost:number}):Presentation{
  return {version:1,before:capturePresentation(before),after:capturePresentation(fighters),...(skill?{skill:{id:skill.id,name:skill.name,element:skill.element,mpCost:skill.mpCost}}:{})};
}
export function presentationForViewer(value:Presentation|undefined,side:0|1):Presentation|undefined{
  if(!value||value.version!==1)return undefined;
  const order=(pair:PresentedFighter[])=>capturePresentation([pair[side],pair[1-side]]);
  return {...presentStep(order(value.before),order(value.after),value.skill)};
}

// ── 대전 한 판(원본 roster60-pvp.ts의 Shared 상태와 턴 처리) ──
export type PvpSide=0|1;
export type PvpAction={kind:'attack'|'skill'|'focus'|'switch'|'item'|'escape';skillId?:string;itemId?:string;targetOwnedId?:string};
export type PvpPending=PvpAction&{heldItem?:string};
export type PvpState={connectionPause?:{observedAfter:number;startedAt:number};entered?:[string[],string[]];botSide?:1;turn:number;parties:[Fighter[],Fighter[]];pending:[PvpPending|null,PvpPending|null];
  accepted:[boolean,boolean];ack:[boolean,boolean];misses:[number,number];winner:PvpSide|null;events:any[]};
export type PvpSnap={policy:BattlePolicy;items:Record<string,ItemDefinition>;observedDefense?:DefenseSnapshot};
/** 행동 검사(원본 validate) */
export function pvpValidate(s:PvpState,side:PvpSide,a:PvpAction,snap:PvpSnap){
  const party=s.parties[side],active=party[0];
  if(a.kind==='escape')return;
  if(active.hp<=0&&a.kind!=='switch')return fail('FORCED_SWITCH_REQUIRED');
  if(a.kind==='switch'){if(!party.slice(1).some(f=>f.ownedId===a.targetOwnedId&&f.hp>0))return fail('INVALID_SWITCH');return;}
  if(a.kind==='item'){const it=snap.items[a.itemId??''];if(!it)return fail('INVALID_ITEM');
    const target=it.revive?party.find(f=>f.ownedId===a.targetOwnedId):active;
    if(!target||(!it.revive&&a.targetOwnedId&&a.targetOwnedId!==active.ownedId))return fail('INVALID_ITEM_TARGET');
    if(it.revive?target.hp>0:!active.hp)return fail('INVALID_ITEM_TARGET');
    if(!it.revive&&!it.heal)return fail('NO_STATUS_TO_CLEANSE');
    if(it.heal&&active.hp>=active.stats.hp)return fail('HP_FULL');return;}
  if(a.kind==='focus')return;
  const skill=a.kind==='attack'?active.attack:a.kind==='skill'?active.skills.find(x=>x.id===a.skillId):null;
  if(!skill)return fail('SKILL_NOT_EQUIPPED');if(skill.mpCost>active.mp)return fail('INSUFFICIENT_MP');
}
/** 교체(원본 switch): 첫 칸과 바꾸고, 실제로 나간 개체 기록 */
export function pvpSwitch(s:PvpState,side:PvpSide,target:string){
  const party=s.parties[side],ix=party.findIndex((f,i)=>i>0&&f.ownedId===target&&f.hp>0);if(ix<0)return fail('INVALID_SWITCH');
  [party[0],party[ix]]=[party[ix],party[0]];s.entered??=[[],[]];if(!s.entered[side].includes(target))s.entered[side].push(target);
}
/** AI 행동 정하기(원본 primeBot): 쓰러졌으면 다음 대원으로 교체, 아니면 정책에 맞는 기술(가장 센 것, 집중 뒤 두 배 넘는 기술이 있으면 집중) */
export function pvpPrimeBot(s:PvpState,snap:PvpSnap){
  if(s.botSide!==1)return;
  const party=s.parties[1];
  if(party[0].hp<=0){const next=party.findIndex((f,i)=>i>0&&f.hp>0);
    if(next>0){const before=capturePresentation(s.parties.map(p=>p[0]));pvpSwitch(s,1,party[next].ownedId!);s.events.push({turn:s.turn,events:[{side:1,kind:'forced-switch',presentation:presentStep(before,s.parties.map(p=>p[0]))}]});}}
  if(s.parties.some(p=>p[0].hp<=0)||s.pending[1])return;
  const enemy=party[0],self=s.parties[0][0];
  let skill:typeof enemy.attack|undefined=[enemy.attack,...enemy.skills].find(sk=>sk.mpCost<=enemy.mp);
  if(snap.policy.enemyStrategy==='best-affordable'){
    const score=(sk:typeof enemy.attack)=>fiveStatAttack({power:sk.power,level:enemy.level,durability:self.stats.durability,suitability:enemy.suitability[sk.element],defense:self.defense[sk.element],attackerHp:enemy.hp,defenderHp:self.hp},snap.policy.calculation,(b,f)=>b*f);
    const usable=[enemy.attack,...enemy.skills].filter(sk=>sk.mpCost<=enemy.mp);
    usable.sort((a,b)=>{const x=score(a),y=score(b);return (y.reflected?-y.damage:y.damage)-(x.reflected?-x.damage:x.damage)||a.mpCost-b.mpCost;});
    skill=usable[0];const bestNow=skill?score(skill).damage:0,afterFocus=focusMp(enemy.mp,enemy.stats.mp).mp;
    if(enemy.skills.some(sk=>sk.mpCost>enemy.mp&&sk.mpCost<=afterFocus&&!score(sk).reflected&&score(sk).damage>2*bestNow))skill=undefined;
  }
  s.pending[1]=!skill?{kind:'focus'}:skill===enemy.attack?{kind:'attack'}:{kind:'skill',skillId:skill.id};
}
export type PvpItemOp={side:PvpSide;itemId:string;op:'CONSUMED'|'REFUNDED'};
/**
 * 양쪽 행동이 모이면 한 턴 처리(원본 resolve). 교체·아이템이 먼저, 그다음 속도 순서. 공격 직전에 한쪽이 쓰러졌으면 그 행동은 취소(아이템 돌려줌).
 * 반환: 바뀐 상태(s를 바꿈), 이번 턴 사건, 새 관측, 아이템 처리(서버가 개수 반영), 끝났으면 승자.
 */
export function pvpResolve(battleId:string,seed:string,s:PvpState,snap:PvpSnap,catalog:Catalog|null){
  const events:any[]=[],observations:DefenseObservation[]=[],itemOps:PvpItemOp[]=[];
  const knowledge=sides.map(side=>battleKnowledge(snap.observedDefense,s.events,String(side)));
  const intels=()=>sides.map(side=>observedOpponentIntel(s.parties[1-side][0],s.turn,snap.observedDefense,knowledge[side],catalog));
  const decision=decideTurnOrder(battleId,s.turn,[{id:'p0',baseSpeed:s.parties[0][0].stats.speed,modifiers:[]},{id:'p1',baseSpeed:s.parties[1][0].stats.speed,modifiers:[]}],seed);
  const priority=(side:PvpSide)=>['switch','item'].includes(s.pending[side]!.kind)?1:0;
  const ordered=decision.order.map(x=>x==='p0'?0:1) as PvpSide[];ordered.sort((a,b)=>priority(b)-priority(a));
  for(const side of ordered){const a=s.pending[side]!,party=s.parties[side],actor=party[0],target=s.parties[1-side][0];
    if(!actor.hp||!target.hp){if(a.heldItem){itemOps.push({side,itemId:a.heldItem,op:'REFUNDED'});delete a.heldItem;}continue;}
    const stepBefore=capturePresentation(s.parties.map(p=>p[0])),intelBefore=intels();
    if(a.kind==='switch'){pvpSwitch(s,side,a.targetOwnedId!);events.push({side,kind:'switch',presentation:presentStep(stepBefore,s.parties.map(p=>p[0])),intelBefore,intelAfter:intels()});continue;}
    if(a.kind==='item'){const it=snap.items[a.itemId!],to=it.revive?party.find(f=>f.ownedId===a.targetOwnedId)!:actor,before=to.hp;
      to.hp=it.revive?Math.round(to.stats.hp*it.revive/100):Math.min(to.stats.hp,to.hp+Math.round(to.stats.hp*it.heal!/100));
      if(a.heldItem){itemOps.push({side,itemId:a.heldItem,op:'CONSUMED'});delete a.heldItem;}
      events.push({side,kind:'item',itemId:a.itemId,recovered:to.hp-before,targetOwnedId:to.ownedId,presentation:presentStep(stepBefore,s.parties.map(p=>p[0])),intelBefore,intelAfter:intels()});continue;}
    if(a.kind==='focus'){const gain=focusMp(actor.mp,actor.stats.mp);actor.mp=gain.mp;events.push({side,kind:'focus',recovered:gain.recovered,presentation:presentStep(stepBefore,s.parties.map(p=>p[0])),intelBefore,intelAfter:intels()});continue;}
    const skill=a.kind==='attack'?actor.attack:actor.skills.find(x=>x.id===a.skillId)!;
    actor.mp=spendMp(actor.mp,skill.mpCost);
    const hit=fiveStatAttack({power:skill.power,level:actor.level,durability:target.stats.durability,suitability:actor.suitability[skill.element],defense:target.defense[skill.element],attackerHp:actor.hp,defenderHp:target.hp},snap.policy.calculation,(b,f)=>b*f);
    if(hit.target==='attacker')actor.hp-=hit.damage;else target.hp-=hit.damage;
    const obs=resolvedDefenseObservation(target,skill.element as SkillElement,hit,String(side),snap.observedDefense,catalog,knowledge[side]);
    if(obs){observations.push(obs);addDefenseObservation(knowledge[side],obs,snap.observedDefense);}
    events.push({side,kind:'skill',skillId:skill.id,...hit,presentation:presentStep(stepBefore,s.parties.map(p=>p[0]),skill),...(obs?{defenseObservation:obs}:{}),intelBefore,intelAfter:intels()});
  }
  s.events.push({turn:s.turn,decision,events});s.turn++;s.pending=[null,null];
  const dead=s.parties.map(p=>p.every(f=>f.hp<=0));
  const finished:{winner:PvpSide|null;reason:'BATTLE'}|null=dead[0]||dead[1]?{winner:dead[0]&&dead[1]?null:dead[0]?1:0,reason:'BATTLE'}:s.turn>=snap.policy.maxRounds?{winner:null,reason:'BATTLE'}:null;
  if(!finished)pvpPrimeBot(s,snap);
  return {state:s,observations,itemOps,finished};
}
/** 제한 시간이 지난 턴(원본 advance의 끝부분): 놓친 횟수 +1, 3번이면 시간 초과, 아니면 안 고른 쪽은 자동(공격 또는 집중) */
export function pvpTurnDeadline(s:PvpState):{finish?:{winner:PvpSide|null;reason:'TIMEOUT'|'DOUBLE_TIMEOUT'};waitForced?:boolean;resolve?:boolean}{
  const forced=s.parties.map(p=>!p[0].hp);
  for(const side of sides)if(side!==s.botSide&&(forced.some(Boolean)?forced[side]:!s.pending[side]))s.misses[side]++;
  const lost=sides.filter(i=>s.misses[i]>=3);
  if(lost.length)return {finish:{winner:lost.length===2?null:(1-lost[0]) as PvpSide,reason:lost.length===2?'DOUBLE_TIMEOUT':'TIMEOUT'}};
  if(forced.some(Boolean))return {waitForced:true};
  for(const side of sides)if(!s.pending[side])s.pending[side]=s.parties[side][0].mp>=s.parties[side][0].attack.mpCost?{kind:'attack'}:{kind:'focus'};
  return {resolve:true};
}

// ── 패배 안내(원본 roster60-loss-feedback.ts 그대로) ──
export type LossFeedbackReason='BATTLE'|'SURRENDER'|'TIMEOUT'|'DOUBLE_TIMEOUT'|'SERVER_ABORT'|'MATCH_TIMEOUT'|'MATCH_DECLINED';
export type LossTerminationKind='DISCONNECTED'|'TURN_INPUT'|'SERVER_OBSERVATION_GAP';
type Frame={hp:number;speciesId:string};type Step={before:[Frame,Frame];after:[Frame,Frame];element:SkillElement|null};type ReplayLocation={turn:number;roundIndex:number;eventIndex:number};
const fbReasons=new Set<string>(['BATTLE','SURRENDER','TIMEOUT','DOUBLE_TIMEOUT','SERVER_ABORT','MATCH_TIMEOUT','MATCH_DECLINED']);
const obj=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const nonneg=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function frames(v:unknown):[Frame,Frame]|null{if(!Array.isArray(v)||v.length!==2)return null;const pair=v.map(obj);if(pair.some(f=>!f||!nonneg(f.hp)||typeof f.speciesId!=='string'||!f.speciesId))return null;return pair.map(f=>({hp:f!.hp,speciesId:f!.speciesId})) as [Frame,Frame];}
function stepOf(v:unknown):Step|null{const p=obj(v);if(p?.version!==1)return null;const before=frames(p.before),after=frames(p.after);if(!before||!after)return null;const el=obj(p.skill)?.element;return {before,after,element:skillElements.includes(el as SkillElement)?el as SkillElement:null};}
const executedSkill=(e:Record<string,any>)=>e.kind==='skill'&&e.executed!==false&&e.hit!==false&&e.miss!==true&&e.missed!==true&&e.cancelled!==true&&(e.outcome===undefined||e.outcome==='hit');
function opponentActedFirst(round:Record<string,any>,eventIndex:number,viewer:PvpSide){const d=obj(round.decision),order=d?.order,events=round.events as unknown[];
  return d?.version==='five-speed-v1'&&d.turn===round.turn&&Array.isArray(order)&&order.length===2&&order[0]===`p${1-viewer}`&&order[1]===`p${viewer}`&&!events.slice(0,eventIndex).some(e=>obj(e)?.side===viewer);}
function koFact(round:Record<string,any>,e:Record<string,any>,loc:ReplayLocation,viewer:PvpSide,p:Step){
  if(!executedSkill(e)||!nonneg(e.damage)||e.damage===0)return null;
  const other=(1-viewer) as PvpSide,before=p.before[viewer].hp,after=p.after[viewer].hp;
  if(before===0||p.before[other].hp===0||after!==0||e.damage!==before-after||p.before.some((f,i)=>f.speciesId!==p.after[i].speciesId)||p.before[other].hp!==p.after[other].hp)return null;
  const fact={...loc,hpBefore:before,hpAfter:0 as const,damage:e.damage};
  if(e.side===viewer&&e.target==='attacker'&&e.defense==='reflect'&&e.reflected===true&&p.element)return {...fact,kind:'reflected-ko' as const,element:p.element};
  if(e.side!==other||e.target!=='defender'||e.reflected!==false||!['weak','normal','resist'].includes(String(e.defense)))return null;
  return {...fact,kind:opponentActedFirst(round,loc.eventIndex,viewer)?'enemy-first-ko' as const:'direct-ko' as const};
}
/** 진 이유를 기록에서 하나만 보여 주고 다음에 해 볼 것 하나(원본 roster60LossFeedback). 이긴 경우·정상 무승부는 없음. */
export function lossFeedback(input:{state:unknown;viewerSide:PvpSide;mode:'normal'|'rank';outcome:'win'|'loss'|'draw'|null;reason:unknown;status:string;opponentKind:'AI'|'HUMAN';terminationKind?:LossTerminationKind}){
  if(!['FINISHED','SETTLED'].includes(input.status)||(input.viewerSide!==0&&input.viewerSide!==1)||!['normal','rank'].includes(input.mode)||!['AI','HUMAN'].includes(input.opponentKind)||![null,'win','loss','draw'].includes(input.outcome)||typeof input.reason!=='string'||!fbReasons.has(input.reason))return null;
  const reason=input.reason as LossFeedbackReason;if(reason==='BATTLE'&&input.outcome!=='loss')return null;
  const rounds=obj(input.state)?.events;let latest:any=null,last:ReplayLocation|null=null;
  if(Array.isArray(rounds))rounds.forEach((raw,roundIndex)=>{const round=obj(raw);if(!round||!nonneg(round.turn)||!Array.isArray(round.events))return;
    round.events.forEach((rawE:unknown,eventIndex:number)=>{const e=obj(rawE);if(!e)return;const p=stepOf(e.presentation);if(!p)return;const loc={turn:round.turn,roundIndex,eventIndex};last=loc;const f=koFact(round,e,loc,input.viewerSide,p);if(f)latest=f;});});
  const base={version:'roster60-loss-feedback-v1' as const,mode:input.mode,outcome:input.outcome,opponentKind:input.opponentKind,reason};
  const replay=(l:ReplayLocation|null)=>l?{available:true,turn:l.turn,roundIndex:l.roundIndex,eventIndex:l.eventIndex}:{available:false};
  if(reason!=='BATTLE'){let explanationKey:string=reason,nextAttemptKey='REVIEW_REPLAY';
    if(['TIMEOUT','DOUBLE_TIMEOUT','SERVER_ABORT'].includes(reason)){
      if(input.terminationKind==='DISCONNECTED'){explanationKey='DISCONNECTED';nextAttemptKey='CHECK_CONNECTION_AND_REPLAY';}
      else if(input.terminationKind==='TURN_INPUT'&&reason!=='SERVER_ABORT'){explanationKey='TURN_INPUT_TIMEOUT';nextAttemptKey='CHECK_TURN_DEADLINE_AND_REPLAY';}
      else if(input.terminationKind==='SERVER_OBSERVATION_GAP')explanationKey='SERVER_OBSERVATION_GAP';}
    return {...base,kind:'termination' as const,explanationKey,nextAttemptKey,replay:replay(last)};}
  if(!latest)return {...base,kind:'record' as const,explanationKey:'INSUFFICIENT_RECORD',nextAttemptKey:'REVIEW_REPLAY',replay:replay(last)};
  const explanationKey=latest.kind==='reflected-ko'?'REFLECTED_KO':latest.kind==='enemy-first-ko'?'ENEMY_FIRST_KO':'DIRECT_KO';
  const nextAttemptKey=latest.kind==='reflected-ko'?'TRY_DIFFERENT_ELEMENT':latest.kind==='enemy-first-ko'?'TRY_SWITCH_OR_HEAL_EARLIER':'REVIEW_LAST_TURN';
  return {...base,kind:'battle' as const,explanationKey,nextAttemptKey,fact:latest,replay:replay(latest)};
}
