// 전투연습장 → 일반전(지금은 AI 연습 상대). 편성으로 상대(훈련 조우)를 골라 출전.
import {h,button,unitArt,asset} from '../core/dom.js';
import {api,message} from '../core/api.js';
import {go,toast,type Scene} from '../core/scenes.js';

export const training=():Scene=>({
  async mount(root){
    const [opts,party,{units},active]=await Promise.all([api.battleOptions(),api.party(),api.owned(),api.activeBattles()]);
    const unfinished=active.battles.find(b=>b.status!=='SETTLED');
    const team=party.ownedIds.map(id=>units.find(u=>u.ownedId===id)).filter(Boolean) as typeof units;
    const list=opts.encounters.filter(e=>e.mode==='duel');
    root.append(h('div',{class:'training-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.55),rgba(7,19,28,.8)),url(${asset('ui/bg-harbor.webp')})`}},
      h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'일반전'),h('span',{class:'muted top-note'},'지금은 AI 연습 상대만 · 사람 대전은 7단계')),
      unfinished?h('div',{class:'panel resume'},h('b',{},'끝나지 않은 전투가 있어요.'),button('이어서 하기',()=>go('battle',{battleId:unfinished.battleId}),{kind:'primary'})):null,
      h('div',{class:'training-body'},
        h('section',{class:'panel team-preview'},h('h2',{},'내 편성'),
          team.length?h('div',{class:'team-row'},...team.map((u,i)=>h('div',{class:'team-mini'},h('img',{src:unitArt(u.speciesId,'front'),alt:''}),h('small',{},`${i===0?'출전':'예비'} · ${u.name} Lv${u.level}`)))):h('p',{class:'muted'},'아직 편성이 없어요.'),
          button('편성 바꾸기',()=>go('party',{next:'training'}))),
        h('section',{class:'panel encounter-list'},h('h2',{},'상대 고르기'),
          h('div',{class:'encounter-grid'},...list.map(e=>button([h('b',{},`Lv${e.level} 상대`),h('small',{},'후보 6종 중 무작위')],async()=>{
            if(!team.length){toast('먼저 편성해 주세요.');go('party',{next:'training'});return;}
            try{const b=await api.createBattle(team[0].ownedId,e.id,team.slice(1).map(u=>u.ownedId));go('battle',{battleId:b.battleId,view:b});}catch(err){toast(message(err));}
          },{kind:'switch',cls:'enc-btn',disabled:!!unfinished})))))));
  },
});
