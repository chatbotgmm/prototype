// 7-2단계 서버 시험(시계 조절): 일반전 사람끼리·30초 뒤 AI·거절 후 다시 대기·끝날 때 아이템 환불·접속 끊김(증명된 이탈)·입력 시간 초과·랭크(점수)·랭크 자격·대전 중 환생 막기.
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import type {PvpService} from '../src/pvp-service.js';
import {createTestDb,seedTestPlayer,root} from '../../tools/test-db.js';
import {loadContent} from '../src/content.js';
import {commanderPolicyFingerprint} from '../../shared/src/index.js';

let app:FastifyInstance,close:()=>Promise<void>,db:Awaited<ReturnType<typeof createTestDb>>['db'],pvp:PvpService;
let clock=Date.now(),n=0,codeNo=880000;
const API='/proto/api/v1',rid=()=>'pv-'+(n++);
beforeAll(async()=>{const t=await createTestDb();db=t.db;close=t.close;app=await buildApp(db,{root,secret:'p'.repeat(40),now:()=>clock,pvpTimer:false});await app.ready();pvp=(app as any).pvp;});
afterAll(async()=>{await app?.close();await close?.();});
type Call=(m:'GET'|'POST',p:string,b?:unknown)=>Promise<any>;
async function account(units:{speciesId:string;level:number}[],opt:{commanderXp?:number;items?:Record<string,number>}={}){
  const code=String(codeNo++),s=await seedTestPlayer(db,{name:'대전'+code,codes:[code],units,items:opt.items??{potion:2,feather:1}});
  if(opt.commanderXp!==undefined){const c=loadContent(root).commander;await db.commanderAccount.create({data:{playerId:s.player.id,totalXp:BigInt(opt.commanderXp),policyVersion:c.version,policyFingerprint:commanderPolicyFingerprint(c)}});}
  const r=await app.inject({method:'POST',url:API+'/auth/code',headers:{'x-gmm':'1','x-gmm-app':'1'},payload:{code}});const token=r.json().token;
  const call:Call=async(method,path,body)=>{const x=await app.inject({method,url:API+path,headers:{'x-gmm':'1','x-gmm-s':token},...(body!==undefined?{payload:body as object}:{})});const j=x.json();if(x.statusCode!==200)return {__error:j.error,status:x.statusCode};return j;};
  return {id:s.player.id,units:s.units.map(u=>u.id),call};
}
/** 시계를 5초씩 움직이며(접속 관측이 끊기지 않게) 지정한 사람만 조회 */
async function step(ms:number,polls:Call[]=[]){while(ms>0){const d=Math.min(5000,ms);clock+=d;ms-=d;for(const c of polls)await c('GET','/pvp/current');await pvp.tick();}}
const battleOf=async(c:Call)=>(await c('GET','/pvp/current')).battle;
async function acceptAll(...cs:Call[]){for(const c of cs){const b=await battleOf(c);expect(b?.status).toBe('ACCEPTING');const r=await c('POST','/pvp/accept',{requestId:rid(),battleId:b.battleId,revision:b.revision,accept:true});expect(r.__error).toBeUndefined();}}
/** 끝날 때까지: 쓸 수 있는 가장 센 기술, 쓰러지면 교체 */
async function playOut(cs:Call[]){
  for(let t=0;t<150;t++){let any=false;
    for(const c of cs){const b=await battleOf(c);if(!b||b.status!=='ACTIVE')continue;any=true;if(b.waitingForOpponent||b.submitted)continue;
      const me=b.state.self,alive=b.state.reserves.filter((f:any)=>f.hp>0),sk=me.skills.filter((s:any)=>s.mpCost<=me.mp).sort((x:any,y:any)=>y.power-x.power)[0];
      const action=me.hp<=0?{kind:'switch',targetOwnedId:alive[0].ownedId}:sk?{kind:'skill',skillId:sk.id}:me.mp>=me.attack.mpCost?{kind:'attack'}:{kind:'focus'};
      await c('POST','/pvp/action',{requestId:rid(),battleId:b.battleId,revision:b.revision,action});}
    if(!any)break;}
  const out=[];for(const c of cs){const b=await battleOf(c);out.push(b);if(b&&b.status==='FINISHED')await c('POST','/pvp/settle',{requestId:rid(),battleId:b.battleId,revision:b.revision});}
  return out;
}

