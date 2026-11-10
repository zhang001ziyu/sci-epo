import type { ModelAttempt, ModelProvider, ModelRequest } from '../types';
import { ModelError } from './provider';

/** Only the trusted audit parser supplies these diagnostics; never an upstream response body. */
export class AuditValidationError extends ModelError {
 readonly validationErrors:string[];
 constructor(errors:readonly string[]){
  super('invalid_audit_format','审计输出未通过结构、覆盖或引文校验。');
  this.validationErrors=[...errors];
 }
}

function freeze<T>(value:T):T {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.freeze(value);for(const child of Object.values(value))freeze(child);
 }
 return value;
}

/** One frozen provider per run; JSON syntax and audit format share one resend budget. */
export function createModelCaller(provider:ModelProvider,kind:ModelRequest['kind'],publish:(attempts:ModelAttempt[])=>void){
 const attempts:ModelAttempt[]=[];
 const budget=provider.mode==='live'?(kind==='review'?2:kind==='rewrite'?1:0):0;
 let extraCalls=0,callId=0;
 return {attempts,async complete(request:ModelRequest,options:{batch?:number;canRetry?:()=>boolean;validate?:(raw:string,attempt:Readonly<ModelAttempt>)=>void}={}):Promise<string>{
  // Both attempts receive the identical immutable request, never the invalid answer.
  const frozen=freeze(structuredClone(request)),currentCall=++callId;
  for(let number=1;number<=2;number++){
   const started=Date.now(),entry:ModelAttempt={callId:currentCall,sequence:attempts.length+1,
    stage:frozen.kind==='review'?(frozen.reviewPass??'review'):frozen.kind,
    ...(options.batch===undefined?{}:{batch:options.batch}),...(frozen.auditTargetIds?{targetIds:[...frozen.auditTargetIds]}:{}),
    attempt:number as 1|2,status:'running',startedAt:new Date(started).toISOString()};
   attempts.push(entry);publish(attempts);
   let auditValidationFailure=false;
   try{
    const raw=await provider.complete(frozen);
    if(options.validate){
     try{options.validate(raw,structuredClone(entry));}
     catch(error){auditValidationFailure=error instanceof AuditValidationError;throw error;}
    }
    Object.assign(entry,{status:'succeeded',finishedAt:new Date().toISOString(),elapsedMs:Math.max(0,Date.now()-started)});publish(attempts);
    return raw;
   }catch(error){
    const errorCode=error instanceof ModelError&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'unknown_error';
    Object.assign(entry,{status:'failed',errorCode,finishedAt:new Date().toISOString(),elapsedMs:Math.max(0,Date.now()-started)});
    if(auditValidationFailure&&error instanceof AuditValidationError)entry.validationErrors=[...error.validationErrors];
    let retry=false;
    if(error instanceof ModelError&&(error.code==='invalid_json'||error.code==='invalid_audit_format')){
     const auditEligible=error.code!=='invalid_audit_format'||auditValidationFailure&&frozen.kind==='review'&&frozen.reviewPass==='verification'&&!!options.validate;
     const reason=!budget||frozen.kind!==kind||!auditEligible?'not_eligible':number===2?'call_limit':extraCalls>=budget?'run_limit':options.canRetry&&!options.canRetry()?'review_stopped':undefined;
     entry.retryScheduled=!reason;
     if(reason)entry.retryStoppedReason=reason;
     else {extraCalls++;retry=true;} // Reserve synchronously before another worker can request a resend.
    }
    publish(attempts);
    if(!retry)throw error;
   }
  }
  throw new Error('Model attempt limit reached.');
 }};
}
