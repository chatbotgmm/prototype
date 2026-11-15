// 마을 위에 뜨는 이야기 창(원본 NativeVillageStoryOverlay.java + NativeRoster60StoryController.java).
// 마을은 그대로 보이고(엷게 어둡게), 아래쪽에 초상(34%) + 대화 칸(66%). 탐험·기록은 초상 없이 목록.
// 열리는 곳: 석상(메인 이야기) · 주민(부탁) · 기록소 「이야기 기록」 · 선착장 「탐험」「스토리 외부 출항」.
// 진행 값(의뢰·석상 단계·흑화 재료)은 서버만 정하고, 이 창은 받은 상태를 보여 주고 요청만 보냄.
import {h,button,asset,unitArt} from '../core/dom.js';
import {api,message,type StoryState,type StoryQuest} from '../core/api.js';
import {go,toast} from '../core/scenes.js';
import type {Departure} from '../core/expedition.js';

export type StoryMode={kind:'statue'}|{kind:'resident';id:string}|{kind:'history'}|{kind:'departure'}|{kind:'exploration'};
const RESIDENT_ART:Record<string,string>={blacksmith:'village/blacksmith.webp',merchant:'village/merchant.webp',librarian:'village/librarian.webp',guard:'village/patrol.webp'};

/** 메인 이야기(원본 mainQuest): 지금 의뢰가 메인이면 그것, 아니면 진행할 수 있는 첫 메인 의뢰 */
const mainQuest=(s:StoryState)=>s.currentQuest?.kind==='main'?s.currentQuest:s.quests.find(q=>q.kind==='main'&&['AVAILABLE','ACTIVE','READY'].includes(q.status))??null;
/** 출항할 수 있는 의뢰: 진행 중이고(출항 가능·전투 중·모험 중 중 하나) */
const departable=(q:StoryQuest|null)=>!!q&&q.status==='ACTIVE'&&(q.canDepart||!!q.battleId||!!q.adventureId);

