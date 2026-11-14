// 동료 모집(방범대 지원소). 원본: roster60-recruit-session.ts + RECRUIT-CANDIDATE-DECISIONS-20261028.md
//  - 하급·중급·고급(후보당 지원서 2·6·10장), 후보마다 새로고침 한 번(반값), 합격, 불합격(이미 가진 종이면 1장 환급), 전부 합격
//  - 처리하지 않은 후보가 있으면 새 모집 불가(원본 RECRUIT_SESSION_PENDING)
import {h,button,unitArt} from '../core/dom.js';
import {api,message,type RecruitSession} from '../core/api.js';
import {go,toast,type Scene} from '../core/scenes.js';
import {gradeName} from '../core/labels.js';

const TIMES=[1,5,10];
export const recruit=():Scene=>({
  async mount(root){
    let info=await api.recruit(),times=1,busy=false,focus=0;
    const scene=h('div',{class:'recruit-scene'});root.append(scene);
    const run=async(f:()=>Promise<unknown>)=>{if(busy)return;busy=true;render();try{await f();}catch(e){toast(message(e));}info={...info,...await api.recruit()};busy=false;render();};
    const odds=(w:Record<string,number>)=>Object.entries(w).map(([g,p])=>`${gradeName[g]} ${p}%`).join(' · ');
    const card=(s:RecruitSession,i:number)=>h('div',{class:`cand-card panel ${i===focus?'focus':''}`,onclick:()=>{focus=i;render();}},
      h('span',{class:`grade grade-${s.candidate.rarity}`},gradeName[s.candidate.rarity]),
      h('img',{src:unitArt(s.candidate.speciesId,'front'),alt:''}),
      h('b',{},s.candidate.name),h('small',{},`Lv${s.candidate.level}${s.ownedSpecies?' · 가진 종':''}`),
      h('div',{class:'cand-actions'},
        button(['↻',h('small',{},`${s.rerollCost}장`)],()=>void run(()=>api.recruitAction(s,'reroll')),{cls:'cand-reroll',disabled:busy||s.rerolls>0,title:s.rerolls>0?'새로고침은 한 번만':`새로고침 ${s.rerollCost}장`}),
        button('합격',()=>void run(()=>api.recruitAction(s,'claim')),{kind:'primary',disabled:busy}),
        s.canReject?button('불합격 · 1장 환급',()=>void run(()=>api.recruitAction(s,'reject')),{disabled:busy,cls:'cand-reject'}):h('span',{class:'cand-reject cand-spacer','aria-hidden':'true'})));
    const render=()=>{
      const pending=info.pendingSessions;focus=Math.min(focus,Math.max(0,pending.length-1));
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'동료 모집'),h('span',{class:'top-note credits'},`지원서 ${info.credits}장`)),
        pending.length?h('div',{class:'recruit-body'},
            h('div',{class:'cand-row'},...pending.map(card)),
            h('div',{class:'recruit-foot'},h('span',{class:'muted'},`후보 ${pending.length}명 · 처리해야 새로 모집할 수 있어요`),button('전부 합격',()=>void run(()=>api.recruitClaimAll(pending)),{kind:'primary',disabled:busy})))
          :h('div',{class:'recruit-body'},
            h('div',{class:'times'},h('span',{class:'muted'},'한 번에'),...TIMES.map(n=>button(`${n}명`,()=>{times=n;render();},{cls:times===n?'on':'',disabled:busy}))),
            h('div',{class:'offer-grid'},...info.offers.map(o=>h('div',{class:'offer panel'},
              h('h2',{},`${o.label} 모집`),h('p',{class:'muted small'},odds(o.weights)),
              h('p',{class:'small'},`후보당 ${o.cost}장 · 새로고침 ${o.rerollCost}장`),
              button(`${times}명 모집 · ${o.cost*times}장`,()=>void run(()=>api.recruitStart(o.kind,times,info.catalogVersion)),{kind:'primary',disabled:busy||info.credits<o.cost*times})))),
            h('p',{class:'muted small center'},'등급 안에서는 같은 확률, 천장 없음. 들어올 때 레벨: 커먼·언커먼 1, 레어 10, 에픽 15, 전설·히든 20 (원본 정책)')));
    };
    render();
  },
});
