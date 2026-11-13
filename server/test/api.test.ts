// 서버 통합 시험: 임시 DB에서 로그인 → 보유 → 편성 → 전투 끝까지 → 정산 → 두 번째 전투(관측 이어받기).
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createTestDb,seedTestPlayer,root} from '../../tools/test-db.js';

let app:FastifyInstance,close:()=>Promise<void>,db:Awaited<ReturnType<typeof createTestDb>>['db'];
let token='',unitIds:string[]=[];
const API='/proto/api/v1';
const call=async(method:'GET'|'POST',path:string,body?:unknown,headers:Record<string,string>={})=>{
  const r=await app.inject({method,url:API+path,headers:{'x-gmm':'1',...(token?{'x-gmm-s':token}:{}),...headers},...(body!==undefined?{payload:body as object}:{})});
  return {status:r.statusCode,body:r.json() as any,headers:r.headers};
};
beforeAll(async()=>{
  const t=await createTestDb();db=t.db;close=t.close;
  // u01 갈매미맨 Lv10, u09 노움 Lv12, u17 드워프 Lv60(상한)
  const s=await seedTestPlayer(db,{name:'시험대장',units:[{speciesId:'u01',level:10},{speciesId:'u09',level:12},{speciesId:'u17',level:60}],items:{potion:2,feather:1},codes:['111111','222222']});
  unitIds=s.units.map(u=>u.id);
  await db.player.create({data:{identity:'real:someone',isTest:false,loginCodes:{create:{code:'999999',expiresAt:new Date(Date.now()+3600000)}}}});
  app=await buildApp(db,{root,secret:'x'.repeat(40)});
});
afterAll(async()=>{await app?.close();await close?.();});

describe('계정',()=>{
  it('보호 머리글이 없으면 403, 로그인 전이면 401',async()=>{
    const r=await app.inject({method:'GET',url:API+'/me'});expect(r.statusCode).toBe(403);
    expect((await call('GET','/me')).status).toBe(401);
  });
  it('시험 계정이 아니면 코드가 있어도 로그인 안 됨',async()=>{
    expect((await call('POST','/auth/code',{code:'999999'})).body).toEqual({error:'LOGIN_CODE_INVALID'});
  });
  it('코드 로그인(한 번만 사용)',async()=>{
    const r=await call('POST','/auth/code',{code:'111111'},{'x-gmm-app':'1'});
    expect(r.status).toBe(200);token=r.body.token;expect(token).toBeTruthy();
    expect(String(r.headers['set-cookie'])).toContain('gmm_proto=');
    expect((await call('POST','/auth/code',{code:'111111'})).body.error).toBe('LOGIN_CODE_INVALID');
    const me=await call('GET','/me');expect(me.body.nickname).toBe('시험대장');expect(me.body.commander.level).toBeNull();expect(me.body.testBaseline).toBe(true);
  });
});

describe('보유·편성',()=>{
  it('보유 목록과 상세(내 방어 상성은 ownResistance로, defense 키는 없음)',async()=>{
    const list=await call('GET','/owned');expect(list.body.units.map((u:any)=>[u.speciesId,u.level])).toEqual([['u01',10],['u09',12],['u17',60]]);
    const d=await call('GET',`/owned/${unitIds[0]}`);
    expect(d.body.name).toBe('갈매미맨');expect(d.body.ownResistance.DARK).toBe('weak');expect('defense' in d.body).toBe(false);
    expect(d.body.skills.filter((s:any)=>s.unlocked).map((s:any)=>s.id)).toEqual(['normal_1','holy_1','normal_2']); // 해금 레벨 1·5·10
    expect(d.body.nextLearn).toEqual({level:24,skillId:'normal_3'});
  });
  it('편성은 1~3마리',async()=>{
    expect((await call('POST','/party',{ownedIds:[]})).body.error).toBe('INVALID_PARTY');
    expect((await call('POST','/party',{ownedIds:[unitIds[0],unitIds[0]]})).body.error).toBe('INVALID_PARTY');
    expect((await call('POST','/party',{ownedIds:unitIds})).body.ownedIds).toEqual(unitIds);
  });
});

