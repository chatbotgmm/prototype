// 작은 DOM 도우미. Godot으로 옮길 때는 Control 노드 만들기에 해당.
type Child=Node|string|number|null|undefined|false;
export function h<K extends keyof HTMLElementTagNameMap>(tag:K,attrs:Record<string,unknown>={},...children:Child[]):HTMLElementTagNameMap[K]{
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(v===undefined||v===null||v===false)continue;
    if(k==='class')el.className=String(v);
    else if(k==='style'&&typeof v==='object')Object.assign(el.style,v);
    else if(k.startsWith('on')&&typeof v==='function')el.addEventListener(k.slice(2).toLowerCase(),v as EventListener);
    else if(v===true)el.setAttribute(k,'');
    else el.setAttribute(k,String(v));
  }
  for(const c of children)if(c!==null&&c!==undefined&&c!==false)el.append(c instanceof Node?c:String(c));
  return el;
}
export const BASE=(document.querySelector('meta[name="gmm-base"]') as HTMLMetaElement|null)?.content??'/proto';
export const asset=(path:string)=>`${BASE}/assets/${path}`;
export const unitArt=(speciesId:string,side:'front'|'rear')=>asset(`units/${speciesId}-${side}.webp`);
/** 버튼: 나인패치 종류(attack 빨강·switch 파랑·item 청록·surrender 크림)나 기본 남색 */
export function button(label:Child|Child[],onClick:()=>void,opt:{kind?:'attack'|'switch'|'item'|'surrender'|'navy'|'primary'|'entry';disabled?:boolean;cls?:string;icon?:string;title?:string}={}){
  const b=h('button',{type:'button',class:`btn ${opt.kind?`btn-${opt.kind}`:'btn-navy'} ${opt.cls??''}`,disabled:opt.disabled,title:opt.title,onclick:(e:Event)=>{e.stopPropagation();onClick();}},
    opt.icon?h('img',{src:asset(`ui/${opt.icon}.webp`),alt:'',class:'btn-icon'}):null,...(Array.isArray(label)?label:[label]));
  return b;
}
