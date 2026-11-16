// 7-2단계(일반전·랭크전) 기준 결과: GMM110 원본 RosterPvp를 시계를 조절하며 실제로 돌려, 내부 단계의 입력·출력을 기록한다.
// 사용(원본 폴더 안에서): npx tsx <이 파일> <GMM110 폴더> <출력 JSON>   — 자세한 준비는 generate.ts 맨 위와 같음
// 기록하는 것(원본 메서드를 감싸서): 턴 처리(resolve), AI 선택(primeBot), 매칭(match), 종료 정산(finish), 접속 판정·점수 계산(순수 함수).
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root,outFile]=process.argv.slice(2).map(p=>resolve(p));
if(!root||!outFile)throw Error('사용: generate-pvp.ts <GMM110 폴더> <출력 JSON>');
const imp=(p:string)=>import(pathToFileURL(join(root,p)).href);
const pvpMod=await imp('src/roster60-pvp.ts');
const presence=await imp('src/progression/roster60-presence.ts');
const rating=await imp('src/ranked/rating.ts');
const normalXp=await imp('src/progression/normal-xp.ts');
const rank=await imp('src/progression/roster60-rank.ts');
const feedback=await imp('src/battle/roster60-loss-feedback.ts');
const cmd=await imp('src/progression/commander.ts');
const rules=await imp('src/battle/roster60-rules.ts');
const {PrismaClient}=createRequire(join(root,'package.json'))('@prisma/client');
const prof=(f:string)=>JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1',f),'utf8'));
const catalog=prof('catalog.json'),policy=prof('battle-policy.json'),xpPacing=prof('unit-xp-pacing-policy.json'),nxp=prof('normal-xp-policy.json');
const paced={...policy,xpPacing},normalXpPolicy={...nxp,xpPacing};
const commanderPolicy=cmd.commanderPolicyReader(root,'five-stat-device-test-v1')();
let s=20261117;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
const pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)];
const tryCode=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:(e as any).code??(e as Error).message};}};
const big=(v:unknown)=>JSON.parse(JSON.stringify(v??null,(_k,x)=>typeof x==='bigint'?x.toString():x instanceof Date?x.toISOString():x));
const out:any={pure:{presence:[],rating:[],casual:[],normalXp:{source:[],terminal:[],shares:[]},order:[],pin:[],feedback:[]},hooks:{resolve:[],primeBot:[],match:[],finish:[]},flows:[]};