async function playToEnd(battle:any,prefix:string){
  for(let t=0;t<120&&battle.status==='ACTIVE';t++){
    const self=battle.state.self,alive=battle.state.reserves.filter((f:any)=>f.hp>0);
    const affordable=[...self.skills].filter((s:any)=>s.mpCost<=self.mp).sort((a:any,b:any)=>b.power-a.power)[0];
    const action=self.hp<=0?{kind:'switch',targetOwnedId:alive[0].ownedId}:affordable?{kind:'skill',skillId:affordable.id}:{kind:'attack'};
    const r=await call('POST',`/battle/${battle.battleId}/action`,{requestId:`${prefix}-${t}`,revision:battle.revision,action});
    expect(r.status,JSON.stringify(r.body)).toBe(200);battle=r.body;
  }
  return battle;
}
describe('전투',()=>{
  let first:any;
  it('선택지: 편성 규칙과 조우',async()=>{
    const o=await call('GET','/battle/options');expect(o.body.partyPolicy.maxParty).toBe(3);expect(o.body.encounters.map((e:any)=>e.id)).toContain('training-10');
  });
  it('만들기: 같은 요청을 다시 보내면 같은 결과, 내용이 다르면 거절',async()=>{
    const body={requestId:'b1',ownedId:unitIds[0],encounterId:'training-10',reserveIds:[unitIds[1],unitIds[2]]};
    const a=await call('POST','/battle',body),b=await call('POST','/battle',body);
    expect(a.status).toBe(200);expect(b.body).toEqual(a.body);first=a.body;
    expect((await call('POST','/battle',{...body,encounterId:'training-1'})).body.error).toBe('REQUEST_ID_REUSED');
    expect((await call('POST','/battle',{...body,requestId:'b1x'})).body.error).toBe('UNIT_UNAVAILABLE'); // 이미 전투 중
  });
  it('응답에 씨앗·상대 방어 표가 없고, 상대 능력치는 첫 턴 전엔 비공개',async()=>{
    const text=JSON.stringify(first);expect(text).not.toContain('"seed"');expect(text).not.toContain('"defense":{');
    expect(first.state.opponentIntel.statsKnown).toBe(false);expect(Object.keys(first.state.enemy.stats)).toEqual(['hp','mp']);
    expect(first.state.decision.speeds).toBeUndefined();expect(first.state.self.ownResistance).toBeTruthy();
  });
  it('체력이 가득하면 치료약 거절, 낡은 revision 거절',async()=>{
    expect((await call('POST',`/battle/${first.battleId}/action`,{requestId:'p0',revision:first.revision,action:{kind:'item',itemId:'potion'}})).body.error).toBe('HP_FULL');
    expect((await call('POST',`/battle/${first.battleId}/action`,{requestId:'p1',revision:first.revision+5,action:{kind:'attack'}})).body.error).toBe('STALE_REVISION');
  });
  it('끝까지 진행 → 정산(처음 출전 개체만 경험치) → 두 번 정산 안 됨',async()=>{
    const end=await playToEnd(first,'t1');expect(end.status).toBe('FINISHED');expect(['win','loss','draw']).toContain(end.state.outcome);
    expect(end.state.opponentIntel.statsKnown).toBe(true);
    expect((await call('POST',`/battle/${end.battleId}/action`,{requestId:'late',revision:end.revision,action:{kind:'attack'}})).body.error).toBe('BATTLE_FINISHED');
    const before=await db.owned.findMany({where:{id:{in:unitIds}}});
    const s=await call('POST',`/battle/${end.battleId}/settle`,{requestId:'s1',revision:end.revision});
    expect(s.body.status).toBe('SETTLED');
    const after=await db.owned.findMany({where:{id:{in:unitIds}}});
    const gained=Object.fromEntries(after.map(u=>[u.id,Number(u.totalXp-before.find(b=>b.id===u.id)!.totalXp)]));
    expect(gained[unitIds[1]]).toBe(0);expect(gained[unitIds[2]]).toBe(0);
    expect(gained[unitIds[0]]).toBe(s.body.settlement.xpAwarded);
    if(end.state.outcome==='win')expect(gained[unitIds[0]]).toBeGreaterThan(0);
    expect(after.every(u=>u.status==='AVAILABLE')).toBe(true);
    const again=await call('POST',`/battle/${end.battleId}/settle`,{requestId:'s2',revision:s.body.revision});
    expect(again.body.settlement).toEqual(s.body.settlement);
    expect((await db.owned.findMany({where:{id:{in:unitIds}}})).map(u=>u.totalXp)).toEqual(after.map(u=>u.totalXp));
  });
  it('관측한 방어 상성은 저장되고, 같은 종을 다시 만나면 처음부터 보임',async()=>{
    expect((await db.observedDefense.findMany()).length).toBeGreaterThan(0);
    // 어느 종을 만날지는 씨앗에 달려 있어서, 후보 6종 모두에 관측 기록을 하나씩 넣어 두고 확인(열쇠는 실제 계산값)
    const {readFileSync}=await import('node:fs');const {defenseProfileKey}=await import('../../shared/src/index.js');
    const catalog=JSON.parse(readFileSync(`${root}/data/catalog.json`,'utf8')),policy=JSON.parse(readFileSync(`${root}/data/battle-policy.json`,'utf8'));
    const player=(await db.player.findFirstOrThrow({where:{identity:'test:시험대장'}})).id;
    for(const sp of policy.encounters.find((e:any)=>e.id==='training-10').enemySpeciesIds){
      const def=catalog.characters.find((c:any)=>c.id===sp);
      await db.observedDefense.upsert({where:{playerId_speciesId_profileKey_element:{playerId:player,speciesId:sp,profileKey:defenseProfileKey(sp,def.defense)!,element:'ICE'}},create:{playerId:player,speciesId:sp,profileKey:defenseProfileKey(sp,def.defense)!,element:'ICE',reaction:def.defense.ICE},update:{}});
    }
    const r=await call('POST','/battle',{requestId:'again',ownedId:unitIds[2],encounterId:'training-10'});
    const saved=await db.observedDefense.findMany({where:{speciesId:r.body.state.enemy.speciesId}});
    expect(saved.length).toBeGreaterThan(0);
    for(const o of saved)expect(r.body.state.opponentIntel.defenses[o.element]).toBe(o.reaction);
    expect(r.body.state.opponentIntel.defenseKnowledgeScope).toBe('base-observed');
    expect(r.body.state.opponentIntel.knownDefenseCount).toBe(saved.length);
    const end=await playToEnd(r.body,'again');await call('POST',`/battle/${end.battleId}/settle`,{requestId:'agains',revision:end.revision});
  });
  it('상한(레벨 60) 개체도 출전 가능, 경험치는 버려짐',async()=>{
    const u=await db.owned.findUniqueOrThrow({where:{id:unitIds[2]}});
    const r=await call('POST','/battle',{requestId:'cap',ownedId:unitIds[2],encounterId:'training-1'});
    const end=await playToEnd(r.body,'cap');const s=await call('POST',`/battle/${end.battleId}/settle`,{requestId:'caps',revision:end.revision});
    expect(s.body.settlement.xpAwarded).toBe(0);expect((await db.owned.findUniqueOrThrow({where:{id:unitIds[2]}})).totalXp).toBe(u.totalXp);
  });
});

describe('웹 화면 파일',()=>{
  it('첫 페이지·묶음·그림을 주고, 바깥 파일은 막음',async()=>{
    const page=await app.inject({url:'/proto/'});expect(page.statusCode).toBe(200);expect(page.body).toContain('<meta name="gmm-base" content="/proto">');
    expect((await app.inject({url:'/proto/assets/units/u01-front.webp'})).headers['content-type']).toBe('image/webp');
    expect((await app.inject({url:'/proto/assets/../data/catalog.json'})).statusCode).toBe(404);
    expect((await app.inject({url:'/proto/assets/%2e%2e/data/catalog.json'})).statusCode).toBe(404);
    expect((await app.inject({url:'/proto/style.css'})).statusCode).toBe(200);
  });
});
