// 7-2단계(일반전·랭크전) 규칙이 GMM110과 같은지: fixtures/gmm110-pvp.json(원본 RosterPvp를 실제로 돌린 기록)과 비교.
// 기준 결과 다시 만들기: tools/parity/generate-pvp.ts 맨 위 설명.
// 원본 내부 단계(턴 처리·AI 선택·매칭·종료 정산)의 입력을 기록에서 다시 만들어 새 함수에 넣고, 원본 출력과 비교한다.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {
  monitorObservation,initializePresence,observePresence,decidePresence,applyRankedResult,rankedMatchmakingMmr,initialRankedSnapshot,normalXpSource,normalXpTerminal,orderRebirthCandidates,validRebirthCountPin,
  pvpResolve,pvpPrimeBot,pickMatches,settleNormalXpPlayer,casualNext,lossFeedback,validatePresenceForfeitProof,defaultPresencePolicy,type PvpState,type NormalXpPolicy,
} from '../src/pvp.js';
import {withRewardSchedule,commanderEventReward} from '../src/progression.js';
import type {Catalog} from '../src/catalog.js';
import {RuleError} from '../src/errors.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-pvp.json');
const catalog:Catalog=read('../../data/catalog.json');
const paced={...read('../../data/battle-policy.json'),xpPacing:read('../../data/unit-xp-pacing-policy.json')};
const normalXp:NormalXpPolicy={...read('../../data/normal-xp-policy.json'),xpPacing:read('../../data/unit-xp-pacing-policy.json')};
const items=read('../../data/items.json').items;
const commander=withRewardSchedule(read('../../data/commander-policy.json'),read('../../data/commander-reward-schedule.json'));
const run=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:e instanceof RuleError?e.code:(e as Error).message};}};
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));
// 기록에서 줄여 적은 값 펼치기
const expand=(v:any)=>JSON.parse(JSON.stringify(v),(_k,x)=>typeof x!=='string'?x:x.startsWith('growth:')?catalog.characters.find(c=>c.id===x.slice(7))!.growth:x==='policy:paced'?paced:x==='policy:normalXp'?normalXp:x);
const rooms:Record<string,any>=expand(fx.rooms);
const finishOf=(bid:string)=>fx.hooks.finish.find((f:any)=>f.battleId===bid);
/** 방 개체 + 턴마다 기록한 순서·체력·MP + 이전 관측 → 원본이 그 턴에 쓴 상태 */
function rebuild(bid:string,v:any,priorCount=0):PvpState{
  const room=rooms[bid],{eventCount,...rest}=v;void eventCount;
  const parties=v.parties.map((p:any[])=>p.map((x:any)=>({...structuredClone(room.fighters[x.ownedId]),hp:x.hp,mp:x.mp})));
  const all=(finishOf(bid)?.stateAfter.events??[]).flatMap((r:any)=>r.events.filter((e:any)=>e.defenseObservation).map((e:any)=>({turn:r.turn,side:e.side,defenseObservation:e.defenseObservation})));
  const events=all.slice(0,priorCount).map((o:any)=>({turn:o.turn,events:[{side:o.side,defenseObservation:o.defenseObservation}]}));
  return {...structuredClone(rest),parties,events};
}
const snapOf=(bid:string)=>({...rooms[bid].snapshot,items});
const vitals=(s:PvpState)=>s.parties.map(p=>p.map(f=>({ownedId:f.ownedId,hp:f.hp,mp:f.mp})));
const lean=(r:any)=>({...r,events:r.events.map(({intelBefore,intelAfter,...e}:any)=>e)});

describe('접속 판정이 GMM110과 같다',()=>{
  for(const [n,seq] of fx.pure.presenceSeq.entries())it(`관측 순서 ${n+1} (${seq.length}단계)`,()=>{
    let m:any=null,st:any=null;
    for(const [i,op] of seq.entries()){
      if(op.op==='monitor'){const r=monitorObservation(op.bogus?{bogus:1}:m,op.now,defaultPresencePolicy); /* bogus: 원본에 일부러 망가진 이전 기록을 넣은 경우 */expect(json(r),`${i} monitor`).toEqual(op.r);m=r.monitor;}
      else if(op.op==='init'){st=initializePresence(m,op.now,defaultPresencePolicy,op.bot??undefined);expect(json(st)).toEqual(op.r);}
      else if(op.op==='observe'){const r=observePresence(st,op.side,m,op.now);expect(json(r),`${i} observe`).toEqual(op.r);if(r.state)st=r.state;}
      else expect(json(decidePresence(st,m,op.now)),`${i} decide`).toEqual(op.r);
    }
  });
});

