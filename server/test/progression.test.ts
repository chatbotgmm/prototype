// 7-1단계 서버 시험: 방범대장 지급(원본 실행 기록과 같은 순서·같은 결과), 의뢰 완료·독립 모험 귀환 지급, 환생 확정(원본 기록과 같은 결과).
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {awardCommanderXp} from '../src/progression-service.js';
import {loadContent} from '../src/content.js';
import {createTestDb,seedTestPlayer,root} from '../../tools/test-db.js';

const fx=JSON.parse(readFileSync(new URL('../../shared/test/fixtures/gmm110-progression.json',import.meta.url),'utf8'));
let app:FastifyInstance,close:()=>Promise<void>,db:Awaited<ReturnType<typeof createTestDb>>['db'];
const API='/proto/api/v1';let n=0;const rid=()=>'p7-'+(n++);
const json=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
beforeAll(async()=>{const t=await createTestDb();db=t.db;close=t.close;app=await buildApp(db,{root,secret:'z'.repeat(40)});});
afterAll(async()=>{await app?.close();await close?.();});
async function login(code:string){const r=await app.inject({method:'POST',url:API+'/auth/code',headers:{'x-gmm':'1','x-gmm-app':'1'},payload:{code}});const token=r.json().token;
  return async(method:'GET'|'POST',path:string,body?:unknown)=>{const x=await app.inject({method,url:API+path,headers:{'x-gmm':'1','x-gmm-s':token},...(body!==undefined?{payload:body as object}:{})});return {status:x.statusCode,body:x.json() as any};};}

describe('방범대장 지급이 GMM110과 같다',()=>{
  it(`원본과 같은 사건 ${fx.awards.length}개를 같은 순서로: 같은 결과(다시 보내기·충돌·정책 없음 포함)`,async()=>{
    const policy=loadContent(root).commander;
    const a=await db.player.create({data:{identity:'test:cmd-a',isTest:true}}),b=await db.player.create({data:{identity:'test:cmd-b',isTest:true}});
    for(const [i,c] of fx.awards.entries()){
      const r=await (async()=>{try{return {ok:json(await db.$transaction(tx=>awardCommanderXp(tx,c.noPolicy?b.id:a.id,c.e,c.noPolicy?null:policy)))};}catch(e:any){return {error:e.code??e.message};}})();
      expect(r,`${i}: ${JSON.stringify(c.e)}`).toEqual(c.r);
    }
    const acc=await db.commanderAccount.findUniqueOrThrow({where:{playerId:a.id}});
    expect(json({totalXp:acc.totalXp,revision:acc.revision,policyVersion:acc.policyVersion,policyFingerprint:acc.policyFingerprint})).toEqual({totalXp:fx.awardFinal.totalXp,revision:fx.awardFinal.revision,policyVersion:fx.awardFinal.policyVersion,policyFingerprint:fx.awardFinal.policyFingerprint});
  });
});

describe('환생 확정이 GMM110과 같다',()=>{
  for(const [i,rec] of fx.rebirth.entries())it(`계정 ${i+1}: 미리보기 → 확정 ${rec.steps.length}번(같은 개체·같은 값)`,async()=>{
    const p=await db.player.create({data:{identity:`test:rb${i}`,isTest:true,peanut:rec.peanut}});
    const ids=new Map<string,string>();
    for(const [k,u] of rec.units.entries()){const row=await db.owned.create({data:{playerId:p.id,speciesId:u.speciesId,totalXp:BigInt(u.totalXp),reincarnation:u.reincarnation,locked:u.locked,source:'rb'+k}});ids.set(u.id,row.id);}
    await db.loginCode.create({data:{code:String(700000+i),playerId:p.id,expiresAt:new Date(Date.now()+3600e3)}});
    const call=await login(String(700000+i)),back=new Map([...ids].map(([a,b])=>[b,a]));
    for(const [j,step] of rec.steps.entries()){
      const pv=(await call('GET','/rebirth')).body;
      // 원본 미리보기와 같은 후보·같은 판정(개체 id는 바꿔 비교, 지문은 id가 들어가서 다름)
      // 새 서버는 그림을 보이려고 오류 후보에도 speciesId를 붙임(원본 후보 계획에는 원래 있음)
      const norm=(c:any)=>({...c,ownedId:back.get(c.ownedId)??c.ownedId,previewFingerprint:undefined,...(c.preview===null?{speciesId:undefined}:{})});
      const mine=[...pv.candidates].map(norm).sort((x:any,y:any)=>x.ownedId<y.ownedId?-1:1),orig=[...step.preview.candidates].map((c:any)=>({...c,previewFingerprint:undefined})).sort((x:any,y:any)=>x.ownedId<y.ownedId?-1:1);
      expect(mine,`${j} 미리보기`).toEqual(orig);
      const target=pv.candidates.find((c:any)=>c.ownedId===ids.get(step.ownedId));
      const fp=step.fp==='0'.repeat(64)?step.fp:target.previewFingerprint??'0'.repeat(64);
      const r=await call('POST','/rebirth/confirm',{requestId:rid(),ownedId:ids.get(step.ownedId),catalogVersion:pv.catalogVersion,previewFingerprint:fp});
      expect(r.body.error??'ok',`${j} 확정`).toBe(step.r.error??'ok');
      if(step.r.ok)expect({...r.body,ownedId:back.get(r.body.ownedId),previewFingerprint:undefined}).toEqual({...step.r.ok,previewFingerprint:undefined});
      const after=await db.owned.findMany({where:{playerId:p.id}});
      for(const a of step.after){const row=after.find(x=>x.id===ids.get(a.id))!;expect([String(row.totalXp),row.reincarnation]).toEqual([String(a.totalXp),a.reincarnation]);}
      expect((await db.player.findUniqueOrThrow({where:{id:p.id}})).peanut).toBe(step.peanut);
    }
  });
});

