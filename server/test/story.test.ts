// 6단계 서버 통합 시험: 임시 DB에서 스토리 장면 → 수락 → 흑화 모험 출항 → 전투 끝까지 → 정산(흑화 재료) → 귀환 → 귀환 장면 → 완료,
// 일반 모험(출발·여러 전투·귀환), 같은 요청 재전송, 낡은 revision 거절, 악당 전투.
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createTestDb,seedTestPlayer,root} from '../../tools/test-db.js';

let app:FastifyInstance,close:()=>Promise<void>,db:Awaited<ReturnType<typeof createTestDb>>['db'];
let token='',units:string[]=[],n=0;
const API='/proto/api/v1';
const rid=()=>'req-'+(n++);
const call=async(method:'GET'|'POST',path:string,body?:unknown)=>{
  const r=await app.inject({method,url:API+path,headers:{'x-gmm':'1','x-gmm-s':token},...(body!==undefined?{payload:body as object}:{})});
  return {status:r.statusCode,body:r.json() as any};
};
const ok=async(method:'GET'|'POST',path:string,body?:unknown)=>{const r=await call(method,path,body);if(r.status!==200)throw Error(`${path}: ${JSON.stringify(r.body)}`);return r.body;};
/** 전투를 끝까지(가장 센 쓸 수 있는 기술, 쓰러지면 교체) */
async function play(battle:any){
  let b=battle;
  for(let i=0;i<120&&b.status==='ACTIVE';i++){
    const me=b.state.self,alive=b.state.reserves.filter((f:any)=>f.hp>0);
    const usable=me.skills.filter((s:any)=>s.mpCost<=me.mp).sort((x:any,y:any)=>y.power-x.power);
    const action=me.hp<=0?{kind:'switch',targetOwnedId:alive[0].ownedId}:usable.length?{kind:'skill',skillId:usable[0].id}:{kind:'attack'};
    b=await ok('POST',`/battle/${b.battleId}/action`,{requestId:rid(),revision:b.revision,action});
  }
  expect(b.status).toBe('FINISHED');
  return ok('POST',`/battle/${b.battleId}/settle`,{requestId:rid(),revision:b.revision});
}
/** 장면을 끝까지 넘기기. 시작 장면이면 마지막에 수락. */
async function readScene(s:any,questId:string,phase:'intro'|'return'|'replay'){
  s=await ok('POST','/story/open',{requestId:rid(),revision:s.revision,questId,phase});
  while(s.scene){
    if(s.scene.last&&phase==='intro')return ok('POST','/story/accept',{requestId:rid(),revision:s.revision,questId});
    s=await ok('POST','/story/advance',{requestId:rid(),revision:s.revision,cursor:s.scene.cursor});
  }
  return s;
}

beforeAll(async()=>{
  const t=await createTestDb();db=t.db;close=t.close;
  const s=await seedTestPlayer(db,{name:'모험가',units:[{speciesId:'u60',level:60},{speciesId:'u59',level:60},{speciesId:'u20',level:20},{speciesId:'u02',level:1}],items:{potion:3},codes:['333333']});
  units=s.units.map(u=>u.id);
  app=await buildApp(db,{root,secret:'y'.repeat(40)});
  const r=await app.inject({method:'POST',url:API+'/auth/code',headers:{'x-gmm':'1','x-gmm-app':'1'},payload:{code:'333333'}});token=r.json().token; // 앱 방식: 머리글 토큰
});
afterAll(async()=>{await app?.close();await close?.();});

