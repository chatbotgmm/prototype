// 서버 API 묶음(Godot의 autoload 싱글턴에 해당). 화면은 이 모듈로만 서버와 이야기한다.
import {BASE} from './dom.js';

export class ApiError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
// 오류 코드 → 화면 문구. 코드는 서버(=GMM110)와 같은 문자열.
const MESSAGES:Record<string,string>={
  LOGIN_REQUIRED:'로그인이 필요해요.',LOGIN_CODE_INVALID:'코드가 맞지 않거나 이미 쓴 코드예요.',INVALID_PARTY:'편성은 1~3마리예요.',
  UNIT_UNAVAILABLE:'지금 쓸 수 없는 갈매미가 있어요(전투 중일 수 있어요).',INSUFFICIENT_MP:'MP가 모자라요.',HP_FULL:'체력이 가득해요.',
  ITEM_UNAVAILABLE:'아이템이 없어요.',INVALID_ITEM_TARGET:'그 대상에는 쓸 수 없어요.',NO_STATUS_TO_CLEANSE:'풀 상태 이상이 없어요.',
  FORCED_SWITCH_REQUIRED:'쓰러진 대원을 먼저 교체해 주세요.',STALE_REVISION:'화면이 오래됐어요. 다시 불러올게요.',BATTLE_FINISHED:'이미 끝난 전투예요.',
  INVALID_SWITCH:'교체할 수 없는 대원이에요.',SKILL_NOT_EQUIPPED:'쓸 수 없는 기술이에요.',NETWORK:'서버에 연결할 수 없어요.',
};
export const message=(e:unknown)=>e instanceof ApiError?(MESSAGES[e.code]??`오류: ${e.code}`):MESSAGES.NETWORK;
let seq=0;
export const requestId=()=>`${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2,8)}`;

async function call<T>(method:'GET'|'POST',path:string,body?:unknown):Promise<T>{
  let r:Response;
  try{r=await fetch(`${BASE}/api/v1${path}`,{method,credentials:'same-origin',headers:{'x-gmm':'1',...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});}
  catch{throw new ApiError(0,'NETWORK');}
  const data=await r.json().catch(()=>({error:'BAD_RESPONSE'}));
  if(!r.ok)throw new ApiError(r.status,data.error??'UNKNOWN');
  return data as T;
}
export type Stats={hp:number;mp:number;durability:number;statusResistance:number;speed:number};
export type OwnedUnit={ownedId:string;speciesId:string;name:string;rarity:string;level:number;maxLevel:number;stats:Stats;reincarnation:number;status:string;locked:boolean};
export type Skill={id:string;name:string;element:string;power:number;mpCost:number;learnLevel?:number};
export type Fighter={ownedId?:string;speciesId:string;name:string;level:number;hp:number;mp:number;stats:Partial<Stats>&{hp:number;mp:number};attack:Skill;skills:Skill[];ownResistance?:Record<string,string>};
export type BattleView={battleId:string;revision:number;status:'ACTIVE'|'FINISHED'|'SETTLED';testBaseline:boolean;
  state:{mode:string|null;turn:number;outcome:string|null;surrendered:boolean;self:Fighter;reserves:Fighter[];enemy:Fighter;
    opponentIntel:{statsKnown:boolean;defenses:Record<string,string>;knownDefenseCount:number;totalDefenseCount:number;defenseKnowledgeScope:string};
    rounds:{turn:number;events:any[]}[]};
  settlement:any;inventory:{itemId:string;count:number}[];itemDefinitions:Record<string,{name:string;heal?:number;revive?:number;cleanse?:boolean;desc:string}>;disabledCommands:Record<string,string>};

export const api={
  login:(code:string)=>call<{ok:true}>('POST','/auth/code',{code}),
  logout:()=>call<{ok:true}>('POST','/auth/logout',{}),
  me:()=>call<{playerId:string;nickname:string|null;credits:number;items:{itemId:string;count:number}[];testBaseline:boolean}>('GET','/me'),
  owned:()=>call<{units:OwnedUnit[]}>('GET','/owned'),
  ownedDetail:(id:string)=>call<OwnedUnit&{totalXp:string;xp:number;xpToNext:number|null;role:string;attack:Skill;skills:(Skill&{unlocked:boolean;inherited:boolean})[];nextLearn:{level:number;skillId:string}|null;suitability:Record<string,number>;ownResistance:Record<string,string>}>('GET',`/owned/${encodeURIComponent(id)}`),
  party:()=>call<{ownedIds:string[]}>('GET','/party'),
  saveParty:(ownedIds:string[])=>call<{ownedIds:string[]}>('POST','/party',{ownedIds}),
  battleOptions:()=>call<{encounters:{id:string;name:string;level:number;tutorial:boolean;mode:string|null}[]}>('GET','/battle/options'),
  activeBattles:()=>call<{battles:BattleView[]}>('GET','/battle/active'),
  createBattle:(ownedId:string,encounterId:string,reserveIds:string[])=>call<BattleView>('POST','/battle',{requestId:requestId(),ownedId,encounterId,reserveIds}),
  battle:(id:string)=>call<BattleView>('GET',`/battle/${id}`),
  act:(b:BattleView,action:Record<string,unknown>)=>call<BattleView>('POST',`/battle/${b.battleId}/action`,{requestId:requestId(),revision:b.revision,action}),
  settle:(b:BattleView)=>call<BattleView>('POST',`/battle/${b.battleId}/settle`,{requestId:requestId(),revision:b.revision}),
};
