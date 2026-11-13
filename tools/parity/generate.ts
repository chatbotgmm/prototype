// GMM110 원본 코드를 실제로 돌려 기준 결과(fixture)를 만든다. 새 shared가 같은 결과를 내는지 비교하는 데 쓴다.
// 사용(원본 폴더 안에서 원본의 tsx로 실행):
//   cd <GMM110 galmaegiman-confirmed> && npx tsx <이 파일> <GMM110 폴더> <출력 JSON>
// 원본 폴더는 chatbotgmm/server backup/gmm-110-source-20261101(0b0fb8b5)의 galmaegiman-confirmed를 풀고 npm ci + prisma generate 한 것.
// 임시 SQLite만 쓴다. 운영 DB는 건드리지 않는다.
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root,outFile]=process.argv.slice(2).map(p=>resolve(p));
if(!root||!outFile)throw Error('사용: generate.ts <GMM110 폴더> <출력 JSON>');
const imp=(p:string)=>import(pathToFileURL(join(root,p)).href);
const rules=await imp('src/battle/roster60-rules.ts');
const combat=await imp('src/battle/roster60-five-combat.ts');
const five=await imp('src/battle/roster60-five-stats.ts');
const rein=await imp('src/battle/roster60-reincarnation.ts');
const intel=await imp('src/battle/roster60-opponent-intel.ts');
const adv=await imp('src/roster60-adventure.ts');
const battleMod=await imp('src/roster60-battle.ts');
const {PrismaClient}=createRequire(join(root,'package.json'))('@prisma/client');
const catalog=JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1/catalog.json'),'utf8'));
const policy=JSON.parse(readFileSync(join(root,'data/test-profiles/five-stat-device-test-v1/battle-policy.json'),'utf8'));

// 결정적 의사 난수(fixture 입력 고르기용, 원본 판정과 무관)
let s=20261113;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
const pick=<T>(a:T[])=>a[Math.floor(rnd()*a.length)];
// 비교에 필요한 값만 남김(연출용 presentation·상대 정보 intel·방어 관측은 아직 옮기지 않아 뺌)
const lean=(f:any)=>({ownedId:f.ownedId,id:f.id,speciesId:f.speciesId,level:f.level,hp:f.hp,mp:f.mp});
const leanEvent=(e:any)=>{const {presentation,intelBefore,intelAfter,defenseObservation,...rest}=e;return rest;};
const slim=(st:any)=>({turn:st.turn,outcome:st.outcome,surrendered:st.surrendered,decision:st.decision,participation:st.participation,
  fighters:st.fighters.map(lean),reserves:(st.reserves??[]).map(lean),lastRound:st.events.length?{...st.events.at(-1),events:st.events.at(-1).events.map(leanEvent)}:null,rounds:st.events.length});
const tryCode=(fn:()=>unknown)=>{try{return {ok:fn()};}catch(e){return {error:(e as Error).message};}};

// 1) 순수 함수
const pure:any={growthAt:[],attack:[],order:[],rebirth:[],fighters:[],enemy:[],escape:[],focus:[],reincarnationLevel:[]};
for(const u of catalog.characters){
  const curve=u.growth;
  for(const rc of [0,1,2])for(const xp of [0,1,curve[5]?.totalXp??0,Math.floor((curve[29]?.totalXp??0)*1.01),curve[59]?.totalXp??0,(curve[59]?.totalXp??0)+1,curve[98]?.totalXp??0])
    pure.growthAt.push({id:u.id,rc,xp,r:tryCode(()=>rules.growthAt(xp,curve,rc,u.reincarnationXpPolicy))});
  for(const lv of [1,5,10,24,40,60])for(const rc of [0,1,3])
    pure.fighters.push({id:u.id,lv,rc,r:tryCode(()=>battleMod.fighter(catalog,u.id,lv,'self',rc))});
}
const defs=['weak','normal','resist','immune','reflect'];
for(let i=0;i<300;i++){
  const inp={power:Math.floor(rnd()*80),level:1+Math.floor(rnd()*99),durability:Math.floor(rnd()*120),suitability:Math.floor(rnd()*7)-3,defense:pick(defs),attackerHp:Math.floor(rnd()*900),defenderHp:Math.floor(rnd()*900)};
  pure.attack.push({inp,r:tryCode(()=>combat.fiveStatAttack(inp,catalog.combatPolicy,(b:number,f:number)=>b*f))});
}
for(let i=0;i<200;i++){
  const a=Math.floor(rnd()*40),b=rnd()<.3?a:Math.floor(rnd()*40),bid='b'+i,seed='seed'+Math.floor(rnd()*1e9),turn=Math.floor(rnd()*50);
  pure.order.push({bid,seed,turn,a,b,r:tryCode(()=>combat.decideTurnOrder(bid,turn,[{id:'self',baseSpeed:a,modifiers:[]},{id:'enemy',baseSpeed:b,modifiers:[]}],seed))});
}
for(const u of catalog.characters.slice(0,20))for(const c of [0,1,2,5,6])pure.rebirth.push({id:u.id,c,r:tryCode(()=>five.fiveRebirthStats(u.levelOneStats,u.combatGrowth[29],c))});
for(const e of policy.encounters)for(let i=0;i<20;i++){const seed='es'+i+e.id;pure.enemy.push({id:e.id,seed,r:tryCode(()=>intel.selectEnemySpecies(e,policy.encounters,seed))});}
for(let i=0;i<200;i++){const seed='x'+i,bid='bid'+(i%7),turn=i%13;pure.escape.push({seed,bid,turn,r:tryCode(()=>adv.adventureEscapeSucceeds(seed,bid,turn))});}
for(const [mp,max] of [[0,33],[10,33],[30,33],[33,33],[0,1],[0,0],[5,4]])pure.focus.push({mp,max,r:tryCode(()=>rules.focusMp(mp,max))});
for(const n of [0,1,2,3,4,5,-1])pure.reincarnationLevel.push({n,r:tryCode(()=>rein.requiredReincarnationLevel(n))});