// 1) 순수 함수
// 접속 판정: 무작위 관측 순서
const P=presence.defaultPresencePolicy;
for(let n=0;n<40;n++){
  let now=1_000_000+Math.floor(rnd()*1000),prev:any=null;const bot=rnd()<.3?1:undefined;
  let m=presence.monitorObservation(prev,now,P).monitor;let st=presence.initializePresence(m,now,P,bot);const steps:any[]=[];
  for(let k=0;k<12;k++){
    now+=Math.floor(rnd()*(rnd()<.2?60000:20000));if(rnd()<.05)now-=5000;
    const mo=rnd()<.85?presence.monitorObservation(m,now,P):{monitor:m};m=mo.monitor;
    const obs=rnd()<.6?pick(bot?[0]:[0,1]):null;
    const r=obs===null?{state:st,decision:presence.decidePresence(st,m,now)}:presence.observePresence(st,obs,m,now);
    steps.push({now,monitor:big(m),observer:obs,decision:big(r.decision),state:big(r.state)});if(r.state)st=r.state;
  }
  out.pure.presence.push({bot:bot??null,start:big(presence.initializePresence(presence.monitorObservation(null,1_000_000,P).monitor,1_000_000,P,bot)),steps});
}
// 접속 판정의 시작 상태를 같은 방법으로 다시 만들 수 있게, 첫 값도 기록(위 루프는 시작 시각이 무작위라 아래에서 다시 기록)
out.pure.presenceSeq=[];
for(let n=0;n<30;n++){
  const t0=2_000_000+n*7,bot=n%4===0?1:undefined,seq:any[]=[];let m:any=null;
  const first=presence.monitorObservation(null,t0,P);m=first.monitor;seq.push({op:'monitor',now:t0,r:big(first)});
  let st:any=presence.initializePresence(m,t0,P,bot);seq.push({op:'init',now:t0,bot:bot??null,r:big(st)});let now=t0;
  for(let k=0;k<14;k++){
    now+=Math.floor(rnd()*(rnd()<.25?70000:25000));const kind=rnd();
    if(kind<.5){const bogus=rnd()<.05;const r=presence.monitorObservation(bogus?{bogus:1}:m,now,P);seq.push({op:'monitor',now,bogus,r:big(r)});m=r.monitor;}
    else if(kind<.8){const side=bot?0:pick([0,1]);const r=presence.observePresence(st,side,m,now);seq.push({op:'observe',now,side,r:big(r)});if(r.state)st=r.state;}
    else seq.push({op:'decide',now,r:big(presence.decidePresence(st,m,now))});
  }
  out.pure.presenceSeq.push(seq);
}
// 랭크 점수
for(let n=0;n<200;n++){
  const snap=()=>{const c=rating.DEFAULT_RANKED_CONFIG,tier=Math.floor(rnd()*c.tiers.length),promo=tier<c.tiers.length-1&&rnd()<.3;const w=Math.floor(rnd()*30),l=Math.floor(rnd()*30),d=Math.floor(rnd()*5);
    return {tierIndex:tier,lp:promo?100:Math.floor(rnd()*(tier===c.tiers.length-1?300:100)),promotionActive:promo,promotionWins:promo?Math.floor(rnd()*2):0,promotionLosses:promo?Math.floor(rnd()*2):0,rankedMmr:Math.round(600+rnd()*900),casualPriorOffset:Math.round((rnd()-.5)*100)/2,games:w+l+d,wins:w,losses:l,draws:d};};
  const a=snap(),b=snap(),score=pick([0,0.5,1]);
  out.pure.rating.push({a,b,score,r:tryCode(()=>rating.applyRankedResult(a,b,score)),mm:tryCode(()=>rating.rankedMatchmakingMmr(a))});
}
for(let n=0;n<40;n++){const mmr=Math.round(700+rnd()*600),games=Math.floor(rnd()*40);out.pure.casual.push({mmr,games,r:tryCode(()=>rating.initialRankedSnapshot({mmr,games}))});}
// 일반전 경험치
for(let lv=1;lv<=99;lv+=7)out.pure.normalXp.source.push({lv,r:tryCode(()=>normalXp.normalXpSource(paced,lv,normalXpPolicy))});
for(const reason of ['BATTLE','SURRENDER','TIMEOUT','DOUBLE_TIMEOUT','SERVER_ABORT'])for(const winner of [0,1,null])for(const tg of [false,true])
  out.pure.normalXp.terminal.push({reason,winner,tg,r:tryCode(()=>normalXp.normalXpTerminal(reason,winner,tg,{version:'roster60-presence-proof-v1',departedSide:1,graceStartedAt:1,graceUntil:2,survivorSide:0,monitorGeneration:1,decisionAt:3}))});
// 접속 이력 순서·고정값 검사
for(let n=0;n<40;n++){const mk=()=>({playerId:'p'+Math.floor(rnd()*99),rating:Math.round(800+rnd()*400),queuedAt:new Date(1_700_000_000_000+Math.floor(rnd()*1e6)),reincarnationCount:rnd()<.2?null:Math.floor(rnd()*4)});
  const seeker=mk(),cands=Array.from({length:1+Math.floor(rnd()*5)},mk);out.pure.order.push({seeker:big(seeker),cands:big(cands),r:big(rank.orderRebirthCandidates(seeker,cands)).map((c:any)=>c.playerId)});}
for(const pool of ['FIRST_LIFE','REBORN','X',null])for(const count of [0,1,null,-1])for(const src of ['NO_REBIRTH_HISTORY','ROSTER60_ACCOUNT_SUCCESSES','HISTORY_WITHOUT_ACCOUNT_COUNT',null])out.pure.pin.push({pool,count,src,r:rank.validRebirthCountPin(pool,count,src)});

