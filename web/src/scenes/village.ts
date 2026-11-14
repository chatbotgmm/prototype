// 마을(메인 화면). 원본: NativeVillageHomeView.java + village-loop-v2/manifest.json(assets/village/village.json로 옮김).
// 배치 해석(원본 코드와 같음): 1단위 = 화면 높이, 세계는 8단위로 돌아감(끝과 처음이 이어짐).
//  - 구역 배경: 가운데 x, 너비 worldWidth×단위, 높이 heightRatio×화면 높이, 위 = baseline×H − 높이×groundAnchor (VillageDistrictScene.java 24~26줄)
//  - 건물·주민: 높이 heightRatio×H, 너비는 그림 비율, 가운데 x, 발 = baseline×H (NativeVillageHomeView.java 380·388줄)
import {h,button,asset} from '../core/dom.js';
import {api,message} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';

type Asset={file:string;width:number;height:number};
type Building={id:string;name:string;sub:string;asset:string;x:number;width:number;baseline:number;heightRatio:number;behindTerrace?:boolean;menu:string[];actionIds:string[]};
type Village={worldUnits:number;assets:Record<string,Asset>;districts:{id:string;title:string;copy:string;nav:string;x:number}[];buildings:Building[];
  residents:{id:string;role:string;asset:string;x:number;baseline:number;heightRatio:number}[];landmark:{x:number;width:number;baseline:number;groundAnchor:number;stageAssets:string[]};
  districtScenery:{id:string;asset:string;x:number;worldWidth:number;depth:string;heightRatio:number;baseline:number;groundAnchor:number}[];
  decorations:{id:string;asset:string;heightRatio:number;surface:string;sourceX:number;sourceY:number}[]};
// 지금 단계에서 열리는 기능. 나머지는 이름은 보이되 「다음 단계」로 안내(만들지 않은 기능을 된 것처럼 보이지 않게)
// 일반전: 원본은 사람 대전(30초 뒤 AI). 대전은 7단계라 지금은 AI 연습 상대(PvE 훈련 조우)로 연결하고 화면에 밝힘
const READY:Record<string,()=>void>={party:()=>go('party'),normal:()=>go('training'),recruit:()=>go('recruit'),collection:()=>go('collection'),craft:()=>go('craft')};
const NOTE:Record<string,string>={normal:'지금은 AI 연습 상대'};

