import {expect,test} from 'bun:test';
import {AuditValidationError,createModelCaller} from '../src/server/modelAttempts';
import {createLiveProvider,ModelError} from '../src/server/provider';
import {snapshotContext} from '../src/core';
import type {ModelAttempt,ModelProvider,ModelRequest,Revision} from '../src/types';

const context=snapshotContext({title:'Clock',premise:'A choice.',characters:'Two workers.',worldRules:'Automation exists.',authorRules:'Keep established facts.'},[]);
const revision:Revision={id:'r1',episodeId:'e1',parentId:null,title:'Clock',logline:'A choice.',scenes:[{id:'s1',heading:'ROOM',content:'The first five days ran automated.',locked:false}],context,kind:'generated',instruction:'',mode:'live',createdAt:'2026-11-07T00:00:00Z'};
const request:ModelRequest={kind:'review',reviewPass:'verification',context,revision,episodeTitle:'Clock',auditTargetIds:['assessment:story']};

test('a real transport invalid_json triggers only one identical frozen-provider resend and retains failed attempt metadata',async()=>{
 const bodies:string[]=[],urls:string[]=[],snapshots:ModelAttempt[][]=[];
 const env={AI_NOVEL_PROVIDER:'openai',AI_NOVEL_BASE_URL:'https://provider.example/v1',AI_NOVEL_MODEL:'same-model',AI_NOVEL_API_KEY:'private-test-key'};
 const transport=(async(url:RequestInfo|URL,init?:RequestInit)=>{
  urls.push(String(url));bodies.push(String(init?.body));
  const content=bodies.length===1?'{"scene":]}':'{"scene":{"id":"s1","heading":"ROOM","content":"An exact new line."}}';
  return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
 }) as typeof fetch;
 const provider=createLiveProvider(env,transport)!,caller=createModelCaller(provider,'rewrite',rows=>snapshots.push(structuredClone(rows)));
 const rewrite:ModelRequest={kind:'rewrite',context,revision,episodeTitle:'Clock',sceneId:'s1',instruction:'Clarify the request.'},before=JSON.stringify(rewrite);
 const raw=await caller.complete(rewrite);
 expect(raw).toContain('An exact new line.');expect(urls).toEqual([urls[0]!,urls[0]!]);expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
 expect(JSON.parse(bodies[1]!).model).toBe('same-model');expect(bodies[1]).not.toContain('invalid_json');expect(JSON.stringify(rewrite)).toBe(before);
 expect(snapshots).toHaveLength(4);expect(snapshots[0]![0]!.status).toBe('running');
 expect(caller.attempts.map(a=>[a.sequence,a.callId,a.attempt,a.status,a.errorCode])).toEqual([[1,1,1,'failed','invalid_json'],[2,1,2,'succeeded',undefined]]);
 expect(caller.attempts[0]!.retryScheduled).toBe(true);
 for(const a of caller.attempts){expect(a.elapsedMs).toBeGreaterThanOrEqual(0);expect(a.finishedAt).toBeDefined();}
 expect(JSON.stringify(caller.attempts)).not.toContain('private-test-key');expect(JSON.stringify(caller.attempts)).not.toContain('{"scene":]}');
});

