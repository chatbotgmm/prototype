// 전투. 원본 배치(ui-v3 전투 캡처): 위 막대(홈·턴 안내), 왼쪽 전장(상대 칸 왼쪽 위·내 칸 오른쪽 아래), 오른쪽 「행동 선택」 6버튼.
// 명령 이름·순서: NativeRoster60Battle.java 461줄. 판정은 서버, 화면은 받은 사건(rounds)을 차례로 보여 주기만 함.
import {h,button,unitArt,asset} from '../core/dom.js';
import {api,message,ApiError,type BattleView,type Fighter,type Skill} from '../core/api.js';
import {go,toast,sheet,closeSheet,type Scene} from '../core/scenes.js';
import {elementName,defenseName,resultLabel} from '../core/labels.js';

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export const battle=():Scene=>{
  let alive=true;
  return {
    unmount(){alive=false;},
    async mount(root,params:{battleId:string;view?:BattleView}){
      let view=params.view??await api.battle(params.battleId),busy=false,menu:'root'|'skills'|'item'|'switch'|'revive'='root';
      const scene=h('div',{class:'battle-scene'});root.append(scene);
      const hint=h('p',{class:'turn-hint',role:'status','aria-live':'polite'});
      const field=h('div',{class:'battle-field',style:{backgroundImage:`url(${asset('ui/bg-harbor.webp')})`}});
      const commands=h('div',{class:'command-panel np-panel'});
      scene.append(h('header',{class:'top-bar battle-top'},button('홈',()=>go('village'),{icon:'icon-back'}),hint),h('div',{class:'battle-body'},field,commands));
      // 화면에 보이는 값(사건을 차례로 보여 줄 때 바뀜)
      type Shown={self:Fighter;enemy:Fighter};
      let shown:Shown={self:structuredClone(view.state.self),enemy:structuredClone(view.state.enemy)};
      const bar=(cur:number,max:number,kind:'hp'|'mp')=>h('div',{class:`bar bar-${kind}`},h('i',{style:{width:`${Math.max(0,Math.min(100,cur/Math.max(1,max)*100))}%`}}));
      const status=(f:Fighter,who:'enemy'|'self')=>{
        const intel=view.state.opponentIntel;
        return h('div',{class:`status np-hp status-${who}`},
          h('div',{class:'status-name'},`${who==='enemy'?'상대':'출전'} · ${f.name} Lv${f.level}`),
          h('div',{class:'status-row'},h('span',{},'HP'),bar(f.hp,f.stats.hp,'hp'),h('span',{class:'num'},`${f.hp}/${f.stats.hp}`)),
          h('div',{class:'status-row'},h('span',{},'MP'),bar(f.mp,f.stats.mp,'mp'),h('span',{class:'num'},`${f.mp}/${f.stats.mp}`)),
          who==='enemy'?h('div',{class:'status-intel'},`공격 관찰 ${intel.knownDefenseCount} / ${intel.totalDefenseCount}${intel.statsKnown?'':' · 능력치는 한 턴 뒤 공개'}`):null);
      };
      const drawField=(fx?:{who:'self'|'enemy';kind:'hit'|'act'})=>{
        field.replaceChildren(
          h('img',{class:`sprite sprite-enemy ${fx?.who==='enemy'?`fx-${fx.kind}`:''} ${shown.enemy.hp<=0?'fainted':''}`,src:unitArt(shown.enemy.speciesId,'front'),alt:shown.enemy.name}),
          h('img',{class:`sprite sprite-self ${fx?.who==='self'?`fx-${fx.kind}`:''} ${shown.self.hp<=0?'fainted':''}`,src:unitArt(shown.self.speciesId,'rear'),alt:shown.self.name}),
          status(shown.enemy,'enemy'),status(shown.self,'self'));
      };
      const reaction=(element:string)=>view.state.opponentIntel.defenses[element]??'unknown';
      const skillButton=(s:Skill,isAttack=false)=>{const r=reaction(s.element),short=s.mpCost>shown.self.mp;
        return button([h('b',{},s.name),h('small',{},`${elementName[s.element]} · 위력 ${s.power} · MP ${s.mpCost}`),r!=='unknown'?h('span',{class:`tag res-${r}`},defenseName[r]):null],
          ()=>void send(isAttack?{kind:'attack'}:{kind:'skill',skillId:s.id}),{kind:'navy',cls:'skill-btn',disabled:short||busy,title:short?'MP가 모자라요':undefined});};
      const drawCommands=()=>{
        const s=view.state,self=s.self,finished=view.status!=='ACTIVE';
        const back=button('뒤로',()=>{menu='root';drawCommands();},{cls:'cmd-back'});
        let body:Node[];
        if(finished){body=[h('div',{class:'finish'},h('b',{class:`result-${s.outcome}`},resultLabel(s.outcome)),button('결과 보기',()=>void finish(),{kind:'primary',cls:'big'}))];}
        else if(self.hp<=0||menu==='switch'){const forced=self.hp<=0;
          body=[h('h2',{},forced?'쓰러졌어요 · 교체할 대원':'대원 교체'),...s.reserves.map(r=>button([h('b',{},`${r.name} Lv${r.level}`),h('small',{},`HP ${r.hp}/${r.stats.hp}`)],()=>void send({kind:'switch',targetOwnedId:r.ownedId}),{cls:'skill-btn',disabled:r.hp<=0||busy})),forced?null:back].filter(Boolean) as Node[];}
        else if(menu==='skills')body=[h('div',{class:'menu-head'},h('h2',{},'기술'),back),h('div',{class:'skill-grid'},skillButton(self.attack,true),...self.skills.map(sk=>skillButton(sk)))];
        else if(menu==='item'){const inv=new Map(view.inventory.map(i=>[i.itemId,i.count]));
          body=[h('h2',{},'아이템'),...Object.entries(view.itemDefinitions).filter(([id])=>id!=='clear').map(([id,it])=>button([h('b',{},`${it.name} ×${inv.get(id)??0}`),h('small',{},it.desc)],
            ()=>{if(it.revive){menu='revive';drawCommands();}else void send({kind:'item',itemId:id});},{cls:'skill-btn',disabled:!(inv.get(id))||busy})),back];}
        else if(menu==='revive'){const down=[s.self,...s.reserves].filter(f=>f.hp<=0);
          body=[h('h2',{},'회복할 대원 선택 · 전투불능만'),...(down.length?down.map(f=>button(`${f.name} Lv${f.level}`,()=>void send({kind:'item',itemId:'feather',targetOwnedId:f.ownedId}),{cls:'skill-btn',disabled:busy})):[h('p',{class:'muted'},'쓰러진 대원이 없어요.')]),back];}
        else body=[h('h2',{},'행동 선택'),h('div',{class:'cmd-grid'},
          button('공격',()=>void send({kind:'attack'}),{kind:'attack',icon:'icon-attack',disabled:busy}),
          button('기술',()=>{menu='skills';drawCommands();},{kind:'attack',icon:'icon-goldenstrike',disabled:busy}),
          button('집중',()=>void send({kind:'focus'}),{kind:'switch',icon:'icon-shield',disabled:busy}),
          button('아이템',()=>{menu='item';drawCommands();},{kind:'item',icon:'icon-item',disabled:busy||!!view.disabledCommands.item}),
          button('교체',()=>{menu='switch';drawCommands();},{kind:'switch',icon:'icon-switch',disabled:busy||!s.reserves.some(r=>r.hp>0)}),
          button('도망치기',()=>{const adv=s.mode==='adventure';sheet(adv?'모험 도망':'항복',h('p',{},adv?'도망칠까요? 성공 확률은 70%예요.':'항복할까요? 패배로 끝나고 경험치는 없어요.'),
            [button('취소',closeSheet),button(adv?'도망치기':'항복하기',()=>{closeSheet();void send({kind:'escape'});},{kind:'primary'})]);},{kind:'surrender',icon:'icon-surrender',disabled:busy||!!view.disabledCommands.escape}))];
        commands.replaceChildren(...body);
      };
      const setHint=(text:string)=>{hint.textContent=text;};
      const idle=()=>setHint(view.status==='ACTIVE'?(view.state.self.hp<=0?`턴 ${view.state.turn+1} · 교체할 대원을 고르세요`:`턴 ${view.state.turn+1} · 행동을 선택하세요`):`${resultLabel(view.state.outcome)} · 결과를 확인하세요`);
      // 새 사건을 하나씩 보여 주기
      const play=async(prev:BattleView,next:BattleView)=>{
        const fresh=next.state.rounds.slice(prev.state.rounds.length).flatMap(r=>r.events);
        const pool=[prev.state.self,...prev.state.reserves,next.state.self,...next.state.reserves];
        const nameOf=(who:string)=>who==='self'?shown.self.name:shown.enemy.name;
        const skillOf=(f:Fighter,id:string)=>[f.attack,...f.skills].find(s=>s.id===id);
        for(const e of fresh){if(!alive)return;
          if(e.kind==='skill'){const actor=e.actor==='self'?shown.self:shown.enemy,target=e.target==='attacker'?actor:(e.actor==='self'?shown.enemy:shown.self),sk=skillOf(actor,e.skillId);
            actor.mp=Math.max(0,actor.mp-(sk?.mpCost??0));setHint(`${actor.name}의 ${sk?.name??'공격'}!`);drawField({who:e.actor,kind:'act'});await wait(380);
            target.hp=Math.max(0,target.hp-e.damage);
            setHint(`${target.name}에게 ${e.damage} 피해${e.reflected?' (반사)':''} · ${defenseName[e.defense]??''}`);drawField({who:target===shown.self?'self':'enemy',kind:'hit'});await wait(620);}
          else if(e.kind==='focus'){const a=e.actor==='self'?shown.self:shown.enemy;a.mp+=e.recovered;setHint(`${nameOf(e.actor)}이(가) 집중해서 MP ${e.recovered} 회복`);drawField();await wait(600);}
          else if(e.kind==='switch'||e.kind==='forced-switch'){const inn=pool.find(f=>f.ownedId===e.to);if(inn)shown.self=structuredClone(next.state.self.ownedId===e.to?next.state.self:inn);setHint(`${shown.self.name} 출전!`);drawField();await wait(600);}
          else if(e.kind==='item'){const it=view.itemDefinitions[e.itemId];if(e.targetOwnedId===shown.self.ownedId)shown.self.hp+=e.recovered;setHint(`${it?.name??'아이템'} 사용 · 체력 ${e.recovered} 회복`);drawField();await wait(600);}
          else if(e.kind==='surrender'){setHint('항복했어요.');await wait(500);}
          else if(e.kind==='escape-success'){setHint('도망쳤어요!');await wait(500);}
          else if(e.kind==='escape-failed'){setHint('도망치지 못했어요!');await wait(600);}
        }
      };
      const send=async(action:Record<string,unknown>)=>{
        if(busy)return;busy=true;drawCommands();
        const prev=view;
        try{const next=await api.act(view,action);await play(prev,next);view=next;menu='root';}
        catch(e){toast(message(e));if(e instanceof ApiError&&e.code==='STALE_REVISION')view=await api.battle(view.battleId);}
        busy=false;shown={self:structuredClone(view.state.self),enemy:structuredClone(view.state.enemy)};drawField();drawCommands();idle();
      };
      const finish=async()=>{
        if(busy)return;busy=true;
        try{const settled=view.status==='SETTLED'?view:await api.settle(view);go('result',{view:settled});}catch(e){toast(message(e));busy=false;}
      };
      drawField();drawCommands();idle();
    },
  };
};
