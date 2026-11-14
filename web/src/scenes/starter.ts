// 커먼 선택지급권: 갈매미맨을 뺀 커먼 7종 중 한 마리를 영구로 받음(원본 roster60-onboarding.ts, 우편 문구
// "갈매미맨을 제외한 커먼 7종 중 한 마리를 선택해 영구 지급받습니다. 선택 전 능력 정보를 확인하세요").
import {h,button,unitArt} from '../core/dom.js';
import {api,message} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';
import {elementName,statName} from '../core/labels.js';

export const starter=():Scene=>({
  async mount(root,params:{ticketId:string}){
    const p=await api.onboardingPreview(params.ticketId);
    if(p.ticket?.status==='used'){toast('이미 받았어요.');go('village');return;}
    let chosen=0;
    const scene=h('div',{class:'starter-scene'});root.append(scene);
    const render=()=>{
      const c=p.characters[chosen];
      const top=Object.entries(c.suitability).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([e])=>elementName[e]).join(' · ')||'없음';
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'커먼 선택지급권'),h('span',{class:'muted top-note'},'갈매미맨을 뺀 커먼 7종 중 한 마리 · 영구 지급')),
        h('div',{class:'starter-body'},
          h('div',{class:'starter-pick'},...p.characters.map((x,i)=>h('button',{type:'button',class:`starter-card panel ${i===chosen?'picked':''}`,'aria-pressed':String(i===chosen),onclick:()=>{chosen=i;render();}},
            h('img',{src:unitArt(x.id,'front'),alt:''}),h('b',{},x.name)))),
          h('section',{class:'starter-detail panel'},
            h('div',{class:'detail-head'},h('img',{src:unitArt(c.id,'front'),alt:''}),h('div',{},h('h2',{},c.name),h('p',{class:'muted'},c.role),h('p',{},`잘 맞는 속성: ${top}`))),
            h('div',{class:'stat-grid'},...(Object.keys(statName) as (keyof typeof statName)[]).map(k=>h('div',{},h('small',{},statName[k]),h('b',{},String(c.levelOneStats[k]))))),
            h('p',{class:'muted small'},`기술 ${c.skills.length}개(레벨에 따라 해금) · Lv1로 들어와요`),
            button(`${c.name} 받기`,()=>confirm(c.id,c.name),{kind:'primary',cls:'big'}))));
    };
    const confirm=(id:string,name:string)=>sheet('선택 확인',h('p',{},`「${name}」를 받을까요? 한 번만 고를 수 있어요.`),[button('취소',closeSheet),button('받기',async()=>{
      try{await api.onboardingConfirm(params.ticketId,id,p.catalogVersion);closeSheet();toast(`${name}이(가) 방범대에 들어왔어요!`);go('village');}catch(e){toast(message(e));}},{kind:'primary'})]);
    render();
  },
});
