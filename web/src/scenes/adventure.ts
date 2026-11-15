// 모험 상태(원본 NativeRoster60Battle.showAdventure + NativeRoster60StoryBattle.returnToStory).
// 대원 체력(전투마다 이어짐) · 귀환 때 받을 경험치 · 「모험 계속」(살아 있는 대원 하나를 먼저 내보냄) · 「정상 귀환」.
// 의뢰 모험: 이긴 수를 채웠으면 귀환해야 이야기가 이어짐(원본 status). returnNow: 결과 화면 「귀환하기」에서 바로 귀환.
import {h,button,unitArt,asset} from '../core/dom.js';
import {api,message,type Adventure} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';

export const adventure=():Scene=>({
  async mount(root,params:{adventureId:string;view?:Adventure;returnNow?:boolean}){
    let a=params.view??await api.adventure(params.adventureId),busy=false;
    const scene=h('div',{class:'adventure-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.45),rgba(7,19,28,.82)),url(${asset('ui/bg-harbor.webp')})`}});root.append(scene);
    const [{units},story]=await Promise.all([api.owned(),api.story().catch(()=>null)]);
    const quest=a.questId?story?.quests.find(q=>q.id===a.questId)??null:null;
    const title=a.kind==='quest'?(quest?.title??'의뢰 모험'):a.kind==='material'?'흑화 갈매미 모험':'자유 탐험';
    const doReturn=async()=>{if(busy)return;busy=true;render();try{a=await api.adventureReturn(a);}catch(e){toast(message(e));a=await api.adventure(a.adventureId);}busy=false;render();};
    const battleWith=async(leadId:string,encounterId?:string)=>{
      // 재료 모험: 열린 흑화 모험이 여럿이면 어느 상대를 찾을지 고름
      if(a.kind==='material'&&!encounterId&&story&&story.adventures.length>1){
        sheet('다음 모험 전투',h('div',{class:'building-menu'},...story.adventures.map(e=>button(`${e.name} · Lv${e.level}`,()=>void battleWith(leadId,e.id),{cls:'menu-btn'}))));return;}
      closeSheet();const ids=[leadId,...a.party.map(f=>f.ownedId).filter(id=>id!==leadId)];busy=true;render();
      try{
        const b=a.kind==='free'?await api.createBattle(leadId,'adventure-1',ids.slice(1),a.adventureId)
          :a.kind==='material'?await api.materialBattle(encounterId??story!.adventures[0]!.id,ids,a.adventureId)
          :await api.storyBattle(a.questId!,ids,a.adventureId);
        go('battle',{battleId:b.battleId,view:b});
      }catch(e){toast(message(e));busy=false;render();}
    };
    const pickLead=()=>{const alive=a.party.filter(f=>f.hp>0);
      sheet('모험 출전 대원',h('div',{class:'building-menu'},h('p',{class:'muted'},'먼저 나갈 대원을 고르세요. 나머지는 예비로 함께 가요.'),
        ...alive.map(f=>button([`${f.name} Lv${f.level}`,h('small',{},`HP ${f.hp} / ${f.maxHp}`)],()=>void battleWith(f.ownedId),{cls:'menu-btn'}))));};
    function render(){
      const active=a.status==='ACTIVE',s=a.settlement,xp=active?a.pendingRewards.xp:(s?.rewards?.xp??{});
      // 의뢰 모험에서 더 싸울 수 있는지: 서버가 준 canDepart(이긴 수가 모자라고 전투 중이 아님)
      const canFight=active&&!a.activeBattleId&&a.party.some(f=>f.hp>0)&&(a.kind!=='quest'||!!quest?.canDepart)&&(a.kind!=='material'||!!story?.adventures.length);
      const head=active?(a.activeBattleId?'전투가 진행 중이에요.':a.kind==='quest'&&!quest?.canDepart?'의뢰 목표를 달성했어요. 귀환하면 이야기가 이어져요.':'계속 싸우거나 정상 귀환할 수 있어요. 보상은 귀환할 때 받아요.')
        :a.status==='RETURNED'?'정상 귀환했어요. 쌓인 보상을 받았어요.':'전멸해서 이번 모험의 미정산 보상을 잃고 돌아왔어요.';
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},title),h('span',{class:'muted top-note'},active?'모험 중':a.status==='RETURNED'?'귀환 완료':'전멸 귀환')),
        h('div',{class:'adventure-body'},
          h('p',{class:'adventure-head panel'},head),
          h('div',{class:'adventure-party'},...a.party.map(f=>{const o=units.find(u=>u.ownedId===f.ownedId),gain=xp[f.ownedId]??0;
            return h('div',{class:`adv-unit panel ${f.hp<=0?'fainted':''}`},h('img',{src:unitArt(f.speciesId,'front'),alt:''}),
              h('div',{class:'adv-text'},h('b',{},`${f.name} Lv${o?.level??f.level}`),
                h('div',{class:'bar bar-hp',title:`HP ${f.hp}/${f.maxHp}`},h('i',{style:{width:`${Math.round(f.hp/f.maxHp*100)}%`}})),
                h('small',{},`HP ${f.hp} / ${f.maxHp} · ${active?'귀환 때':'받은'} 경험치 +${gain}`)));})),
          h('div',{class:'adventure-actions'},
            active?button('모험 계속',()=>a.activeBattleId?go('battle',{battleId:a.activeBattleId}):pickLead(),{kind:'primary',disabled:busy||!(canFight||a.activeBattleId)}):null,
            active?button('정상 귀환',()=>void doReturn(),{disabled:busy||!!a.activeBattleId}):button('마을로',()=>go('village'),{kind:'primary'})),
          h('p',{class:'muted small'},'모험 중 도망은 70% 확률이에요. 모두 쓰러지면 쌓인 보상을 잃어요(원본 규칙). 수치는 시험값이에요.')));
    }
    render();
    if(params.returnNow&&a.status==='ACTIVE'&&!a.activeBattleId)await doReturn();
  },
});
