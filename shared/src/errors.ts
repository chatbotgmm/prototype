// 규칙 위반은 모두 이 오류로 던진다. code는 GMM110 원본과 같은 문자열을 쓴다(비교 시험·화면 문구 연결용).
export class RuleError extends Error {
  constructor(readonly code:string){super(code);this.name='RuleError';}
}
export const fail=(code:string):never=>{throw new RuleError(code);};
