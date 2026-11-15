// 6단계(스토리·주민 의뢰·모험) 기준 결과: GMM110 원본의 스토리 서비스·모험·전투 정산을 실제로 실행해 기록한다.
// 사용(원본 폴더 안에서): npx tsx <이 파일> <GMM110 폴더> <출력 JSON>   — 자세한 준비는 generate.ts 맨 위와 같음
// 원본 경로(story/routes.ts)는 ROSTER60_STORY_PROFILE=story-device-test-v1일 때만 RosterStory를 만든다. 여기서는 같은 인자로 직접 만든다.
// 방범대장 경험치(commanderPolicy)는 7단계라 넣지 않는다(원본 기본값 ()=>null 과 같음).
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root,outFile]=process.argv.slice(2).map(p=>resolve(p));
if(!root||!outFile)throw Error('사용: generate-story.ts <GMM110 폴더> <출력 JSON>');
const imp=(p:string)=>import(pathToFileURL(join(root,p)).href);
const rules=await imp('src/battle/roster60-rules.ts');
const storySvc=await imp('src/story/service.ts');
const villains=await imp('src/story/villains.ts');
const advMod=await imp('src/roster60-adventure.ts');
const battleMod=await imp('src/roster60-battle.ts');
const {PrismaClient}=createRequire(join(root,'package.json'))('@prisma/client');
const prof=(f:string)=>JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1',f),'utf8'));
const catalog=prof('catalog.json'),policy=prof('battle-policy.json'),xpPacing=prof('unit-xp-pacing-policy.json'),unitXpPolicy=prof('story-unit-xp-policy.json');
const paced={...policy,xpPacing};
const content=JSON.parse(readFileSync(join(root,'data/story/story-mode-v1.json'),'utf8'));

let s=20261115;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
const pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)];
const tryCode=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:(e as any).code??(e as Error).message};}};
const xpAt=(id:string,lv:number)=>catalog.characters.find((c:any)=>c.id===id).growth[lv-1].totalXp;

// 1) 순수 함수
const pure:any={adventureXp:[],content:[],villain:[]};
for(let i=0;i<120;i++){
  const n=1+Math.floor(rnd()*4),owned=Array.from({length:n},(_,k)=>'o'+k);
  const entered=rnd()<.1?['x']:rnd()<.05?[]:owned.filter((_,k)=>k===0||rnd()<.5);
  const base=rnd()<.05?-1:rnd()<.05?1.5:Math.floor(rnd()*5000);
  pure.adventureXp.push({base,owned,entered,r:tryCode(()=>advMod.adventureBattleXp(base,owned,entered))});
}
// 콘텐츠 검사: 원본 그대로 + 한 군데씩 틀리게
const mutate:[string,(c:any)=>void][]=[
  ['ok',()=>{}],['approved',c=>{c.productionBalanceApproved=true;}],['dropZero',c=>{c.policy.darkGangPerWin=0;}],['dupQuest',c=>{c.quests.push(structuredClone(c.quests[0]));}],
  ['emptyLine',c=>{c.scenes[0].lines[0].text='';}],['lvl61',c=>{c.encounters[0].level=61;}],['hp2',c=>{c.encounters[0].hpMultiplier=2;}],['loss1',c=>{c.encounters[0].lossXp=1;}],
  ['blackVillain',c=>{c.encounters[0].villainProfileId='record';}],['badUnlock',c=>{c.quests[1].unlockAfter=['NOPE'];}],['winsMismatch',c=>{c.quests[0].objective.wins=2;}],
  ['sceneWins',c=>{const q=c.quests.find((q:any)=>q.objective.kind==='scene');q.objective.wins=1;}],['statue6',c=>{c.quests[0].statueStageAfter=6;}],['bundle0',c=>{c.quests[0].fragmentBundle.count=0;}],
  ['gateUnknown',c=>{c.policy.mainLifetimeGates.NOPE=1;}],['lifetimeOver',c=>{c.quests[0].darkGangLifetimeRequired=c.policy.maxBalance+1;}],['noScene',c=>{c.quests[0].acceptScene='nope';}],
];
for(const [name,fn] of mutate){const c=structuredClone(content);fn(c);pure.content.push({name,r:tryCode(()=>{storySvc.validateStoryContent(c);return true;})});}
for(const id of ['first','dark_first','record','engineer','escort','guide','nope'])for(const lv of [1,20,23,29,50,58,60])pure.villain.push({id,lv,r:tryCode(()=>villains.storyVillainFighter(catalog,id,lv,'enemy'))});