describe('의뢰 완료·독립 모험 귀환에서 방범대장 경험치',()=>{
  it('첫 의뢰 완료 +250(보상 일정), 의뢰 모험 귀환 0, 재료 모험(독립)을 이기고 귀환 +150',async()=>{
    const s=await seedTestPlayer(db,{name:'대장',codes:['777777'],units:[{speciesId:'u60',level:60},{speciesId:'u45',level:30}]});
    const call=await login('777777');
    const ok=async(m:'GET'|'POST',path:string,body?:unknown)=>{const r=await call(m,path,body);if(r.status!==200)throw Error(path+JSON.stringify(r.body));return r.body;};
    const play=async(b:any)=>{for(let i=0;i<100&&b.status==='ACTIVE';i++){const me=b.state.self,sk=me.skills.filter((x:any)=>x.mpCost<=me.mp).sort((x:any,y:any)=>y.power-x.power)[0];
      b=await ok('POST',`/battle/${b.battleId}/action`,{requestId:rid(),revision:b.revision,action:sk?{kind:'skill',skillId:sk.id}:{kind:'attack'}});}return ok('POST',`/battle/${b.battleId}/settle`,{requestId:rid(),revision:b.revision});};
    expect((await ok('GET','/commander')).level).toBe(1);
    let st=await ok('GET','/story');
    st=await ok('POST','/story/open',{requestId:rid(),revision:st.revision,questId:'STORY_01',phase:'intro'});
    while(!st.scene.last)st=await ok('POST','/story/advance',{requestId:rid(),revision:st.revision,cursor:st.scene.cursor});
    st=await ok('POST','/story/accept',{requestId:rid(),revision:st.revision,questId:'STORY_01'});
    const b=await ok('POST','/story/battle',{requestId:rid(),questId:'STORY_01',ownedIds:[s.units[0].id]});await play(b);
    const run=await ok('GET',`/adventure/${b.adventureId}`),back=await ok('POST',`/adventure/${b.adventureId}/return`,{requestId:rid(),revision:run.revision});
    expect(back.settlement.commanderReward).toMatchObject({xpAwarded:0,reason:'QUEST_LINKED_ADVENTURE_ZERO'});
    st=await ok('POST','/story/open',{requestId:rid(),revision:(await ok('GET','/story')).revision,questId:'STORY_01',phase:'return'});
    while(st.scene&&!st.scene.last)st=await ok('POST','/story/advance',{requestId:rid(),revision:st.revision,cursor:st.scene.cursor});
    st=await ok('POST','/story/advance',{requestId:rid(),revision:st.revision,cursor:st.scene.cursor});
    expect(st.commanderReward).toMatchObject({status:'APPLIED',xpAwarded:250,reason:'QUEST_COMPLETED',rewardScheduleVersion:'commander-reward-uplift-20261030-v1'});
    expect(st.commander.totalXp).toBe('250');expect(st.commander.level).toBe(3);
    const m=await ok('POST','/story/material-battle',{requestId:rid(),encounterId:'STORY_01_01',ownedIds:[s.units[1].id]});await play(m);
    const mr=await ok('GET',`/adventure/${m.adventureId}`),mb=await ok('POST',`/adventure/${m.adventureId}/return`,{requestId:rid(),revision:mr.revision});
    expect(mb.settlement.commanderReward).toMatchObject({xpAwarded:150,reason:'INDEPENDENT_ADVENTURE_COMPLETED'});
    expect((await ok('GET','/me')).commander.totalXp).toBe('400');
  });
});
