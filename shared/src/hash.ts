// 결정적 난수용 해시. 서버(Node)에서만 판정하므로 node:crypto를 쓴다.
import {createHash,createHmac} from 'node:crypto';
export const sha256=(text:string)=>createHash('sha256').update(text).digest();
export const hmacHex=(key:string,text:string)=>createHmac('sha256',key).update(text).digest('hex');
