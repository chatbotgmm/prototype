// 7-1단계(방범대장·환생) 기준 결과: GMM110 원본의 방범대장 계산·지급, 환생 미리보기·확정을 실제로 실행해 기록한다.
// 사용(원본 폴더 안에서): npx tsx <이 파일> <GMM110 폴더> <출력 JSON>   — 자세한 준비는 generate.ts 맨 위와 같음
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root,outFile]=process.argv.slice(2).map(p=>resolve(p));
if(!root||!outFile)throw Error('사용: generate-progression.ts <GMM110 폴더> <출력 JSON>');
const imp=(p:string)=>import(pathToFileURL(join(root,p)).href);
const cmd=await imp('src/progression/commander.ts');
const rein=await imp('src/roster60-reincarnation.ts');
const rules=await imp('src/battle/roster60-rules.ts');
const {PrismaClient}=createRequire(join(root,'package.json'))('@prisma/client');
const prof=(f:string)=>JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1',f),'utf8'));
const catalog=prof('catalog.json'),rawPolicy=prof('commander-policy.json'),schedule=prof('commander-reward-schedule.json');
const policy=cmd.commanderPolicyReader(root,'five-stat-device-test-v1')();
let s=20261116;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
const pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)];
const tryCode=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:(e as any).code??(e as Error).message};}};
const big=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
const out:any={policy:big(policy),pure:{validate:[],levels:[],progress:[],events:[],budget:null,fingerprint:null},awards:[],rebirth:[]};

// 1) 정책 검사: 원본 그대로 + 한 군데씩 틀리게(보상 일정 포함)
const muts:[string,(p:any)=>void][]=[['ok',()=>{}],['approved',p=>{p.productionBalanceApproved=true;}],['short',p=>{p.growth=p.growth.slice(0,59);}],['notIncreasing',p=>{p.growth[5].totalXp=p.growth[4].totalXp;}],
  ['firstNonZero',p=>{p.growth[0].totalXp=1;}],['dupQuest',p=>{p.story.residentQuestIds.push(p.story.mainQuestIds[0]);}],['lossNotHalf',p=>{p.rewards.normalLoss=51;}],['timeoutNotWin',p=>{p.rewards.normalProvenTimeoutSurvivor=99;}],
  ['scheduleLower',p=>{p.rewardSchedule={version:'x',rewards:{...p.rewards,storyQuest:p.rewards.storyQuest-1}};}],['scheduleOk',p=>{p.rewardSchedule={version:'x',rewards:{...p.rewards,storyQuest:p.rewards.storyQuest+5}};}],
  ['scheduleExtraKey',p=>{p.rewardSchedule={version:'x',rewards:p.rewards,extra:1};}],['name',p=>{p.name='대장';}],['null',()=>{}]];
for(const [name,fn] of muts){const p=name==='null'?null:structuredClone(rawPolicy);if(p)fn(p);out.pure.validate.push({name,input:p,r:tryCode(()=>cmd.validateCommanderPolicy(p)&&true)});}
out.pure.fingerprint=cmd.commanderPolicyFingerprint(policy);
// 2) 레벨·진행 막대
for(const t of [0,1,99,100,101,4199,4200,5899,5900,9799,9800,9801,50000,-1])out.pure.levels.push({t,r:tryCode(()=>cmd.commanderLevelAt(BigInt(t),policy))});
for(let i=0;i<60;i++){const a=Math.floor(rnd()*10000),b=a+Math.floor(rnd()*900);out.pure.progress.push({a,b,r:tryCode(()=>cmd.commanderXpProgress(BigInt(a),BigInt(b),policy))});}
// 3) 사건별 지급량
const v=policy.story.contentVersion,quests=[...policy.story.mainQuestIds,...policy.story.residentQuestIds];
for(let i=0;i<300;i++){
  const kind=pick(['STORY_QUEST','RESIDENT_QUEST','ADVENTURE_RETURN','NORMAL_PLAY']),q=pick([...quests,'NOPE']);
  const e:any={kind,eventId:kind.endsWith('QUEST')?(rnd()<.9?v+':'+q:'other:'+q):'ev'+i,outcome:pick(['completed','win','loss','draw','surrender','departed','aborted'])};
  if(rnd()<.6)e.reason=pick(['WIN_RETURN','NO_CLEAR_RETURN','BATTLE','TIMEOUT','SURRENDER','CLEAR_EVIDENCE_MISSING']);
  if(kind==='ADVENTURE_RETURN'&&rnd()<.3)e.linkedQuestId=pick(quests);
  if(kind==='NORMAL_PLAY'&&rnd()<.2)e.timeoutGenerated=rnd()<.5;
  if(kind==='NORMAL_PLAY'&&rnd()<.5)e.side=pick([0,1]);
  if(rnd()<.02)e.bogus=1;
  out.pure.events.push({e,r:tryCode(()=>cmd.commanderEventReward(e,policy))});
}
out.pure.budget=cmd.simulateCommanderBudget(policy);

