// 출항(편성 → 서버 요청 → 다음 장면). 스토리 창·편성 화면·모험 화면이 같이 씀. 판정은 모두 서버.
import {api,message} from './api.js';
import {go,toast} from './scenes.js';

export type Departure=
  |{type:'quest';questId:string;title:string;recommended?:[number,number]}
  |{type:'material';encounterId:string;level:number}
  |{type:'free'};
export const departureTitle=(d:Departure)=>d.type==='quest'?d.title:d.type==='material'?`흑화 갈매미 모험 · Lv${d.level}`:'자유 탐험';
/** 고른 편성(첫 칸 출전)으로 출항. 의뢰·재료 모험은 바로 전투, 자유 탐험은 모험 출발 화면으로. */
export async function depart(d:Departure,ownedIds:string[]){
  try{
    if(d.type==='free'){const a=await api.adventureStart(ownedIds);go('adventure',{adventureId:a.adventureId,view:a});return;}
    const b=d.type==='quest'?await api.storyBattle(d.questId,ownedIds):await api.materialBattle(d.encounterId,ownedIds);
    go('battle',{battleId:b.battleId,view:b});
  }catch(e){toast(message(e));}
}
