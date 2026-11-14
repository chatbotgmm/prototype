// 전투 결과·경험치. 막대 위치는 서버가 준 xpProgress(정산 전후 레벨 구간)를 그대로 씀.
import {h,button,unitArt,asset} from '../core/dom.js';
import {api,type BattleView} from '../core/api.js';
import {go,type Scene} from '../core/scenes.js';
import {resultLabel} from '../core/labels.js';

export const result=():Scene=>({
  async mount(root,params:{view:BattleView}){
    const v=params.view,s=v.settlement,{units}=await api.owned();
    const rows=(s?.unitXp?.units??[]).filter((u:any)=>u.status!=='NOT_ENTERED');
    const pct=(p:any)=>{const start=Number(p.levelStartTotalXp),next=p.nextLevelTotalXp===null?null:Number(p.nextLevelTotalXp),t=Number(p.totalXp);return next===null?100:Math.round((t-start)/(next-start)*100);};
    root.append(h('div',{class:'result-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.5),rgba(7,19,28,.85)),url(${asset('ui/bg-harbor.webp')})`}},
      h('div',{class:'panel result-panel'},
        h('h1',{class:`result-title result-${v.state.outcome}`},resultLabel(v.state.outcome)),
        h('p',{class:'muted'},v.state.surrendered?'항복하면 경험치가 없어요.':`받은 경험치 ${s?.xpAwarded??0}${s?.xpDiscarded?` · 최대 레벨이라 ${s.xpDiscarded} 버림`:''}`),
        ...rows.map((u:any)=>{const o=units.find(x=>x.ownedId===u.ownedId),p=u.xpProgress;
          return h('div',{class:'xp-row'},o?h('img',{src:unitArt(o.speciesId,'front'),alt:''}):null,
            h('div',{class:'xp-text'},h('b',{},`${o?.name??''} Lv${p?.before.level??'?'}${p&&p.after.level>p.before.level?` → Lv${p.after.level}`:''}`),
              p?h('div',{class:'bar bar-xp'},h('i',{style:{width:`${pct(p.after)}%`}})):null,h('small',{},`+${u.appliedXp} 경험치`)));}),
        h('p',{class:'muted small'},'경험치는 처음 출전한 대원만 받아요(원본 규칙). 수치는 시험값이에요.'),
        h('div',{class:'result-actions'},v.state.mode==='story'?button('마을로',()=>go('village'),{kind:'primary'}):button('다시 출전',()=>go('training'),{kind:'primary'}),v.state.mode==='story'?null:button('마을로',()=>go('village'))))));
  },
});
