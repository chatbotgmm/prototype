// 일반전·랭크전 대기실(원본 NativeRoster60Pvp.java). 대전 편성 → 진행(대기열) → 상대를 찾으면 10초 안에 수락 → 대전.
// 일반전은 30초 동안 사람을 못 찾으면 AI와 붙어요. 랭크는 사람끼리만, 방범대장 Lv.60·출전 대원 Lv.60 이상(원본 규칙).
// 판정·시간은 모두 서버. 이 화면은 1초마다 서버 상태를 확인해 보여 줌.
import {h,button,unitArt,asset} from '../core/dom.js';
import {api,message,type PvpCurrent,type PvpOptions,type RankSummary} from '../core/api.js';
import {go,toast,type Scene} from '../core/scenes.js';

const CONDITION:Record<string,string>={RANK_ACCOUNT_LEVEL_REQUIRED:'방범대장 레벨이 모자라요',RANK_UNIT_LEVEL_REQUIRED:'랭크 출전 대원은 모두 Lv.60 이상이어야 해요',MATCH_POOL_CLASS_CHANGED:'환생 상태가 바뀌었어요. 매칭을 취소하고 다시 참가해 주세요.',
  MATCH_POOL_HISTORY_CHANGED:'환생 상태가 바뀌었어요. 매칭을 취소하고 다시 참가해 주세요.',RANK_QUEUE_CLASS_CHANGED:'랭크 조건이 바뀌었어요. 대기를 취소하고 다시 확인해 주세요.'};
