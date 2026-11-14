// 갈매미 한 마리 상세(편성 창·내 갈매미·조합 결과에서 같이 씀). 원본 「내 갈매미」 상세(OWNED-GULLS-20261028.md) 항목:
// 능력치(기본·성장·환생), 적합도, 내 방어 상성, 기술(레벨에 따라 해금), 다음 해금.
import {h,unitArt} from './dom.js';
import type {OwnedDetail,Stats} from './api.js';
import {gradeName,elementName,defenseName,ELEMENTS,statName} from './labels.js';

const statKeys=Object.keys(statName) as (keyof Stats)[];
export function statsSection(d:OwnedDetail){
  const b=d.statBreakdown;
  return h('table',{class:'stat-table'},
    h('thead',{},h('tr',{},h('th',{},''),...statKeys.map(k=>h('th',{},statName[k])))),
    h('tbody',{},
      h('tr',{class:'total'},h('th',{},'합계'),...statKeys.map(k=>h('td',{},String(b.total[k])))),
      h('tr',{},h('th',{},'기본'),...statKeys.map(k=>h('td',{},String(b.base[k])))),
      h('tr',{},h('th',{},'성장'),...statKeys.map(k=>h('td',{},`+${b.growth[k]}`))),
      d.reincarnation?h('tr',{},h('th',{},'환생'),...statKeys.map(k=>h('td',{},`+${b.rebirth[k]}`))):null));
}
export function skillsSection(d:OwnedDetail){
  const sk=d.skills;
  return h('ul',{class:'skill-list'},h('li',{},h('b',{},sk.attack.name),h('small',{},` 일반 공격 · 위력 ${sk.attack.power} · MP 0`)),
    ...sk.slots.map(s=>h('li',{class:s.unlocked?'':'locked'},h('b',{},s.name),h('small',{},` ${elementName[s.element]} · 위력 ${s.power} · MP ${s.mpCost}${s.unlocked?'':` · Lv${s.learnLevel} 해금`}${s.inherited?' · 물려받은 기술':''}`))));
}
export function resistSection(d:OwnedDetail){
  return h('div',{class:'resist-grid'},...ELEMENTS.map(e=>h('div',{class:`res res-${d.ownResistance[e]}`},h('small',{},elementName[e]),h('b',{},defenseName[d.ownResistance[e]]),h('small',{class:'apt'},`적합 ${d.aptitude[e]>0?'+':''}${d.aptitude[e]}`))));
}
export function unitDetailBody(d:OwnedDetail){
  const g=d.growth,sk=d.skills;
  return h('div',{class:'detail'},
    h('div',{class:'detail-head'},h('img',{src:unitArt(d.speciesId,'front'),alt:''}),
      h('div',{},h('p',{},`${gradeName[d.rarity]??d.rarity} · Lv${d.level} / ${d.maxLevel}${d.reincarnation?` · 환생 ${d.reincarnation}회`:''}`),
        h('p',{class:'muted'},g.xpToNext===null?'최대 레벨':`다음 레벨까지 ${g.xpToNext.toLocaleString()} 경험치`),
        sk.nextLearn?h('p',{class:'muted'},`Lv${sk.nextLearn.level}에 ${sk.nextLearn.skills.map(s=>s.name).join(', ')} 해금`):null)),
    h('h3',{},'능력치'),statsSection(d),h('h3',{},'기술'),skillsSection(d),h('h3',{},'받는 속성(내 방어 상성)'),resistSection(d));
}
