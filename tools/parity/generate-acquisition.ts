// 5단계(획득) 기준 결과: GMM110 원본의 모집·조합·계승·보유 상세를 실제로 실행해 기록한다.
// 사용(원본 폴더 안에서): npx tsx <이 파일> <GMM110 폴더> <출력 JSON>   — 자세한 준비는 generate.ts 맨 위와 같음
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root,outFile]=process.argv.slice(2).map(p=>resolve(p));
const imp=(p:string)=>import(pathToFileURL(join(root,p)).href);
const rules=await imp('src/battle/roster60-rules.ts');
const library=await imp('src/roster60-library.ts');
const recruit=await imp('src/roster60-recruit-session.ts');
const inherit=await imp('src/roster60-skill-inheritance.ts');
const craftMod=await imp('src/roster60-craft.ts');
const ownedMod=await imp('src/roster60-owned.ts');
const {PrismaClient}=createRequire(join(root,'package.json'))('@prisma/client');
const catalog=JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1/catalog.json'),'utf8'));
const policy=JSON.parse(readFileSync(join(root,'data/roster60-recruit-policy.json'),'utf8'));
let s=20261114;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
const pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)];
const tryCode=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:(e as any).code??(e as Error).message};}};
const xpAt=(id:string,lv:number)=>catalog.characters.find((c:any)=>c.id===id).growth[lv-1].totalXp;
const out:any={pure:{grant:[],half:[],tickets:[],inherit:[]},recruit:[],craft:[],owned:[]};

// 1) 순수 함수
for(const u of catalog.characters)out.pure.grant.push({id:u.id,r:tryCode(()=>library.recruitmentGrowth(u))});
for(const [c,r] of [[2,null],[6,null],[10,null],[3,null],[3,'ceil'],[3,'floor'],[0,null],[-2,'ceil'],[2.5,'ceil']] as const)out.pure.half.push({c,r,res:tryCode(()=>recruit.halfRecruitCost(c,r))});
for(const w of [{COMMON:70,UNCOMMON:28,RARE:2},{RARE:90,EPIC:9,LEGEND:.5,HIDDEN:.5},{A:50,B:49},{A:100.5},{A:33.333,B:66.667},{},{A:0,B:100},{A:-1,B:101}])out.pure.tickets.push({w,r:tryCode(()=>recruit.recruitWeightTickets(w))});
for(let i=0;i<250;i++){
  const recipe=pick(catalog.recipes),mats:any[]=[];let k=0;
  for(const ing of recipe.ingredients)for(let j=0;j<ing.count;j++)mats.push({id:`m${i}-${k++}`,speciesId:ing.unitId,level:1+Math.floor(rnd()*60),skillInheritanceJson:null});
  const resultLevel=1+Math.floor(rnd()*60);
  const base=tryCode(()=>inherit.inheritancePreview(catalog,recipe.resultId,resultLevel,mats));
  let choice:any;
  if((base as any).ok){const v=(base as any).ok.view;const cand=pick(v.candidates as any[]);
    choice=rnd()<.7?{skillId:cand.skillId,replaceSlot:pick(cand.allowedReplaceSlots as number[])}:rnd()<.5?{skillId:cand.skillId,replaceSlot:5}:{skillId:'nope',replaceSlot:0};}
  out.pure.inherit.push({resultId:recipe.resultId,resultLevel,mats,choice,base,chosen:choice?tryCode(()=>inherit.inheritancePreview(catalog,recipe.resultId,resultLevel,mats,choice)):null});
}

