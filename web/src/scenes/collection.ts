// 도감(기록소). 원본 roster60-library.ts collection: 60종 전체, 보유 수, 공격으로 관측한 방어 상성. 등급 거르기.
import {h,button,unitArt} from '../core/dom.js';
import {api,type Collection} from '../core/api.js';
import {go,sheet,type Scene} from '../core/scenes.js';
import {gradeName,elementName,defenseName,ELEMENTS,statName} from '../core/labels.js';

export const collection=():Scene=>({
  async mount(root){
    const data=await api.collection();
    let grade='all',page=0;
    const scene=h('div',{class:'collection-scene'});root.append(scene);
    const perPage=()=>{const cols=Math.max(4,Math.floor((scene.clientWidth-24)/112)),rows=Math.max(1,Math.floor((scene.clientHeight-56-60-56)/(Math.min(96,innerHeight*.15)+38)));return {cols,rows,n:cols*rows};};
    const render=()=>{
      const list=data.characters.filter(c=>grade==='all'||c.rarity===grade),g=perPage(),pages=Math.max(1,Math.ceil(list.length/g.n));page=Math.min(page,pages-1);
      const owned=data.characters.filter(c=>c.ownedCount>0).length;
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'도감'),h('span',{class:'top-note muted'},`가진 종 ${owned} / ${data.characters.length}`)),
        h('div',{class:'grade-tabs'},...['all',...Object.keys(gradeName)].map(k=>button(k==='all'?'전체':gradeName[k],()=>{grade=k;page=0;render();},{cls:grade===k?'on':''}))),
        h('div',{class:'dex-grid',style:{gridTemplateColumns:`repeat(${g.cols},1fr)`}},...list.slice(page*g.n,page*g.n+g.n).map(c=>h('button',{type:'button',class:`dex-card panel ${c.ownedCount?'':'unowned'}`,onclick:()=>openEntry(c)},
          h('img',{src:unitArt(c.id,'front'),alt:''}),h('b',{},c.name),h('small',{},`${gradeName[c.rarity]}${c.ownedCount?` · ${c.ownedCount}마리`:''}`)))),
        h('div',{class:'pager'},button('이전',()=>{page=(page-1+pages)%pages;render();},{disabled:pages<2}),h('span',{},`${page+1} / ${pages}`),button('다음',()=>{page=(page+1)%pages;render();},{disabled:pages<2})));
    };
    render();new ResizeObserver(()=>render()).observe(scene);
  },
});
function openEntry(c:Collection['characters'][number]){
  const k=c.defenseKnowledge;
  sheet(`${c.name} · ${gradeName[c.rarity]}`,h('div',{class:'detail'},
    h('div',{class:'detail-head'},h('img',{src:unitArt(c.id,'front'),alt:''}),h('div',{},h('p',{},c.role),h('p',{class:'muted'},`가진 수 ${c.ownedCount}마리${c.discovered?'':' · 아직 만나지 못함'}`),
      h('div',{class:'stat-grid'},...(Object.keys(statName) as (keyof typeof statName)[]).map(s=>h('div',{},h('small',{},statName[s]),h('b',{},String(c.levelOneStats[s]))))))),
    h('h3',{},'기술(레벨에 따라 해금)'),h('ul',{class:'skill-list'},...c.skills.map(s=>h('li',{},h('b',{},s.name),h('small',{},` ${elementName[s.element]} · 위력 ${s.power} · MP ${s.mpCost} · Lv${s.learnLevel??1}`)))),
    h('h3',{},`방어 상성 · 공격 관찰 ${k.knownDefenseCount} / ${k.totalDefenseCount}`),
    h('div',{class:'resist-grid'},...ELEMENTS.map(e=>h('div',{class:`res res-${k.defenses[e]}`},h('small',{},elementName[e]),h('b',{},defenseName[k.defenses[e]])))),
    h('p',{class:'muted small'},'방어 상성은 전투에서 그 속성으로 공격해 봐야 알 수 있어요.')));
}
