// 조합(기록소). 원본 roster60-craft.ts + CRAFT-SKILL-INHERITANCE-20261028.md
//  - 조합식 목록(발견하지 않은 결과·재료는 ???), 재료 준비 상태, 미리보기(결과 레벨 = 재료 경험치 평균)
//  - 재료가 가진 해금 기술 중 하나를 결과의 한 칸과 바꿈(필수) → 미리보기 지문이 같아야 확정
//  - 재료는 조합식 순서대로 레벨 높은 개체부터 자동으로 고름(원본 화면의 직접 선택은 다음에 다듬기)
import {h,button,unitArt} from '../core/dom.js';
import {api,message,type Recipe,type CraftUnit,type CraftPreview} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';
import {gradeName,elementName} from '../core/labels.js';
import {unitDetailBody} from '../core/unitview.js';

export const craft=():Scene=>({
  async mount(root){
    let opts=await api.craftOptions(),sel=0,page=0,busy=false;
    const scene=h('div',{class:'craft-scene'});root.append(scene);
    const pick=(r:Recipe,units:CraftUnit[])=>{const ids:string[]=[];
      for(const ing of r.ingredients){const ready=units.filter(u=>u.speciesId===ing.unitId&&u.reincarnation===0&&u.level>=ing.minLevel).sort((a,b)=>b.level-a.level);
        if(ready.length<ing.count)return null;ids.push(...ready.slice(0,ing.count).map(u=>u.ownedId));}return ids;};
    const perPage=()=>Math.max(3,Math.floor((scene.clientHeight-56-20-56)/56));
    const render=()=>{
      const rs=opts.recipes,n=perPage(),pages=Math.max(1,Math.ceil(rs.length/n));page=Math.min(page,pages-1);sel=Math.min(sel,rs.length-1);
      const r=rs[sel],ids=r?pick(r,opts.units):null;
      const row=(x:Recipe,i:number)=>button([h('img',{src:x.discovered?unitArt(x.resultId,'front'):'',alt:'',class:x.discovered?'thumb':'thumb hidden'}),
          h('span',{class:'rname'},h('b',{},x.nameVisible?x.name:'???'),h('small',{},x.craftable?'조합 가능':x.levelRestricted?'재료 레벨 부족':x.materialsReady?'재료 있음':'재료 모자람'))],
        ()=>{sel=i;render();},{cls:`recipe-row ${i===sel?'on':''} ${x.craftable?'ready':''}`});
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'조합'),h('span',{class:'top-note muted'},`조합식 ${rs.length}개`)),
        h('div',{class:'craft-body'},
          h('section',{class:'recipe-list panel'},...rs.slice(page*n,page*n+n).map((x,j)=>row(x,page*n+j)),
            h('div',{class:'pager'},button('이전',()=>{page=(page-1+pages)%pages;render();},{disabled:pages<2}),h('span',{},`${page+1} / ${pages}`),button('다음',()=>{page=(page+1)%pages;render();},{disabled:pages<2}))),
          r?h('section',{class:'recipe-detail panel'},
            h('div',{class:'detail-head'},r.discovered?h('img',{src:unitArt(r.resultId,'front'),alt:''}):h('div',{class:'unknown-art'},'?'),
              h('div',{},h('h2',{},r.nameVisible?r.name:'???'),r.hidden?h('p',{class:'muted small'},'숨은 조합식'):null)),
            h('h3',{},'재료'),
            h('ul',{class:'ing-list'},...r.ingredients.map(i=>h('li',{class:i.readyCount>=i.count?'ok':''},h('b',{},`${i.name} ×${i.count}`),h('small',{},` Lv${i.minLevel} 이상 · 가진 수 ${i.availableCount}(조건 맞음 ${i.readyCount})`)))),
            button('미리보기',()=>void preview(r,ids!),{kind:'primary',disabled:!ids||busy,cls:'big'})):null));
    };
    const preview=async(r:Recipe,materialIds:string[])=>{
      busy=true;
      try{const p=await api.craftPreview({resultId:r.resultId,materialIds,catalogVersion:opts.catalogVersion});openInheritance(p,materialIds);}catch(e){toast(message(e));}
      busy=false;
    };
    const openInheritance=(p:CraftPreview,materialIds:string[])=>{
      let choice:{skillId:string;replaceSlot:number}|null=null;
      const body=h('div',{class:'inherit'});
      const draw=()=>{
        const inh=p.inheritance;
        body.replaceChildren(...([
          h('p',{},`결과: ${p.resultName}(${gradeName[p.resultRarity]}) Lv${p.expectedLevel} · 재료 ${materialIds.length}마리는 사라져요`),
          h('h3',{},'1. 물려받을 기술'),
          h('div',{class:'inherit-grid'},...inh.candidates.map(c=>button([h('b',{},c.name),h('small',{},`${elementName[c.element]} · 위력 ${c.power} · MP ${c.mpCost} · Lv${c.requiredLevel} · ${c.source.name}`)],
            ()=>{choice={skillId:c.skillId,replaceSlot:c.allowedReplaceSlots[0]};draw();},{cls:`skill-btn ${choice?.skillId===c.skillId?'on':''}`}))),
          choice?h('h3',{},'2. 바꿀 칸'):null,
          choice?h('div',{class:'inherit-grid'},...inh.resultSkillSlots.map(s=>{const allowed=inh.candidates.find(c=>c.skillId===choice!.skillId)!.allowedReplaceSlots.includes(s.slot);
            return button([h('b',{},`${s.slot+1}칸 · ${s.name}`),h('small',{},`${elementName[s.element]} · 위력 ${s.power} · Lv${s.requiredLevel}`)],()=>{choice={...choice!,replaceSlot:s.slot};draw();},{cls:`skill-btn ${choice!.replaceSlot===s.slot?'on':''}`,disabled:!allowed});})):null].filter(Boolean) as Node[]));
      };
      draw();
      sheet('기술 물려받기',body,[button('취소',closeSheet),button('조합하기',async()=>{
        if(!choice){toast('물려받을 기술을 골라 주세요.');return;}
        try{const v=await api.craftPreview({resultId:p.resultId,materialIds,catalogVersion:opts.catalogVersion,inheritance:choice});
          const done=await api.craftConfirm({resultId:p.resultId,materialIds,catalogVersion:opts.catalogVersion,inheritance:choice,previewFingerprint:v.previewFingerprint});
          closeSheet();opts=await api.craftOptions();render();
          const d=await api.ownedDetail(done.ownedId);sheet(`조합 성공 · ${d.name}`,unitDetailBody(d));
        }catch(e){toast(message(e));}},{kind:'primary'})]);
    };
    render();new ResizeObserver(()=>render()).observe(scene);
  },
});