// 2) 실제 서비스(임시 DB)
const dir=mkdtempSync(join(tmpdir(),'gmm-parity6-'));const url=`file:${join(dir,'p.db')}`;
writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'prisma/schema.prisma')));
execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],{cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
const db=new PrismaClient({datasources:{db:{url}}});
const runs:any[]=[];
// 실제 id(개체·전투·모험·플레이어)를 짧은 별명으로 바꿔 비교 가능하게
const alias=new Map<string,string>();
const al=(id:string,name:string)=>{alias.set(id,name);};
const sortedAlias=(ids:string[],prefix:string)=>[...ids].sort((a,b)=>a<b?-1:a>b?1:0).forEach((id,i)=>al(id,prefix+i));
// 성장 곡선 배열은 카탈로그와 같으면 종 id로 줄여 적음(시험에서 다시 펼침)
const growthKey=new Map(catalog.characters.map((c:any)=>[JSON.stringify(c.growth),'growth:'+c.id]));
const norm=(v:unknown)=>{let t=JSON.stringify(v??null,(k,x)=>k==='growth'&&Array.isArray(x)?growthKey.get(JSON.stringify(x))??x:x);for(const [id,name] of alias)t=t.split(id).join(name);return JSON.parse(t);};
const slim=(st:any)=>({mode:st.mode,turn:st.turn,outcome:st.outcome,surrendered:!!st.surrendered,fighters:st.fighters.map((f:any)=>({ownedId:f.ownedId,speciesId:f.speciesId,hp:f.hp,mp:f.mp})),reserves:(st.reserves??[]).map((f:any)=>({ownedId:f.ownedId,hp:f.hp,mp:f.mp})),participation:st.participation,
  switches:st.events.flatMap((r:any)=>(r.events??[]).filter((e:any)=>e.actor==='self'&&['switch','forced-switch'].includes(e.kind)).map((e:any)=>({kind:e.kind,to:e.to})))});
// 응답 전체 대신 비교에 쓰는 값만(의뢰 목록은 줄 배열로)
const view=(d:any)=>{if(!d||typeof d!=='object'||!d.quests)return d&&typeof d==='object'?norm(d):d;
  return norm({revision:d.revision,contentVersion:d.contentVersion,statue:d.statue,currentQuest:d.currentQuest?.id??null,
    quests:d.quests.map((q:any)=>[q.id,q.status,q.objective.wins,q.objective.requiredWins,q.canDepart,q.adventureId,q.battleId]),
    residents:d.residents.map((r:any)=>[r.id,r.status,r.questId]),history:d.history.map((h:any)=>h.questId),adventures:d.adventures,
    pendingDeparture:d.pendingDeparture,materialAdventure:d.materialAdventure,nextStoryHint:d.nextStoryHint,scene:d.scene});};

try{
  const battleSvc=new battleMod.RosterBattle(db,()=>catalog,()=>paced);
  const adventure=new advMod.RosterAdventure(db,()=>catalog,battleMod.fighter);
  // 파티 구성: 강함(60레벨 3마리)·보통·약함. 약한 파티는 패배·강제 귀환·도망을 기록하려고.
  const plans=[
    {name:'strong',party:[['u60',60],['u59',60],['u58',60]],campaign:true},
    {name:'strong2',party:[['u57',60],['u56',58]],campaign:true},
    {name:'mid',party:[['u20',25],['u33',22],['u09',18]],campaign:true},
    {name:'weak',party:[['u02',3]],campaign:true},
    {name:'weak3',party:[['u02',2],['u03',2],['u05',2]],campaign:true},
  ] as const;
  let opNo=0;
  for(const plan of plans){
    const player=await db.player.create({data:{identity:'p6:'+plan.name,credits:0}});al(player.id,'P-'+plan.name);
    const units:string[]=[];
    for(const [k,[sp,lv]] of plan.party.entries()){const row=await db.roster60Owned.create({data:{playerId:player.id,speciesId:sp,totalXp:BigInt(xpAt(sp,lv)),source:'p6-'+k}});units.push(row.id);}
    const spare=await db.roster60Owned.create({data:{playerId:player.id,speciesId:'u10',totalXp:BigInt(xpAt('u10',30)),source:'p6-spare'}});
    sortedAlias([...units,spare.id],'U'); // 경험치 나머지는 id 순서로 나눠서, 별명도 실제 id와 같은 순서가 되게
    for(const [itemId,count] of Object.entries({potion:5,big:2,feather:2,clear:1}))await db.playerItem.create({data:{playerId:player.id,itemId,count}});
    const story=new storySvc.RosterStory(db,()=>catalog,()=>paced,content,()=>null,()=>unitXpPolicy);
    const ops:any[]=[];let rev=0,lastDto:any=null,battleNo=0,advNo=0;
    const rid=()=>'r'+(opNo++);
    const record=async(op:any,fn:()=>Promise<any>)=>{
      try{const d=await fn();if(d&&typeof d.revision==='number'&&d.quests){rev=d.revision;lastDto=d;}op.view=view(d);}catch(e:any){op.error=e.code??e.message;}
      ops.push(op);return op;};
    const ownedState=async()=>norm((await db.roster60Owned.findMany({where:{playerId:player.id},orderBy:{source:'asc'}})).map((o:any)=>({id:o.id,totalXp:Number(o.totalXp),status:o.status})));
    await record({op:'state'},()=>story.state(player.id));
    const playBattle=async(created:any,op:any)=>{
      const id=created.battleId;al(id,'B'+(battleNo++));
      const row0=await db.roster60Battle.findUnique({where:{id}}),snap=JSON.parse(row0.snapshot),init=JSON.parse(row0.state);
      if(snap.adventureId&&!alias.has(snap.adventureId))al(snap.adventureId,'A'+(advNo++));
      const {acceptToken,...ctx}=snap.story??{};
      op.battle={encounter:snap.encounter,story:snap.story?norm(ctx):null,hasToken:!!acceptToken,unitXpPacing:norm(snap.unitXpPacing),storyUnitXp:snap.storyUnitXp?norm({...snap.storyUnitXp,acceptToken:undefined}):null,
        adventureId:norm(snap.adventureId??null),xpRecipient:snap.xpRecipient,enemy:norm(init.fighters[1]),self:norm(init.fighters.map((f:any)=>({ownedId:f.ownedId,hp:f.hp}))),reserves:norm((init.reserves??[]).map((f:any)=>({ownedId:f.ownedId,hp:f.hp}))),publicEnemy:norm({name:created.state.fighters[1].name,artVariant:created.state.fighters[1].artVariant??null})};
      let r=created;
      for(let t=0;t<80&&r.status==='ACTIVE';t++){
        const st=JSON.parse((await db.roster60Battle.findUnique({where:{id}})).state),me=st.fighters[0];
        const alive=(st.reserves??[]).filter((f:any)=>f.hp>0);let action:any;const x=rnd();
        if(me.hp<=0)action=alive.length?{kind:'switch',targetOwnedId:alive[0].ownedId}:{kind:'attack'};
        else if(st.mode==='adventure'&&x<.06)action={kind:'escape'};
        else if(x<.1&&alive.length)action={kind:'switch',targetOwnedId:pick(alive).ownedId};
        else{const usable=me.skills.filter((k:any)=>k.mpCost<=me.mp);action=usable.length&&x<.85?{kind:'skill',skillId:usable.sort((a:any,b:any)=>b.power-a.power)[0].id}:me.mp<me.stats.mp/3?{kind:'focus'}:{kind:'attack'};}
        const before=await db.roster60Battle.findUnique({where:{id}});
        try{r=await battleSvc.action(player.id,{requestId:rid(),battleId:id,revision:before.revision,action});}catch(e:any){op.actionErrors=(op.actionErrors??0)+1;if(op.actionErrors>5)break;}
      }
      const fin=await db.roster60Battle.findUnique({where:{id}});
      op.final=norm(slim(JSON.parse(fin.state)));op.status=fin.status;
      if(fin.status==='FINISHED'){const st=await battleSvc.settle(player.id,{requestId:rid(),battleId:id,revision:fin.revision});op.settlement=norm(st.settlement);}
      op.ownedAfter=await ownedState();
      op.account=await db.roster60StoryAccount.findUnique({where:{playerId:player.id}}).then((a:any)=>({darkGangBalance:a.darkGangBalance,darkGangLifetime:a.darkGangLifetime}));
      if(snap.adventureId){const run=await db.roster60Adventure.findUnique({where:{id:snap.adventureId}});op.adventure=norm({status:run.status,activeBattleId:run.activeBattleId,pendingRewards:JSON.parse(run.pendingRewards),party:JSON.parse(run.state).party.map((f:any)=>({ownedId:f.ownedId,hp:f.hp,mp:f.mp})),settlement:run.settlement?JSON.parse(run.settlement):null});}
      await record({op:'state'},()=>story.state(player.id));
    };
    const doReturn=async(adventureId:string)=>{
      const run=await db.roster60Adventure.findUnique({where:{id:adventureId}});
      const op:any={op:'return',adventureId:norm(adventureId)};
      try{const r=await adventure.return(player.id,{requestId:rid(),adventureId,revision:run.revision});op.result=norm({status:r.status,settlement:r.settlement});}catch(e:any){op.error=e.code??e.message;}
      op.ownedAfter=await ownedState();ops.push(op);
      await record({op:'state'},()=>story.state(player.id));
    };
    const sceneThrough=async(questId:string,phase:string,closeAt?:number)=>{
      const o=await record({op:'open',questId,phase},()=>story.open(player.id,{requestId:rid(),revision:rev,questId,phase}));if(o.error)return false;
      for(let i=0;i<60;i++){
        const sc=lastDto.scene;if(!sc)break;
        if(closeAt!==undefined&&i===closeAt){await record({op:'close'},()=>story.close(player.id,{requestId:rid(),revision:rev}));await record({op:'open',questId,phase},()=>story.open(player.id,{requestId:rid(),revision:rev,questId,phase}));closeAt=undefined;continue;}
        if(sc.last&&phase==='intro'){
          if(rnd()<.3)await record({op:'advance',cursor:sc.cursor},()=>story.advance(player.id,{requestId:rid(),revision:rev,cursor:sc.cursor}));
          await record({op:'accept',questId},()=>story.accept(player.id,{requestId:rid(),revision:rev,questId}));break;}
        await record({op:'advance',cursor:sc.cursor},()=>story.advance(player.id,{requestId:rid(),revision:rev,cursor:sc.cursor}));
      }
      return true;
    };
    // 일부러 틀린 요청 몇 개
    await record({op:'accept',questId:'STORY_01'},()=>story.accept(player.id,{requestId:rid(),revision:rev,questId:'STORY_01'}));
    await record({op:'open',questId:'STORY_02',phase:'intro'},()=>story.open(player.id,{requestId:rid(),revision:rev,questId:'STORY_02',phase:'intro'}));
    await record({op:'open',questId:'STORY_01',phase:'return'},()=>story.open(player.id,{requestId:rid(),revision:rev,questId:'STORY_01',phase:'return'}));
    await record({op:'open',questId:'NOPE',phase:'intro'},()=>story.open(player.id,{requestId:rid(),revision:rev,questId:'NOPE',phase:'intro'}));
    await record({op:'open-stale',questId:'STORY_01',phase:'intro'},()=>story.open(player.id,{requestId:rid(),revision:rev+5,questId:'STORY_01',phase:'intro'}));
    let guard=0,materialDone=false,losses=0;
    while(guard++<120){
      const avail=lastDto.quests.filter((q:any)=>q.status!=='COMPLETED');
      if(!avail.length)break;
      const q=avail.find((q:any)=>q.status==='READY')??avail.find((q:any)=>q.status==='ACTIVE')??avail.find((q:any)=>q.status==='AVAILABLE');
      if(!q)break;
      if(q.status==='AVAILABLE'){await sceneThrough(q.id,'intro',rnd()<.3?1:undefined);continue;}
      if(q.status==='READY'){await sceneThrough(q.id,'return',rnd()<.2?0:undefined);
        if(rnd()<.15&&lastDto.quests.some((x:any)=>x.id===q.id&&x.status==='COMPLETED')){await sceneThrough(q.id,'replay');}
        continue;}
      // ACTIVE: 출전 또는 귀환
      if(q.adventureId&&!q.canDepart&&!q.battleId){
        const real=q.adventureId;if(real)await doReturn(real);else break;continue;}
      if(!q.canDepart)break;
      const free=await db.roster60Owned.findMany({where:{playerId:player.id}});
      let ownedIds=units.filter(id=>free.find((o:any)=>o.id===id)?.status==='AVAILABLE');
      let adventureId:string|undefined;
      if(q.adventureId){const real=q.adventureId;const run=real?await db.roster60Adventure.findUnique({where:{id:real}}):null;
        if(run?.status==='ACTIVE'){const party=JSON.parse(run.state).party;const aliveFirst=[...party].sort((a:any,b:any)=>(b.hp>0?1:0)-(a.hp>0?1:0));ownedIds=aliveFirst.map((f:any)=>f.ownedId);adventureId=rnd()<.5?run.id:undefined;}}
      if(!ownedIds.length)break;
      const op:any={op:'battle',questId:q.id,ownedIds:norm(ownedIds),adventureId:norm(adventureId??null)};
      try{const created=await story.createBattle(player.id,{requestId:rid(),questId:q.id,ownedIds,...(adventureId?{adventureId}:{})});await playBattle(created,op);
        if(op.final?.outcome!=='win')losses++;}
      catch(e:any){op.error=e.code??e.message;}
      if(!op.battle)ops.push(op);else ops.splice(ops.length-1,0,op);
      if(losses>4)break;
      // 재료 모험: 한 번은 의뢰 모험 중에 따로 흑화 재료 모험을 다녀옴(다른 개체가 없으면 실패 기록)
      if(!materialDone&&lastDto.adventures.length&&rnd()<.5){materialDone=true;
        const enc=lastDto.adventures[0].id,free2=(await db.roster60Owned.findMany({where:{playerId:player.id,status:'AVAILABLE'}})).map((o:any)=>o.id);
        const mop:any={op:'material',encounterId:enc,ownedIds:norm(free2.filter((id:string)=>!units.includes(id)).slice(0,1))};
        try{const created=await story.createBattle(player.id,{requestId:rid(),encounterId:enc,ownedIds:free2.filter((id:string)=>!units.includes(id)).slice(0,1)});await playBattle(created,mop);
          if(lastDto.materialAdventure){const real=lastDto.materialAdventure.adventureId;if(real){ops.splice(ops.length-1,0,mop);await doReturn(real);continue;}}}
        catch(e:any){mop.error=e.code??e.message;}
        if(!mop.battle)ops.push(mop);else ops.splice(ops.length-1,0,mop);
      }
    }
    runs.push({name:plan.name,party:plan.party,ops,final:view(lastDto)});
  }
  // 2-1) 직접 만든 시작 상태: 보통 진행에서는 드러나지 않는 경계(흑화 재료 누적 조건, 석상 단계는 낮아지지 않음)
  const crafted:any[]=[];
  const mains=(n:number)=>Array.from({length:n},(_,i)=>'STORY_'+String(i+1).padStart(2,'0'));
  const cases:{name:string;progress:any;lifetime:number;finish?:string}[]=[];
  for(const [gate,done] of [[2,5],[4,11],[6,17]] as const)for(const lifetime of [gate-1,gate,gate+1])cases.push({name:`gate${gate}-life${lifetime}`,progress:{completed:mains(done)},lifetime});
  cases.push({name:'statue-keeps-max',progress:{completed:mains(5),statueStage:5,accepted:{STORY_06:{token:'tk',wins:1,battles:[]}}},lifetime:9,finish:'STORY_06'});
  cases.push({name:'statue-raise',progress:{completed:mains(5),statueStage:1,accepted:{STORY_06:{token:'tk',wins:1,battles:[]}}},lifetime:9,finish:'STORY_06'});
  cases.push({name:'fragments-overwrite',progress:{completed:mains(5),fragments:{STORY_06_fragments:7},accepted:{STORY_06:{token:'tk',wins:1,battles:[]}}},lifetime:9,finish:'STORY_06'});
  cases.push({name:'resident-gates',progress:{completed:[...mains(17),'RESIDENT_BLACKSMITH_01']},lifetime:5});
  cases.push({name:'hatch',progress:{completed:mains(20),accepted:{STORY_21:{token:'tk',wins:0,battles:[]}}},lifetime:30,finish:'STORY_21'});
  for(const [k,cs] of cases.entries()){
    const player=await db.player.create({data:{identity:'p6c:'+k,credits:0}});al(player.id,'PC'+k);
    const progress={...storySvc.initialStoryProgress?.()??{version:1,completed:[],accepted:{},scene:null,checkpoints:{},readScenes:[],fragments:{},statueStage:1,hatched:false},...cs.progress};
    await db.roster60StoryAccount.create({data:{playerId:player.id,contentVersion:content.version,state:JSON.stringify(progress),darkGangLifetime:cs.lifetime,darkGangBalance:cs.lifetime}});
    const story=new storySvc.RosterStory(db,()=>catalog,()=>paced,content,()=>null,()=>unitXpPolicy);
    const rec:any={...cs,progress,views:[]};let d:any=await story.state(player.id);rec.views.push(view(d));
    if(cs.finish){d=await story.open(player.id,{requestId:'c'+k+'o',revision:d.revision,questId:cs.finish,phase:'return'});
      for(let i=0;d.scene&&i<60;i++)d=await story.advance(player.id,{requestId:`c${k}a${i}`,revision:d.revision,cursor:d.scene.cursor});
      rec.views.push(view(d));}
    crafted.push(rec);
  }
  pure.crafted=crafted;
  // 3) 일반 모험(스토리 아님): 전투 정책의 adventure-1, 출전 개체 100%·대기 50%(원본 per-entered/reserveHalf)
  const generic:any[]=[];
  for(let n=0;n<8;n++){
    const player=await db.player.create({data:{identity:'p6g:'+n,credits:0}});al(player.id,'PG'+n);
    const size=1+Math.floor(rnd()*3),units:string[]=[];
    for(let k=0;k<size;k++){const sp=pick(catalog.characters).id,lv=1+Math.floor(rnd()*(n<2?8:60));const row=await db.roster60Owned.create({data:{playerId:player.id,speciesId:sp,totalXp:BigInt(xpAt(sp,lv)),source:'g'+k}});units.push(row.id);}
    sortedAlias(units,`G${n}U`);
    const rec:any={units:norm(await db.roster60Owned.findMany({where:{playerId:player.id},orderBy:{source:'asc'}}).then((r:any)=>r.map((o:any)=>({id:o.id,speciesId:o.speciesId,totalXp:Number(o.totalXp)})))),battles:[]};
    const start=await adventure.start(player.id,{requestId:'gs'+n,ownedIds:units});al(start.adventureId,'GA'+n);
    for(let b=0;b<3;b++){
      const run=await db.roster60Adventure.findUnique({where:{id:start.adventureId}});if(run.status!=='ACTIVE')break;
      const party=JSON.parse(run.state).party.filter((f:any)=>f.hp>0);if(!party.length)break;
      const ids=[party[0].ownedId,...JSON.parse(run.state).party.map((f:any)=>f.ownedId).filter((id:string)=>id!==party[0].ownedId)];
      const op:any={op:'battle'};
      try{const created=await battleSvc.create(player.id,{requestId:`gb${n}-${b}`,ownedId:ids[0],reserveIds:ids.slice(1),encounterId:'adventure-1',adventureId:start.adventureId});
        const id=created.battleId;al(id,`GB${n}-${b}`);const row0=await db.roster60Battle.findUnique({where:{id}}),snap=JSON.parse(row0.snapshot);
        op.unitXpPacing=norm(snap.unitXpPacing);op.xpRecipient=snap.xpRecipient;
        let r=created;
        for(let t=0;t<80&&r.status==='ACTIVE';t++){
          const st=JSON.parse((await db.roster60Battle.findUnique({where:{id}})).state),me=st.fighters[0],alive=(st.reserves??[]).filter((f:any)=>f.hp>0);
          const x=rnd();const action=me.hp<=0?(alive.length?{kind:'switch',targetOwnedId:alive[0].ownedId}:{kind:'attack'}):x<.08?{kind:'escape'}:x<.2&&alive.length?{kind:'switch',targetOwnedId:pick(alive).ownedId}:{kind:'attack'};
          const before=await db.roster60Battle.findUnique({where:{id}});
          try{r=await battleSvc.action(player.id,{requestId:`ga${n}-${b}-${t}`,battleId:id,revision:before.revision,action});}catch{break;}
        }
        const fin=await db.roster60Battle.findUnique({where:{id}});op.final=norm(slim(JSON.parse(fin.state)));
        if(fin.status==='FINISHED'){const st=await battleSvc.settle(player.id,{requestId:`gx${n}-${b}`,battleId:id,revision:fin.revision});op.settlement=norm(st.settlement);}
        const after=await db.roster60Adventure.findUnique({where:{id:start.adventureId}});op.adventure=norm({status:after.status,pendingRewards:JSON.parse(after.pendingRewards),party:JSON.parse(after.state).party.map((f:any)=>({ownedId:f.ownedId,hp:f.hp,mp:f.mp}))});
      }catch(e:any){op.error=e.code??e.message;}
      rec.battles.push(op);
    }
    const run=await db.roster60Adventure.findUnique({where:{id:start.adventureId}});
    if(run.status==='ACTIVE'){const r=await adventure.return(player.id,{requestId:'gr'+n,adventureId:run.id,revision:run.revision});rec.returned=norm({status:r.status,settlement:r.settlement});}
    rec.ownedAfter=norm(await db.roster60Owned.findMany({where:{playerId:player.id},orderBy:{source:'asc'}}).then((r:any)=>r.map((o:any)=>({id:o.id,totalXp:Number(o.totalXp),status:o.status}))));
    generic.push(rec);
  }
  pure.generic=generic;
}finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
writeFileSync(outFile,JSON.stringify({source:'chatbotgmm/server backup/gmm-110-source-20261101 (0b0fb8b5)',generatedAt:new Date().toISOString(),pure,runs}));
const count=(k:string)=>runs.reduce((n,r)=>n+r.ops.filter((o:any)=>o.op===k).length,0);
console.log(`기준 결과 저장: ${outFile} (진행 ${runs.length}명, 장면 열기 ${count('open')}, 넘기기 ${count('advance')}, 수락 ${count('accept')}, 전투 ${count('battle')}+재료 ${count('material')}, 귀환 ${count('return')}, 일반 모험 ${pure.generic.length}판)`);
for(const r of runs)console.log(r.name,'완료',r.final?.history?.length,'석상',r.final?.statue?.stage);