// 2) 실제 전투 서비스(임시 DB)
const dir=mkdtempSync(join(tmpdir(),'gmm-parity-'));const url=`file:${join(dir,'p.db')}`;
writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'prisma/schema.prisma')));
execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],{cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
const db=new PrismaClient({datasources:{db:{url}}});
const battles:any[]=[];
try{
  const svc=new battleMod.RosterBattle(db,()=>catalog,()=>policy);
  const xpAt=(id:string,lv:number,rc:number)=>{const u=catalog.characters.find((c:any)=>c.id===id);return rules.instanceGrowthCurve(u.growth,rc,u.reincarnationXpPolicy)[lv-1].totalXp;};
  for(let n=0;n<60;n++){
    const player=await db.player.create({data:{identity:'parity:'+n,credits:0}});
    const size=1+Math.floor(rnd()*3),units:any[]=[];
    for(let k=0;k<size;k++){
      const speciesId=pick(catalog.characters).id,rc=rnd()<.2?1:0,lv=1+Math.floor(rnd()*(rc?80:60));
      const row=await db.roster60Owned.create({data:{playerId:player.id,speciesId,totalXp:BigInt(xpAt(speciesId,lv,rc)),reincarnation:rc,source:'parity-'+n+'-'+k}});
      units.push({id:row.id,speciesId,totalXp:Number(row.totalXp),reincarnation:rc,level:lv});
    }
    const items={potion:Math.floor(rnd()*3),big:Math.floor(rnd()*2),feather:Math.floor(rnd()*2),clear:1};
    for(const [itemId,count] of Object.entries(items))await db.playerItem.create({data:{playerId:player.id,itemId,count}});
    const encounter=pick(policy.encounters.filter((e:any)=>e.mode!=='adventure'));
    let r:any;
    try{r=await svc.create(player.id,{requestId:'c'+n,ownedId:units[0].id,encounterId:encounter.id,reserveIds:units.slice(1).map(u=>u.id)});}
    catch(e:any){battles.push({units,items,encounterId:encounter.id,createError:e.code??e.message});continue;}
    const row0=await db.roster60Battle.findUnique({where:{id:r.battleId}});
    const init=JSON.parse(row0.state);
    const rec:any={units,items,encounterId:encounter.id,battleId:r.battleId,seed:row0.seed,initial:{mode:init.mode,decision:init.decision,fighters:init.fighters,reserves:init.reserves,participation:init.participation},steps:[]};
    for(let t=0;t<60&&r.status==='ACTIVE';t++){
      const st=JSON.parse((await db.roster60Battle.findUnique({where:{id:r.battleId}})).state),me=st.fighters[0];
      const alive=(st.reserves??[]).filter((f:any)=>f.hp>0),dead=[me,...(st.reserves??[])].filter((f:any)=>f.hp<=0);
      let action:any;const x=rnd();
      if(me.hp<=0)action=alive.length?{kind:'switch',targetOwnedId:pick(alive).ownedId}:{kind:'attack'};
      else if(x<.08&&alive.length)action={kind:'switch',targetOwnedId:pick(alive).ownedId};
      else if(x<.14)action={kind:'item',itemId:pick(['potion','big','clear'])};
      else if(x<.18&&dead.length)action={kind:'item',itemId:'feather',targetOwnedId:pick(dead).ownedId};
      else if(x<.20)action={kind:'item',itemId:'potion',targetOwnedId:'not-mine'};
      else if(x<.30)action={kind:'focus'};
      else if(x<.33)action={kind:'skill',skillId:'nope'};
      else if(x<.35&&t>3)action={kind:'escape'};
      else if(x<.55)action={kind:'attack'};
      else action=me.skills.length?{kind:'skill',skillId:pick(me.skills).id}:{kind:'attack'};
      const before=await db.roster60Battle.findUnique({where:{id:r.battleId}});
      let error:string|undefined;
      try{r=await svc.action(player.id,{requestId:`a${n}-${t}`,battleId:r.battleId,revision:before.revision,action});}catch(e:any){error=e.code??e.message;}
      const after=await db.roster60Battle.findUnique({where:{id:r.battleId}});
      const inv=await db.playerItem.findMany({where:{playerId:player.id}});
      rec.steps.push({action,error,state:error?null:slim(JSON.parse(after.state)),status:after.status,inventory:Object.fromEntries(inv.map((i:any)=>[i.itemId,i.count]))});
    }
    battles.push(rec);
  }
}finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
writeFileSync(outFile,JSON.stringify({source:'chatbotgmm/server backup/gmm-110-source-20261101 (0b0fb8b5)',generatedAt:new Date().toISOString(),pure,battles}));
console.log(`기준 결과 저장: ${outFile} (순수 함수 ${Object.values(pure).reduce((n:number,a:any)=>n+a.length,0)}건, 전투 ${battles.length}판, 행동 ${battles.reduce((n,b)=>n+(b.steps?.length??0),0)}개)`);
