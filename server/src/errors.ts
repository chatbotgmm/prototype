// HTTP 오류. 규칙 위반(RuleError)은 409로 바꿔 보냄. 코드는 GMM110과 같은 문자열.
export class ApiError extends Error{
  constructor(readonly status:number,readonly code:string){super(code);this.name='ApiError';}
}
export const apiFail=(status:number,code:string):never=>{throw new ApiError(status,code);};
