// 5단계 서버 시험: 빈 시험 계정으로 첫 갈매미 → 튜토리얼 전투 → 커먼 고르기 → 모집 → 조합 → 도감까지.
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {readFileSync} from 'node:fs';
import {buildApp} from '../src/app.js';
import {createTestDb,seedTestPlayer,root} from '../../tools/test-db.js';
import {instanceGrowthCurve} from '../../shared/src/index.js';

let app:FastifyInstance,close:()=>Promise<void>,db:Awaited<ReturnType<typeof createTestDb>>['db'];
let token='',playerId='';
const rolls:number[]=[];   // 모집 굴림을 시험이 정함(비어 있으면 0)
const API='/proto/api/v1';
const catalog=JSON.parse(readFileSync(`${root}/data/catalog.json`,'utf8'));
const call=async(method:'GET'|'POST',path:string,body?:unknown)=>{
  const r=await app.inject({method,url:API+path,headers:{'x-gmm':'1','x-gmm-s':token},...(body!==undefined?{payload:body as object}:{})});
  return {status:r.statusCode,body:r.json() as any};
};
const rid=()=>Math.random().toString(36).slice(2);
beforeAll(async()=>{
  const t=await createTestDb();db=t.db;close=t.close;
  const s=await seedTestPlayer(db,{name:'새내기',units:[],codes:['333333']});playerId=s.player.id;
  app=await buildApp(db,{root,secret:'y'.repeat(40),roll:max=>Math.min(max-1,rolls.shift()??0)});
  token=(await app.inject({method:'POST',url:API+'/auth/code',headers:{'x-gmm':'1','x-gmm-app':'1'},payload:{code:'333333'}})).json().token;
});
afterAll(async()=>{await app?.close();await close?.();});

async function playTutorial(ownedId:string){
  for(let attempt=0;attempt<8;attempt++){
    let b=(await call('POST','/battle',{requestId:rid(),ownedId,encounterId:'tutorial'})).body;
    for(let t=0;t<100&&b.status==='ACTIVE';t++){const me=b.state.self,sk=me.skills.filter((s:any)=>s.mpCost<=me.mp).sort((x:any,y:any)=>y.power-x.power)[0];
      b=(await call('POST',`/battle/${b.battleId}/action`,{requestId:rid(),revision:b.revision,action:sk?{kind:'skill',skillId:sk.id}:{kind:'attack'}})).body;}
    const s=(await call('POST',`/battle/${b.battleId}/settle`,{requestId:rid(),revision:b.revision})).body;
    if(s.state.outcome==='win')return s;
  }
  throw Error('튜토리얼을 8번 안에 못 이김');
}
describe('첫 갈매미',()=>{
  let ticketId='';
  it('시작 전엔 started=false, 시작하면 갈매미맨 한 마리(두 번 불러도 한 마리)',async()=>{
    expect((await call('GET','/onboarding')).body.started).toBe(false);
    const a=await call('POST','/onboarding/start'),b=await call('POST','/onboarding/start');
    expect(a.body.starter.speciesId).toBe('u01');expect(b.body.starter.id).toBe(a.body.starter.id);
    expect((await call('GET','/owned')).body.units.map((u:any)=>u.speciesId)).toEqual(['u01']);
  });
  it('튜토리얼을 이기기 전엔 완료 안 됨 → 이기고 정산하면 선택지급권',async()=>{
    expect((await call('POST','/onboarding/complete')).body.error).toBe('TUTORIAL_NOT_VERIFIED');
    const starter=(await call('GET','/onboarding')).body.starter.id;
    await playTutorial(starter);
    expect((await call('GET','/onboarding')).body.tutorialVerified).toBe(true);
    const done=await call('POST','/onboarding/complete');expect(done.body.ticket.status).toBe('unused');ticketId=done.body.ticket.ticketId;
  });
  it('커먼 7종에서 고르기(한 번만, 다른 종으로 다시 고르면 거절)',async()=>{
    const p=await call('POST','/onboarding/preview',{ticketId});
    expect(p.body.characters.map((c:any)=>c.id)).toEqual(['u02','u03','u04','u05','u06','u07','u08']);
    expect(JSON.stringify(p.body.characters)).not.toContain('"defense":{');
    expect((await call('POST','/onboarding/confirm',{ticketId,characterId:'u01',catalogVersion:catalog.version})).body.error).toBe('INVALID_CHOICE');
    const c=await call('POST','/onboarding/confirm',{ticketId,characterId:'u03',catalogVersion:catalog.version});expect(c.body.ticket.characterId).toBe('u03');
    expect((await call('POST','/onboarding/confirm',{ticketId,characterId:'u03',catalogVersion:catalog.version})).status).toBe(200);
    expect((await call('POST','/onboarding/confirm',{ticketId,characterId:'u04',catalogVersion:catalog.version})).body.error).toBe('ALREADY_REDEEMED');
    expect((await call('GET','/owned')).body.units.map((u:any)=>u.speciesId).sort()).toEqual(['u01','u03']);
  });
});