describe('스토리: 첫 의뢰 끝까지',()=>{
  it('처음 상태: 첫 의뢰만 열림, 석상 1단계, 시험값 표시',async()=>{
    const s=await ok('GET','/story');
    expect(s.testValues).toBe(true);expect(s.statue.stage).toBe(1);expect(s.currentQuest.id).toBe('STORY_01');
    expect(s.quests.map((q:any)=>[q.id,q.status])).toEqual([['STORY_01','AVAILABLE']]);
    expect(s.residents.map((r:any)=>r.status)).toEqual(['LOCKED','LOCKED','LOCKED','LOCKED']);
    expect(s.pendingDeparture).toBeNull();
  });
  it('장면: 낡은 revision·잠긴 의뢰·마지막 줄 전 수락은 거절, 닫으면 위치 저장',async()=>{
    let s=await ok('GET','/story');
    expect((await call('POST','/story/open',{requestId:rid(),revision:s.revision+3,questId:'STORY_01',phase:'intro'})).body.error).toBe('STORY_STALE_REVISION');
    expect((await call('POST','/story/open',{requestId:rid(),revision:s.revision,questId:'STORY_02',phase:'intro'})).body.error).toBe('STORY_SCENE_LOCKED');
    s=await ok('POST','/story/open',{requestId:rid(),revision:s.revision,questId:'STORY_01',phase:'intro'});
    expect(s.scene.cursor).toBe(0);expect(s.scene.line.speakerName).toBe('');expect(s.scene.background).toBe('village_statue');
    expect((await call('POST','/story/accept',{requestId:rid(),revision:s.revision,questId:'STORY_01'})).body.error).toBe('STORY_ACCEPT_NOT_READY');
    const id=rid();s=await ok('POST','/story/advance',{requestId:id,revision:s.revision,cursor:0});expect(s.scene.cursor).toBe(1);expect(s.scene.line.speakerName).toBe('주인공');
    // 같은 요청 다시 보내면 처음 결과(두 번 넘어가지 않음)
    const again=await ok('POST','/story/advance',{requestId:id,revision:s.revision-1,cursor:0});expect(again.scene.cursor).toBe(1);
    s=await ok('POST','/story/close',{requestId:rid(),revision:s.revision});expect(s.scene).toBeNull();
    s=await ok('POST','/story/open',{requestId:rid(),revision:s.revision,questId:'STORY_01',phase:'intro'});expect(s.scene.cursor).toBe(1);
    await ok('POST','/story/close',{requestId:rid(),revision:s.revision});
  });
  it('수락 → 흑화 모험 출항 → 이김 → 흑화 재료 1 → 귀환 전에는 아직 진행 중 → 귀환하면 귀환 장면 → 완료',async()=>{
    let s=await readScene(await ok('GET','/story'),'STORY_01','intro');
    expect(s.quests[0]).toMatchObject({id:'STORY_01',status:'ACTIVE',canDepart:true,objective:{wins:0,requiredWins:1}});
    expect((await call('POST','/story/battle',{requestId:rid(),questId:'STORY_01',ownedIds:[]})).status).toBe(400);
    const battle=await ok('POST','/story/battle',{requestId:rid(),questId:'STORY_01',ownedIds:[units[0],units[1]]});
    expect(battle.state.mode).toBe('adventure');expect(battle.adventureId).toBeTruthy();expect(battle.story).toEqual({questId:'STORY_01',encounterId:'STORY_01_01',kind:'black'});
    expect(battle.state.enemy.name).toBe('흑화 갈매미맨');expect(battle.state.enemy.artVariant).toBe('black');
    // 전투 중: 같은 의뢰로 또 출항 불가, 모험 귀환 불가
    expect((await call('POST','/story/battle',{requestId:rid(),questId:'STORY_01',ownedIds:[units[2]]})).body.error).toBe('STORY_BATTLE_ACTIVE');
    const adv=await ok('GET',`/adventure/${battle.adventureId}`);
    expect((await call('POST',`/adventure/${battle.adventureId}/return`,{requestId:rid(),revision:adv.revision})).body.error).toBe('RETURN_ONLY_OUTSIDE_BATTLE');
    s=await ok('GET','/story');expect(s.quests[0].battleId).toBe(battle.battleId);expect(s.quests[0].canDepart).toBe(false);
    const done=await play(battle);
    expect(done.settlement.outcome).toBe('win');expect(done.settlement.story).toEqual({darkGangAwarded:1,questId:'STORY_01',objectiveProgressed:true});
    expect(done.settlement.adventureStatus).toBe('ACTIVE');expect(done.settlement.unitXp.delivery).toBe('pending-return');
    expect((await ok('GET','/story/materials')).balance).toBe(1);
    // 귀환 전: 이긴 수는 채웠지만 모험이 끝나지 않아 진행 중(원본 status)
    s=await ok('GET','/story');expect(s.quests[0]).toMatchObject({status:'ACTIVE',canDepart:false,objective:{wins:1}});
    expect((await call('POST','/story/battle',{requestId:rid(),questId:'STORY_01',ownedIds:[units[0],units[1]]})).body.error).toBe('STORY_OBJECTIVE_AWAITING_RETURN');
    const owned=await db.owned.findMany({where:{id:{in:[units[0],units[1]]}}});expect(owned.every(o=>o.status==='ADVENTURE')).toBe(true);
    const run=await ok('GET',`/adventure/${battle.adventureId}`);expect(run.kind).toBe('quest');expect(run.questId).toBe('STORY_01');
    const back=await ok('POST',`/adventure/${battle.adventureId}/return`,{requestId:rid(),revision:run.revision});
    expect(back.status).toBe('RETURNED');expect(back.settlement.kind).toBe('normal-return');expect(back.settlement.winsThisRun).toBe(1);
    const after=await db.owned.findMany({where:{id:{in:[units[0],units[1]]}}});expect(after.every(o=>o.status==='AVAILABLE')).toBe(true);
    s=await ok('GET','/story');expect(s.quests[0].status).toBe('READY');
    s=await readScene(s,'STORY_01','return');
    expect(s.quests.map((q:any)=>[q.id,q.status])).toEqual([['STORY_01','COMPLETED'],['STORY_02','AVAILABLE']]);
    expect(s.statue.fragments).toBe(1);expect(s.history).toEqual([{questId:'STORY_01',title:'우리는 무엇을 지키고 있나'}]);
    expect(s.adventures).toEqual([{id:'STORY_01_01',name:'흑화 갈매미 모험',level:1}]);
    // 다시 보기(시작+귀환 장면 이어서)
    s=await ok('POST','/story/open',{requestId:rid(),revision:s.revision,questId:'STORY_01',phase:'replay'});expect(s.scene.id).toBe('replay:STORY_01');
    await ok('POST','/story/close',{requestId:rid(),revision:s.revision});
  });
  it('흑화 재료 모험: 같은 모험으로 두 번 싸우고(체력 이어 받음) 귀환',async()=>{
    const b1=await ok('POST','/story/material-battle',{requestId:rid(),encounterId:'STORY_01_01',ownedIds:[units[2]]});
    const r1=await play(b1);expect(r1.settlement.story.darkGangAwarded).toBe(1);expect(r1.settlement.story.questId).toBeNull();
    let s=await ok('GET','/story');expect(s.materialAdventure.adventureId).toBe(b1.adventureId);expect(s.materialAdventure.activeBattleId).toBeNull();
    const run=await ok('GET',`/adventure/${b1.adventureId}`);expect(run.kind).toBe('material');
    const b2=await ok('POST','/story/material-battle',{requestId:rid(),encounterId:'STORY_01_01',ownedIds:[units[2]],adventureId:b1.adventureId});
    expect(b2.adventureId).toBe(b1.adventureId);expect(b2.state.self.hp).toBe(run.party[0].hp);
    await play(b2);
    const before=await ok('GET',`/adventure/${b1.adventureId}`);
    const back=await ok('POST',`/adventure/${b1.adventureId}/return`,{requestId:rid(),revision:before.revision});
    expect(back.settlement.rewards.xp).toEqual(before.pendingRewards.xp);
    expect((await ok('GET','/story/materials')).lifetimeEarned).toBe(3);
    s=await ok('GET','/story');expect(s.materialAdventure).toBeNull();
  });
  it('잠긴 재료 모험 조우·없는 의뢰는 거절',async()=>{
    expect((await call('POST','/story/material-battle',{requestId:rid(),encounterId:'STORY_02_01',ownedIds:[units[2]]})).body.error).toBe('STORY_ENCOUNTER_LOCKED');
    expect((await call('POST','/story/battle',{requestId:rid(),questId:'NOPE',ownedIds:[units[2]]})).body.error).toBe('STORY_QUEST_NOT_FOUND');
  });
});

