// HTTP 서버. 모든 API는 `${basePath}/api/v1/...` 아래.
import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {RuleError,growthAt,equippedSkills,skillElements} from '../../shared/src/index.js';
import {loadContent} from './content.js';
import {sessionSigner,rawSession,COOKIE,SESSION_DAYS} from './auth.js';
import {ApiError,apiFail} from './errors.js';
import {BattleService,isValidParty,partyPolicy} from './battle-service.js';
import {serial} from './receipts.js';

export type AppOptions={root:string;secret:string;basePath?:string;log?:boolean;now?:()=>number};
export async function buildApp(db:PrismaClient,opt:AppOptions){
  const base=(opt.basePath??'/proto').replace(/\/$/,''),api=`${base}/api/v1`,now=opt.now??Date.now;
  const content=loadContent(opt.root),battles=new BattleService(db,content),sessions=sessionSigner(opt.secret);
  const app=Fastify({logger:opt.log??false,bodyLimit:8192});
  app.setErrorHandler((e,_req,reply)=>{
    if(e instanceof ApiError)return reply.code(e.status).send({error:e.code});
    if(e instanceof RuleError)return reply.code(409).send({error:e.code});
    if(e instanceof z.ZodError)return reply.code(400).send({error:'INVALID_REQUEST'});
    if((e as {statusCode?:number}).statusCode===400)return reply.code(400).send({error:'INVALID_REQUEST'});
    app.log.error(e);return reply.code(500).send({error:'SERVER_ERROR'});
  });
  const secure=(req:FastifyRequest)=>/https/.test(String(req.headers['cf-visitor']??req.headers['x-forwarded-proto']??''));
  const cookie=(req:FastifyRequest,value:string,maxAge:number)=>`${COOKIE}=${value}; Path=${base||'/'}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure(req)?'; Secure':''}`;
  // 다른 사이트에서 몰래 보내는 요청 막기: 화면 스크립트가 붙이는 머리글이 있어야 함
  const guard=(req:FastifyRequest)=>{if(req.headers['x-gmm']!=='1')apiFail(403,'FORBIDDEN');};
  const who=async(req:FastifyRequest)=>{
    guard(req);const id=sessions.verify(rawSession(req),now());if(!id)return apiFail(401,'LOGIN_REQUIRED');
    const p=await db.player.findUnique({where:{id},select:{id:true,isTest:true}});if(!p||!p.isTest)return apiFail(401,'LOGIN_REQUIRED');
    return id;
  };
  const route=(method:'GET'|'POST',path:string,run:(id:string,req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>)=>
    app.route({method,url:api+path,handler:async(req,reply)=>{reply.header('Cache-Control','no-store');return run(await who(req),req,reply);}});

  app.get(`${api}/health`,async()=>({ok:true,catalog:content.catalog.version,testBaseline:content.catalog.productionBalanceApproved===false}));

  // ── 계정
  app.post(`${api}/auth/code`,async(req,reply)=>{
    guard(req);const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);
    const playerId=await db.$transaction(async tx=>{
      const row=await tx.loginCode.findUnique({where:{code},include:{player:true}});
      if(!row||row.usedAt||row.expiresAt.getTime()<now()||!row.player.isTest)return null;
      const used=await tx.loginCode.updateMany({where:{code,usedAt:null},data:{usedAt:new Date(now())}});
      return used.count===1?row.playerId:null;
    });
    if(!playerId)return apiFail(400,'LOGIN_CODE_INVALID');
    const token=sessions.issue(playerId,now());
    reply.header('Set-Cookie',cookie(req,token,SESSION_DAYS*86400));
    return {ok:true,...(req.headers['x-gmm-app']==='1'?{token}:{})};
  });
  app.post(`${api}/auth/logout`,async(req,reply)=>{guard(req);reply.header('Set-Cookie',cookie(req,'',0));return {ok:true};});
  route('GET','/me',async id=>{
    const p=await db.player.findUniqueOrThrow({where:{id}});
    const items=await db.playerItem.findMany({where:{playerId:id}});
    // 방범대장 레벨은 7단계에서 연결. 그 전에는 정책 미연결로 표시(값을 지어내지 않음)
    return {playerId:p.id,nickname:p.nickname,credits:p.credits,items:items.map(i=>({itemId:i.itemId,count:i.count})),commander:{level:null,reason:'COMMANDER_NOT_CONNECTED'},testBaseline:content.catalog.productionBalanceApproved===false};
  });

  // ── 보유 개체
  const ownedSummary=(u:Parameters<BattleService['formationUnit']>[0]&{status:string;locked:boolean})=>({...battles.formationUnit(u),reincarnation:u.reincarnation,status:u.status,locked:u.locked});
  route('GET','/owned',async id=>{
    const rows=await db.owned.findMany({where:{playerId:id},orderBy:{createdAt:'asc'}});
    return {units:rows.map(ownedSummary)};
  });
  route('GET','/owned/:ownedId',async(id,req)=>{
    const {ownedId}=z.object({ownedId:z.string().min(1).max(100)}).parse(req.params);
    const u=await db.owned.findFirst({where:{id:ownedId,playerId:id}});if(!u)return apiFail(404,'UNIT_NOT_FOUND');
    const def=content.catalog.characters.find(d=>d.id===u.speciesId)!,g=growthAt(Number(u.totalXp),def.growth,u.reincarnation,def.reincarnationXpPolicy);
    const skills=equippedSkills(content.catalog,u.speciesId,u.skillInheritanceJson).map(e=>({slot:e.slot,id:e.skill.id,name:e.skill.name,element:e.skill.element,power:e.skill.power,mpCost:e.skill.mpCost,learnLevel:e.origin.requiredLevel,unlocked:e.origin.requiredLevel<=g.level,inherited:e.origin.sourceSpeciesId!==u.speciesId}));
    const next=skills.filter(s=>!s.unlocked).sort((a,b)=>a.learnLevel-b.learnLevel)[0]??null;
    return {...ownedSummary(u),totalXp:u.totalXp.toString(),xp:g.xp,xpToNext:g.xpToNext,role:def.role,
      attack:{...def.attack},skills,nextLearn:next?{level:next.learnLevel,skillId:next.id}:null,
      suitability:{...def.suitability},ownResistance:Object.fromEntries(skillElements.map(e=>[e,def.defense[e]]))};
  });

  // ── 편성
  route('GET','/party',async id=>{
    const p=await db.party.findUnique({where:{playerId:id}});
    return {ownedIds:p?JSON.parse(p.ownedIds):[],partyPolicy};
  });
  route('POST','/party',async(id,req)=>{
    const {ownedIds}=z.object({ownedIds:z.array(z.string().min(1).max(100)).max(6)}).strict().parse(req.body);
    if(!isValidParty(ownedIds))return apiFail(400,'INVALID_PARTY');
    return serial(id,async()=>{
      const n=await db.owned.count({where:{playerId:id,id:{in:ownedIds}}});if(n!==ownedIds.length)return apiFail(404,'UNIT_NOT_FOUND');
      await db.party.upsert({where:{playerId:id},create:{playerId:id,ownedIds:JSON.stringify(ownedIds)},update:{ownedIds:JSON.stringify(ownedIds)}});
      return {ownedIds,partyPolicy};
    });
  });

  // ── 전투
  const requestId=z.string().min(1).max(100),revision=z.number().int().nonnegative(),bid=z.object({battleId:z.string().uuid()});
  const action=z.discriminatedUnion('kind',[
    z.object({kind:z.literal('attack')}).strict(),z.object({kind:z.literal('focus')}).strict(),z.object({kind:z.literal('escape')}).strict(),
    z.object({kind:z.literal('skill'),skillId:z.string().min(1).max(100)}).strict(),
    z.object({kind:z.literal('switch'),targetOwnedId:z.string().min(1).max(100)}).strict(),
    z.object({kind:z.literal('item'),itemId:z.string().min(1).max(100),targetOwnedId:z.string().min(1).max(100).optional()}).strict(),
  ]);
  route('GET','/battle/options',async id=>battles.options(id));
  route('GET','/battle/active',async id=>battles.active(id));
  route('POST','/battle',async(id,req)=>battles.create(id,z.object({requestId,ownedId:z.string().min(1).max(100),encounterId:z.string().min(1).max(100),reserveIds:z.array(z.string().min(1).max(100)).max(5).optional()}).strict().parse(req.body)));
  route('GET','/battle/:battleId',async(id,req)=>battles.read(id,bid.parse(req.params).battleId));
  route('POST','/battle/:battleId/action',async(id,req)=>{const b=z.object({requestId,revision,action}).strict().parse(req.body);return battles.action(id,{...b,battleId:bid.parse(req.params).battleId});});
  route('POST','/battle/:battleId/settle',async(id,req)=>{const b=z.object({requestId,revision}).strict().parse(req.body);return battles.settle(id,{...b,battleId:bid.parse(req.params).battleId});});
  return app;
}