describe('랭크·일반전 점수와 일반전 경험치 계산이 GMM110과 같다',()=>{
  it('랭크 점수 200판(승급전·강등·무승부 포함)',()=>{for(const c of fx.pure.rating){expect(json(run(()=>applyRankedResult(c.a,c.b,c.score)))).toEqual(c.r);expect(run(()=>rankedMatchmakingMmr(c.a))).toEqual(c.mm);}});
  it('첫 랭크 상태(일반전 점수 반영)',()=>{for(const c of fx.pure.casual)expect(run(()=>initialRankedSnapshot({mmr:c.mmr,games:c.games}))).toEqual(c.r);});
  it('일반전 경험치 원천',()=>{for(const c of fx.pure.normalXp.source)expect(run(()=>normalXpSource(paced,c.lv,normalXp))).toEqual(c.r);});
  it('일반전 경험치를 주는 끝인지',()=>{for(const c of fx.pure.normalXp.terminal)expect(json(run(()=>normalXpTerminal(c.reason,c.winner,c.tg,{version:'roster60-presence-proof-v1',departedSide:1,graceStartedAt:1,graceUntil:2,survivorSide:0,monitorGeneration:1,decisionAt:3})))).toEqual(c.r);});
  it('환생 횟수가 가까운 상대 순서',()=>{for(const c of fx.pure.order)expect(orderRebirthCandidates({...c.seeker,queuedAt:new Date(c.seeker.queuedAt)},c.cands.map((x:any)=>({...x,queuedAt:new Date(x.queuedAt)}))).map(x=>x.playerId)).toEqual(c.r);});
  it('대기열 묶음 고정값 검사',()=>{for(const c of fx.pure.pin)expect(validRebirthCountPin(c.pool,c.count,c.src)).toBe(c.r);});
});

describe('대전 턴 처리가 GMM110과 같다',()=>{
  it(`원본 턴 ${fx.hooks.resolve.length}번: 같은 상태·같은 행동이면 같은 결과(순서·피해·교체·아이템·관측·연출)`,()=>{
    let refunds=0;
    for(const [i,e] of fx.hooks.resolve.entries()){
      const s=rebuild(e.battleId,e.before,e.priorCount);
      const r=pvpResolve(e.battleId,rooms[e.battleId].seed,s,snapOf(e.battleId),catalog);
      expect(json(lean(s.events.at(-1))),`${i} 사건`).toEqual(e.round);
      expect(vitals(s),`${i} 체력·순서`).toEqual(e.after.parties);
      expect(s.turn,`${i} 턴`).toBe(e.after.turn);
      expect(s.entered,`${i} 출전 기록`).toEqual(e.after.entered);
      // 아이템: 고를 때 이미 1개 빠짐. 행동 전에 쓰러져 취소되면 돌려받음(REFUNDED) → 원본 DB 개수 변화와 같아야 함
      const room=rooms[e.battleId],ids=[room.player0Id,room.player1Id],delta:Record<string,number>={};
      for(const op of r.itemOps)if(op.op==='REFUNDED'){const k=ids[op.side]+':'+op.itemId;delta[k]=(delta[k]??0)+1;}
      for(const k of new Set([...Object.keys(e.items.before),...Object.keys(e.items.after)]))expect((e.items.after[k]??0)-(e.items.before[k]??0),`${i} 아이템 ${k}`).toBe(delta[k]??0);
      refunds+=Object.values(delta).reduce((a,b)=>a+b,0);
      if(!r.finished)expect(json(s.pending),`${i} AI 다음 행동`).toEqual(e.after.pending);
      else{const f=finishOf(e.battleId);expect(r.finished.winner,`${i} 승자`).toBe(f.winner);}
    }
    console.log('턴 처리 중 아이템 환불',refunds,'번');
  });
  it(`AI 행동 선택 ${fx.hooks.primeBot.length}번`,()=>{
    for(const [i,e] of fx.hooks.primeBot.entries()){
      if(!rooms[e.battleId])continue;
      const s=rebuild(e.battleId,e.before);const n=s.events.length;pvpPrimeBot(s,snapOf(e.battleId));
      expect(json(s.pending),`${i}`).toEqual(e.after.pending);expect(vitals(s)).toEqual(e.after.parties);
      expect(json(s.events.slice(n).map(lean))).toEqual(e.added);
    }
  });
});

