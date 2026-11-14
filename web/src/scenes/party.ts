// 방범대 편성(아지트). 1~3마리: 첫 칸이 출전, 나머지는 예비(원본 single-active-party-3-v1).
// 기본 페이지는 스크롤 없이: 목록은 쪽 넘기기, 긴 상세는 창에서(UI-COLOR 규칙).
import {h,button,unitArt} from '../core/dom.js';
import {api,message,type OwnedUnit} from '../core/api.js';
import {go,sheet,toast,type Scene} from '../core/scenes.js';
import {gradeName} from '../core/labels.js';
import {unitDetailBody} from '../core/unitview.js';

export const party=():Scene=>({
  async mount(root,params:{next?:string}={}){
    const [{units},saved]=await Promise.all([api.owned(),api.party()]);
    let picked=saved.ownedIds.filter(id=>units.some(u=>u.ownedId===id)),page=0;
    const scene=h('div',{class:'party-scene'});root.append(scene);
    // 한 쪽에 들어가는 카드 수: 목록 칸의 실제 크기 ÷ 카드 최소 크기(가로 132px, 세로 = 그림 + 이름 2줄 + 정보 버튼)
    const cardH=()=>Math.min(96,Math.max(48,innerHeight*.15))+12;
    const grid=()=>{const w=scene.clientWidth*0.6,hgt=scene.clientHeight-56-20-56;return {cols:Math.max(1,Math.floor((w+8)/250)),rows:Math.max(1,Math.floor((hgt+8)/(cardH()+8)))};};
    const perPage=()=>{const g=grid();return g.cols*g.rows;};
    const render=()=>{
      const n=perPage(),pages=Math.max(1,Math.ceil(units.length/n));page=Math.min(page,pages-1);
      const slot=(i:number)=>{const u=units.find(x=>x.ownedId===picked[i]);
        return h('div',{class:`slot panel ${u?'filled':''}`},h('span',{class:'slot-role'},i===0?'출전':`예비 ${i}`),
          u?h('img',{src:unitArt(u.speciesId,'front'),alt:''}):h('span',{class:'slot-empty'},'비어 있음'),
          u?h('b',{},`${u.name} Lv${u.level}`):null,
          u?button('빼기',()=>{picked=picked.filter(id=>id!==u.ownedId);render();},{cls:'slot-remove'}):null);};
      const card=(u:OwnedUnit)=>{const at=picked.indexOf(u.ownedId),busy=u.status!=='AVAILABLE';
        return h('div',{class:`unit-card panel ${at>=0?'picked':''}`},
          h('button',{type:'button',class:'unit-pick','aria-pressed':String(at>=0),disabled:busy,onclick:()=>{
            if(at>=0)picked=picked.filter(id=>id!==u.ownedId);else if(picked.length<3)picked=[...picked,u.ownedId];else{toast('편성은 3마리까지예요. 먼저 한 마리를 빼 주세요.');return;}render();}},
            h('img',{src:unitArt(u.speciesId,'front'),alt:''}),h('b',{},u.name),h('small',{},`Lv${u.level} · ${gradeName[u.rarity]??u.rarity}${busy?' · 전투 중':''}`),
            at>=0?h('span',{class:'pick-badge'},at===0?'출전':`예비 ${at}`):null),
          button('정보',()=>void openDetail(u),{cls:'unit-info',title:`${u.name} 정보`}));};
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'방범대 편성'),h('span',{class:'muted top-note'},'1~3마리 · 첫 칸이 출전')),
        h('div',{class:'party-body'},
          h('section',{class:'party-slots'},slot(0),slot(1),slot(2),
            button('편성 저장',async()=>{try{await api.saveParty(picked);toast('편성을 저장했어요.');if(params.next)go(params.next);}catch(e){toast(message(e));}},{kind:'primary',disabled:!picked.length,cls:'save-btn'})),
          h('section',{class:'party-list'},
            h('div',{class:'unit-grid',style:{gridTemplateColumns:`repeat(${grid().cols},1fr)`}},...units.slice(page*n,page*n+n).map(card)),
            pages>1?h('div',{class:'pager'},button('이전',()=>{page=(page-1+pages)%pages;render();}),h('span',{},`${page+1} / ${pages}`),button('다음',()=>{page=(page+1)%pages;render();})):null)));
    };
    render();new ResizeObserver(()=>render()).observe(scene);
  },
});
async function openDetail(u:OwnedUnit){
  try{const d=await api.ownedDetail(u.ownedId);sheet(`${d.name} Lv${d.level}`,unitDetailBody(d));}catch(e){toast(message(e));}
}