let villageData:Village|null=null;
export const village=():Scene=>{
  let raf=0,cleanup:(()=>void)[]=[];
  return {
    async mount(root){
      const [me,data]=await Promise.all([api.me().catch(()=>null),villageData?Promise.resolve(villageData):fetch(asset('village/village.json')).then(r=>r.json() as Promise<Village>)]);
      if(!me){go('title');return;}
      villageData=data;
      const view=h('div',{class:'village-view'}),sky=h('div',{class:'village-sky'}),world=h('div',{class:'village-world'});
      view.append(sky,world);
      const W=data.worldUnits;
      let U=1,camera=(data.buildings.find(b=>b.id==='recruit')!.x+data.buildings.find(b=>b.id==='hideout')!.x)/2; // 원본 시작 위치: 지원소와 아지트 사이(NativeVillageHomeView.java 348줄)
      const img=(key:string,cls:string)=>h('img',{src:asset(data.assets[key].file),alt:'',class:cls,draggable:'false'});
      // 세계를 세 벌(−8, 0, +8단위) 그려서 끝과 처음이 이어지게
      const pieces:{el:HTMLElement;place:()=>void}[]=[];
      const put=(el:HTMLElement,place:(copy:number)=>{left:number;top:number;width:number;height:number})=>{
        for(const copy of [-1,0,1]){const e=copy?el.cloneNode(true) as HTMLElement:el;if(copy)e.querySelectorAll('[data-click]').forEach(c=>c.removeAttribute('id'));world.append(e);
          pieces.push({el:e,place:()=>{const r=place(copy);Object.assign(e.style,{left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`});}});}
      };
      const H=()=>view.clientHeight;
      const scenery=(depth:string)=>data.districtScenery.filter(s=>s.depth===depth).forEach(s=>put(img(s.asset,'v-scenery'),copy=>{const height=H()*s.heightRatio,width=s.worldWidth*U;return {left:(s.x+copy*W)*U-width/2,top:H()*s.baseline-height*s.groundAnchor,width,height};}));
      const standing=(key:string,x:number,baseline:number,heightRatio:number,cls:string,wrap?:HTMLElement)=>{const a=data.assets[key],el=wrap??img(key,cls);if(wrap)wrap.prepend(img(key,'v-img'));
        put(el,copy=>{const height=H()*heightRatio,width=height*a.width/a.height;return {left:(x+copy*W)*U-width/2,top:H()*baseline-height,width,height};});};
      const buildingEl=(b:Building)=>{
        const ready=b.actionIds.some(a=>READY[a]);
        const plate=h('span',{class:`v-plate ${ready?'':'v-plate-soon'}`},h('b',{},b.name),h('small',{},b.sub));
        const el=h('button',{type:'button',class:'v-building','data-click':b.id,'aria-label':`${b.name}: ${b.sub}`},plate);
        return el;
      };
      scenery('backdrop');
      for(const b of data.buildings.filter(b=>b.behindTerrace))standing(b.asset,b.x,b.baseline,b.heightRatio,'v-building',buildingEl(b));
      scenery('terrace');
      // 시장 대장간 장식: 시장 구역 배경 그림 위의 한 점에 세움(원본 decorations.surface)
      for(const d of data.decorations){const s=data.districtScenery.find(x=>x.id===d.surface)!,a=data.assets[d.asset];
        put(img(d.asset,'v-deco'),copy=>{const sh=H()*s.heightRatio,sw=s.worldWidth*U,sl=(s.x+copy*W)*U-sw/2,st=H()*s.baseline-sh*s.groundAnchor;const height=H()*d.heightRatio,width=height*a.width/a.height;return {left:sl+sw*d.sourceX-width/2,top:st+sh*d.sourceY-height,width,height};});}
      for(const b of data.buildings.filter(b=>!b.behindTerrace))standing(b.asset,b.x,b.baseline,b.heightRatio,'v-building',buildingEl(b));
      // 석상(복원 1단계: 스토리 연결 전이라 1단계로 고정)
      const lm=data.landmark,la=data.assets[lm.stageAssets[0]];
      put(img(lm.stageAssets[0],'v-statue'),copy=>{const width=lm.width*U,height=width*la.height/la.width;return {left:(lm.x+copy*W)*U-width/2,top:H()*lm.baseline-height*lm.groundAnchor,width,height};});
      for(const r of data.residents)standing(r.asset,r.x,r.baseline,r.heightRatio,'v-resident');
      // 하늘: 원본 layers.background parallax 0.25
      const skyTiles=[0,1,2,3,4].map(()=>{const e=img('layered-sky','v-sky');sky.append(e);return e;});
      const layout=()=>{U=H();for(const p of pieces)p.place();render();};
      const render=()=>{
        camera=((camera%W)+W)%W;
        const vw=view.clientWidth;world.style.transform=`translate3d(${-camera*U}px,0,0)`;
        const tile=H()*data.assets['layered-sky'].width/data.assets['layered-sky'].height,off=-((camera*U*.25)%tile+tile);
        skyTiles.forEach((t,i)=>Object.assign(t.style,{left:`${off+i*tile}px`,width:`${tile}px`,height:`${H()}px`}));
        void vw;
      };
      // 끌어서 움직이기 + 관성
      let dragging=false,lastX=0,vel=0,moved=0;
      const down=(e:PointerEvent)=>{dragging=true;lastX=e.clientX;vel=0;moved=0;cancelAnimationFrame(raf);};
      const move=(e:PointerEvent)=>{if(!dragging)return;const dx=e.clientX-lastX;lastX=e.clientX;moved+=Math.abs(dx);camera-=dx/U;vel=dx;render();};
      const up=()=>{if(!dragging)return;dragging=false;const step=()=>{vel*=.94;if(Math.abs(vel)<.3)return;camera-=vel/U;render();raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);};
      view.addEventListener('pointerdown',down);window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
      view.addEventListener('click',e=>{if(moved>8)return;const t=(e.target as HTMLElement).closest('[data-click]') as HTMLElement|null;if(t)openBuilding(data.buildings.find(b=>b.id===t.dataset.click)!);},true);
      const ro=new ResizeObserver(layout);ro.observe(view);
      cleanup.push(()=>{ro.disconnect();window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);});
      // 화면 고정 UI: 프로필, 구역 바로가기
      const jump=(x:number)=>{cancelAnimationFrame(raf);const target=x+1-view.clientWidth/U/2,start=camera;let d=target-start;d=((d+W/2)%W+W)%W-W/2;const t0=performance.now();
        const step=(t:number)=>{const k=Math.min(1,(t-t0)/450),e=1-Math.pow(1-k,3);camera=start+d*e;render();if(k<1)raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);};
      const hud=h('div',{class:'village-hud'},
        h('button',{type:'button',class:'hud-profile panel',onclick:()=>go('owned'),'aria-label':'내 갈매미 보기'},h('b',{},me.nickname??'방범대장'),h('small',{},'내 갈매미 · 시험 계정')),
        button('설정',()=>openSettings(),{cls:'hud-settings'}));
      const nav=h('nav',{class:'village-nav','aria-label':'구역 바로가기'},...data.districts.map(d=>button([h('b',{},d.title),h('small',{},d.nav)],()=>jump(d.x),{cls:'nav-btn'})));
      const guide=h('div',{class:'village-guide'});
      root.append(h('div',{class:'village-scene'},view,hud,nav,guide));
      layout();
      void onboardingGuide(guide);
    },
    unmount(){cancelAnimationFrame(raf);cleanup.forEach(f=>f());cleanup=[];},
  };
};
function openBuilding(b:Building){
  const items=b.menu.map((label,i)=>{
    const id=b.actionIds[i],run=READY[id];
    return run?button([label,NOTE[id]?h('small',{},NOTE[id]):null],()=>{closeSheet();run();},{kind:'primary',cls:'menu-btn'})
      :button([label,h('small',{class:'soon'},'다음 단계')],()=>toast(`「${label}」은(는) 다음 단계에서 만들어요.`),{cls:'menu-btn'});
  });
  sheet(b.name,h('div',{class:'building-menu'},h('p',{class:'muted'},b.sub),...items));
}
function openSettings(){
  sheet('설정',h('div',{class:'building-menu'},
    button('첫 화면으로',()=>{closeSheet();go('title');},{cls:'menu-btn'}),
    button('로그아웃',async()=>{await api.logout().catch(()=>{});closeSheet();go('title');},{cls:'menu-btn'})));
}

/** 첫 갈매미 흐름 안내(원본 순서: 시작 → 튜토리얼 전투 승리 → 커먼 선택지급권 → 고르기). 서버 상태만 보고 다음 할 일을 보여 줌. */
async function onboardingGuide(el:HTMLElement){
  try{
    let s=await api.onboarding();
    if(!s.started){s=await api.onboardingStart();toast('갈매미맨이 방범대에 합류했어요!');}
    if(s.tutorialVerified&&!s.tutorialComplete)s=await api.onboardingComplete();
    if(!s.tutorialVerified){
      el.replaceChildren(h('div',{class:'guide panel'},h('b',{},'첫 출동'),h('small',{},'갈매미맨과 첫 전투를 이겨 보세요'),
        button('튜토리얼 전투',async()=>{try{const b=await api.createBattle(s.starter!.id,'tutorial',[]);go('battle',{battleId:b.battleId,view:b});}catch(e){toast(message(e));}},{kind:'primary'})));
    }else if(s.ticket&&s.ticket.status==='unused'){
      el.replaceChildren(h('div',{class:'guide panel'},h('b',{},'커먼 선택지급권'),h('small',{},'커먼 7종 중 한 마리를 골라 받아요'),
        button('고르러 가기',()=>go('starter',{ticketId:s.ticket!.ticketId}),{kind:'primary'})));
    }else el.replaceChildren();
  }catch(e){toast(message(e));}
}
