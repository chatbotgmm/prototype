// 시험 계정 만들기·로그인 코드 발급(운영 서버에서 실행). 시제품은 시험 계정만 로그인돼요.
// 사용: node --env-file=.env --import tsx tools/issue-codes.ts <이름> [코드 수=5] [유효 시간=24]
//   - 이름의 시험 계정(identity "test:<이름>")이 없으면 만들고, 처음 만들 때 시작 갈매미를 넣어 줘요.
//   - 6자리 코드는 한 번씩만 쓸 수 있어요. 화면에만 찍고 어디에도 저장하지 않아요(DB에는 남음).
import {randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {instanceGrowthCurve,type Catalog} from '../shared/src/index.js';

const [name,countArg,hoursArg]=process.argv.slice(2);
if(!name||!/^[가-힣A-Za-z0-9_-]{1,20}$/.test(name))throw Error('사용: tools/issue-codes.ts <이름(한글·영문·숫자 1~20자)> [코드 수] [유효 시간]');
const count=Math.min(20,Math.max(1,Number(countArg??5))),hours=Math.min(168,Math.max(1,Number(hoursArg??24)));
// 시작 갈매미: 아직 첫 갈매미 고르기(5단계)가 없어서 시험용으로 정해 둔 구성(dev 서버와 같음)
const STARTER=[{speciesId:'u01',level:10},{speciesId:'u09',level:12},{speciesId:'u20',level:15},{speciesId:'u33',level:20},{speciesId:'u45',level:30}];
const db=new PrismaClient();
try{
  let player=await db.player.findUnique({where:{identity:`test:${name}`}});
  if(!player){
    const catalog:Catalog=JSON.parse(readFileSync(resolve(import.meta.dirname,'../data/catalog.json'),'utf8'));
    player=await db.player.create({data:{identity:`test:${name}`,nickname:name,isTest:true,credits:40}});
    for(const [i,u] of STARTER.entries()){const def=catalog.characters.find(c=>c.id===u.speciesId)!;
      await db.owned.create({data:{playerId:player.id,speciesId:u.speciesId,totalXp:BigInt(instanceGrowthCurve(def.growth)[u.level-1].totalXp),source:`test-starter-${i}`}});}
    for(const [itemId,n] of Object.entries({potion:3,big:1,feather:1}))await db.playerItem.create({data:{playerId:player.id,itemId,count:n}});
    console.log(`새 시험 계정 「${name}」을 만들고 시작 갈매미 ${STARTER.length}마리를 넣었어요.`);
  }
  const codes:string[]=[];
  while(codes.length<count){const code=String(randomInt(0,1_000_000)).padStart(6,'0');
    if(await db.loginCode.findUnique({where:{code}}))continue;
    await db.loginCode.create({data:{code,playerId:player.id,expiresAt:new Date(Date.now()+hours*3600000)}});codes.push(code);}
  console.log(`「${name}」 로그인 코드(한 번씩, ${hours}시간 유효): ${codes.join(' ')}`);
}finally{await db.$disconnect();}