export function openStory(mode:StoryMode,onClose:()=>void=()=>{}){
  document.getElementById('story-overlay')?.remove();
  const list=mode.kind==='exploration'||mode.kind==='history';
  const art=h('div',{class:'story-art'}),name=h('div',{class:'story-name'}),speech=h('div',{class:'story-speech'}),notice=h('div',{class:'story-notice',role:'status'}),choices=h('div',{class:`story-choices ${list?'story-list':''}`});
  const panel=h('div',{class:`story-panel ${list?'story-panel-wide':''}`},name,speech,notice,choices);
  const close=button('×',()=>void closeAll(),{cls:'story-close',title:'닫기'});
  const root=h('div',{id:'story-overlay',class:'story-overlay overlay-layer'},h('div',{class:'story-row'},list?null:art,panel),close);
  document.body.append(root);
  let state:StoryState|null=null,busy=false,typing=0,lineKey='',whole='',letters=0;
  const finishTyping=()=>{if(!typing)return false;clearTimeout(typing);typing=0;letters=whole.length;speech.textContent=whole;speech.dataset.typing='0';return true;};
  const say=(key:string,text:string)=>{clearTimeout(typing);typing=0;whole=text;const same=key===lineKey;lineKey=key;letters=same?text.length:0;speech.textContent=text.slice(0,letters);
    const tick=()=>{letters=Math.min(whole.length,letters+2);speech.textContent=whole.slice(0,letters);typing=letters<whole.length?window.setTimeout(tick,24):0;speech.dataset.typing=typing?'1':'0';};if(letters<text.length)tick();else speech.dataset.typing='0';};
  const action=(label:string,run:()=>void|Promise<void>,primary=false)=>choices.append(button(label,()=>{if(busy)return;if(finishTyping())return;void run();},{kind:primary?'primary':undefined,cls:'story-btn'}));
  const portrait=(id:string)=>{art.replaceChildren();if(!id)return;
    const src=id==='hero'?unitArt('u01','front'):RESIDENT_ART[id]?asset(RESIDENT_ART[id]):null; // 원본: 주인공은 u01, 주민은 마을 그림. 다른 화자는 만들어 넣지 않음
    if(src)art.append(h('img',{src,alt:id==='hero'?'주인공 갈매미맨':name.textContent??''}));};
  const send=async(f:()=>Promise<StoryState>)=>{busy=true;notice.textContent='저장하는 중…';try{state=await f();render();}catch(e){notice.textContent=message(e);if(String((e as any)?.code).includes('STALE')){state=await api.story();render();}}finally{busy=false;}};
  const openQuest=(questId:string,phase:'intro'|'return'|'replay')=>send(()=>api.storyOpen(state!,questId,phase));
  const leaveTo=(scene:string,params:unknown)=>{root.remove();go(scene,params);};
  const departTo=(d:Departure)=>leaveTo('party',{depart:d});
  /** 의뢰 이어 가기(원본 continueQuest): 전투 중이면 전투로, 모험 중이면 모험 화면으로, 아니면 출항 편성 */
  const continueQuest=(q:StoryQuest)=>{
    if(q.battleId)return leaveTo('battle',{battleId:q.battleId});
    if(q.adventureId)return leaveTo('adventure',{adventureId:q.adventureId});
    departTo({type:'quest',questId:q.id,title:q.title,recommended:q.recommendedLevel});
  };
  async function closeAll(){
    if(state?.scene&&!busy){try{await api.storyClose(state);}catch{/* 닫기 실패는 다음에 열 때 이어짐 */}}
    clearTimeout(typing);root.remove();onClose();
  }
  const resident=(id:string)=>state!.residents.find(r=>r.id===id);
  function render(){
    const s=state!;choices.replaceChildren();notice.textContent='';
    if(s.scene&&(mode.kind==='statue'||mode.kind==='resident'||mode.kind==='history'))return scene(s);
    if(mode.kind==='exploration')return exploration(s);
    if(mode.kind==='departure')return departure(s);
    if(mode.kind==='history')return history(s);
    if(mode.kind==='resident'){
      const npc=resident(mode.id);if(!npc){say('none','요청 주민 확인 필요');action('확인',closeAll);return;}
      name.textContent=`${npc.name} · ${npc.role}`;portrait(npc.id);say(`daily:${npc.id}`,npc.dailyDialogue);
      if(npc.status==='AVAILABLE')action('부탁 듣기',()=>openQuest(npc.questId!,'intro'),true);
      else if(npc.status==='READY')action('귀환 이야기',()=>openQuest(npc.questId!,'return'),true);
      else if(npc.status==='ACTIVE'){notice.textContent='진행 중인 부탁이에요. 외부 출발은 배에서 준비해 주세요.';}
      else if(npc.status==='LOCKED')notice.textContent='아직 부탁이 없어요. 이야기를 더 진행하면 들을 수 있어요.';
    }else{
      const q=mainQuest(s);name.textContent='부서진 석상';portrait('');
      say(`statue:${q?.id??''}`,q?q.title:'현재 이어갈 이야기가 없어요.');
      if(q?.status==='AVAILABLE')action('이야기 듣기',()=>openQuest(q.id,'intro'),true);
      else if(q?.status==='READY')action('귀환 이야기',()=>openQuest(q.id,'return'),true);
      else if(q?.status==='ACTIVE')notice.textContent='외부 출발은 배에서 준비해 주세요.';
      if(!q&&s.nextStoryHint)notice.textContent=s.nextStoryHint;
      notice.textContent+=`${notice.textContent?' · ':''}석상 ${s.statue.stage}단계 · 조각 ${s.statue.fragments}`;
    }
    if(!choices.childElementCount)action('확인',closeAll);
  }
  function scene(s:StoryState){
    const sc=s.scene!,line=sc.line,speakerId=line.speakerId==='hero'||(!line.speakerId&&line.speakerName==='주인공')?'hero':resident(line.speakerId)?line.speakerId:'';
    name.textContent=line.speakerName;portrait(speakerId);say(`${sc.id}:${sc.cursor}`,line.text);
    const accept=sc.last&&sc.phase==='intro';
    action('나중에',async()=>{busy=true;try{state=await api.storyClose(s);render();}catch(e){notice.textContent=message(e);}finally{busy=false;}});
    action(accept?'의뢰 수락':'다음',()=>send(()=>accept?api.storyAccept(s,sc.questId):api.storyAdvance(s)),true);
  }
  function history(s:StoryState){
    name.textContent='이야기 기록';portrait('');say('history','마친 이야기를 다시 읽을 수 있어요.');
    for(const r of s.history)action(r.title,()=>openQuest(r.questId,'replay'));
    if(!s.history.length){notice.textContent='아직 완료한 이야기 기록이 없어요.';action('확인',closeAll);}
  }
  function departure(s:StoryState){
    name.textContent='외부 출항';portrait('');const q=s.currentQuest,ok=q?.kind==='main'&&departable(q);
    say(`departure:${ok}`,ok?`${q!.title}\n대원을 확인한 뒤 출항할 수 있어요.`:'지금 출항 가능한 메인 스토리가 없어요. 석상에서 이야기를 먼저 확인해 주세요.');
    if(ok)action('출항 준비',()=>continueQuest(q!),true);
    if(!choices.childElementCount)action('확인',closeAll);
  }
  function exploration(s:StoryState){
    name.textContent='탐험 출항';say('exploration','자유롭게 탐험하거나, 수락한 주민 부탁을 선택해 출항하세요.');
    action('자유 탐험',async()=>{const free=(await api.adventures()).adventures.find(a=>a.kind==='free');if(free)leaveTo('adventure',{adventureId:free.adventureId});else departTo({type:'free'});});
    const m=s.materialAdventure;
    if(m)action(m.activeBattleId?'재료 모험 이어가기':'재료 모험 확인',()=>m.activeBattleId?leaveTo('battle',{battleId:m.activeBattleId}):leaveTo('adventure',{adventureId:m.adventureId}));
    else if(s.adventures.length)action('흑화 갈매미 모험',()=>{
      choices.replaceChildren();say('material','어느 흑화 갈매미를 찾아 나설까요? 이기면 어둠의 새우Gang을 얻어요.');
      for(const e of s.adventures)action(`${e.name} · Lv${e.level}`,()=>departTo({type:'material',encounterId:e.id,level:e.level}));
      action('뒤로',()=>render());});
    for(const q of s.quests.filter(q=>q.kind==='resident'&&departable(q)))
      action(`${q.battleId||q.adventureId?'이어서 진행':'부탁 출항'} · ${q.title}`,()=>continueQuest(q));
    notice.textContent='주민 부탁은 해당 부탁을 선택해야 진행돼요. 자유 탐험과는 별개예요.';
  }
  (async()=>{notice.textContent='이야기를 불러오는 중…';try{state=await api.story();render();}catch(e){notice.textContent=message(e);toast(message(e));}})();
}
