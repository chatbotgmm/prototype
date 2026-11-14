// 임시 SQLite DB 만들기 + 시험 계정 넣기. 통합 시험과 시험 서버가 같이 씀. 운영 DB는 건드리지 않음.
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PrismaClient} from '@prisma/client';
import {instanceGrowthCurve,type Catalog} from '../shared/src/index.js';

export const root=resolve(import.meta.dirname,'..');
export async function createTestDb(){
  const dir=mkdtempSync(join(tmpdir(),'gmm-proto-')),url=`file:${join(dir,'test.db')}`;
  // 저장소의 .env를 읽지 않도록 스키마를 임시 폴더에 복사해서 씀
  writeFileSync(join(dir,'schema.prisma'),readFileSync(join(root,'server/prisma/schema.prisma')));
  execFileSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'db','push','--schema',join(dir,'schema.prisma'),'--skip-generate'],
    {cwd:dir,env:{PATH:process.env.PATH??'',DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1'},stdio:'pipe'});
  const db=new PrismaClient({datasources:{db:{url}}});
  return {db,url,close:async()=>{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}};
}
/** 시험 계정: 개체(종·레벨 지정), 아이템, 로그인 코드 여러 개(한 번씩만 쓸 수 있음). */
export async function seedTestPlayer(db:PrismaClient,opt:{name:string;units:{speciesId:string;level:number;reincarnation?:number}[];items?:Record<string,number>;codes:string[];hoursValid?:number;credits?:number}){
  const catalog:Catalog=JSON.parse(readFileSync(join(root,'data/catalog.json'),'utf8'));
  const player=await db.player.create({data:{identity:`test:${opt.name}`,nickname:opt.name,isTest:true,credits:opt.credits??40}});
  const units=[];
  for(const [i,u] of opt.units.entries()){
    const def=catalog.characters.find(c=>c.id===u.speciesId);if(!def)throw Error(`없는 종: ${u.speciesId}`);
    const xp=instanceGrowthCurve(def.growth,u.reincarnation??0,def.reincarnationXpPolicy)[u.level-1].totalXp;
    units.push(await db.owned.create({data:{playerId:player.id,speciesId:u.speciesId,totalXp:BigInt(xp),reincarnation:u.reincarnation??0,source:`test-seed-${i}`}}));
  }
  for(const [itemId,count] of Object.entries(opt.items??{}))await db.playerItem.create({data:{playerId:player.id,itemId,count}});
  await db.loginCode.createMany({data:opt.codes.map(code=>({code,playerId:player.id,expiresAt:new Date(Date.now()+(opt.hoursValid??12)*3600000)}))});
  return {player,units};
}
