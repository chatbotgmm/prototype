// 환생(원본 NativeProgression.renderNewReincarnation). 한 번에 한 마리씩 넘겨 보며: Lv1 기본 능력치 전→후, 비용(계정 첫 성공 무료, 그 뒤 땅콩 1개), 확인 창.
// 환생하면 Lv.1 / 99로 돌아가고 경험치 0부터. 제한·초월·불멸·영원 등급만, 필요 레벨 60·70·80·90·99(원본 규칙). 판정은 서버.
import {h,button,unitArt} from '../core/dom.js';
import {api,message,type RebirthPreview,type RebirthCandidate} from '../core/api.js';
import {go,sheet,closeSheet,toast,type Scene} from '../core/scenes.js';
import {statName} from '../core/labels.js';

const REASON:Record<string,string>={REINCARNATION_GRADE_NOT_ALLOWED:'이 등급은 환생할 수 없어요(제한·초월·불멸·영원만)',REINCARNATION_REQUIREMENTS_NOT_MET:'레벨이 모자라요',REINCARNATION_LIMIT:'환생을 5번 모두 했어요',UNIT_UNAVAILABLE:'지금 쓸 수 없는 갈매미예요'};
export const rebirth=():Scene=>({
  async mount(root){
    let info:RebirthPreview=await api.rebirth(),page=0,busy=false;
    // 환생할 수 있는 갈매미를 앞에(같은 판정이면 원래 순서)
    const order=()=>[...info.candidates].sort((a,b)=>Number(b.eligible)-Number(a.eligible));
    const scene=h('div',{class:'rebirth-scene'});root.append(scene);
    const confirm=(c:RebirthCandidate)=>sheet('환생',h('p',{},`${c.name} · Lv.1 / 99로 초기화\n${c.accountFreeAvailable?'계정 첫 성공 무료':`땅콩 ${c.costPeanut}개 사용`}\n환생할까요?`),
      [button('취소',closeSheet),button('확인',async()=>{if(busy)return;busy=true;closeSheet();try{const r=await api.rebirthConfirm(c,info.catalogVersion);toast(`${r.name} 환생 ${r.preview!.next.reincarnation}회 완료!`);}catch(e){toast(message(e));}info=await api.rebirth();busy=false;render();},{kind:'primary'})]);
    function render(){
      const list=order();page=Math.min(page,Math.max(0,list.length-1));const c=list[page];
      const body=!c?h('p',{class:'panel rebirth-empty'},'환생 미리보기 대상이 없어요.'):h('div',{class:'rebirth-body'},
        h('div',{class:'panel rebirth-art'},h('img',{src:unitArt(c.speciesId,'front'),alt:''}),h('b',{},c.name)),
        h('div',{class:'panel rebirth-info'},
          c.preview?h('div',{},
            h('p',{class:'rebirth-head'},`지금 Lv.${c.preview.beforeLevel} → 환생 ${c.preview.next.reincarnation}회 · Lv.1 / ${c.preview.next.maxLevel} · XP 0`),
            h('table',{class:'stat-table'},h('tbody',{},...(['hp','mp','durability','statusResistance','speed'] as const).map(k=>{const a=c.preview!.baselineLevelOneStats[k],b=c.preview!.afterLevelOneStats[k];
              return h('tr',{},h('th',{},statName[k]),h('td',{},String(a)),h('td',{},'→'),h('td',{class:b>a?'up':''},String(b)));}))),
            h('p',{class:'muted small'},'Lv1 기본 능력치의 10%×환생 횟수(반올림)를 체력·MP·내구에 더해요(원본 규칙).'))
            :h('p',{},'기본 능력치 또는 환생 정책 준비 중'),
          h('p',{class:'small'},c.costPeanut===undefined?'':c.accountFreeAvailable?'계정 첫 성공 1회 무료':`비용: 땅콩 ${c.costPeanut}개 (가진 땅콩 ${info.peanut}개)`),
          button(c.eligible?'환생 확인':c.requiredLevel?`필요 Lv.${c.requiredLevel} · ${REASON[c.reason]??'대상 조건 미충족'}`:REASON[c.reason]??'환생 정보 준비 중',()=>confirm(c),{kind:c.eligible?'primary':undefined,disabled:!c.eligible||busy,cls:'rebirth-go'})));
      scene.replaceChildren(
        h('header',{class:'top-bar'},button('마을',()=>go('village'),{icon:'icon-back'}),h('h1',{},'환생'),h('span',{class:'muted top-note'},`땅콩 ${info.peanut}개 · 시험 수치`)),body,
        ...(list.length>1?[h('div',{class:'pager'},button('이전',()=>{page=(page-1+list.length)%list.length;render();}),h('span',{},`${page+1} / ${list.length}`),button('다음',()=>{page=(page+1)%list.length;render();}))]:[]));
    }
    render();
  },
});
