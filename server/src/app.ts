// HTTP 서버. 모든 API는 `${basePath}/api/v1/...` 아래.
import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {RuleError} from '../../shared/src/index.js';
import {loadContent} from './content.js';
import {sessionSigner,rawSession,COOKIE,SESSION_DAYS} from './auth.js';
import {ApiError,apiFail} from './errors.js';
import {BattleService,isValidParty,partyPolicy} from './battle-service.js';
import {AcquisitionService} from './acquisition-service.js';
import {serial} from './receipts.js';
import {registerStatic} from './static.js';

export type AppOptions={root:string;secret:string;basePath?:string;log?:boolean;now?:()=>number;/** 시험용: 모집 굴림 주입 */roll?:(max:number)=>number};
export async function buildApp(db:PrismaClient,opt:AppOptions){
  const base=(opt.basePath??'/proto').replace(/\/$/,''),api=`${base}/api/v1`,now=opt.now??Date.now;
  const content=loadContent(opt.root),battles=new BattleService(db,content),acquisition=new AcquisitionService(db,content,opt.roll),sessions=sessionSigner(opt.secret);
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

  registerStatic(app,opt.root,base);
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

  // ── 보유 개체(원본 roster60-owned.ts 모양: 목록은 레벨 높은 순, 재료로 쓴 개체 제외)
  route('GET','/owned',async id=>acquisition.ownedList(id));
  route('GET','/owned/:ownedId',async(id,req)=>acquisition.ownedRead(id,z.object({ownedId:z.string().min(1).max(100)}).parse(req.params).ownedId));

  // ── 첫 갈매미
  const requestIdField=z.string().min(1).max(100),catalogVersion=z.string().min(1).max(100);
  route('GET','/onboarding',async id=>acquisition.onboarding(id));
  route('POST','/onboarding/start',async id=>acquisition.onboardingStart(id));
  route('POST','/onboarding/complete',async id=>acquisition.onboardingComplete(id));
  route('POST','/onboarding/preview',async(id,req)=>acquisition.onboardingPreview(id,z.object({ticketId:z.string().min(1).max(100)}).strict().parse(req.body).ticketId));
  route('POST','/onboarding/confirm',async(id,req)=>acquisition.onboardingConfirm(id,z.object({ticketId:z.string().min(1).max(100),characterId:z.string().max(10),catalogVersion}).strict().parse(req.body)));

  // ── 모집
  route('GET','/recruit',async id=>acquisition.recruitInfo(id));
  route('POST','/recruit/start',async(id,req)=>acquisition.recruitStart(id,z.object({requestId:requestIdField,kind:z.enum(['LOW','MID','HIGH']),catalogVersion,times:z.number().int().min(1).max(50).optional()}).strict().parse(req.body)));
  route('POST','/recruit/action',async(id,req)=>acquisition.recruitAction(id,z.object({requestId:requestIdField,sessionId:z.string().uuid(),revision:z.number().int().nonnegative(),action:z.enum(['reroll','claim','reject'])}).strict().parse(req.body)));
  route('POST','/recruit/claim-all',async(id,req)=>acquisition.recruitClaimAll(id,z.object({requestId:requestIdField,sessions:z.array(z.object({sessionId:z.string().uuid(),revision:z.number().int().nonnegative()}).strict()).min(1).max(50)}).strict().parse(req.body)));

  // ── 도감·조합
  route('GET','/collection',async id=>acquisition.collection(id));
  const inheritance=z.object({skillId:z.string().min(1).max(100),replaceSlot:z.number().int().min(0).max(5)}).strict();
  const selection=z.object({resultId:z.string().regex(/^u\d{2}$/),materialIds:z.array(z.string().min(1).max(100)).min(1).max(6),catalogVersion,inheritance:inheritance.optional()}).strict();
  route('GET','/craft/options',async(id,req)=>acquisition.craftOptions(id,(req.query as {discovery?:string}).discovery==='1'));
  route('POST','/craft/preview',async(id,req)=>acquisition.craftPreview(id,selection.parse(req.body)));
  route('POST','/craft/confirm',async(id,req)=>acquisition.craftConfirm(id,selection.extend({requestId:requestIdField,previewFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body)));

  // ── 편성
  route('GET','/party',async id=>{
    const p=await db.party.findUnique({where:{playerId:id}});
    // 재료로 쓴 개체 등 지금 없는 개체는 빼고 돌려줌
    const ids:string[]=p?JSON.parse(p.ownedIds):[],alive=new Set((await db.owned.findMany({where:{playerId:id,id:{in:ids},status:{not:'CONSUMED'}},select:{id:true}})).map(o=>o.id));
    return {ownedIds:ids.filter(x=>alive.has(x)),partyPolicy};
  });
  route('POST','/party',async(id,req)=>{
    const {ownedIds}=z.object({ownedIds:z.array(z.string().min(1).max(100)).max(6)}).strict().parse(req.body);
    if(!isValidParty(ownedIds))return apiFail(400,'INVALID_PARTY');
    return serial(id,async()=>{
      const n=await db.owned.count({where:{playerId:id,id:{in:ownedIds},status:{not:'CONSUMED'}}});if(n!==ownedIds.length)return apiFail(404,'UNIT_NOT_FOUND');
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