describe('악당 전투(스토리 모드, 모험 아님)',()=>{
  it('STORY_08 묵인: 전용 공격·체력 1.2배, 흑화 재료 없음, 경험치는 바로 지급',async()=>{
    // 앞 의뢰를 마친 상태로 맞춤(진행 저장값은 서버 것만 씀: 시험에서 DB에 직접 넣음)
    const a=await db.storyAccount.findUniqueOrThrow({where:{playerId:(await db.owned.findUniqueOrThrow({where:{id:units[0]}})).playerId}});
    const p=JSON.parse(a.state);p.completed=['STORY_01','STORY_02','STORY_03','STORY_04','STORY_05','STORY_06','STORY_07'];
    await db.storyAccount.update({where:{playerId:a.playerId},data:{state:JSON.stringify(p),darkGangLifetime:10,darkGangBalance:10}});
    const s=await readScene(await ok('GET','/story'),'STORY_08','intro');
    expect(s.quests.find((q:any)=>q.id==='STORY_08').status).toBe('ACTIVE');
    const b=await ok('POST','/story/battle',{requestId:rid(),questId:'STORY_08',ownedIds:[units[0]]});
    expect(b.state.mode).toBe('story');expect(b.adventureId).toBeNull();expect(b.state.enemy.speciesId).toBe('story_record');expect(b.state.enemy.name).toBe('묵인');
    const done=await play(b);
    expect(done.settlement.story).toEqual({darkGangAwarded:0,questId:'STORY_08',objectiveProgressed:true});
    expect(done.settlement.unitXp.delivery).toBe('immediate');
    expect((await ok('GET','/story')).quests.find((q:any)=>q.id==='STORY_08').status).toBe('READY');
  });
});

