// 5단계(획득) 규칙이 GMM110 원본과 같은지: fixtures/gmm110-acquisition.json(원본 실행 기록)과 비교.
// 기준 결과 다시 만들기: tools/parity/generate-acquisition.ts 맨 위 설명.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {recruitmentGrowth,halfRecruitCost,recruitWeightTickets,drawRecruitCandidate,validateRecruitPolicy,inheritancePreview,craftPlan,craftOptions,ownedDetail,type RecruitPolicy,type OwnedRow} from '../src/acquisition.js';
import type {Catalog} from '../src/catalog.js';
import {RuleError} from '../src/errors.js';

const read=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const fx=read('./fixtures/gmm110-acquisition.json');
const catalog:Catalog=read('../../data/catalog.json');
const policy:RecruitPolicy=read('../../data/recruit-policy.json');
const run=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:e instanceof RuleError?e.code:(e as Error).message};}};
const json=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
const row=(r:any):OwnedRow=>({...r,totalXp:BigInt(r.totalXp)});

describe('모집 규칙이 GMM110과 같다',()=>{
  it('지급 레벨(60종)',()=>{for(const c of fx.pure.grant)expect(json(run(()=>recruitmentGrowth(catalog.characters.find(u=>u.id===c.id)!))),c.id).toEqual(c.r);});
  it('새로고침 비용',()=>{for(const c of fx.pure.half)expect(run(()=>halfRecruitCost(c.c,c.r))).toEqual(c.res);});
  it('확률표',()=>{for(const c of fx.pure.tickets)expect(run(()=>recruitWeightTickets(c.w))).toEqual(c.r);});
  it('지금 정책은 유효',()=>expect(()=>validateRecruitPolicy(policy)).not.toThrow());
  for(const [n,rec] of fx.recruit.entries())it(`모집 ${n+1}: ${rec.kind} ${rec.times}명${rec.edges?' (등급 경계 굴림)':''} — 같은 굴림이면 같은 후보·같은 새로고침`,()=>{
    const queue=[...rec.rolls];const roll=(max:number)=>{const m=queue.shift(),v=queue.shift();expect(m,'굴림 범위').toBe(max);return v;};
    const offer=policy.offers.find(o=>o.kind===rec.kind)!,weights=recruitWeightTickets(offer.weights);
    const draws=Array.from({length:rec.times},()=>drawRecruitCandidate(catalog,weights,roll));
    expect(json(draws.map(d=>d.candidate))).toEqual(rec.candidates);
    expect(rec.credits).toBe((rec.start??500)-offer.cost*rec.times);
    for(const [i,step] of rec.steps.entries())if(step.act==='reroll'&&!step.error)expect(json(draws[i].pool[roll(draws[i].pool.length)])).toEqual(step.candidate);
    expect(queue.length,'남은 굴림 없음').toBe(0);
  });
});

describe('조합·계승·보유 상세가 GMM110과 같다',()=>{
  it('기술 계승 미리보기(고르기 전·후, 잘못 고른 경우 포함)',()=>{
    for(const c of fx.pure.inherit){
      expect(json(run(()=>inheritancePreview(catalog,c.resultId,c.resultLevel,c.mats))),`${c.resultId}`).toEqual(c.base);
      if(c.choice)expect(json(run(()=>inheritancePreview(catalog,c.resultId,c.resultLevel,c.mats,c.choice))),`${c.resultId} ${JSON.stringify(c.choice)}`).toEqual(c.chosen);
    }
  });
  for(const [n,rec] of fx.craft.entries())it(`조합 ${n+1}: ${rec.recipe} — 선택지·미리보기(지문 포함)·확정 결과·보유 상세`,()=>{
    const rows=rec.rows.map(row).sort((a:OwnedRow,b:OwnedRow)=>a.id<b.id?-1:a.id>b.id?1:0);
    const discovered=new Set<string>(rows.map((r:OwnedRow)=>r.speciesId));
    if(rec.optPublic){
      expect(json(craftOptions(catalog,rows,new Set(),false)),'공개 선택지').toEqual(rec.optPublic);
      expect(json(craftOptions(catalog,rows,discovered,true)),'발견 포함 선택지').toEqual(rec.optDiscovery);
    }
    const materials=rows.filter((r:OwnedRow)=>rec.materialIds.includes(r.id));
    const input={resultId:rec.recipe,materialIds:rec.materialIds,catalogVersion:catalog.version};
    const p0=run(()=>craftPlan(catalog,input,materials).view);
    expect(json(p0),'미리보기(계승 고르기 전)').toEqual(rec.preview0);
    if(rec.preview1){const p1=run(()=>craftPlan(catalog,{...input,inheritance:rec.preview1.inheritance},materials).view);
      const {inheritance,...want}=rec.preview1;expect(json(p1),'미리보기(계승 고름)').toEqual(want);}
    if(rec.confirmed?.ok){
      const plan=craftPlan(catalog,{...input,inheritance:rec.preview1.inheritance},materials);
      const {ownedId,...view}=rec.confirmed.ok;expect(json(plan.view),'확정 결과').toEqual(view);
      expect(JSON.stringify(plan.stored)).toBe(rec.detail.row.skillInheritanceJson);
      expect(json(ownedDetail(catalog,row(rec.detail.row),[])),'보유 상세').toEqual(rec.detail.unit);
    }
  });
});
