// 첫 화면. 원본: TitleView.java — 시간대 배경(c-home-*), 왼쪽에 갈매미맨(u01) 앞모습, 오른쪽에 제목·문구·게임 시작.
import {h,button,asset,unitArt} from '../core/dom.js';
import {api,message} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';

function phase(hour=new Date().getHours()){return hour>=5&&hour<10?'morning':hour<17&&hour>=10?'day':hour>=17&&hour<20?'evening':'night';}
export const title=():Scene=>({
  async mount(root){
    let loggedIn=false;
    try{await api.me();loggedIn=true;}catch{loggedIn=false;}
    const start=button('게임 시작',()=>loggedIn?go('village'):openLogin(),{kind:'entry',cls:'title-start'});
    root.append(h('div',{class:'title-scene'},
      h('img',{class:'title-bg',src:asset(`title/c-home-${phase()}.webp`),alt:''}),
      h('div',{class:'title-shade'}),
      h('div',{class:'title-guardian'},h('img',{src:unitArt('u01','front'),alt:'갈매미맨'})),
      h('div',{class:'title-column'},
        h('p',{class:'title-caption'},'작은 날개로, 우리 섬을 지켜요.'),
        h('h1',{class:'title-name'},h('span',{class:'title-first'},'갈매미맨'),h('span',{class:'title-second'},'방범대')),
        start,
        loggedIn?button('로그아웃',async()=>{await api.logout().catch(()=>{});go('title');},{cls:'title-sub'}):h('p',{class:'title-note'},'시제품: 시험 계정 코드로 들어와요.'),
      )));
  },
});
function openLogin(){
  const input=h('input',{class:'code-input',inputmode:'numeric',autocomplete:'one-time-code',maxlength:'6',placeholder:'6자리 코드','aria-label':'로그인 코드'}) as HTMLInputElement;
  const submit=async()=>{
    const code=input.value.replace(/\s/g,'');
    if(!/^\d{6}$/.test(code)){toast('6자리 숫자를 넣어 주세요.');return;}
    try{await api.login(code);closeSheet();go('village');}catch(e){toast(message(e));}
  };
  input.addEventListener('keydown',e=>{if(e.key==='Enter')void submit();});
  sheet('로그인',h('div',{class:'login-body'},h('p',{},'시제품은 시험 계정만 들어올 수 있어요. 받은 코드를 넣어 주세요.'),input),[button('들어가기',()=>void submit(),{kind:'primary'})]);
  setTimeout(()=>input.focus(),50);
}