// 4) DB: 지급(같은 사건 다시 보내기·충돌·정책 없음 포함), 환생
const dir=mkdtempSync(join(tmpdir(),'gmm-parity7-'));const url=`file:${join(dir,'p.db')}`;
writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'prisma/schema.prisma')));
execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],{cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
const db=new PrismaClient({datasources:{db:{url}}});
const strip=(r:any)=>r&&typeof r==='object'?big({...r,commander:{...r.commander}}):r;
try{
  const player=await db.player.create({data:{identity:'p7:cmd',credits:0}});
  const seq:any[]=[
    {kind:'STORY_QUEST',eventId:v+':STORY_01',outcome:'completed'},{kind:'STORY_QUEST',eventId:v+':STORY_01',outcome:'completed'},
    {kind:'STORY_QUEST',eventId:v+':STORY_01',outcome:'loss'},{kind:'RESIDENT_QUEST',eventId:v+':RESIDENT_BLACKSMITH_01',outcome:'completed'},
    {kind:'ADVENTURE_RETURN',eventId:'adv-1',outcome:'completed',reason:'WIN_RETURN',linkedQuestId:null},{kind:'ADVENTURE_RETURN',eventId:'adv-2',outcome:'completed',reason:'WIN_RETURN',linkedQuestId:'STORY_02'},
    {kind:'ADVENTURE_RETURN',eventId:'adv-3',outcome:'completed',reason:'NO_CLEAR_RETURN',linkedQuestId:null},{kind:'NORMAL_PLAY',eventId:'room-1',outcome:'win',reason:'BATTLE',timeoutGenerated:false,side:0},
    {kind:'NORMAL_PLAY',eventId:'room-2',outcome:'loss',reason:'BATTLE',timeoutGenerated:false,side:1},{kind:'NORMAL_PLAY',eventId:'room-3',outcome:'win',reason:'BATTLE',timeoutGenerated:true,side:0},
    {kind:'NORMAL_PLAY',eventId:'room-4',outcome:'surrender',reason:'SURRENDER',side:0},{kind:'NORMAL_PLAY',eventId:'room-5',outcome:'win',reason:'TIMEOUT',side:0},
  ];
  for(let i=0;i<40;i++)seq.push({kind:'STORY_QUEST',eventId:v+':'+policy.story.mainQuestIds[i%21],outcome:'completed'});
  for(const e of seq){const r=await (async()=>{try{return {ok:strip(await db.$transaction((tx:any)=>cmd.awardCommanderXp(tx,player.id,e,policy)))};}catch(x:any){return {error:x.code??x.message};}})();out.awards.push({e,r});}
  const p2=await db.player.create({data:{identity:'p7:none',credits:0}});
  out.awards.push({e:seq[0],noPolicy:true,r:{ok:strip(await db.$transaction((tx:any)=>cmd.awardCommanderXp(tx,p2.id,seq[0],null)))}});
  out.awardFinal=big(await db.commanderAccount.findUnique({where:{playerId:player.id}}));
  // 환생
  const svc=new rein.RosterReincarnation(db,()=>catalog);
  const grades=['LIMITED','TRANSCEND','IMMORTAL','ETERNAL'];
  for(let n=0;n<12;n++){
    const pl=await db.player.create({data:{identity:'p7:r'+n,credits:0,peanut:n%3===0?0:5}});
    const units:any[]=[];
    for(let k=0;k<4;k++){
      const sp=rnd()<.75?pick(catalog.characters.filter((c:any)=>grades.includes(c.rarity))):pick(catalog.characters),rc=Math.floor(rnd()*3),max=rc?99:60,lv=rnd()<.6?max:1+Math.floor(rnd()*max);
      const xp=rules.instanceGrowthCurve(sp.growth,rc,sp.reincarnationXpPolicy)[lv-1].totalXp;
      units.push(await db.roster60Owned.create({data:{playerId:pl.id,speciesId:sp.id,totalXp:BigInt(xp),reincarnation:rc,source:'r'+k,locked:rnd()<.05}}));
    }
    const rec:any={peanut:n%3===0?0:5,units:units.map(u=>big({id:u.id,speciesId:u.speciesId,totalXp:u.totalXp,reincarnation:u.reincarnation,locked:u.locked})),steps:[]};
    for(let step=0;step<3;step++){
      const pv=big(await svc.preview(pl.id));delete pv.serverNow;
      const cand=pv.candidates.filter((c:any)=>c.eligible);
      const target=cand.length&&rnd()<.85?pick(cand):pick(pv.candidates);
      const fp=rnd()<.1?'0'.repeat(64):target.previewFingerprint??'0'.repeat(64);
      let r:any;try{r={ok:big(await svc.confirm(pl.id,{ownedId:target.ownedId,requestId:`c${n}-${step}`,catalogVersion:catalog.version,previewFingerprint:fp}))};}catch(x:any){r={error:x.code??x.message};}
      const after=big(await db.roster60Owned.findMany({where:{playerId:pl.id},orderBy:{source:'asc'},select:{id:true,totalXp:true,reincarnation:true}}));
      rec.steps.push({preview:pv,ownedId:target.ownedId,fp,r,after,peanut:(await db.player.findUnique({where:{id:pl.id}})).peanut});
    }
    out.rebirth.push(rec);
  }
}finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
writeFileSync(outFile,JSON.stringify({source:'chatbotgmm/server backup/gmm-110-source-20261101 (0b0fb8b5)',generatedAt:new Date().toISOString(),...out}));
console.log(`기준 결과 저장: ${outFile} (정책 검사 ${out.pure.validate.length}, 레벨 ${out.pure.levels.length}, 사건 ${out.pure.events.length}, 지급 ${out.awards.length}, 환생 ${out.rebirth.length}명)`);
console.log('환생 결과', out.rebirth.flatMap((r:any)=>r.steps.map((x:any)=>x.r.error??'ok')).join(' '));