const REASON:Record<string,string>={MATCH_DECLINED:'거절 또는 수락 시간 종료로 대전이 시작되지 않았어요.',MATCH_TIMEOUT:'대전 수락 시간이 지나 종료됐어요.',SERVER_ABORT:'서버가 대전을 종료했어요.'};
export const pvp=():Scene=>{
  let alive=true,timer=0;
  return {
    unmount(){alive=false;clearTimeout(timer);},
    async mount(root,params:{mode?:'normal'|'rank'}={}){
      const mode=params.mode??'normal';
      // 대전 편성이 아직 없으면 아지트 편성을 먼저 보여 줌(진행을 누르면 대전 편성으로 저장). 원본은 편성을 따로 골라야 했어요.
      const home=await api.party().catch(()=>({ownedIds:[] as string[]}));
      let opts:PvpOptions=await api.pvpOptions(),cur:PvpCurrent=await api.pvpCurrent(),rank:RankSummary|null=mode==='rank'?await api.pvpRank().catch(()=>null):null,busy=false,skew=Date.now()-cur.serverNow;
      const scene=h('div',{class:'pvp-scene',style:{backgroundImage:`linear-gradient(rgba(7,19,28,.55),rgba(7,19,28,.82)),url(${asset('ui/bg-harbor.webp')})`}});root.append(scene);
      const act=async(f:()=>Promise<unknown>)=>{if(busy)return;busy=true;render();try{await f();}catch(e){toast(message(e));}try{cur=await api.pvpCurrent();}catch{/**/}busy=false;render();};
      const secs=(at:number)=>Math.max(0,Math.ceil((at+skew-Date.now())/1000));
      const team=()=>{const ids=cur.partyIds?.length?cur.partyIds:opts.partyIds.length?opts.partyIds:home.ownedIds;return ids.map(id=>opts.units.find(u=>u.ownedId===id)).filter(Boolean) as PvpOptions['units'];};
      function statusPanel(){
        const b=cur.battle;
        if(b&&b.status==='ACCEPTING'){
          const left=secs(b.deadline!);
          return h('div',{class:'panel pvp-status'},h('h2',{},'대전 상대를 찾았어요'),h('p',{},`${b.opponentKind==='AI'?'AI 상대':'사람 상대'} · ${b.mode==='rank'?'랭크':'일반'} · 남은 시간 ${left}초`),
            b.accepted?h('p',{class:'muted'},b.opponentAccepted?'곧 시작해요':'상대 수락 대기 중'):h('div',{class:'pvp-actions'},
              button('대전 수락',()=>void act(()=>api.pvpAccept(b,true)),{kind:'primary',disabled:busy}),button('대전 거절',()=>void act(()=>api.pvpAccept(b,false)),{disabled:busy})));}
        if(b&&(b.status==='FINISHED'||b.status==='SETTLED')){
          const reason=b.settlement?.reason as string;
          return h('div',{class:'panel pvp-status'},h('h2',{},REASON[reason]??'대전이 끝났어요'),b.requeued?h('p',{class:'muted'},'수락했던 순서 그대로 다시 기다려요.'):null,
            button('확인',()=>void act(async()=>{if(['MATCH_DECLINED','MATCH_TIMEOUT','SERVER_ABORT'].includes(reason))await api.pvpSettle(b);else go('battle',{battleId:b.battleId,view:b,pvp:true});}),{kind:'primary',disabled:busy}));}
        if(cur.status==='waiting'){
          const waited=Math.max(0,Math.floor((Date.now()-skew-(cur.queuedAt??Date.now()))/1000)),ai=cur.aiAvailableAt?secs(cur.aiAvailableAt):null;
          const cond=cur.matchPoolCondition||cur.rankCondition;
          return h('div',{class:'panel pvp-status'},h('h2',{},'상대를 찾는 중'),h('p',{},`기다린 시간 ${waited}초${ai!==null?ai>0?` · ${ai}초 뒤 AI 상대`:' · AI 상대 준비 중':' · 랭크는 사람끼리만'}`),
            cond?h('p',{class:'warn'},CONDITION[cond]??`확인 필요 · ${cond}`):null,button('매칭 취소',()=>void act(()=>api.pvpCancel()),{disabled:busy}));}
        const elig=opts.rankEligibility,locked=mode==='rank'&&!elig.eligible&&elig.reason==='RANK_ACCOUNT_LEVEL_REQUIRED';
        return h('div',{class:'panel pvp-status'},h('h2',{},mode==='rank'?'랭크게임':'일반게임'),
          h('p',{class:'small'},mode==='rank'?`방범대장 Lv.${opts.commander.level??'?'} / 필요 Lv.60 · 각 대원 Lv.60 이상 · 모두 Lv.30으로 맞춰 싸워요`:'사람과 대전해요. 30초 동안 상대가 없으면 AI와 붙어요. 이기면 경험치 100%, 지면 50%(출전한 대원끼리 나눔).'),
          locked?h('p',{class:'warn'},`랭크 잠금 · 방범대장 Lv.${opts.commander.level??'?'} / 필요 Lv.60`):null,
          button(mode==='rank'?'랭크 진행':'일반 진행',()=>void act(async()=>{await api.pvpParty(team().map(u=>u.ownedId),mode);await api.pvpJoin(mode);}),{kind:'primary',disabled:busy||!team().length||locked}));
      }
      function render(){
        if(!alive)return;
        if(cur.battle&&cur.battle.status==='ACTIVE'){go('battle',{battleId:cur.battle.battleId,view:cur.battle,pvp:true});return;}
        const t=team();
        scene.replaceChildren(
          h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},mode==='rank'?'랭크전':'일반전'),
            h('span',{class:'muted top-note'},rank?`${rank.me.tierName} · ${rank.me.point} LP${rank.me.promotion.active?` · 승급전 ${rank.me.promotion.wins}승 ${rank.me.promotion.losses}패`:''} · ${rank.me.wins}승 ${rank.me.losses}패`:'시험 수치')),
          h('div',{class:'pvp-body'},
            h('section',{class:'panel team-preview'},h('h2',{},'대전 편성'),
              t.length?h('div',{class:'team-row'},...t.map((u,i)=>h('div',{class:'team-mini'},h('img',{src:unitArt(u.speciesId,'front'),alt:''}),h('small',{},`${i===0?'출전':'예비'} · ${u.name} Lv${u.level}${mode==='rank'&&!u.rankEligible?' · Lv.60 미만':''}`)))):h('p',{class:'muted'},'아직 대전 편성이 없어요.'),
              button('편성 바꾸기',()=>go('party',{pvp:mode}),{disabled:cur.status!=='idle'||!!cur.battle})),
            statusPanel()));
      }
      const loop=async()=>{if(!alive)return;try{cur=await api.pvpCurrent();skew=Date.now()-cur.serverNow;}catch{/* 다음에 다시 */}if(!busy)render();timer=window.setTimeout(()=>void loop(),1000);};
      render();timer=window.setTimeout(()=>void loop(),1000);
    },
  };
};
