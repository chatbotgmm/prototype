// 개발용 시험 서버: 켤 때마다 임시 DB를 새로 만들고, 끄면 지운다. 운영 DB·.env는 읽지 않는다.
// 사용: npm run dev [-- 포트]   (기본 3999)
import {buildApp} from '../server/src/app.js';
import {createTestDb,seedTestPlayer,root} from './test-db.js';

const port=Number(process.argv[2]??3999);
const t=await createTestDb();
const codes=['135790',...Array.from({length:19},(_,i)=>String(100001+i))];
await seedTestPlayer(t.db,{name:'시험대장',codes,items:{potion:3,big:1,feather:1},
  units:[{speciesId:'u01',level:10},{speciesId:'u09',level:12},{speciesId:'u20',level:15},{speciesId:'u33',level:20},{speciesId:'u45',level:30}]});
const app=await buildApp(t.db,{root,secret:'local-dev-only-not-a-production-secret-0000'});
await app.listen({host:'127.0.0.1',port});
console.log(`시험 서버: http://127.0.0.1:${port}/proto/api/v1/health\n로그인 코드(한 번씩): ${codes.join(' ')}\n끄면(Ctrl+C) 임시 DB를 지워요.`);
const stop=()=>{void app.close().then(t.close).then(()=>process.exit(0));};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
