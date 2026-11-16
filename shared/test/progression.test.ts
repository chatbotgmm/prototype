// 7-1단계(방범대장·환생) 규칙이 GMM110과 같은지: fixtures/gmm110-progression.json(원본 실행 기록)과 비교.
// 기준 결과 다시 만들기: tools/parity/generate-progression.ts 맨 위 설명. 지급(DB)·환생 확정은 server/test/progression.test.ts에서 같은 기록과 비교.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {validateCommanderPolicy,withRewardSchedule,commanderPolicyFingerprint,commanderLevelAt,commanderXpProgress,commanderEventReward,simulateCommanderBudget,rebirthPlan,type RebirthCharacter} from '../src/progression.js';
import {publicDefenseSafe} from '../src/intel.js';
import type {Catalog} from '../src/catalog.js';
import {RuleError} from '../src/errors.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-progression.json');
const catalog:Catalog=read('../../data/catalog.json');
const policy=withRewardSchedule(read('../../data/commander-policy.json'),read('../../data/commander-reward-schedule.json'));
const run=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:e instanceof RuleError?e.code:(e as Error).message};}};
const json=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));

describe('방범대장 계산이 GMM110과 같다',()=>{
  it('정책 파일 + 보상 일정을 합친 결과가 원본과 같음',()=>expect(json(policy)).toEqual(fx.policy));
  it('정책 검사(원본 그대로 + 틀린 12가지)',()=>{for(const c of fx.pure.validate)expect(run(()=>validateCommanderPolicy(c.input)&&true),c.name).toEqual(c.r);});
  it('정책 지문',()=>expect(commanderPolicyFingerprint(policy)).toBe(fx.pure.fingerprint));
  it('누적 경험치 → 레벨(경계·마지막 줄 너머·음수)',()=>{for(const c of fx.pure.levels)expect(json(run(()=>commanderLevelAt(BigInt(c.t),policy))),String(c.t)).toEqual(c.r);});
  it('진행 막대',()=>{for(const c of fx.pure.progress)expect(json(run(()=>commanderXpProgress(BigInt(c.a),BigInt(c.b),policy)))).toEqual(c.r);});
  it('사건별 지급량 300건',()=>{for(const c of fx.pure.events)expect(run(()=>commanderEventReward(c.e,policy)),JSON.stringify(c.e)).toEqual(c.r);});
  it('지금 콘텐츠의 경험치 예산',()=>expect(simulateCommanderBudget(policy)).toEqual(fx.pure.budget));
});

describe('환생 미리보기가 GMM110과 같다',()=>{
  // 원본 preview 응답의 후보 하나하나를, 그때의 개체 값·계정 성공 횟수로 다시 계산해 비교
  let n=0;
  for(const [i,rec] of fx.rebirth.entries())it(`계정 ${i+1}: 미리보기 ${rec.steps.length}번`,()=>{
    let units=rec.units.map((u:any)=>({...u})),successes=0;
    for(const step of rec.steps){
      for(const cand of step.preview.candidates){
        const u=units.find((x:any)=>x.id===cand.ownedId),d=catalog.characters.find(c=>c.id===u.speciesId) as unknown as RebirthCharacter;
        const cost=successes===0?0:1; // 원본 rebirthCost() 기본값 1(환경 변수 ROSTER60_REBIRTH_PEANUT_COST 없음)
        const mine=run(()=>rebirthPlan(catalog as any,{id:u.id,speciesId:u.speciesId,totalXp:BigInt(u.totalXp),reincarnation:u.reincarnation,skillInheritanceJson:null,status:'AVAILABLE',locked:u.locked},d,successes,cost,publicDefenseSafe)) as any;
        if(cand.preview===null)expect(mine.error,`${u.speciesId} 오류`).toBe(cand.reason);
        else expect(json(publicDefenseSafe(mine.ok))).toEqual(cand);
        n++;
      }
      if(step.r.ok){successes++;units=units.map((u:any)=>{const a=step.after.find((x:any)=>x.id===u.id);return {...u,totalXp:Number(a.totalXp),reincarnation:a.reincarnation};});}
    }
  });
  it('비교한 후보 수',()=>expect(n).toBeGreaterThan(100));
});