test('parallel review calls share two extra attempts and each repeats the exact same immutable payload',async()=>{
 const byTarget=new Map<string,ModelRequest[]>();
 const provider:ModelProvider={mode:'live',async complete(req){
  const key=req.auditTargetIds![0]!,calls=byTarget.get(key)??[];calls.push(req);byTarget.set(key,calls);
  expect(Object.isFrozen(req)).toBe(true);expect(Object.isFrozen(req.context.brief)).toBe(true);
  if(calls.length===1)throw new ModelError('invalid_json','Invalid JSON.');return '{}';
 }};
 const caller=createModelCaller(provider,'review',()=>{});
 const results=await Promise.allSettled([1,2,3].map(n=>caller.complete({...request,auditTargetIds:[`assessment:${n}`]},{batch:n})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(caller.attempts).toHaveLength(5);expect(caller.attempts.filter(a=>a.attempt===2)).toHaveLength(2);
 expect(caller.attempts.find(a=>a.retryStoppedReason==='run_limit')?.errorCode).toBe('invalid_json');
 for(const [key,calls] of byTarget){expect(calls.length).toBeLessThanOrEqual(2);if(calls.length===2)expect(calls[0]).toBe(calls[1]);expect(calls[0]!.auditTargetIds).toEqual([key]);}
 expect(new Set(caller.attempts.map(a=>a.sequence)).size).toBe(5);
});

test('a persistent syntax failure stops after the second attempt even with run budget left',async()=>{
 let calls=0;const error=new ModelError('invalid_json','Final format failure.');
 const caller=createModelCaller({mode:'live',async complete(){calls++;throw error;}},'review',()=>{});
 await expect(caller.complete(request)).rejects.toBe(error);
 expect(calls).toBe(2);expect(caller.attempts.at(-1)).toMatchObject({status:'failed',errorCode:'invalid_json',retryScheduled:false,retryStoppedReason:'call_limit'});
});

test('HTTP, timeout, output limits, non-ModelError failures and other run kinds never gain a retry',async()=>{
 for(const error of [new ModelError('upstream_http','HTTP failure.'),new ModelError('timeout','Timed out.'),new ModelError('output_limit','Output limit.'),new ModelError('invalid_response','Bad transport.'),Object.assign(new Error('private detail'),{name:'ModelError',code:'invalid_json'})]){
  let calls=0;const caller=createModelCaller({mode:'live',async complete(){calls++;throw error;}},'review',()=>{});
  await expect(caller.complete(request)).rejects.toBe(error);expect(calls).toBe(1);expect(caller.attempts).toHaveLength(1);
  expect(JSON.stringify(caller.attempts)).not.toContain('private detail');
 }
 for(const kind of ['generate','localize'] as const){
  let calls=0;const caller=createModelCaller({mode:'live',async complete(){calls++;throw new ModelError('invalid_json','Bad JSON.');}},kind,()=>{});
  await expect(caller.complete({...request,kind})).rejects.toMatchObject({code:'invalid_json'});expect(calls).toBe(1);
  expect(caller.attempts[0]!.retryStoppedReason).toBe('not_eligible');
 }
 const demo=createModelCaller({mode:'demo',async complete(){throw new ModelError('invalid_json','Bad JSON.');}},'review',()=>{});
 await expect(demo.complete(request)).rejects.toMatchObject({code:'invalid_json'});expect(demo.attempts).toHaveLength(1);
});

test('a completed peer failure prevents a new resend while preserving the in-flight result',async()=>{
 const caller=createModelCaller({mode:'live',async complete(){throw new ModelError('invalid_json','Bad JSON.');}},'review',()=>{});
 await expect(caller.complete(request,{canRetry:()=>false})).rejects.toMatchObject({code:'invalid_json'});
 expect(caller.attempts).toHaveLength(1);expect(caller.attempts[0]!.retryStoppedReason).toBe('review_stopped');
});

test('verification validation can resend the same frozen call and retains the first structural failure',async()=>{
 const seen:ModelRequest[]=[],validated:number[]=[],published:ModelAttempt[][]=[];
 const caller=createModelCaller({mode:'live',async complete(req){seen.push(req);return seen.length===1?'{"checks":[]}':'{"checks":[{"targetId":"assessment:story"}]}';}},'review',rows=>published.push(structuredClone(rows)));
 const raw=await caller.complete(request,{batch:4,validate:(value,entry)=>{
  validated.push(entry.attempt);
  if(JSON.parse(value).checks.length===0)throw new AuditValidationError(['assessment:story missing from this batch']);
 }});
 expect(JSON.parse(raw).checks).toHaveLength(1);expect(seen).toHaveLength(2);expect(seen[0]).toBe(seen[1]);expect(Object.isFrozen(seen[0])).toBe(true);
 expect(validated).toEqual([1,2]);expect(caller.attempts.map(a=>[a.callId,a.attempt,a.status])).toEqual([[1,1,'failed'],[1,2,'succeeded']]);
 expect(caller.attempts[0]).toMatchObject({batch:4,errorCode:'invalid_audit_format',validationErrors:['assessment:story missing from this batch'],retryScheduled:true});
 expect(caller.attempts[1]!.validationErrors??[]).toEqual([]);
 expect(published.some(rows=>rows[0]?.status==='failed'&&rows[0]?.validationErrors?.length===1)).toBe(true);
});

test('syntax and audit validation share a single retry per logical call in either order',async()=>{
 for(const firstError of ['syntax','validation'] as const){
  let calls=0;const caller=createModelCaller({mode:'live',async complete(){calls++;if((calls===1)===(firstError==='syntax'))throw new ModelError('invalid_json','Invalid JSON.');return '{}';}},'review',()=>{});
  await expect(caller.complete(request,{validate:()=>{throw new AuditValidationError(['Missing explanation.']);}})).rejects.toMatchObject({code:firstError==='syntax'?'invalid_audit_format':'invalid_json'});
  expect(calls).toBe(2);expect(caller.attempts.map(a=>a.errorCode)).toEqual(firstError==='syntax'?['invalid_json','invalid_audit_format']:['invalid_audit_format','invalid_json']);
  expect(caller.attempts.at(-1)).toMatchObject({attempt:2,status:'failed',retryScheduled:false,retryStoppedReason:'call_limit'});
 }
});

test('audit validation is not an extra budget beyond the two shared review retries',async()=>{
 const counts=new Map<string,number>();
 const caller=createModelCaller({mode:'live',async complete(req){const key=req.auditTargetIds![0]!;counts.set(key,(counts.get(key)??0)+1);return JSON.stringify({complete:counts.get(key)!>1});}},'review',()=>{});
 const results=await Promise.allSettled([1,2,3].map(n=>caller.complete({...request,auditTargetIds:[`assessment:${n}`]},{batch:n,validate:raw=>{if(!JSON.parse(raw).complete)throw new AuditValidationError(['Incomplete batch.']);}})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(caller.attempts).toHaveLength(5);expect(caller.attempts.filter(a=>a.attempt===2)).toHaveLength(2);
 expect(caller.attempts.find(a=>a.retryStoppedReason==='run_limit')).toMatchObject({status:'failed',errorCode:'invalid_audit_format',validationErrors:['Incomplete batch.']});
});

test('only the verification validator may authorize structural retries; valid negatives do not retry',async()=>{
 for(const req of [{...request,reviewPass:'facts' as const},{...request,reviewPass:undefined},{...request,kind:'rewrite' as const,reviewPass:undefined}]){
  let calls=0;const caller=createModelCaller({mode:'live',async complete(){calls++;return '{}';}},req.kind,()=>{});
  await expect(caller.complete(req,{validate:()=>{throw new AuditValidationError(['Wrong stage.']);}})).rejects.toMatchObject({code:'invalid_audit_format'});
  expect(calls).toBe(1);expect(caller.attempts[0]!.retryStoppedReason).toBe('not_eligible');
 }
 for(const error of [new ModelError('invalid_audit_format','Not the trusted validator.'),new AuditValidationError(['Provider cannot authorize validation retries.'])]){
  let calls=0;const untrusted=createModelCaller({mode:'live',async complete(){calls++;throw error;}},'review',()=>{});
  await expect(untrusted.complete(request,{validate:()=>{}})).rejects.toBe(error);expect(calls).toBe(1);
 }
 const valid=createModelCaller({mode:'live',async complete(){return '{"verdict":"unsupported"}';}},'review',()=>{});
 expect(await valid.complete(request,{validate:raw=>{expect(JSON.parse(raw).verdict).toBe('unsupported');}})).toContain('unsupported');
 expect(valid.attempts).toHaveLength(1);expect(valid.attempts[0]!.status).toBe('succeeded');
});

test('a peer stop prevents a structural resend while keeping its validation errors visible',async()=>{
 const caller=createModelCaller({mode:'live',async complete(){return '{}';}},'review',()=>{});
 await expect(caller.complete(request,{canRetry:()=>false,validate:()=>{throw new AuditValidationError(['Missing source reference.']);}})).rejects.toMatchObject({code:'invalid_audit_format'});
 expect(caller.attempts).toHaveLength(1);expect(caller.attempts[0]).toMatchObject({retryStoppedReason:'review_stopped',validationErrors:['Missing source reference.']});
});
