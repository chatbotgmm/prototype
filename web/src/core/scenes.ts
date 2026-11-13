// 장면 관리자(Godot의 change_scene에 해당) + 알림·창. 화면끼리는 go(이름, 인자)로만 넘어간다.
import {h,button} from './dom.js';

export type Scene={mount(root:HTMLElement,params:any):void|Promise<void>;unmount?():void};
const registry=new Map<string,()=>Scene>();
let current:Scene|null=null,root:HTMLElement;
export function register(name:string,make:()=>Scene){registry.set(name,make);}
export function start(el:HTMLElement){root=el;}
export async function go(name:string,params:any={}){
  closeSheet();current?.unmount?.();root.replaceChildren();
  const make=registry.get(name);if(!make)throw Error(`장면 없음: ${name}`);
  current=make();root.dataset.scene=name;
  try{await current.mount(root,params);}catch(e){console.error(e);toast('화면을 불러오지 못했어요.');}
}
let toastTimer:ReturnType<typeof setTimeout>|undefined;
export function toast(text:string){
  let t=document.getElementById('toast');if(!t){t=h('div',{id:'toast',role:'status','aria-live':'polite'});document.body.append(t);}
  t.textContent=text;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t!.classList.remove('show'),2400);
}
/** 창(모달). 긴 내용은 창 안에서만 세로 스크롤(UI-COLOR 규칙). */
export function sheet(title:string,body:Node,actions:Node[]=[]){
  closeSheet();
  const close=button('닫기',closeSheet,{cls:'sheet-close'});
  const panel=h('div',{class:'sheet panel',role:'dialog','aria-modal':'true','aria-label':title},
    h('div',{class:'sheet-head'},h('h2',{},title),close),h('div',{class:'sheet-body'},body),actions.length?h('div',{class:'sheet-actions'},...actions):null);
  const wrap=h('div',{id:'sheet',class:'sheet-wrap',onclick:(e:Event)=>{if(e.target===wrap)closeSheet();}},panel);
  document.body.append(wrap);return panel;
}
export function closeSheet(){document.getElementById('sheet')?.remove();}