describe('일반전',()=>{
  it('사람 둘: 매칭 → 둘 다 수락 → 끝까지 → 경험치(출전 대원)·방범대장·일반전 점수, 대원은 다시 쓸 수 있음',async()=>{
    const a=await account([{speciesId:'u20',level:20},{speciesId:'u21',level:18}]),b=await account([{speciesId:'u22',level:20}]);
    expect((await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'})).__error).toBe('PARTY_REQUIRED');
    for(const p of [a,b])expect((await p.call('POST','/pvp/party',{ownedIds:p.units})).partyIds).toEqual(p.units);
    const ja=await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});expect(ja.status).toBe('waiting');expect(ja.aiAvailableAt).toBe(ja.queuedAt+30000);
    expect((await db.owned.findUniqueOrThrow({where:{id:a.units[0]}})).status).toBe('PVP_QUEUE');
    const jb=await b.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});expect(jb.status).toBe('matched');expect(jb.battle.opponentKind).toBe('HUMAN');
    await acceptAll(a.call,b.call);
    const ba=await battleOf(a.call);expect(ba.status).toBe('ACTIVE');expect(ba.state.enemy.speciesId).toBe('u22');expect(ba.deadline).toBe(clock+30000);
    const [fa,fb]=await playOut([a.call,b.call]);
    expect(['win','loss']).toContain(fa.state.outcome);expect(fa.settlement.reason).toBe('BATTLE');
    const winner=fa.state.outcome==='win'?a:b,loser=winner===a?b:a,wv=winner===a?fa:fb,lv=winner===a?fb:fa;
    expect(wv.settlement.commanderReward).toMatchObject({xpAwarded:150,reason:'NORMAL_WIN'});expect(lv.settlement.commanderReward).toMatchObject({xpAwarded:75,reason:'NORMAL_LOSS'});
    expect(wv.settlement.xpAwarded).toBeGreaterThan(0);expect(lv.settlement.xpAwarded).toBeGreaterThan(0);expect(wv.settlement.normalXp.status).toMatch(/APPLIED|CAP_CLAMPED/);
    expect(wv.settlement.rating.after.mmr).toBeGreaterThan(1000);expect(lv.settlement.rating.after.mmr).toBeLessThan(1000);
    const units=await db.owned.findMany({where:{playerId:{in:[a.id,b.id]}}});expect(units.every(u=>u.status==='AVAILABLE')).toBe(true);
    expect((await a.call('GET','/pvp/current')).status).toBe('idle');void loser;
  });
  it('혼자 기다리면 30초 뒤 AI와 매칭(대원 수만큼 AI)',async()=>{
    const a=await account([{speciesId:'u30',level:12},{speciesId:'u31',level:40}]);
    await a.call('POST','/pvp/party',{ownedIds:a.units});await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});
    await step(25000,[a.call]);expect((await a.call('GET','/pvp/current')).status).toBe('waiting');
    await step(5000,[a.call]);const b=await battleOf(a.call);expect(b.opponentKind).toBe('AI');expect(b.status).toBe('ACCEPTING');
    await acceptAll(a.call);const [f]=await playOut([a.call]);expect(f.status).toBe('FINISHED');expect(f.settlement.rating).toBeNull(); // AI 방은 점수 없음
  });
  it('거절하면 끝나고, 수락했던 사람은 같은 대기 순서로 다시 대기',async()=>{
    const a=await account([{speciesId:'u10',level:20}]),b=await account([{speciesId:'u11',level:20}]);
    for(const p of [a,b])await p.call('POST','/pvp/party',{ownedIds:p.units});
    const ja=await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await b.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});
    let x=await battleOf(a.call);await a.call('POST','/pvp/accept',{requestId:rid(),battleId:x.battleId,revision:x.revision,accept:true});
    x=await battleOf(b.call);const d=await b.call('POST','/pvp/accept',{requestId:rid(),battleId:x.battleId,revision:x.revision,accept:false});expect(d.settlement.reason).toBe('MATCH_DECLINED');
    const ca=await a.call('GET','/pvp/current');expect(ca.status).toBe('waiting');expect(ca.queuedAt).toBe(ja.queuedAt);
    expect((await b.call('GET','/pvp/current')).status).toBe('matched'); // 거절한 쪽은 결과 확인 전
    expect((await a.call('POST','/pvp/cancel',{requestId:rid()})).status).toBe('idle');
  });
  it('아이템을 골라 둔 채 상대가 항복하면 아이템을 돌려받음',async()=>{
    const a=await account([{speciesId:'u40',level:30}],{items:{potion:1}}),b=await account([{speciesId:'u41',level:30}]);
    for(const p of [a,b])await p.call('POST','/pvp/party',{ownedIds:p.units});
    await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await b.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await acceptAll(a.call,b.call);
    // 체력이 가득하면 회복약을 못 써서, 먼저 한 턴 서로 공격
    for(const p of [a,b]){const x=await battleOf(p.call);await p.call('POST','/pvp/action',{requestId:rid(),battleId:x.battleId,revision:x.revision,action:{kind:'attack'}});}
    const x=await battleOf(a.call);const r=await a.call('POST','/pvp/action',{requestId:rid(),battleId:x.battleId,revision:x.revision,action:{kind:'item',itemId:'potion'}});expect(r.submitted).toBe(true);
    expect((await db.playerItem.findUniqueOrThrow({where:{playerId_itemId:{playerId:a.id,itemId:'potion'}}})).count).toBe(0);
    const y=await battleOf(b.call);const s=await b.call('POST','/pvp/action',{requestId:rid(),battleId:y.battleId,revision:y.revision,action:{kind:'escape'}});expect(s.settlement.reason).toBe('SURRENDER');
    expect((await db.playerItem.findUniqueOrThrow({where:{playerId_itemId:{playerId:a.id,itemId:'potion'}}})).count).toBe(1);
    expect(s.settlement.xpAwarded).toBe(0);expect(s.settlement.commanderReward.reason).toBe('NORMAL_NON_COMPLETION_ZERO');
  });
  it('상대가 연결을 끊으면(90초) 서버가 증명한 이탈: 남은 쪽 승리 경험치·방범대장 150, 끊긴 쪽 0',async()=>{
    const a=await account([{speciesId:'u12',level:25}]),b=await account([{speciesId:'u13',level:25}]);
    for(const p of [a,b])await p.call('POST','/pvp/party',{ownedIds:p.units});
    await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await b.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await acceptAll(a.call,b.call);
    await step(50000,[a.call]);expect((await battleOf(a.call)).presence.status).toBe('RECONNECT_GRACE');
    await step(45000,[a.call]);const f=await battleOf(a.call);
    expect(f.settlement.reason).toBe('TIMEOUT');expect(f.state.outcome).toBe('win');expect(f.settlement.terminationKind).toBe('DISCONNECTED');
    expect(f.settlement.normalXp.status).toMatch(/DISCONNECT_WIN|CAP_CLAMPED/);expect(f.settlement.commanderReward).toMatchObject({xpAwarded:150,reason:'PROVEN_TIMEOUT_SURVIVOR'});
    const fb=await battleOf(b.call);expect(fb.settlement.xpAwarded).toBe(0);expect(fb.settlement.commanderReward.reason).toBe('TIMEOUT_NON_SURVIVOR_ZERO');expect(fb.settlement.lossFeedback.explanationKey).toBe('DISCONNECTED');
  });
  it('둘 다 접속은 하지만 아무것도 안 고르면 자동 행동(경험치 없음), 3번 놓치면 끝',async()=>{
    const a=await account([{speciesId:'u14',level:25}]),b=await account([{speciesId:'u15',level:25}]);
    for(const p of [a,b])await p.call('POST','/pvp/party',{ownedIds:p.units});
    await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await b.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});await acceptAll(a.call,b.call);
    await step(31000,[a.call,b.call]);const x=await battleOf(a.call);expect(x.state.turn).toBe(1);expect(x.state.rounds[0].events.length).toBeGreaterThan(0);
    await step(70000,[a.call,b.call]);const f=await battleOf(a.call);expect(['DOUBLE_TIMEOUT','BATTLE']).toContain(f.settlement.reason);expect(f.settlement.xpAwarded).toBe(0);
  });
});

