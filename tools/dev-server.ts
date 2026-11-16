// 개발용 시험 서버: 켤 때마다 임시 DB를 새로 만들고, 끄면 지운다. 운영 DB·.env는 읽지 않는다.
// 사용: npm run dev [-- 포트]   (기본 3999)
import {buildApp} from '../server/src/app.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTestDb,seedTestPlayer,root} from './test-db.js';

const port=Number(process.argv[2]??3999);
const t=await createTestDb();
const codes=['135790',...Array.from({length:19},(_,i)=>String(100001+i))];
// 바로 해 보기 계정: 첫 갈매미 흐름을 마친 상태 + 갈매미 5마리
const ready=await seedTestPlayer(t.db,{name:'시험대장',codes,items:{potion:3,big:1,feather:1},
  units:[{speciesId:'u01',level:10},{speciesId:'u09',level:12},{speciesId:'u20',level:15},{speciesId:'u33',level:20},{speciesId:'u45',level:30},...[5,6,5,6,5,6].map(level=>({speciesId:'u02',level}))]}); // u02 여섯 마리: 노움(u09) 조합 확인용(검토 화면 크기마다 두 마리씩)
await t.db.onboardingState.create({data:{playerId:ready.player.id,starterId:ready.units[0].id,tutorialProof:'dev-seed',completedAt:new Date(),ticketId:'dev-seed-ticket',selectedId:'u02'}});
// 처음부터 해 보기 계정 3개: 빈 계정(원본 흐름 그대로, 지원서 30장). 첫 갈매미 흐름은 계정마다 한 번이라 검토 화면 크기마다 하나씩
const fresh:string[]=[];
for(let k=0;k<3;k++){const c=Array.from({length:5},(_,i)=>String(200001+k*10+i));fresh.push(`새내기${k+1}: ${c.join(' ')}`);await seedTestPlayer(t.db,{name:`새내기${k+1}`,codes:c,units:[],credits:30});}
// 이야기 해 보기 계정(검토 화면 크기마다 하나씩, 진행은 계정마다라서): 처음 상태 / 7장까지 마친 상태(악당 의뢰·주민 부탁이 열린 상태)
const storyCodes:string[]=[];
const storyContent=JSON.parse(readFileSync(join(root,'data/story/story-mode-v1.json'),'utf8'));
for(let k=0;k<3;k++)for(const [kind,done] of [['처음',0],['중반',7]] as const){
  const c=String(300001+k*10+(done?5:0));storyCodes.push(`이야기${kind}${k+1}: ${c}`);
  const s=await seedTestPlayer(t.db,{name:`이야기${kind}${k+1}`,codes:[c],items:{potion:3},units:[{speciesId:'u60',level:60},{speciesId:'u45',level:30},{speciesId:'u20',level:15},{speciesId:'u02',level:3}]});
  await t.db.onboardingState.create({data:{playerId:s.player.id,starterId:s.units[3].id,tutorialProof:'dev-seed',completedAt:new Date(),ticketId:`dev-story-${k}-${done}`,selectedId:'u02'}});
  if(done)await t.db.storyAccount.create({data:{playerId:s.player.id,contentVersion:storyContent.version,darkGangBalance:done,darkGangLifetime:done,
    state:JSON.stringify({version:1,completed:Array.from({length:done},(_,i)=>'STORY_0'+(i+1)),accepted:{},scene:null,checkpoints:{},readScenes:[],fragments:{STORY_01_fragments:1,STORY_06_fragments:2},statueStage:2,hatched:false})}});
}
// 랭크 해 보기 계정(검토 화면 크기마다 하나): 방범대장 6000 XP(Lv.60 넘음) + Lv60 대원 둘
const rankCodes:string[]=[];
{const {withRewardSchedule,commanderPolicyFingerprint}=await import('../shared/src/index.js');
  const cp=withRewardSchedule(JSON.parse(readFileSync(join(root,'data/commander-policy.json'),'utf8')),JSON.parse(readFileSync(join(root,'data/commander-reward-schedule.json'),'utf8')));
  for(let k=0;k<3;k++){const c=String(400001+k);rankCodes.push(`랭크대장${k+1}: ${c}`);
    const s=await seedTestPlayer(t.db,{name:`랭크대장${k+1}`,codes:[c],items:{potion:2},units:[{speciesId:'u60',level:60},{speciesId:'u59',level:60},{speciesId:'u20',level:20}]});
    await t.db.onboardingState.create({data:{playerId:s.player.id,starterId:s.units[2].id,tutorialProof:'dev-seed',completedAt:new Date(),ticketId:`dev-rank-${k}`,selectedId:'u02'}});
    await t.db.commanderAccount.create({data:{playerId:s.player.id,totalXp:6000n,policyVersion:cp.version,policyFingerprint:commanderPolicyFingerprint(cp)}});
    await t.db.pvpParty.create({data:{playerId:s.player.id,ownedIds:JSON.stringify([s.units[0].id,s.units[1].id])}});}}
const app=await buildApp(t.db,{root,secret:'local-dev-only-not-a-production-secret-0000'});
await app.listen({host:'127.0.0.1',port});
console.log(`시험 서버: http://127.0.0.1:${port}/proto/api/v1/health\n로그인 코드(한 번씩) — 바로 해 보기 「시험대장」: ${codes.join(' ')}\n처음부터 해 보기 — ${fresh.join(' / ')}\n이야기 해 보기 — ${storyCodes.join(' / ')}\n랭크 해 보기 — ${rankCodes.join(' / ')}\n끄면(Ctrl+C) 임시 DB를 지워요.`);
const stop=()=>{void app.close().then(t.close).then(()=>process.exit(0));};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