describe('매칭이 GMM110과 같다',()=>{
  it(`매칭 ${fx.hooks.match.length}번: 같은 대기열이면 같은 짝·같은 AI 배정`,()=>{
    for(const [i,m] of fx.hooks.match.entries()){
      const rows=m.rows.filter((q:any)=>new Date(q.leaseUntil).getTime()>m.clock&&['FIRST_LIFE','REBORN'].includes(q.reincarnationPool))
        .map((q:any)=>({...q,queuedAt:new Date(q.queuedAt)})).sort((a:any,b:any)=>a.queuedAt-b.queuedAt||(a.playerId<b.playerId?-1:1));
      const r=pickMatches(rows,m.clock,m.mode,1000);
      const mine=[...r.pairs.map(([a,b])=>[a.playerId,b.playerId]),...r.bots.map(q=>[q.playerId,'AI'])];
      expect(mine,`${i}`).toEqual(m.created.map((c:any)=>[c.player0Id,c.player1Id]));
    }
  });
});

describe('대전 종료 정산이 GMM110과 같다',()=>{
  for(const [i,f] of fx.hooks.finish.entries())it(`종료 ${i+1}: ${rooms[f.battleId].mode} ${f.reason}`,()=>{
    const room=rooms[f.battleId],snap=room.snapshot,st=f.stateAfter,ids=[room.player0Id,room.player1Id];
    if(room.mode==='normal'&&f.settlement.normalXp){
      const terminal=normalXpTerminal(f.reason,f.winner,f.timeoutGenerated,f.proof??undefined);
      for(const side of [0,1] as const){if(side===st.botSide)continue;const pid=ids[side],exp=f.settlement.normalXp.players[pid];
        const plan=snap.normalXp?.players.find((p:any)=>p.playerId===pid)??null,refs=snap.members.filter((m:any)=>m.playerId===pid);
        const mine=settleNormalXpPlayer(plan,refs,st.entered?.[side]??[],side,f.winner,terminal,st.botSide);
        const {units,...rest}=exp;
        expect({...mine,units:undefined,outcome:undefined},`경험치 ${side}`).toEqual({...rest,units:undefined});
        expect(mine.units.map(({startingXp,endingXp,...u})=>u)).toEqual(units.map(({xpProgress,...u}:any)=>u));
      }
      // 방범대장: 같은 사건 → 같은 지급량·이유
      for(const side of [0,1] as const){if(side===st.botSide)continue;const pid=ids[side],exp=f.settlement.commanderRewards?.[pid];if(!exp)continue;
        const outcome=f.reason==='SURRENDER'?'surrender':f.reason==='SERVER_ABORT'||f.reason==='DOUBLE_TIMEOUT'?'aborted':f.proof?.departedSide===side?'departed':f.winner===null?'draw':f.winner===side?'win':'loss';
        const r=commanderEventReward({kind:'NORMAL_PLAY',eventId:f.battleId,outcome,reason:f.reason,timeoutGenerated:f.timeoutGenerated,...(f.proof?{terminationProof:f.proof}:{}),side},commander,validatePresenceForfeitProof as any);
        expect([r.requestedXp,r.reason],`방범대장 ${side}`).toEqual([exp.requestedXp,exp.reason]);}
    }
    const rating=f.settlement.rating;
    if(rating&&room.mode==='rank'){const [p0,p1]=rating.players;
      for(const [me,other,idx] of [[p0,p1,0],[p1,p0,1]] as const){const r=rating.voided?{...me}:applyRankedResult(me.before,other.before,f.winner===null?0.5:f.winner===idx?1:0);
        const {playerId,...exp}=me;expect(json({...r,playerId:undefined})).toEqual(json(exp));}}
    if(rating&&room.mode==='normal'){const [p0,p1]=rating.players;
      expect(casualNext(p0.before,p1.before,f.winner,0,f.reason)).toEqual(p0.after);expect(casualNext(p1.before,p0.before,f.winner,1,f.reason)).toEqual(p1.after);}
  });
  it('패배 안내: 직접 만든 드문 장면(반사로 쓰러짐·상대가 먼저 침·그냥 쓰러짐·끝 사유별)',()=>{for(const c of fx.pure.feedbackSynthetic)
    expect(json(lossFeedback({state:{events:c.rounds},viewerSide:c.side,mode:'normal',outcome:'loss',reason:c.reason,status:'FINISHED',opponentKind:'HUMAN',terminationKind:c.tk??undefined}))).toEqual(c.r);});
  it('패배 안내',()=>{for(const c of fx.pure.feedback){const f=finishOf(c.battleId);
    expect(json(lossFeedback({state:f.stateAfter,viewerSide:c.side,mode:c.mode,outcome:c.outcome,reason:c.reason,status:'FINISHED',opponentKind:c.bot?'AI':'HUMAN',terminationKind:c.terminationKind??undefined})),JSON.stringify(c).slice(0,80)).toEqual(c.r);}});
});
