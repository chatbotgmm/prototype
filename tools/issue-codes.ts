// 시험 계정 만들기·로그인 코드 발급(운영 서버에서 실행). 시제품은 시험 계정만 로그인돼요.
// 사용: node --env-file=.env --import tsx tools/issue-codes.ts <이름> [코드 수=5] [유효 시간=24]
//   - 이름의 시험 계정(identity "test:<이름>")이 없으면 빈 계정으로 만들어요. 게임에 들어가면 원본처럼 첫 갈매미 흐름(갈매미맨 → 튜토리얼 → 커먼 고르기)이 시작돼요.
//   - 6자리 코드는 한 번씩만 쓸 수 있어요. 화면에만 찍고 어디에도 저장하지 않아요(DB에는 남음).
import {randomInt} from 'node:crypto';
import {PrismaClient} from '@prisma/client';

const [name,countArg,hoursArg]=process.argv.slice(2);
if(!name||!/^[가-힣A-Za-z0-9_-]{1,20}$/.test(name))throw Error('사용: tools/issue-codes.ts <이름(한글·영문·숫자 1~20자)> [코드 수] [유효 시간]');
const count=Math.min(20,Math.max(1,Number(countArg??5))),hours=Math.min(168,Math.max(1,Number(hoursArg??24)));
const db=new PrismaClient();
try{
  let player=await db.player.findUnique({where:{identity:`test:${name}`}});
  if(!player){
    // 지원서 30장: 원본 DB의 Player.credits 기본값(GMM110 prisma/schema.prisma)
    player=await db.player.create({data:{identity:`test:${name}`,nickname:name,isTest:true,credits:30}});
    console.log(`새 시험 계정 「${name}」을 만들었어요(빈 계정, 지원서 30장).`);
  }
  const codes:string[]=[];
  while(codes.length<count){const code=String(randomInt(0,1_000_000)).padStart(6,'0');
    if(await db.loginCode.findUnique({where:{code}}))continue;
    await db.loginCode.create({data:{code,playerId:player.id,expiresAt:new Date(Date.now()+hours*3600000)}});codes.push(code);}
  console.log(`「${name}」 로그인 코드(한 번씩, ${hours}시간 유효): ${codes.join(' ')}`);
}finally{await db.$disconnect();}