describe('랭크전',()=>{
  it('방범대장 Lv60·대원 Lv60이 아니면 참가 불가',async()=>{
    const low=await account([{speciesId:'u60',level:60}],{commanderXp:100}),weak=await account([{speciesId:'u10',level:20}],{commanderXp:6000});
    expect((await low.call('POST','/pvp/party',{ownedIds:low.units,mode:'rank'})).__error).toBe('RANK_ACCOUNT_LEVEL_REQUIRED');
    expect((await weak.call('POST','/pvp/party',{ownedIds:weak.units,mode:'rank'})).__error).toBe('RANK_UNIT_LEVEL_REQUIRED');
    const o=await low.call('GET','/pvp/options');expect(o.rankEligibility).toMatchObject({eligible:false,reason:'RANK_ACCOUNT_LEVEL_REQUIRED',requiredAccountLevel:60});
  });
  it('사람끼리만, Lv30으로 맞춰 싸우고, 이기면 LP +20(같은 등급)·지면 0 아래로 안 내려감',async()=>{
    const a=await account([{speciesId:'u60',level:60},{speciesId:'u59',level:60}],{commanderXp:6000}),b=await account([{speciesId:'u58',level:60}],{commanderXp:6000});
    for(const p of [a,b])expect((await p.call('POST','/pvp/party',{ownedIds:p.units,mode:'rank'})).mode).toBe('rank');
    await a.call('POST','/pvp/join',{requestId:rid(),mode:'rank'});await step(35000,[a.call]);expect((await a.call('GET','/pvp/current')).status).toBe('waiting'); // 랭크는 AI 없음
    await b.call('POST','/pvp/join',{requestId:rid(),mode:'rank'});await acceptAll(a.call,b.call);
    const x=await battleOf(a.call);expect(x.state.self.level).toBe(30);expect(x.state.enemy.level).toBe(30);
    const [fa,fb]=await playOut([a.call,b.call]);
    const win=fa.state.outcome==='win'?fa:fb,lose=win===fa?fb:fa;
    expect(win.settlement.rating).toMatchObject({lpDelta:20,promotionChange:'NONE'});expect(lose.settlement.rating.after.lp).toBe(0);
    expect(win.settlement.xpAwarded).toBe(0);expect(win.settlement.commanderReward).toBeUndefined(); // 랭크는 경험치·방범대장 없음
    const r=await a.call('GET','/pvp/rank');expect(r.me.tierName).toBe('브론즈');expect(r.top.length).toBe(2);
  });
  it('대전 대기 중에는 환생 불가',async()=>{
    const a=await account([{speciesId:'u57',level:60},{speciesId:'u45',level:30}]);
    await a.call('POST','/pvp/party',{ownedIds:[a.units[1]]});await a.call('POST','/pvp/join',{requestId:rid(),mode:'normal'});
    const pv=await a.call('GET','/rebirth'),c=pv.candidates.find((x:any)=>x.ownedId===a.units[0]);
    expect((await a.call('POST','/rebirth/confirm',{requestId:rid(),ownedId:c.ownedId,catalogVersion:pv.catalogVersion,previewFingerprint:c.previewFingerprint})).__error).toBe('BATTLE_ACTIVE');
    await a.call('POST','/pvp/cancel',{requestId:rid()});
  });
});