// 2) 서비스(임시 DB)
const dir=mkdtempSync(join(tmpdir(),'gmm-parity5-'));const url=`file:${join(dir,'p.db')}`;
writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'prisma/schema.prisma')));
execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],{cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
const db=new PrismaClient({datasources:{db:{url}}});
try{
  // 모집: 굴림 값을 기록하며 실행
  for(let n=0;n<20;n++){
    const player=await db.player.create({data:{identity:'p5r:'+n,credits:500}});
    await db.roster60State.create({data:{playerId:player.id,starterId:'starter-'+n}});
    const rolls:number[]=[];const roll=(max:number)=>{const v=Math.floor(rnd()*max);rolls.push(max,v);return v;};
    const svc=new recruit.RecruitSessions(db,()=>catalog,()=>policy,roll);
    const kind=pick(['LOW','MID','HIGH']),times=1+Math.floor(rnd()*4);
    const started:any=await svc.start(player.id,{requestId:'r'+n,kind,catalogVersion:catalog.version,times});
    const steps:any[]=[];
    for(const sess of started.sessions){
      const act=pick(['claim','reroll','reject']);
      try{const r:any=await svc.action(player.id,{requestId:`a${n}-${sess.sessionId}`,sessionId:sess.sessionId,revision:sess.revision,action:act});steps.push({act,candidate:r.candidate,status:r.status,credits:r.credits});}
      catch(e:any){steps.push({act,error:e.code});}
    }
    out.recruit.push({kind,times,rolls,candidates:started.sessions.map((x:any)=>x.candidate),credits:started.credits,steps});
  }
  // 등급 경계: 굴림 값을 확률표의 경계(0, 각 누적값−1·누적값, 9999)에 일부러 놓고 실행
  for(const offer of policy.offers){
    const tickets=recruit.recruitWeightTickets(offer.weights);let sum=0;const edges=[0,9999];
    for(const [,t] of tickets){sum+=t;if(sum<10000)edges.push(sum-1,sum);}
    const queue=[...edges];const rolls:number[]=[];
    const roll=(max:number)=>{const v=max===10000?queue.shift()!:0;rolls.push(max,v);return v;};
    const player=await db.player.create({data:{identity:'p5b:'+offer.kind,credits:5000}});
    await db.roster60State.create({data:{playerId:player.id,starterId:'starter-b-'+offer.kind}});
    const started:any=await new recruit.RecruitSessions(db,()=>catalog,()=>policy,roll).start(player.id,{requestId:'b'+offer.kind,kind:offer.kind,catalogVersion:catalog.version,times:edges.length});
    out.recruit.push({kind:offer.kind,times:edges.length,rolls,candidates:started.sessions.map((x:any)=>x.candidate),credits:started.credits,start:5000,steps:[],edges});
  }
  // 조합·보유 상세
  for(let n=0;n<40;n++){
    const player=await db.player.create({data:{identity:'p5c:'+n,credits:0}});
    const recipe=pick(catalog.recipes),rows:any[]=[];let k=0;
    for(const ing of recipe.ingredients)for(let j=0;j<ing.count;j++){
      const lv=rnd()<.15?1+Math.floor(rnd()*4):ing.minLevel+Math.floor(rnd()*(60-ing.minLevel));
      rows.push(await db.roster60Owned.create({data:{playerId:player.id,speciesId:ing.unitId,totalXp:BigInt(xpAt(ing.unitId,lv)),source:`c${n}-${k++}`}}));}
    // 상관없는 개체도 하나(선택지 목록용)
    const extra=pick(catalog.characters.slice(0,24));rows.push(await db.roster60Owned.create({data:{playerId:player.id,speciesId:extra.id,totalXp:BigInt(xpAt(extra.id,5)),source:`c${n}-extra`}}));
    const svc=new craftMod.RosterCraft(db,()=>catalog);
    const optPublic=await svc.options(player.id,false),optDiscovery=await svc.options(player.id,true);
    const materialIds=rows.slice(0,-1).map(r=>r.id);
    const preview0=await svc.preview(player.id,{resultId:recipe.resultId,materialIds,catalogVersion:catalog.version}).then((v:any)=>({ok:v}),(e:any)=>({error:e.code}));
    let preview1:any=null,confirmed:any=null,detail:any=null;
    if(preview0.ok){const cand=pick(preview0.ok.inheritance.candidates);const inheritance={skillId:cand.skillId,replaceSlot:pick(cand.allowedReplaceSlots)};
      preview1=await svc.preview(player.id,{resultId:recipe.resultId,materialIds,catalogVersion:catalog.version,inheritance}).then((v:any)=>({ok:v,inheritance}),(e:any)=>({error:e.code,inheritance}));
      if(preview1.ok){confirmed=await svc.confirm(player.id,{resultId:recipe.resultId,materialIds,catalogVersion:catalog.version,inheritance,requestId:'cf'+n,previewFingerprint:preview1.ok.previewFingerprint}).then((v:any)=>({ok:v}),(e:any)=>({error:e.code}));
        if(confirmed.ok){const o=await new ownedMod.RosterOwned(db,()=>catalog,()=>0).read(player.id,confirmed.ok.ownedId);const row=await db.roster60Owned.findUnique({where:{id:confirmed.ok.ownedId}});
          detail={row:{id:row.id,speciesId:row.speciesId,totalXp:row.totalXp.toString(),reincarnation:row.reincarnation,status:row.status,locked:row.locked,skillInheritanceJson:row.skillInheritanceJson},unit:o.unit};}}}
    out.craft.push({recipe:recipe.resultId,rows:rows.map(r=>({id:r.id,speciesId:r.speciesId,totalXp:r.totalXp.toString(),reincarnation:0,status:'AVAILABLE',locked:false,skillInheritanceJson:null})),...(n<12?{optPublic,optDiscovery}:{}),materialIds,preview0,preview1,confirmed,detail});
  }
}finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
writeFileSync(outFile,JSON.stringify({source:'chatbotgmm/server backup/gmm-110-source-20261101 (0b0fb8b5)',generatedAt:new Date().toISOString(),...out}));
console.log(`기준 결과 저장: 순수 ${Object.values(out.pure).reduce((n:number,a:any)=>n+a.length,0)}건, 모집 ${out.recruit.length}판, 조합 ${out.craft.length}판(확정 ${out.craft.filter((c:any)=>c.confirmed?.ok).length})`);