describe('모집',()=>{
  it('하급 3장: 지원서 2장씩 → 새로고침(반값 1장) → 합격 → 전부 합격',async()=>{
    const before=(await call('GET','/recruit')).body.credits;
    // 굴림: [등급, 후보] × 3 = 커먼 u02, 언커먼(7000) u10, 레어(9800) u18
    rolls.push(0,1, 7000,1, 9800,1);
    const st=await call('POST','/recruit/start',{requestId:rid(),kind:'LOW',catalogVersion:catalog.version,times:3});
    expect(st.body.sessions.map((s:any)=>[s.candidate.speciesId,s.candidate.level])).toEqual([['u02',1],['u10',1],['u18',10]]); // 레어는 10레벨로 들어옴
    expect(st.body.credits).toBe(before-6);
    expect((await call('POST','/recruit/start',{requestId:rid(),kind:'LOW',catalogVersion:catalog.version})).body.error).toBe('RECRUIT_SESSION_PENDING');
    const [s1,s2,s3]=st.body.sessions;
    rolls.push(2); // 새로고침: 같은 등급(커먼) 목록의 3번째 = u03
    const rr=await call('POST','/recruit/action',{requestId:rid(),sessionId:s1.sessionId,revision:s1.revision,action:'reroll'});
    expect(rr.body.candidate.speciesId).toBe('u03');expect(rr.body.credits).toBe(before-7);
    expect((await call('POST','/recruit/action',{requestId:rid(),sessionId:s1.sessionId,revision:rr.body.revision,action:'reroll'})).body.error).toBe('RECRUIT_REROLL_USED');
    const cl=await call('POST','/recruit/action',{requestId:rid(),sessionId:s2.sessionId,revision:s2.revision,action:'claim'});expect(cl.body.status).toBe('CLAIMED');
    const all=await call('POST','/recruit/claim-all',{requestId:rid(),sessions:[{sessionId:s1.sessionId,revision:rr.body.revision},{sessionId:s3.sessionId,revision:s3.revision}]});
    expect(all.body.receipt.grantedOwnedIds).toHaveLength(2);expect(all.body.pendingSessions).toEqual([]);
    expect((await call('GET','/owned')).body.units.map((u:any)=>u.speciesId).sort()).toEqual(['u01','u03','u03','u10','u18']);
  });
  it('이미 가진 종은 불합격하면 1장 환급, 없는 종은 불합격 불가',async()=>{
    const before=(await call('GET','/recruit')).body.credits;
    rolls.push(0,0, 0,5); // u01(가진 종), u06(없는 종)
    const st=await call('POST','/recruit/start',{requestId:rid(),kind:'LOW',catalogVersion:catalog.version,times:2});
    const [a,b]=st.body.sessions;expect(a.canReject).toBe(true);expect(b.canReject).toBe(false);expect(b.rejectReason).toBe('NOT_OWNED_SPECIES');
    const rj=await call('POST','/recruit/action',{requestId:rid(),sessionId:a.sessionId,revision:a.revision,action:'reject'});
    expect(rj.body.status).toBe('REJECTED');expect(rj.body.credits).toBe(before-4+1);
    expect((await call('POST','/recruit/action',{requestId:rid(),sessionId:b.sessionId,revision:b.revision,action:'reject'})).body.error).toBe('RECRUIT_NOT_OWNED_SPECIES');
    await call('POST','/recruit/action',{requestId:rid(),sessionId:b.sessionId,revision:b.revision,action:'claim'});
  });
  it('지원서가 모자라면 거절',async()=>{
    await db.player.update({where:{id:playerId},data:{credits:1}});
    expect((await call('POST','/recruit/start',{requestId:rid(),kind:'LOW',catalogVersion:catalog.version})).body.error).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('조합',()=>{
  let a='',b='';
  beforeAll(async()=>{
    const xp=instanceGrowthCurve(catalog.characters.find((c:any)=>c.id==='u02').growth)[4].totalXp; // u02 Lv5 두 마리 → u09 조합식
    a=(await db.owned.create({data:{playerId,speciesId:'u02',totalXp:BigInt(xp),source:'t-a'}})).id;
    b=(await db.owned.create({data:{playerId,speciesId:'u02',totalXp:BigInt(xp),source:'t-b'}})).id;
    await call('POST','/party',{ownedIds:[a]});
  });
  it('선택지에 조합 가능으로 나오고, 계승을 고르기 전엔 확정 불가',async()=>{
    const o=await call('GET','/craft/options');const r=o.body.recipes.find((x:any)=>x.resultId==='u09');expect(r.craftable).toBe(true);
    const p=await call('POST','/craft/preview',{resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version});
    expect(p.body.inheritance.status).toBe('selection-required');expect(p.body.expectedLevel).toBe(5);
    expect((await call('POST','/craft/confirm',{resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version,requestId:rid(),previewFingerprint:p.body.previewFingerprint})).body.error).toBe('INHERITANCE_SELECTION_REQUIRED');
  });
  it('계승을 고르고 확정 → 재료는 사라지고 결과에 계승 기록, 편성에서도 빠짐, 같은 요청은 한 번만',async()=>{
    const p0=(await call('POST','/craft/preview',{resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version})).body;
    const cand=p0.inheritance.candidates[0],inheritance={skillId:cand.skillId,replaceSlot:cand.allowedReplaceSlots[0]};
    const p=(await call('POST','/craft/preview',{resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version,inheritance})).body;
    expect((await call('POST','/craft/confirm',{resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version,inheritance,requestId:rid(),previewFingerprint:'0'.repeat(64)})).body.error).toBe('PREVIEW_CHANGED');
    const req={resultId:'u09',materialIds:[a,b],catalogVersion:catalog.version,inheritance,requestId:'craft-1',previewFingerprint:p.previewFingerprint};
    const c1=await call('POST','/craft/confirm',req),c2=await call('POST','/craft/confirm',req);
    expect(c1.body.ownedId).toBeTruthy();expect(c2.body).toEqual(c1.body);
    expect((await db.owned.findMany({where:{id:{in:[a,b]}}})).map(m=>m.status)).toEqual(['CONSUMED','CONSUMED']);
    const d=(await call('GET',`/owned/${c1.body.ownedId}`)).body.unit;expect(d.speciesId).toBe('u09');expect(d.skills.inheritance.skillId).toBe(cand.skillId);
    expect((await call('GET','/party')).body.ownedIds).toEqual([]);
    expect((await call('GET','/owned')).body.units.some((u:any)=>u.ownedId===a)).toBe(false);
  });
});

describe('도감',()=>{
  it('60종, 보유 수, 발견(가진 종·만난 상대)',async()=>{
    const c=(await call('GET','/collection')).body;expect(c.characters).toHaveLength(60);
    const by=(id:string)=>c.characters.find((x:any)=>x.id===id);
    expect(by('u03').ownedCount).toBe(2);expect(by('u02').ownedCount).toBe(0);expect(by('u02').discovered).toBe(true); // 튜토리얼 상대·재료로 썼던 종
    expect(by('u60').discovered).toBe(false);expect(JSON.stringify(c)).not.toContain('"defense":{');
  });
});