// 2) 실제 서비스(임시 DB, 시계 조절)
const dir=mkdtempSync(join(tmpdir(),'gmm-parity72-'));const url=`file:${join(dir,'p.db')}`;
writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'prisma/schema.prisma')));
execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],{cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
const db=new PrismaClient({datasources:{db:{url}}});
let clock=Date.now();const now=()=>clock; // 방 생성 시각(createdAt)은 DB가 실제 시계로 넣어서, 가짜 시계도 실제 시각에서 시작
const svc=new pvpMod.RosterPvp(db,()=>catalog,()=>paced,now,()=>normalXpPolicy,undefined,undefined,()=>commanderPolicy);
// 별명: 실제 id → 짧은 이름(id 순서가 결과에 영향을 주는 곳이 있어 정렬 순서를 지키는 별명)
const alias=new Map<string,string>();
const growthKey=new Map(catalog.characters.map((c:any)=>[JSON.stringify(c.growth),'growth:'+c.id]));
const policyKey=JSON.stringify(paced),nxpKey=JSON.stringify(normalXpPolicy);
// 같은 값은 짧은 표시로: 성장 곡선 → growth:uXX, 전투 정책 → policy:paced, 일반전 경험치 정책 → policy:normalXp
const shrink=(_k:string,x:any)=>{if(x&&typeof x==='object'){const j=JSON.stringify(x);if(Array.isArray(x)&&growthKey.has(j))return growthKey.get(j);if(j===policyKey)return 'policy:paced';if(j===nxpKey)return 'policy:normalXp';}return x;};
const norm=(v:unknown)=>{let t=JSON.stringify(big(v),shrink);for(const [id,name] of [...alias].sort((a,b)=>b[0].length-a[0].length))t=t.split(id).join(name);return JSON.parse(t);};
// 내부 단계 감싸기
const proto=pvpMod.RosterPvp.prototype as any;
const wrap=(name:string,rec:(args:any[],before:any)=>any,after:(entry:any,result:any,args:any[])=>void)=>{const orig=proto[name];proto[name]=async function(...args:any[]){const entry=rec(args,null);const r=await orig.apply(this,args);after(entry,r,args);return r;};};
// 상태 줄이기: 사건 기록(events)은 빼고 개수만. 턴 처리에는 이전 관측만, 새 턴은 통째로.
const slim=(st:any)=>{const {events,...rest}=st;return {...rest,eventCount:events.length};};
const priorObs=(st:any)=>st.events.flatMap((r:any)=>r.events.filter((e:any)=>e.defenseObservation).map((e:any)=>({turn:r.turn,side:e.side,defenseObservation:e.defenseObservation})));
const vitals=(st:any)=>({...slim(st),parties:st.parties.map((p:any[])=>p.map((f:any)=>({ownedId:f.ownedId,hp:f.hp,mp:f.mp})))});
const lean=(r:any)=>({...r,events:r.events.map(({intelBefore,intelAfter,...e}:any)=>e)});
const rooms:Record<string,any>={},extraFighters:Record<string,any>={}; // AI 개체 id는 'AI:<방 id>:<번호>'
const room=(r:any,st?:any)=>{if(!rooms[r.id]){const sn=JSON.parse(r.snapshot);delete sn.items;rooms[r.id]={seed:r.seed,mode:r.mode,player0Id:r.player0Id,player1Id:r.player1Id,snapshot:sn,fighters:{}};}
  // 개체 정보는 방마다 한 번(처음 본 값: 체력·MP는 턴마다 vitals로 따로 기록)
  if(st)for(const p of st.parties)for(const f of p)if(!rooms[r.id].fighters[f.ownedId])rooms[r.id].fighters[f.ownedId]=structuredClone(f);return r.id;};
const inv=async(tx:any,r:any)=>Object.fromEntries((await tx.playerItem.findMany({where:{playerId:{in:[r.player0Id,r.player1Id]}}})).map((i:any)=>[i.playerId+':'+i.itemId,i.count]));
wrap('resolve',a=>({battleId:room(a[1],a[2]),before:vitals(structuredClone(a[2])),priorCount:priorObs(a[2]).length,timeoutGenerated:!!a[3],clock}),(e,r)=>{const st=JSON.parse(r.state);e.after=vitals(st);e.round=lean(st.events.at(-1)); /* 사건마다 붙는 공개 정보 전후값(intel)은 뺌: observedOpponentIntel은 2단계 비교 시험에서 확인 */e.status=r.status;out.hooks.resolve.push(e);});
// 바깥에서 감싸서: 안쪽(턴 기록)이 먼저 기록을 만든 뒤 아이템 개수를 붙임
{const orig=proto.resolve;proto.resolve=async function(...a:any[]){const before=await inv(a[0],a[1]);const r=await orig.apply(this,a);out.hooks.resolve.at(-1).items={before,after:await inv(a[0],a[1])};return r;};}
{const orig=proto.primeBot;proto.primeBot=function(st:any,snap:any){const before=structuredClone(st);const r=orig.call(this,st,snap);if(st.botSide===1){const bid=String(st.parties[1][0].ownedId).split(':')[1];extraFighters[bid]??={};for(const pp of before.parties)for(const f of pp)extraFighters[bid][f.ownedId]??=structuredClone(f);out.hooks.primeBot.push({battleId:bid,before:vitals(before),after:vitals(st),added:st.events.slice(before.events.length).map(lean)});}return r;};}
wrap('finish',a=>({battleId:room(a[1]),status:a[1].status,state:structuredClone(a[2]),winner:a[3],reason:a[4],timeoutGenerated:!!a[5],proof:a[8]??null,clock}),(e,r)=>{e.settlement=JSON.parse(r.settlement);const st=JSON.parse(r.state);e.stateAfter={...st,events:st.events.map(lean)};e.state={...slim(e.state)};out.hooks.finish.push(e);});
{const orig=proto.match;proto.match=async function(tx:any,mode:string){const rows=await tx.roster60PvpQueue.findMany({where:{mode}});const beforeRooms=new Set((await tx.roster60PvpMatch.findMany({select:{id:true}})).map((r:any)=>r.id));
  const r=await orig.call(this,tx,mode);const created=(await tx.roster60PvpMatch.findMany()).filter((m:any)=>!beforeRooms.has(m.id)).map((m:any)=>({player0Id:m.player0Id,player1Id:m.player1Id,bot:JSON.parse(m.state).botSide===1,party:JSON.parse(m.state).parties}));
  if(rows.length)out.hooks.match.push({mode,clock,rows:big(rows.map(({normalXpSnapshot,commanderXpSnapshot,rankAdmissionSnapshot,...q}:any)=>q)),created:big(created.map((c:any)=>({player0Id:c.player0Id,player1Id:c.bot?'AI':c.player1Id,bot:c.bot,party:c.party.map((p:any[])=>p.map((f:any)=>f.ownedId.startsWith('AI:')?{ai:true,speciesId:f.speciesId,level:f.level}:f.ownedId))})))});return r;};}
const xpAt=(id:string,lv:number,rc=0)=>{const u=catalog.characters.find((c:any)=>c.id===id);return rules.instanceGrowthCurve(u.growth,rc,u.reincarnationXpPolicy)[lv-1].totalXp;};
let pn=0,rq=0;const rid=()=>'q'+(rq++);
async function player(units:[string,number,number?][],opt:{commanderXp?:number;rebirths?:number}={}){
  const p=await db.player.create({data:{identity:'p72:'+(pn++),credits:0,nickname:'P'+pn}});
  const ids:string[]=[];for(const [k,[sp,lv,rc]] of units.entries()){const u=await db.roster60Owned.create({data:{playerId:p.id,speciesId:sp,totalXp:BigInt(xpAt(sp,lv,rc??0)),reincarnation:rc??0,source:'s'+k}});ids.push(u.id);}
  // 개체 id는 별명으로 바꾸지 않음: 전투 관측 열쇠(targetKey)가 개체 id로 만든 해시라서
  for(const [itemId,count] of Object.entries({potion:3,big:1,feather:1,clear:1}))await db.playerItem.create({data:{playerId:p.id,itemId,count}});
  if(opt.commanderXp!==undefined)await db.commanderAccount.create({data:{playerId:p.id,totalXp:BigInt(opt.commanderXp),policyVersion:commanderPolicy.version,policyFingerprint:cmd.commanderPolicyFingerprint(commanderPolicy)}});
  if(opt.rebirths)await db.roster60RebirthAccount.create({data:{playerId:p.id,successes:opt.rebirths}});
  return {id:p.id,units:ids};
}
const tick=async()=>{try{await svc.tick();}catch(e:any){}};
const step=async(ms:number,poll:string[]=[])=>{while(ms>0){const d=Math.min(ms,5000);clock+=d;ms-=d;for(const id of poll)await svc.current(id).catch(()=>{});await tick();}};
const call=async(log:any[],who:string,op:string,fn:()=>Promise<any>)=>{try{const r=await fn();const battle=r?.battle??(r?.battleId?r:null);log.push({who,op,status:r?.status,battle:battle?norm({status:battle.status,turn:battle.state?.turn,outcome:battle.state?.outcome,settlement:battle.settlement,presence:battle.presence?.status,waiting:battle.waitingForOpponent}):null});return r;}catch(e:any){log.push({who,op,error:e.code??e.message});return null;}};
// 행동 고르기(사람 쪽): 기술·공격·집중·교체·아이템·항복 섞음
const chooseAction=(b:any)=>{const me=b.state.fighters[0],res=(b.state.reserves??[]).filter((f:any)=>f.hp>0),dead=[me,...(b.state.reserves??[])].filter((f:any)=>f.hp<=0);const x=rnd();
  if(me.hp<=0)return res.length?{kind:'switch',targetOwnedId:res[0].ownedId}:{kind:'attack'};
  if(x<.06&&res.length)return {kind:'switch',targetOwnedId:pick(res).ownedId};
  if(x<.1)return {kind:'item',itemId:pick(['potion','big'])};
  if(x<.12&&dead.length)return {kind:'item',itemId:'feather',targetOwnedId:dead[0].ownedId};
  if(x<.2)return {kind:'focus'};
  if(x<.21)return {kind:'escape'};
  const sk=me.skills.filter((k:any)=>k.mpCost<=me.mp);return sk.length&&x<.8?{kind:'skill',skillId:pick(sk).id}:{kind:'attack'};};
async function playRoom(log:any[],ids:string[],opt:{idle?:string;maxTurns?:number}={}){
  for(let t=0;t<(opt.maxTurns??80);t++){
    let any=false;
    for(const id of ids){
      if(id===opt.idle)continue;
      const cur=await svc.current(id).catch(()=>null);const b=cur?.battle;if(!b||b.status!=='ACTIVE')continue;any=true;
      if(b.waitingForOpponent)continue;
      await call(log,id,'action',()=>svc.action(id,{requestId:rid(),battleId:b.battleId,revision:b.revision,action:chooseAction(b)}));
    }
    if(!any)break;
    if(opt.idle){await step(10000,ids.filter(i=>i!==opt.idle));}else await tick();
  }
  for(const id of ids){const cur=await svc.current(id).catch(()=>null);const b=cur?.battle;if(b&&['FINISHED','SETTLED'].includes(b.status))await call(log,id,'settle',()=>svc.settle(id,{requestId:rid(),battleId:b.battleId,revision:b.revision}));}
}
const flow=async(name:string,fn:(log:any[])=>Promise<void>)=>{const log:any[]=[];try{await fn(log);}catch(e:any){log.push({fatal:e.code??e.message});}out.flows.push({name,log});};
try{
  await svc.startPresenceEpoch();await tick();
  // 일반전: 사람 둘
  for(let n=0;n<4;n++)await flow('normal-human-'+n,async log=>{
    const a=await player([[pick(catalog.characters).id,10+Math.floor(rnd()*40)],[pick(catalog.characters).id,10+Math.floor(rnd()*40)]]),b=await player([[pick(catalog.characters).id,10+Math.floor(rnd()*40)],[pick(catalog.characters).id,12],[pick(catalog.characters).id,20]]);
    for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'normal'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));await step(1000,[a.id]);
    const j=await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'normal'}));
    const battle=j?.battle;if(!battle)return;
    for(const p of [a,b]){const cur=await svc.current(p.id);await call(log,p.id,'accept',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:true}));}
    await playRoom(log,[a.id,b.id]);
  });
  // 일반전: 30초 뒤 AI
  for(let n=0;n<4;n++)await flow('normal-ai-'+n,async log=>{
    const a=await player([[pick(catalog.characters).id,5+Math.floor(rnd()*50)],[pick(catalog.characters).id,5+Math.floor(rnd()*50)],[pick(catalog.characters).id,30]]);
    await call(log,a.id,'party',()=>svc.party(a.id,a.units,'normal'));await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));
    await step(31000,[a.id]);const cur=await call(log,a.id,'current',()=>svc.current(a.id));if(!cur?.battle)return;
    await call(log,a.id,'accept',()=>svc.accept(a.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:true}));
    await playRoom(log,[a.id]);
  });
  // 거절·수락 시간 초과
  await flow('decline',async log=>{
    const a=await player([['u10',20]]),b=await player([['u11',22]]);for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'normal'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));const j=await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'normal'}));
    const ca=await svc.current(a.id);await call(log,a.id,'accept',()=>svc.accept(a.id,{requestId:rid(),battleId:ca.battle.battleId,revision:ca.battle.revision,accept:true}));
    const cb=await svc.current(b.id);await call(log,b.id,'decline',()=>svc.accept(b.id,{requestId:rid(),battleId:cb.battle.battleId,revision:cb.battle.revision,accept:false}));
    await call(log,a.id,'current',()=>svc.current(a.id));await call(log,b.id,'current',()=>svc.current(b.id));await call(log,a.id,'cancel',()=>svc.cancel(a.id,{requestId:rid()}));void j;
  });
  await flow('accept-timeout',async log=>{
    const a=await player([['u12',20]]),b=await player([['u13',22]]);for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'normal'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'normal'}));
    await step(12000,[a.id,b.id]);await call(log,a.id,'current',()=>svc.current(a.id));await call(log,b.id,'current',()=>svc.current(b.id));
    for(const p of [a,b])await call(log,p.id,'cancel',()=>svc.cancel(p.id,{requestId:rid()}));
  });
  // 접속 끊김: 한쪽이 아무것도 안 함(조회도 안 함) → 재접속 유예 → 증명된 시간 초과
  for(let n=0;n<2;n++)await flow('disconnect-'+n,async log=>{
    const a=await player([['u20',30],['u21',30]]),b=await player([['u22',30]]);for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'normal'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'normal'}));
    for(const p of [a,b]){const cur=await svc.current(p.id);await call(log,p.id,'accept',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:true}));}
    await playRoom(log,[a.id,b.id],{maxTurns:2});
    await playRoom(log,[a.id,b.id],{idle:n?a.id:b.id,maxTurns:20});
  });
  // 입력 시간 초과(둘 다 조회는 하지만 행동하지 않음): 자동 행동, 3번 놓치면 시간 초과
  await flow('turn-timeout',async log=>{
    const a=await player([['u30',30]]),b=await player([['u31',30]]);for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'normal'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'normal'}));await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'normal'}));
    for(const p of [a,b]){const cur=await svc.current(p.id);await call(log,p.id,'accept',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:true}));}
    await step(100000,[a.id,b.id]);await call(log,a.id,'current',()=>svc.current(a.id));
    await playRoom(log,[a.id,b.id]);
  });
  // 랭크: 방범대장 Lv60(5900 XP) + 대원 Lv60. 여러 판 해서 점수·승급전
  const ra=await player([['u60',60],['u59',60]],{commanderXp:6000}),rb=await player([['u58',60],['u57',60]],{commanderXp:6000});
  for(let n=0;n<6;n++)await flow('rank-'+n,async log=>{
    for(const p of [ra,rb])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'rank'));
    await call(log,ra.id,'join',()=>svc.join(ra.id,{requestId:rid(),mode:'rank'}));await step(1000,[ra.id]);await call(log,rb.id,'join',()=>svc.join(rb.id,{requestId:rid(),mode:'rank'}));
    for(const p of [ra,rb]){const cur=await svc.current(p.id);if(!cur.battle)continue;await call(log,p.id,'accept',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:true}));}
    await playRoom(log,[ra.id,rb.id]);
    log.push({profiles:norm(await db.rankedProfile.findMany({where:{playerId:{in:[ra.id,rb.id]}},orderBy:{playerId:'asc'}}))});
  });
  // 랭크 점수 차·등급 차: 처음엔 안 붙고, 기다릴수록 허용 폭이 넓어져 붙음(5초마다 기록)
  await flow('rank-gap',async log=>{
    const a=await player([['u56',60]],{commanderXp:6000}),b=await player([['u55',60]],{commanderXp:6000});
    await db.rankedProfile.create({data:{playerId:a.id,rankedMmr:1000,tierIndex:0,lp:10}});await db.rankedProfile.create({data:{playerId:b.id,rankedMmr:1290,tierIndex:1,lp:20}});
    for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'rank'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'rank'}));await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'rank'}));
    for(let k=0;k<14;k++){await step(5000,[a.id,b.id]);const cur=await svc.current(a.id);if(cur.battle){log.push({matchedAfterSteps:k});break;}}
    for(const p of [a,b]){const cur=await svc.current(p.id);if(cur.battle)await call(log,p.id,'decline',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:false}));await call(log,p.id,'cancel',()=>svc.cancel(p.id,{requestId:rid()}));}
  });
  // 랭크 등급 차만 다를 때(점수 같음): 등급 2 차이는 60초 기다려야 붙음
  await flow('rank-tier-gap',async log=>{
    const a=await player([['u54',60]],{commanderXp:6000}),b=await player([['u53',60]],{commanderXp:6000});
    await db.rankedProfile.create({data:{playerId:a.id,rankedMmr:1000,tierIndex:0,lp:10}});await db.rankedProfile.create({data:{playerId:b.id,rankedMmr:1000,tierIndex:2,lp:20}});
    for(const p of [a,b])await call(log,p.id,'party',()=>svc.party(p.id,p.units,'rank'));
    await call(log,a.id,'join',()=>svc.join(a.id,{requestId:rid(),mode:'rank'}));await call(log,b.id,'join',()=>svc.join(b.id,{requestId:rid(),mode:'rank'}));
    for(let k=0;k<16;k++){await step(5000,[a.id,b.id]);const cur=await svc.current(a.id);if(cur.battle){log.push({matchedAfterSteps:k});break;}}
    for(const p of [a,b]){const cur=await svc.current(p.id);if(cur.battle)await call(log,p.id,'decline',()=>svc.accept(p.id,{requestId:rid(),battleId:cur.battle.battleId,revision:cur.battle.revision,accept:false}));await call(log,p.id,'cancel',()=>svc.cancel(p.id,{requestId:rid()}));}
  });
  // 랭크 자격 오류
  await flow('rank-ineligible',async log=>{
    const a=await player([['u60',60]],{commanderXp:100}),b=await player([['u10',20]],{commanderXp:6000}),c=await player([['u60',60]],{commanderXp:6000,rebirths:1});
    for(const p of [a,b,c]){await call(log,p.id,'options',async()=>({status:(await svc.options(p.id)).rankEligibility.reason||'ok'}));await call(log,p.id,'party-rank',()=>svc.party(p.id,p.units,'rank'));await call(log,p.id,'join-rank',()=>svc.join(p.id,{requestId:rid(),mode:'rank'}));}
  });
  out.casualRatings=norm(await db.casualHumanRating.findMany({orderBy:{playerId:'asc'}}));
  out.ledgers=norm(await db.roster60NormalXpLedger.findMany({orderBy:[{roomId:'asc'},{ownedId:'asc'}]}));
}finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
// 패배 안내: 기록된 종료 상태로
for(const f of out.hooks.finish)for(const side of [0,1] as const){const st=f.stateAfter,outcome=f.winner===null?'draw':f.winner===side?'win':'loss',mode=rooms[f.battleId].mode;
  out.pure.feedback.push({side,battleId:f.battleId,mode,outcome,reason:f.reason,bot:st.botSide===1,terminationKind:f.settlement.terminationKind??null,r:big(feedback.roster60LossFeedback({state:st,viewerSide:side,mode,outcome,reason:f.reason,status:'FINISHED',opponentKind:st.botSide===1?'AI':'HUMAN',terminationKind:f.settlement.terminationKind}))});}
