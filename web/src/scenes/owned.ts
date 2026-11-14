// 내 갈매미. 원본 OWNED-GULLS-20261028.md: 보유 개체를 한 마리씩(같은 종이라도 개체마다 따로), 이전·다음, 상세는 고정 스냅샷.
import {h,button,unitArt} from '../core/dom.js';
import {api,message,type OwnedDetail} from '../core/api.js';
import {go,toast,sheet,type Scene} from '../core/scenes.js';
import {gradeName} from '../core/labels.js';
import {statsSection,skillsSection,resistSection} from '../core/unitview.js';

export const owned=():Scene=>({
  async mount(root){
    const {units}=await api.owned();
    let index=0;const cache=new Map<string,OwnedDetail>();
    const scene=h('div',{class:'owned-scene'});root.append(scene);
    const render=async()=>{
      if(!units.length){scene.replaceChildren(h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'내 갈매미')),h('p',{class:'center muted'},'아직 갈매미가 없어요.'));return;}
      const u=units[index];
      let d=cache.get(u.ownedId);if(!d){try{d=await api.ownedDetail(u.ownedId);cache.set(u.ownedId,d);}catch(e){toast(message(e));return;}}
      const g=d.growth,pct=g.nextLevelTotalXp===null?100:Math.round((g.totalXp-g.levelStartTotalXp)/(g.nextLevelTotalXp-g.levelStartTotalXp)*100);
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'내 갈매미'),h('span',{class:'top-note muted'},`${index+1} / ${units.length}`)),
        h('div',{class:'owned-body'},
          h('section',{class:'owned-hero panel'},
            button('이전',()=>{index=(index-1+units.length)%units.length;void render();},{cls:'nav-prev',title:'이전 갈매미'}),
            h('div',{class:'hero-main'},h('img',{src:unitArt(d.speciesId,'front'),alt:''}),
              h('b',{},`${d.name} Lv${d.level}`),h('small',{},`${gradeName[d.rarity]} · HP ${d.stats.hp} · MP ${d.stats.mp}${d.party.pvp.position?` · 편성 ${d.party.pvp.position}번`:''}`),
              h('div',{class:'bar bar-xp'},h('i',{style:{width:`${pct}%`}}))),
            button('다음',()=>{index=(index+1)%units.length;void render();},{cls:'nav-next',title:'다음 갈매미'})),
          // 원본 기본 화면: 큰 능력치/속성/기술 버튼 → 상세는 창(기본 화면 세로 스크롤 없음)
          h('section',{class:'owned-detail panel'},
            h('p',{},g.xpToNext===null?'최대 레벨이에요.':`다음 레벨까지 ${g.xpToNext.toLocaleString()} 경험치`),
            d.skills.nextLearn?h('p',{class:'muted'},`Lv${d.skills.nextLearn.level}에 ${d.skills.nextLearn.skills.map(x=>x.name).join(', ')} 해금`):h('p',{class:'muted'},'더 해금할 기술이 없어요.'),
            d.skills.inheritance?h('p',{class:'muted'},'조합으로 물려받은 기술이 있어요.'):null,
            h('div',{class:'owned-buttons'},
              button('능력치',()=>sheet(`${d!.name} · 능력치`,statsSection(d!)),{kind:'switch'}),
              button('속성',()=>sheet(`${d!.name} · 받는 속성(내 방어 상성)`,resistSection(d!)),{kind:'item'}),
              button('기술',()=>sheet(`${d!.name} · 기술`,skillsSection(d!)),{kind:'attack'})))));
    };
    await render();
  },
});
