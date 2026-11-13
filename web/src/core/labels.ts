// 화면 표시 이름. 모두 GMM110 원본과 같은 문자열.
// 속성: NativeOwnedGulls.java ELEMENT_NAMES / 방어 반응: Roster60OpponentIntel.java 65~66줄 / 등급: 서버 roster60-library.ts rosterGrades
export const ELEMENTS=['NORMAL','FIRE','WATER','LIGHTNING','ICE','NATURE','HOLY','DARK'] as const;
export const elementName:Record<string,string>={NORMAL:'일반',FIRE:'불',WATER:'물',LIGHTNING:'번개',ICE:'얼음',NATURE:'자연',HOLY:'성',DARK:'어둠'};
export const defenseName:Record<string,string>={weak:'약점',normal:'보통',resist:'내성',immune:'무효',reflect:'반사',unknown:'?'};
export const gradeName:Record<string,string>={COMMON:'커먼',UNCOMMON:'언커먼',RARE:'레어',EPIC:'에픽',LEGEND:'전설',HIDDEN:'히든',LIMITED:'제한',TRANSCEND:'초월',IMMORTAL:'불멸',ETERNAL:'영원'};
export const statName={hp:'체력',mp:'MP',durability:'내구',statusResistance:'상태 저항',speed:'속도'} as const;
// 전투 명령: NativeRoster60Battle.java 461줄 ids/labels
export const COMMANDS=[['attack','공격'],['skills','기술'],['focus','집중'],['item','아이템'],['switch','교체'],['escape','도망치기']] as const;
export const resultLabel=(o:string|null)=>o==='win'?'승리':o==='loss'?'패배':o==='escaped'?'도망 성공':'전투 종료';