for(const [bid,fs] of Object.entries(extraFighters))if(rooms[bid])rooms[bid].fighters={...fs,...rooms[bid].fighters};// 패배 안내: 드물게만 나오는 장면(반사로 쓰러짐·상대가 먼저 쳐서 쓰러짐·그냥 쓰러짐)을 직접 만든 기록으로
const fr=(hp0:number,hp1:number,sp0='u01',sp1='u02')=>[{hp:hp0,speciesId:sp0},{hp:hp1,speciesId:sp1}];
const synth=[
  {turn:3,decision:{version:'five-speed-v1',turn:3,order:['p0','p1']},events:[{side:0,kind:'skill',damage:40,target:'attacker',defense:'reflect',reflected:true,presentation:{version:1,before:fr(40,90),after:fr(0,90),skill:{element:'FIRE'}}}]},
  {turn:4,decision:{version:'five-speed-v1',turn:4,order:['p1','p0']},events:[{side:1,kind:'skill',damage:55,target:'defender',defense:'weak',reflected:false,presentation:{version:1,before:fr(55,90),after:fr(0,90)}}]},
  {turn:5,decision:{version:'five-speed-v1',turn:5,order:['p0','p1']},events:[{side:0,kind:'focus',presentation:{version:1,before:fr(70,90),after:fr(70,90)}},{side:1,kind:'skill',damage:70,target:'defender',defense:'normal',reflected:false,presentation:{version:1,before:fr(70,90),after:fr(0,90)}}]},
  {turn:6,decision:{version:'five-speed-v1',turn:6,order:['p0','p1']},events:[{side:1,kind:'skill',damage:30,target:'defender',defense:'immune',reflected:false,presentation:{version:1,before:fr(70,90),after:fr(40,90)}}]},
];
out.pure.feedbackSynthetic=[];
for(let mask=1;mask<16;mask++){const rounds=synth.filter((_,i)=>mask&(1<<i));for(const side of [0,1] as const)for(const [reason,tk] of [['BATTLE',undefined],['TIMEOUT','DISCONNECTED'],['DOUBLE_TIMEOUT','TURN_INPUT'],['SERVER_ABORT','SERVER_OBSERVATION_GAP'],['MATCH_DECLINED',undefined]] as const)
  out.pure.feedbackSynthetic.push({rounds,side,reason,tk:tk??null,r:big(feedback.roster60LossFeedback({state:{events:rounds},viewerSide:side,mode:'normal',outcome:'loss',reason,status:'FINISHED',opponentKind:'HUMAN',terminationKind:tk}))});}
out.rooms=norm(rooms);out.hooks=norm(out.hooks);out.flows=norm(out.flows);out.pure.feedback=norm(out.pure.feedback);
writeFileSync(outFile,JSON.stringify({source:'chatbotgmm/server backup/gmm-110-source-20261101 (0b0fb8b5)',generatedAt:new Date().toISOString(),...out}));
console.log(`기준 결과 저장: ${outFile} (턴 처리 ${out.hooks.resolve.length}, AI 선택 ${out.hooks.primeBot.length}, 매칭 ${out.hooks.match.length}, 종료 ${out.hooks.finish.length}, 흐름 ${out.flows.length})`);
console.log('종료 사유', out.hooks.finish.map((f:any)=>out.rooms[f.battleId].mode+':'+f.reason+(f.winner===null?'':'/'+f.winner)).join(' '));
for(const f of out.flows)console.log(f.name,f.log.filter((x:any)=>x.error||x.fatal).map((x:any)=>x.op+':'+(x.error??x.fatal)).join(' ')||'오류 없음');