describe('일반 모험(탐험)',()=>{
  it('출발 → 전투 → 귀환: 경험치는 귀환 때 지급, 같은 귀환 요청은 한 번만',async()=>{
    const start=await ok('POST','/adventure/start',{requestId:rid(),ownedIds:[units[3],units[2]]});
    expect(start.status).toBe('ACTIVE');expect(start.kind).toBe('free');expect(start.party.map((f:any)=>f.ownedId)).toEqual([units[3],units[2]]);
    expect((await call('POST','/adventure/start',{requestId:rid(),ownedIds:[units[3]]})).body.error).toBe('UNIT_UNAVAILABLE');
    expect((await call('POST','/battle',{requestId:rid(),ownedId:units[3],encounterId:'adventure-1'})).body.error).toBe('ADVENTURE_REQUIRED');
    expect((await call('POST','/battle',{requestId:rid(),ownedId:units[3],encounterId:'adventure-1',adventureId:start.adventureId})).body.error).toBe('INVALID_PARTY');
    const b=await ok('POST','/battle',{requestId:rid(),ownedId:units[2],reserveIds:[units[3]],encounterId:'adventure-1',adventureId:start.adventureId});
    const done=await play(b);expect(done.settlement.outcome).toBe('win');
    const run=await ok('GET',`/adventure/${start.adventureId}`);
    expect(run.pendingRewards.xp[units[2]]).toBeGreaterThan(0);
    const xp0=(await db.owned.findUniqueOrThrow({where:{id:units[2]}})).totalXp;
    const body={requestId:rid(),revision:run.revision};
    const back=await ok('POST',`/adventure/${start.adventureId}/return`,body);
    expect(back.status).toBe('RETURNED');
    const again=await ok('POST',`/adventure/${start.adventureId}/return`,body);expect(again).toEqual(back);
    const xp1=(await db.owned.findUniqueOrThrow({where:{id:units[2]}})).totalXp;
    expect(xp1-xp0).toBe(BigInt(run.pendingRewards.xp[units[2]]));
    expect((await ok('GET','/adventure/active')).adventures).toEqual([]);
  });
});
