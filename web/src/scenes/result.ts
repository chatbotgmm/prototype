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
    const adventure=!!v.adventureId,lost=s?.adventureStatus==='LOST',drop=s?.story?.darkGangAwarded??0;
    // 모험 안 전투: 경험치는 귀환 때 받음(원본 NativeRoster60Battle 정산 문구). 전멸이면 쌓인 보상을 잃음.
    const summary=v.state.surrendered?'항복하면 경험치가 없어요.':adventure?(lost?'전멸로 이번 모험의 미정산 보상을 잃었어요.':`모험 보상은 쌓아 두고, 정상 귀환할 때 받아요. 이번 전투 +${s?.xpEscrowed??0}${s?.xpDiscarded?` · 최대 레벨이라 ${s.xpDiscarded} 버림`:''}`)
      :`받은 경험치 ${s?.xpAwarded??0}${s?.xpDiscarded?` · 최대 레벨이라 ${s.xpDiscarded} 버림`:''}`;
    // 대전 결과(원본 NativeRoster60PvpBattle 문구): 끝난 이유, 대원 경험치, 방범대장, 점수 변화, 패배 안내
    if(v.pvp){
      const reasonText:Record<string,string>={SURRENDER:v.state.outcome==='win'?'상대가 항복했어요.':'항복으로 끝났어요.',TIMEOUT:'제한 시간이 지나 끝났어요.',DOUBLE_TIMEOUT:'양쪽의 제한 시간이 지나 대전이 끝났어요.',SERVER_ABORT:'서버가 대전을 종료했어요.'};
      const fbText:Record<string,string>={REFLECTED_KO:'내 기술이 반사돼 전투불능이 됐어요.',ENEMY_FIRST_KO:'상대가 먼저 행동해 전투불능이 됐어요.',DIRECT_KO:'상대 기술로 전투불능이 됐어요.',INSUFFICIENT_RECORD:'기록이 부족해 패배 원인을 확인하기 어려워요.',
        DISCONNECTED:'연결이 끊겨 대전이 끝났어요.',TURN_INPUT_TIMEOUT:'제한 시간 안에 행동을 고르지 않았어요.',SERVER_OBSERVATION_GAP:'서버가 연결을 확인하지 못해 끝났어요.',SURRENDER:'항복으로 끝났어요.'};
      const nextText:Record<string,string>={TRY_DIFFERENT_ELEMENT:'다음 시도: 다른 속성 기술을 살펴보세요.',TRY_SWITCH_OR_HEAL_EARLIER:'다음 시도: 더 일찍 교체하거나 회복해 보세요.',REVIEW_LAST_TURN:'다음 시도: 마지막 턴의 행동을 확인해 보세요.',
        CHECK_CONNECTION_AND_REPLAY:'다음 시도: 연결 상태와 전투 기록을 확인해 보세요.',CHECK_TURN_DEADLINE_AND_REPLAY:'다음 시도: 제한 시간 안에 행동을 선택해 보세요.',REVIEW_REPLAY:'다음 시도: 확인할 수 있는 전투 기록을 살펴보세요.'};
      const r=s?.rating,fb=s?.lossFeedback,cr=s?.commanderReward,xpRows=(s?.normalXp?.units??[]).filter((u:any)=>u.status!=='NOT_ENTERED');
      const rateLine=!r?null:v.mode==='rank'?`랭크 ${r.lpDelta>=0?'+':''}${r.lpDelta} LP · 지금 ${r.after.lp} LP${r.promotionChange==='STARTED'?' · 승급전 시작!':r.promotionChange==='PROMOTED'?' · 승급!':r.promotionChange==='DEMOTED'?' · 강등':r.promotionChange==='FAILED'?' · 승급 실패':''}`
        :`일반전 점수 ${r.mmrDelta>=0?'+':''}${Math.round(r.mmrDelta)}`;
      root.append(h('div',{class:'result-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.5),rgba(7,19,28,.85)),url(${asset('ui/bg-harbor.webp')})`}},
        h('div',{class:'panel result-panel'},
          h('h1',{class:`result-title result-${v.state.outcome}`},v.state.outcome==='draw'?'무승부':resultLabel(v.state.outcome)),
          h('p',{class:'muted'},`${v.mode==='rank'?'랭크전':'일반전'} · ${v.opponentKind==='AI'?'AI 상대':'사람 상대'}${reasonText[s?.reason]?` · ${reasonText[s.reason]}`:''}`),
          v.mode==='normal'?h('p',{},s?.xpAwarded?`대원 경험치 +${s.xpAwarded}${s.xpDiscarded?` · 상한 초과 ${s.xpDiscarded} 버림`:''}`:'대원 경험치 없음'):null,
          xpRows.length?h('div',{class:'xp-list'},...xpRows.map((u:any)=>{const o=units.find(x=>x.ownedId===u.ownedId),p=u.xpProgress;return h('div',{class:'xp-row'},o?h('img',{src:unitArt(o.speciesId,'front'),alt:''}):null,
            h('div',{class:'xp-text'},h('b',{},`${o?.name??''} Lv${p?.before.level??'?'}${p&&p.after.level>p.before.level?` → Lv${p.after.level}`:''}`),p?h('div',{class:'bar bar-xp'},h('i',{style:{width:`${pct(p.after)}%`}})):null,h('small',{},`+${u.appliedXp} 경험치`)));})):null,
          cr?h('p',{class:'small'},`방범대장 XP +${cr.xpAwarded}${cr.replayed?' · 기록 완료':''}`):null,
          rateLine?h('p',{class:'small'},rateLine):null,
          fb?h('p',{class:'small warn'},`${fbText[fb.explanationKey]??''} ${nextText[fb.nextAttemptKey]??''}`):null,
          h('p',{class:'muted small'},v.mode==='rank'?'랭크전은 대원 경험치가 없고 모두 Lv.30으로 싸워요(원본 규칙). 수치는 시험값이에요.':'정상 승리 100%·패배 50%를 실제로 나간 대원끼리 나눠요(원본 규칙). 수치는 시험값이에요.'),
          h('div',{class:'result-actions'},button('다시 대전',()=>go('pvp',{mode:v.mode}),{kind:'primary'}),button('마을로',()=>go('village'))))));
      return;
    }
    const actions=adventure?(lost?[button('마을로',()=>go('village'),{kind:'primary'})]
        :v.story?.questId?[button('귀환하기',()=>go('adventure',{adventureId:v.adventureId,returnNow:true}),{kind:'primary'}),button('모험 확인',()=>go('adventure',{adventureId:v.adventureId}))]
        :[button('모험 확인',()=>go('adventure',{adventureId:v.adventureId}),{kind:'primary'})])
      :[button('마을로',()=>go('village'),{kind:'primary'})];
    root.append(h('div',{class:'result-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.5),rgba(7,19,28,.85)),url(${asset('ui/bg-harbor.webp')})`}},
      h('div',{class:'panel result-panel'},
        h('h1',{class:`result-title result-${v.state.outcome}`},resultLabel(v.state.outcome)),
        h('p',{class:'muted'},summary),
        drop?h('p',{class:'drop'},`어둠의 새우Gang +${drop} · 계정에 지급`):null,
        v.story?.questId&&s?.story?.objectiveProgressed?h('p',{class:'small'},'의뢰 목표를 달성했어요. 귀환한 뒤 이야기를 이어 들어요.'):null,
        ...(adventure?[]:rows.map((u:any)=>{const o=units.find(x=>x.ownedId===u.ownedId),p=u.xpProgress;
          return h('div',{class:'xp-row'},o?h('img',{src:unitArt(o.speciesId,'front'),alt:''}):null,
            h('div',{class:'xp-text'},h('b',{},`${o?.name??''} Lv${p?.before.level??'?'}${p&&p.after.level>p.before.level?` → Lv${p.after.level}`:''}`),
              p?h('div',{class:'bar bar-xp'},h('i',{style:{width:`${pct(p.after)}%`}})):null,h('small',{},`+${u.appliedXp} 경험치`)));})),
        h('p',{class:'muted small'},adventure?'모험 전투는 실제로 나간 대원이 나눠 받고, 일반 모험은 대기 대원도 절반을 받아요(원본 규칙). 수치는 시험값이에요.'
          :v.state.mode==='story'?'스토리 전투는 실제로 나간 대원이 나눠 받아요(원본 규칙). 수치는 시험값이에요.':'경험치는 처음 출전한 대원만 받아요(원본 규칙). 수치는 시험값이에요.'),
        h('div',{class:'result-actions'},...actions))));
  },
});
