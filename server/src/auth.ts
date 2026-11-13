// 세션: `${playerId}.${만료초}.${서명}` (GMM110과 같은 방식). 웹은 쿠키, 앱은 머리글 x-gmm-s.
import {createHmac,timingSafeEqual} from 'node:crypto';
import type {FastifyRequest} from 'fastify';

export const COOKIE='gmm_proto';
export const SESSION_DAYS=30;
export function sessionSigner(secret:string){
  const key=createHmac('sha256',secret).update('proto-session').digest();
  const sign=(v:string)=>createHmac('sha256',key).update(v).digest('base64url');
  return {
    issue(playerId:string,now=Date.now()){const exp=Math.floor(now/1000)+SESSION_DAYS*86400,v=`${playerId}.${exp}`;return `${v}.${sign(v)}`;},
    verify(raw:string|undefined,now=Date.now()):string|null{
      if(!raw||raw.length>200)return null;
      const [id,exp,sig]=raw.split('.');if(!id||!exp||!sig)return null;
      const want=Buffer.from(sign(`${id}.${exp}`)),got=Buffer.from(sig);
      if(want.length!==got.length||!timingSafeEqual(want,got)||Number(exp)<now/1000)return null;
      return id;
    },
  };
}
export function rawSession(req:FastifyRequest){
  const h=req.headers['x-gmm-s'];if(typeof h==='string')return h;
  return (req.headers.cookie??'').split(/;\s*/).find(c=>c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
}
