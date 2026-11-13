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
      if(b.right>W+1||b.bottom>H+1||b.left<-1||b.top<-1)issues.push(`화면 밖: ${t}`);
      if(b.width<47.5||b.height<47.5){if(!e.closest('.sheet-body')||b.height<44)issues.push(`터치 영역 작음 ${Math.round(b.width)}×${Math.round(b.height)}: ${t}`);}}
    const groups=new Map();for(const e of fixed){const k=e.parentElement;groups.set(k,[...(groups.get(k)||[]),e]);}
    for(const list of groups.values())for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i].getBoundingClientRect(),b=list[j].getBoundingClientRect();
      if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)issues.push(`겹침: ${list[i].textContent.trim().slice(0,12)} / ${list[j].textContent.trim().slice(0,12)}`);}
    for(const e of [...document.querySelectorAll('h1,h2,b,small,span,p,button')].filter(vis)){if(e.closest('.village-world'))continue;
      if(e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).overflow!=='visible')issues.push(`글자 잘림: ${e.textContent.trim().slice(0,16)}`);}
    const fixedBoxes=[...document.querySelectorAll('.village-hud > *, .village-nav .btn')].map(e=>e.getBoundingClientRect());
    for(const pl of document.querySelectorAll('.village-world .v-plate')){const r=pl.getBoundingClientRect();if(r.right<0||r.left>W)continue;
      for(const f of fixedBoxes)if(r.left<f.right&&f.left<r.right&&r.top<f.bottom&&f.top<r.bottom)issues.push(`이름판이 고정 UI와 겹침: ${pl.textContent.trim().slice(0,10)}`);}
    const fontOk=document.fonts.check('16px Jua')&&document.fonts.check('16px "Gowun Dodum"');
    if(!fontOk)issues.push('게임 글꼴 미적용');
    return issues;
  });
  findings.push({label,issues:[...new Set(r)]});console.log(label,r.length?r:'통과');
};
const b=await chromium.launch();
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
  findings.push({label:`${name} 스크립트 오류`,issues:errs});await c.close();
}
await b.close();
writeFileSync(`${out}/findings.json`,JSON.stringify(findings,null,1));
const bad=findings.filter(f=>f.issues.length);console.log(bad.length?`문제 ${bad.length}곳`:'숫자 검사 모두 통과');
