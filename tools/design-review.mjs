// 디자인 검토(커밋 전에 꼭): 시험 서버(npm run dev)를 켠 뒤 실행
//   node tools/design-review.mjs <결과 폴더> [로그인 코드 첫 번호]
// 가로 화면 휴대폰 915×412, 큰 화면 1280×720(+작은 휴대폰 780×360)에서 첫 화면→로그인→마을→건물 창→편성→상대 고르기→전투→기술→끝까지→결과를 찍고,
// 숫자 검사(화면 넘침·화면 밖 요소·48px 미만 터치 영역·형제 버튼 겹침·글자 잘림·게임 글꼴 적용)를 findings.json에 남긴다.
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright'); // 이 환경에 미리 깔린 Playwright
import {mkdirSync,writeFileSync} from 'node:fs';
const out=process.argv[2]??'review',B='http://127.0.0.1:3999/proto/';
let code=Number(process.argv[3]??100001);
mkdirSync(out,{recursive:true});
const findings=[];
const check=async(p,label)=>{
  const r=await p.evaluate(()=>{
    const vis=e=>{const s=getComputedStyle(e),b=e.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&b.width>0&&b.height>0&&!e.closest('[aria-hidden="true"]');};
    const issues=[];const W=innerWidth,H=innerHeight;
    if(document.documentElement.scrollWidth>W+1)issues.push('가로 넘침');
    if(document.documentElement.scrollHeight>H+1)issues.push('세로 넘침');
    const clickable=[...document.querySelectorAll('button,a,input')].filter(vis);
    // 마을 세계 안의 건물은 화면 밖에 있는 게 정상(끌어서 봄). 화면 고정 UI만 검사
    const fixed=clickable.filter(e=>!e.closest('.village-world'));
    for(const e of fixed){const b=e.getBoundingClientRect(),t=(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,20);
      // 옆으로 넘기는 줄(캐러셀) 안의 요소는 넘겨서 보는 게 정상: 줄 자체가 화면 안이고 실제로 넘겨지는지만 확인
      const scroller=e.closest('.cand-row');
      if(scroller){const r=scroller.getBoundingClientRect();if(r.right>W+1||r.left<-1)issues.push('넘기는 줄이 화면 밖');if(b.right>r.right+1&&scroller.scrollWidth<=scroller.clientWidth)issues.push(`넘길 수 없는데 잘림: ${t}`);continue;}
      if(b.right>W+1||b.bottom>H+1||b.left<-1||b.top<-1)issues.push(`화면 밖: ${t}`);
      if(b.width<47.5||b.height<47.5){if(!e.closest('.sheet-body')||b.height<44)issues.push(`터치 영역 작음 ${Math.round(b.width)}×${Math.round(b.height)}: ${t}`);}}
    const groups=new Map();for(const e of fixed){const k=e.parentElement;groups.set(k,[...(groups.get(k)||[]),e]);}
    for(const list of groups.values())for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i].getBoundingClientRect(),b=list[j].getBoundingClientRect();
      if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)issues.push(`겹침: ${list[i].textContent.trim().slice(0,12)} / ${list[j].textContent.trim().slice(0,12)}`);}
    for(const e of [...document.querySelectorAll('h1,h2,b,small,span,p,button')].filter(vis)){if(e.closest('.village-world'))continue;
      if(e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).overflow!=='visible')issues.push(`글자 잘림: ${e.textContent.trim().slice(0,16)}`);}
    const fixedBoxes=[...document.querySelectorAll('.village-hud > *, .village-nav .btn, .village-guide > *')].map(e=>e.getBoundingClientRect());
    for(const pl of document.querySelectorAll('.village-world .v-plate')){const r=pl.getBoundingClientRect();if(r.right<0||r.left>W)continue;
      for(const f of fixedBoxes)if(r.left<f.right&&f.left<r.right&&r.top<f.bottom&&f.top<r.bottom)issues.push(`이름판이 고정 UI와 겹침: ${pl.textContent.trim().slice(0,10)}`);}
    const fontOk=document.fonts.check('16px Jua')&&document.fonts.check('16px "Gowun Dodum"');
    if(!fontOk)issues.push('게임 글꼴 미적용');
    return issues;
  });
  findings.push({label,issues:[...new Set(r)]});console.log(label,r.length?r:'통과');
};
const playToFinish=async(p)=>{
  for(let t=0;t<120;t++){
    await p.waitForFunction(()=>!document.querySelector('.command-panel button[disabled]')||document.querySelector('.finish'),null,{timeout:15000}).catch(()=>{});
    if(await p.$('.finish'))return;
    if(await p.$('.cmd-grid'))await p.click('.cmd-grid .btn >> nth=0');else await p.click('.command-panel .skill-btn:not([disabled]) >> nth=0');
    await p.waitForTimeout(150);
  }
};
const b=await chromium.launch();
let freshIndex=0;
for(const [name,w,h] of [['L',915,412],['W',1280,720],['S',780,360]]){
  const c=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:1});const p=await c.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('response',r=>{if(r.status()>=500)errs.push(`${r.status()} ${r.url()}`);});
  const shot=async(n)=>{await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(450);await p.screenshot({path:`${out}/${name}-${n}.png`});await check(p,`${name} ${w}×${h} ${n}`);};
  await p.goto(B);await p.waitForSelector('.title-start');await shot('01-title-out');
  await p.click('.title-start');await p.waitForSelector('.code-input');await shot('02-login');
  await p.fill('.code-input',String(code++));await p.click('.sheet-actions .btn-primary');await p.waitForSelector('.village-view');await p.waitForTimeout(800);await shot('03-village');
  // 구역 바로가기: 바닷가(전투연습장 쪽)
  await p.click('.nav-btn >> nth=3');await p.waitForTimeout(700);await shot('04-village-market');
  await p.click('.nav-btn >> nth=0');await p.waitForTimeout(700);
  await p.evaluate(()=>document.querySelector('[data-click="hideout"]').click());await p.waitForSelector('.sheet');await shot('05-building-sheet');
  await p.click('.sheet .menu-btn');await p.waitForSelector('.party-scene .unit-card');await shot('06-party');
  // 편성: 앞의 3마리
  while(await p.$('.slot-remove'))await p.click('.slot-remove >> nth=0');
  for(let i=0;i<3;i++)await p.click(`.unit-card:not(.picked) .unit-pick:not([disabled]) >> nth=0`);await shot('07-party-picked');
  await p.click('.unit-info >> nth=0');await p.waitForSelector('.sheet .detail');await shot('08-unit-detail');await p.click('.sheet-close');
  await p.click('.save-btn');await p.waitForTimeout(300);
  await p.goto(B+'#training');await p.reload();await p.waitForSelector('.enc-btn');await shot('09-training');
  await p.click('.enc-btn >> nth=1');await p.waitForSelector('.cmd-grid');await shot('10-battle');
  await p.click('.cmd-grid .btn >> nth=1');await p.waitForSelector('.skill-btn');await shot('11-battle-skills');
  await p.click('.skill-btn >> nth=0');await p.waitForTimeout(200);await shot('12-battle-playing');
  // 끝까지: 쓸 수 있는 가장 앞 버튼(공격 또는 교체)
  for(let t=0;t<80;t++){
    await p.waitForFunction(()=>!document.querySelector('.command-panel button[disabled]')||document.querySelector('.finish'),null,{timeout:15000}).catch(()=>{});
    if(await p.$('.finish'))break;
    if(await p.$('.cmd-grid'))await p.click('.cmd-grid .btn >> nth=0');else await p.click('.command-panel .skill-btn:not([disabled]) >> nth=0');
    await p.waitForTimeout(150);
  }
  await p.waitForSelector('.finish',{timeout:30000});await shot('13-battle-finish');
  await p.click('.finish .btn');await p.waitForSelector('.result-panel');await shot('14-result');
  // 5단계(바로 해 보기 계정): 조합 → 계승 고르기 → 성공, 도감, 내 갈매미
  await p.goto(B+'#craft');await p.reload();await p.waitForSelector('.recipe-row');await shot('20-craft');
  if(await p.$('.recipe-detail .btn-primary:not([disabled])')){
    await p.click('.recipe-detail .btn-primary');await p.waitForSelector('.inherit');await shot('21-craft-inherit');
    await p.click('.inherit .inherit-grid .skill-btn >> nth=0');await p.waitForTimeout(200);
    await p.click('.inherit .inherit-grid >> nth=1 >> .skill-btn:not([disabled]) >> nth=0');await shot('22-craft-inherit-picked');
    await p.click('.sheet-actions .btn-primary');await p.waitForSelector('.sheet .detail');await shot('23-craft-done');await p.click('.sheet-close');
  }else findings.push({label:`${name} 조합 가능한 조합식 없음`,issues:['조합 성공 화면을 찍지 못함']});
  await p.goto(B+'#collection');await p.reload();await p.waitForSelector('.dex-card');await shot('24-collection');
  await p.click('.dex-card >> nth=0');await p.waitForSelector('.sheet .detail');await shot('25-collection-entry');await p.click('.sheet-close');
  await p.goto(B+'#owned');await p.reload();await p.waitForSelector('.owned-buttons');await shot('26-owned');
  await p.click('.owned-buttons .btn >> nth=0');await p.waitForSelector('.sheet .stat-table');await shot('27-owned-stats');await p.click('.sheet-close');
  findings.push({label:`${name} 스크립트 오류`,issues:errs});await c.close();
  // 5단계(처음부터 해 보기 계정): 첫 갈매미 → 튜토리얼 → 커먼 고르기 → 모집
  const c2=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:1});const q=await c2.newPage();const errs2=[];q.on('pageerror',e=>errs2.push(e.message));q.on('response',r=>{if(r.status()>=500)errs2.push(`${r.status()} ${r.url()}`);});
  const shot2=async(n)=>{await q.evaluate(()=>document.fonts.ready);await q.waitForTimeout(450);await q.screenshot({path:`${out}/${name}-${n}.png`});await check(q,`${name} ${w}×${h} ${n}`);};
  await q.goto(B);await q.waitForSelector('.title-start');await q.click('.title-start');await q.waitForSelector('.code-input');
  await q.fill('.code-input',String(200001+freshIndex*10));freshIndex++;await q.click('.sheet-actions .btn-primary');await q.waitForSelector('.guide');await q.waitForTimeout(600);await shot2('30-fresh-village-guide');
  for(let tries=0;tries<6&&await q.$('.guide >> text=튜토리얼 전투');tries++){
    await q.click('.guide .btn-primary');await q.waitForSelector('.cmd-grid');if(!tries)await shot2('31-tutorial-battle');
    await playToFinish(q);await q.click('.finish .btn');await q.waitForSelector('.result-panel');if(!tries)await shot2('32-tutorial-result');
    await q.click('.result-actions .btn-primary');await q.waitForSelector('.village-view');await q.waitForTimeout(900);
  }
  await q.waitForSelector('.guide >> text=고르러 가기');await shot2('33-ticket-guide');
  await q.click('.guide .btn-primary');await q.waitForSelector('.starter-card');await shot2('34-starter');
  await q.click('.starter-card >> nth=2');await q.click('.starter-detail .btn-primary');await q.waitForSelector('.sheet-actions');await shot2('35-starter-confirm');
  await q.click('.sheet-actions .btn-primary');await q.waitForSelector('.village-view');await q.waitForTimeout(600);
  await q.goto(B+'#recruit');await q.reload();await q.waitForSelector('.offer');await shot2('36-recruit');
  await q.click('.times .btn >> nth=1');await q.click('.offer .btn-primary >> nth=0');await q.waitForSelector('.cand-card');await shot2('37-recruit-candidates');
  await q.click('.recruit-foot .btn-primary');await q.waitForSelector('.offer');await shot2('38-recruit-after');
  findings.push({label:`${name} 새 계정 스크립트 오류`,issues:errs2});await c2.close();
  // 6단계(이야기 계정): 석상 → 장면 → 수락 → 외부 출항 → 흑화 모험 전투 → 결과 → 귀환 → 귀환 장면, 탐험(재료·자유 모험), 주민, 기록, 악당 전투
  const k=['L','W','S'].indexOf(name);
  const c3=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:1});const s=await c3.newPage();const errs3=[];s.on('pageerror',e=>errs3.push(e.message));s.on('response',r=>{if(r.status()>=500)errs3.push(`${r.status()} ${r.url()}`);});
  const shot3=async(n)=>{await s.evaluate(()=>document.fonts.ready);await s.waitForTimeout(500);await s.screenshot({path:`${out}/${name}-${n}.png`});await check(s,`${name} ${w}×${h} ${n}`);};
  const login=async(code)=>{await s.goto(B);await s.waitForSelector('.title-start');await s.click('.title-start');await s.waitForSelector('.code-input');await s.fill('.code-input',code);await s.click('.sheet-actions .btn-primary');await s.waitForSelector('.village-view');await s.waitForTimeout(800);};
  const clickWorld=async(sel)=>{await s.evaluate(q=>document.querySelector(q).click(),sel);};
  // 글자가 나오는 중에 누르면 첫 누름은 글자 다 보이기(원본 finishTyping)라서, 글자가 다 나온 뒤 누름
  const typed=async(page)=>page.waitForFunction(()=>{const e=document.querySelector('.story-speech');return !e||e.dataset.typing!=='1';},null,{timeout:8000}).catch(()=>{});
  const choice=async(text)=>{await s.waitForSelector(`.story-choices .btn >> text=${text}`);await typed(s);await s.click(`.story-choices .btn >> text=${text}`);};
  const settleTyping=async()=>{await s.waitForTimeout(80);await s.click('.story-speech').catch(()=>{});await s.waitForTimeout(700);};
  /** 장면을 마지막 줄까지(또는 끝까지) 넘기기. 「다음」이 typing 중이면 첫 누름은 글자 다 보이기 */
  const throughScene=async(stopAtAccept)=>{for(let i=0;i<40;i++){await s.waitForTimeout(150);const label=await s.$eval('.story-choices .btn-primary',e=>e.textContent).catch(()=>null);if(!label)return;
    if(!label.includes('다음')&&!label.includes('의뢰 수락'))return; // 장면이 끝나면 멈춤(다음 의뢰로 넘어가지 않게)
    if(label.includes('의뢰 수락')&&stopAtAccept)return;await typed(s);await s.click('.story-choices .btn-primary');await s.waitForTimeout(250);}};
  await login(String(300001+k*10));await shot3('40-story-village');
  await clickWorld('[data-click="statue"]');await s.waitForSelector('.story-panel');await s.waitForTimeout(900);await shot3('41-statue');
  await choice('이야기 듣기');await s.waitForTimeout(1200);await shot3('42-scene-narrator');
  await s.click('.story-choices .btn-primary');await s.waitForTimeout(150);await s.click('.story-choices .btn-primary');await s.waitForTimeout(1500);await shot3('43-scene-hero');
  await throughScene(true);await s.waitForTimeout(1200);await shot3('44-scene-accept');
  await choice('의뢰 수락');await s.waitForTimeout(900);await shot3('45-statue-active');
  await s.click('.story-close');await s.waitForTimeout(400);
  await s.click('.nav-btn >> nth=3');await s.waitForTimeout(600);
  await clickWorld('[data-click="harbor"]');await s.waitForSelector('.sheet');await shot3('46-harbor-menu');
  await s.click('.sheet .menu-btn >> nth=1');await s.waitForSelector('.story-panel');await s.waitForTimeout(1200);await shot3('47-departure');
  await choice('출항 준비');await s.waitForSelector('.party-scene .unit-card');
  for(let i=0;i<2;i++)await s.click('.unit-card:not(.picked) .unit-pick:not([disabled]) >> nth=0');await shot3('48-depart-party');
  await s.click('.save-btn');await s.waitForSelector('.cmd-grid');await shot3('49-black-battle');
  await playToFinish(s);await s.click('.finish .btn');await s.waitForSelector('.result-panel');await shot3('50-story-result');
  await s.click('.result-actions .btn-primary');await s.waitForSelector('.adventure-scene');await s.waitForFunction(()=>document.querySelector('.top-note')?.textContent?.includes('귀환'));await shot3('51-adventure-returned');
  await s.click('.adventure-actions .btn-primary');await s.waitForSelector('.village-view');await s.waitForTimeout(800);
  await clickWorld('[data-click="statue"]');await s.waitForSelector('.story-panel');await choice('귀환 이야기');await s.waitForTimeout(1000);await shot3('52-return-scene');
  await throughScene(false);await s.waitForTimeout(900);await shot3('53-statue-next');await s.click('.story-close');await s.waitForTimeout(400);
  await clickWorld('[data-click="harbor"]');await s.waitForSelector('.sheet');await s.click('.sheet .menu-btn >> nth=0');await s.waitForSelector('.story-panel');await s.waitForTimeout(1000);await shot3('54-exploration');
  await choice('흑화 갈매미 모험');await s.waitForTimeout(900);await shot3('55-material-list');await choice('뒤로');
  await choice('자유 탐험');await s.waitForSelector('.party-scene .unit-card');
  while(await s.$('.slot-remove'))await s.click('.slot-remove >> nth=0');
  for(let i=0;i<3;i++)await s.click('.unit-card:not(.picked) .unit-pick:not([disabled]) >> nth=0');
  await s.click('.save-btn');await s.waitForSelector('.adventure-scene');await shot3('56-adventure-active');
  await s.click('.adventure-actions .btn-primary');await s.waitForSelector('.sheet');await shot3('57-adventure-lead');
  await s.click('.sheet .menu-btn >> nth=0');await s.waitForSelector('.cmd-grid');await playToFinish(s);await s.click('.finish .btn');await s.waitForSelector('.result-panel');await shot3('58-adventure-result');
  await s.click('.result-actions .btn-primary');await s.waitForSelector('.adventure-scene');await shot3('59-adventure-after-battle');
  await s.click('.adventure-actions .btn >> text=정상 귀환');await s.waitForFunction(()=>document.querySelector('.top-note')?.textContent?.includes('귀환'));await shot3('60-adventure-returned-free');
  await s.click('.adventure-actions .btn-primary');await s.waitForSelector('.village-view');await s.waitForTimeout(700);
  await clickWorld('[data-click="archive"]');await s.waitForSelector('.sheet');await s.click('.sheet .menu-btn >> text=이야기 기록');await s.waitForSelector('.story-panel');await s.waitForTimeout(900);await shot3('61-history');
  await s.click('.story-close');await s.waitForTimeout(300);
  await clickWorld('[data-click="resident:blacksmith"]');await s.waitForSelector('.story-panel');await s.waitForTimeout(1500);await shot3('62-resident-blacksmith');
  findings.push({label:`${name} 이야기 계정 스크립트 오류`,issues:errs3});await c3.close();
  // 중반 계정: 주민 부탁(상인) 장면 · 악당 의뢰 출항 → 악당 전투
  const c4=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:1});const m=await c4.newPage();const errs4=[];m.on('pageerror',e=>errs4.push(e.message));m.on('response',r=>{if(r.status()>=500)errs4.push(`${r.status()} ${r.url()}`);});
  const shot4=async(n)=>{await m.evaluate(()=>document.fonts.ready);await m.waitForTimeout(500);await m.screenshot({path:`${out}/${name}-${n}.png`});await check(m,`${name} ${w}×${h} ${n}`);};
  await m.goto(B);await m.waitForSelector('.title-start');await m.click('.title-start');await m.waitForSelector('.code-input');await m.fill('.code-input',String(300006+k*10));await m.click('.sheet-actions .btn-primary');await m.waitForSelector('.village-view');await m.waitForTimeout(900);
  await shot4('63-mid-village');
  await m.evaluate(()=>document.querySelector('[data-click="resident:merchant"]').click());await m.waitForSelector('.story-panel');await m.waitForTimeout(1200);await shot4('64-resident-merchant');
  await m.waitForSelector('.story-choices .btn >> text=부탁 듣기');await typed(m);await m.click('.story-choices .btn >> text=부탁 듣기');await m.waitForTimeout(400);
  for(let i=0;i<8;i++){const who=await m.$eval('.story-name',e=>e.textContent).catch(()=>'');if(who==='모아')break;await m.click('.story-choices .btn-primary');await m.waitForTimeout(150);await m.click('.story-choices .btn-primary').catch(()=>{});await m.waitForTimeout(300);}
  await m.waitForTimeout(1500);await shot4('65-resident-scene');
  await m.click('.story-close');await m.waitForTimeout(500);
  await m.evaluate(()=>document.querySelector('[data-click="statue"]').click());await m.waitForSelector('.story-panel');await m.waitForSelector('.story-choices .btn >> text=이야기 듣기');await typed(m);await m.click('.story-choices .btn >> text=이야기 듣기');await m.waitForTimeout(300);
  for(let i=0;i<40;i++){const label=await m.$eval('.story-choices .btn-primary',e=>e.textContent).catch(()=>null);if(!label||label.includes('의뢰 수락'))break;await m.click('.story-choices .btn-primary');await m.waitForTimeout(100);await m.click('.story-choices .btn-primary').catch(()=>{});await m.waitForTimeout(200);}
  await m.waitForSelector('.story-choices .btn >> text=의뢰 수락');await typed(m);await m.click('.story-choices .btn >> text=의뢰 수락');await m.waitForTimeout(600);await m.click('.story-close');await m.waitForTimeout(400);
  await m.evaluate(()=>document.querySelector('[data-click="harbor"]').click());await m.waitForSelector('.sheet');await m.click('.sheet .menu-btn >> nth=1');await m.waitForSelector('.story-panel');
  await m.waitForSelector('.story-choices .btn >> text=출항 준비');await typed(m);await m.click('.story-choices .btn >> text=출항 준비');await m.waitForSelector('.party-scene .unit-card');await m.click('.unit-card:not(.picked) .unit-pick:not([disabled]) >> nth=0');await m.click('.save-btn');await m.waitForSelector('.cmd-grid');await shot4('66-villain-battle');
  findings.push({label:`${name} 중반 계정 스크립트 오류`,issues:errs4});await c4.close();
}
await b.close();
writeFileSync(`${out}/findings.json`,JSON.stringify(findings,null,1));
const bad=findings.filter(f=>f.issues.length);console.log(bad.length?`문제 ${bad.length}곳`:'숫자 검사 모두 통과');
