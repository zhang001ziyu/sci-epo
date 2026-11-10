import {inferenceTargets} from '../src/core/inferenceProof';
import {neutralProofs} from './inference-fixtures';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { Store } from '../src/server/store';
import { ModelError } from '../src/server/provider';
import { DIMENSIONS, type ModelRequest, type ProjectBundle, type Revision, type Review } from '../src/types';
import { reviewTargets, timelineTargets, verificationFieldTargets, auditBatches } from '../src/core/reviewVerification';
import { reviewSuggestion } from '../src/core/reviewSuggestions';

const brief = {title:'月台维修站',premise:'维修员决定把唯一电池用在哪里。',characters:'小林急着回家。阿禾留下修门。',worldRules:'电池只能启动一次。',authorRules:'允许安静结尾。'};
const script = {title:'末班船',logline:'一次维修改变了回家的安排。',scenes:[{id:'s1',heading:'内景 · 闸门 · 夜',content:'小林拔出已经耗尽的电池。',locked:false},{id:'s2',heading:'外景 · 月台 · 夜',content:'阿禾坐下，给小林留了一个位置。',locked:false}]};
const stores: Store[]=[];
const tempDirs: string[]=[];
afterEach(()=>{for(const s of stores.splice(0))try{s.close();}catch{} for(const p of tempDirs.splice(0))rmSync(p,{recursive:true,force:true});});
function factsResponse(req:ModelRequest){
 if(!req.revision)throw new Error('Facts require the frozen revision.');
 const scenes=req.revision.scenes;
 return {timelineFacts:timelineTargets(req.revision).map(t=>({targetId:t.id,meaning:{subject:'Test scene actor',activity:'The activity in the cited line',durationKind:'Test temporal statement',clock:'The clock specified by the source',basis:'Test fixture retaining the exact source quotation'},status:'consistent',explanation:'Test fact extractor checked this temporal statement.',evidence:[{sourceId:t.sourceId,quote:t.quote}]})),
  omissions:['timeline','accounting','agency','continuity','other'].map(category=>({category,status:'no_issue',explanation:'Test fact extractor found no omitted issue.',sceneIds:scenes.map(s=>s.id),evidence:scenes.map(s=>({sourceId:`scene:${s.id}`,quote:s.content}))}))};
}
function verificationResponse(req:ModelRequest){
 if(!req.draftReview||!req.draftFacts||!req.revision)throw new Error('Audit requires the exact review, independently extracted facts and frozen revision.');
 const first=req.revision.scenes[0]!;
 const ids=[...reviewTargets(req.draftReview).map(t=>t.id),...req.draftFacts.timelineFacts.map(t=>t.targetId),...req.draftFacts.omissions.map(o=>`omission:${o.category}`)];
 const check=(targetId:string)=>({targetId,verdict:'supported',explanation:'The test auditor supports this complete interpretation.',
  evidence:[{sourceId:`scene:${first.id}`,quote:first.content}],counterEvidence:[]});
 const selected=req.auditTargetIds??ids;
 return {inferenceProofs:neutralProofs(inferenceTargets(verificationFieldTargets(req.draftReview,req.draftFacts).filter(t=>selected.includes(t.parentId)))),checks:ids.filter(id=>selected.includes(id)).map(check),fieldChecks:verificationFieldTargets(req.draftReview,req.draftFacts).filter(t=>selected.includes(t.parentId)).map(t=>t.field==='suggestedSceneId'?{...check(t.id),evidence:[{sourceId:`scene:${t.claim}`,quote:req.revision!.scenes.find(s=>s.id===t.claim)!.content}]}:check(t.id))};
}
function defaultResponse(req:ModelRequest):string{
 if(req.kind==='generate')return JSON.stringify(script);
 if(req.reviewPass==='causality')return JSON.stringify({pressures:[],checks:req.revision!.scenes.map(s=>({sceneId:s.id,state:'场内人物安静停留，没有新增资源。',choice:'停下等待。',obstacleKind:'none',alternative:'立刻离开。',verdict:'not_applicable',explanation:'本场没有声称离开不可能，也未将等待写成物理困境。',evidence:[{sourceId:`scene:${s.id}`,sourceQuote:s.content,sceneId:s.id,draftQuote:s.content}],constraintEvidence:[]}))});
 if(req.reviewPass==='facts')return JSON.stringify(factsResponse(req));
 if(req.reviewPass==='verification')return JSON.stringify(verificationResponse(req));
 if(req.kind==='rewrite')return JSON.stringify({scene:{id:req.sceneId,heading:'外景 · 月台 · 夜',content:'阿禾把工具箱挪开，拍了拍空出来的椅子。'}});
 return JSON.stringify({assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'本次未发现问题；不等于质量验收。',evidence:[{sourceId:'authorRules',sourceQuote:'允许安静结尾。',sceneId:'s2',draftQuote:req.revision!.scenes[1]!.content}]}))});
}
function harness(path?:string){
 const store=new Store(path);stores.push(store);
 const requests:ModelRequest[]=[];
 let responder:(request:ModelRequest)=>Promise<string>=async req=>defaultResponse(req);
 const live={mode:'live' as const,async complete(request:ModelRequest){requests.push(structuredClone(request));return responder(request);}};
 const app=createApp(store,{live,demo:{...live,mode:'demo'}});
 async function call(path:string,body?:unknown,method=body===undefined?'GET':'POST',origin?:string){
  const response=await app(new Request(`http://127.0.0.1:4117${path}`,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  return {status:response.status,body:await response.json()};
 }
 async function ok<T>(path:string,body?:unknown,method?:string):Promise<T>{const result=await call(path,body,method);expect(result.status).toBe(200);return result.body as T;}
 async function project(){return ok<ProjectBundle>('/api/projects',brief);}
 async function generate(eid:string){return ok<Revision>(`/api/episodes/${eid}/generate`,{mode:'live'});}
 async function accept(r:Revision,expected:string|null=null){return ok<ProjectBundle>(`/api/episodes/${r.episodeId}/accept`,{revisionId:r.id,expectedAcceptedRevisionId:expected,expectedContextToken:store.contextToken(store.get('episodes',r.episodeId)!),acknowledgeReview:true});}
 return {store,requests,call,ok,project,generate,accept,setResponder(fn:typeof responder){responder=fn;}};
}

describe('script workflow and accepted memory',()=>{
 test('live audit cannot omit inference premises and still authorize a rewrite',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const output:any=verificationResponse(req);delete output.inferenceProofs;return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.status).toBe('needs_review');expect(result.verification!.audit!.errors.join(' ')).toContain('inferenceProofs');
  expect(h.store.all('runs').at(-1)!.status).toBe('failed');expect(h.store.get('revisions',r.id)).toEqual(r);
  expect(h.requests.filter(q=>q.reviewPass==='verification').length).toBeLessThanOrEqual(4);
 });
 test('generation stores immutable candidate; drafts never enter later episode context',async()=>{
  const h=harness(),p=await h.project(),e1=p.episodes[0]!;
  const r1=await h.generate(e1.id);
  expect(r1.mode).toBe('live');
  expect(h.store.get('episodes',e1.id)!.acceptedRevisionId).toBeNull();
  const added=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'}),e2=added.episodes[1]!;
  const r2=await h.generate(e2.id);
  expect(r2.context.previousEpisodes).toEqual([]);
  expect(h.store.all('runs').every(r=>r.status==='succeeded')).toBe(true);
 });
 test('only adopted earlier revisions enter memory; future episodes never leak to earlier generation',async()=>{
  const h=harness(),p=await h.project(),e1=p.episodes[0]!;
  const r1=await h.generate(e1.id);await h.accept(r1);
  const added=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'}),e2=added.episodes[1]!;
  const r2=await h.generate(e2.id);await h.accept(r2);
  expect(r2.context.previousEpisodes.map(e=>e.revisionId)).toEqual([r1.id]);
  const early=await h.generate(e1.id);
  expect(early.context.previousEpisodes).toEqual([]);
  expect(h.store.get('revisions',r1.id)).toEqual(r1);
 });
 test('single-scene revision retains original and untouched scenes, then explicit adoption changes memory',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const next=await h.ok<Revision>(`/api/revisions/${r.id}/rewrite`,{sceneId:'s2',instruction:'让动作代替解释',mode:'live'});
  expect(next.parentId).toBe(r.id);
  expect(next.scenes[0]).toEqual(r.scenes[0]);
  expect(next.scenes[1]!.content).not.toBe(r.scenes[1]!.content);
  expect(next.context).toEqual(r.context);
  expect(h.store.get('revisions',r.id)).toEqual(r);
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
  await h.accept(next);
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBe(next.id);
 });
 test('locking creates a version and blocks both model rewrite and manual replacement without spending a model call',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const locked=await h.ok<Revision>(`/api/revisions/${r.id}/locks`,{sceneId:'s1',locked:true});
  expect(h.store.get('revisions',r.id)!.scenes[0]!.locked).toBe(false);
  const before=h.requests.length;
  expect((await h.call(`/api/revisions/${locked.id}/rewrite`,{sceneId:'s1',instruction:'换写法',mode:'live'})).status).toBe(409);
  expect(h.requests).toHaveLength(before);
  const changed=structuredClone(locked.scenes);changed[0]!.content='锁定部分被改掉了';
  expect((await h.call(`/api/revisions/${locked.id}/edit`,{title:locked.title,logline:locked.logline,scenes:changed})).status).toBe(409);
  const moved=[locked.scenes[1],locked.scenes[0]];
  expect((await h.call(`/api/revisions/${locked.id}/edit`,{title:locked.title,logline:locked.logline,scenes:moved})).status).toBe(409);
  const unlocked=await h.ok<Revision>(`/api/revisions/${locked.id}/locks`,{sceneId:'s1',locked:false});
  expect(unlocked.scenes[0]!.locked).toBe(false);
 });
 test('manual save cannot smuggle an unlock; edited text gets a new revision',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const changed=structuredClone(r.scenes);changed[0]!.locked=true;
  expect((await h.call(`/api/revisions/${r.id}/edit`,{title:r.title,logline:r.logline,scenes:changed})).status).toBe(400);
  changed[0]!.locked=false;changed[0]!.content='小林把空电池收进工具袋。';
  const edit=await h.ok<Revision>(`/api/revisions/${r.id}/edit`,{title:r.title,logline:r.logline,scenes:changed});
  expect(edit.mode).toBe('manual');expect(edit.parentId).toBe(r.id);expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('adoption requires an explicit read acknowledgement and compare-and-swap of accepted version',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  expect((await h.call(`/api/episodes/${r.episodeId}/accept`,{revisionId:r.id,expectedAcceptedRevisionId:null,expectedContextToken:h.store.contextToken(h.store.get('episodes',r.episodeId)!),acknowledgeReview:false})).status).toBe(400);
  await h.accept(r);
  const next=await h.generate(r.episodeId);
  expect((await h.call(`/api/episodes/${r.episodeId}/accept`,{revisionId:next.id,expectedAcceptedRevisionId:null,acknowledgeReview:true})).status).toBe(409);
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBe(r.id);
  await h.accept(next,r.id);
 });
 test('changing an adopted early episode marks later drafts stale and blocks continuation until author reconfirms',async()=>{
  const h=harness(),p=await h.project(),r1=await h.generate(p.episodes[0]!.id);await h.accept(r1);
  const b2=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'});
  const r2=await h.generate(b2.episodes[1]!.id);await h.accept(r2);
  const b3=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第三集'});
  const r1b=await h.generate(r1.episodeId);await h.accept(r1b,r1.id);
  expect(h.store.get('episodes',r2.episodeId)!.needsReview).toBe(true);
  expect((await h.call(`/api/episodes/${b3.episodes[2]!.id}/generate`,{mode:'live'})).status).toBe(409);
  await h.accept(r2,r2.id);
  const r3=await h.generate(b3.episodes[2]!.id);
  expect(r3.context.previousEpisodes.map(e=>e.revisionId)).toEqual([r1b.id,r2.id]);
 });
 test('a tab that reviewed old upstream context cannot clear a newly stale episode',async()=>{
  const h=harness(),p=await h.project(),r1=await h.generate(p.episodes[0]!.id);await h.accept(r1);
  const added=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'});
  const r2=await h.generate(added.episodes[1]!.id);await h.accept(r2);
  const viewed=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}`);
  const oldToken=viewed.episodes[1]!.contextToken;
  expect(oldToken).toHaveLength(64);
  const r1b=await h.generate(r1.episodeId);await h.accept(r1b,r1.id);
  const result=await h.call(`/api/episodes/${r2.episodeId}/accept`,{revisionId:r2.id,expectedAcceptedRevisionId:r2.id,expectedContextToken:oldToken,acknowledgeReview:true});
  expect(result.status).toBe(409);
  expect(h.store.get('episodes',r2.episodeId)!.needsReview).toBe(true);
  const refreshed=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}`);
  expect(refreshed.episodes[1]!.contextToken).not.toBe(oldToken);
  await h.accept(r2,r2.id);
  expect(h.store.get('episodes',r2.episodeId)!.needsReview).toBe(false);
 });
 test('author brief changes invalidate a tab acceptance even if accepted revision did not change',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const viewed=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}`),oldToken=viewed.episodes[0]!.contextToken;
  await h.ok(`/api/projects/${p.project.id}`,{...brief,authorRules:'作者新增：结尾必须留在站内。'},'PUT');
  expect((await h.call(`/api/episodes/${r.episodeId}/accept`,{revisionId:r.id,expectedAcceptedRevisionId:null,expectedContextToken:oldToken,acknowledgeReview:true})).status).toBe(409);
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
  expect(h.store.get('episodes',r.episodeId)!.needsReview).toBe(true);
 });
 test('future episodes do not invalidate an earlier episode context token',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);await h.accept(r);
  const before=h.store.bundle(p.project.id)!.episodes[0]!.contextToken;
  const added=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'});
  const r2=await h.generate(added.episodes[1]!.id);await h.accept(r2);
  expect(h.store.bundle(p.project.id)!.episodes[0]!.contextToken).toBe(before);
 });
 test('brief changes preserve frozen old revision and mark saved episodes for author review',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  await h.ok(`/api/projects/${p.project.id}`,{...brief,worldRules:'新电池规则由作者修订。'},'PUT');
  expect(h.store.get('revisions',r.id)!.context.brief.worldRules).toBe(brief.worldRules);
  expect(h.store.get('episodes',r.episodeId)!.needsReview).toBe(true);
  const fresh=await h.generate(r.episodeId);
  expect(fresh.context.brief.worldRules).toBe('新电池规则由作者修订。');
 });
});

describe('visible bounded format resends',()=>{
 for(const failingStage of ['causality','review','facts','verification'])test(`${failingStage} resends only the failed logical call and stores both attempts`,async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  let failedRequest:ModelRequest|undefined,repeatedRequest:ModelRequest|undefined;
  h.setResponder(async req=>{
   const stage=req.reviewPass??req.kind;
   if(stage===failingStage&&!failedRequest){failedRequest=req;throw new ModelError('invalid_json','JSON format failed.');}
   if(failedRequest&&req===failedRequest)repeatedRequest=req;
   return defaultResponse(req);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(repeatedRequest).toBe(failedRequest);expect(result.verification!.errors).toEqual([]);expect(run.status).toBe('succeeded');
  const failed=run.modelAttempts!.filter(a=>a.status==='failed'),resends=run.modelAttempts!.filter(a=>a.attempt===2);
  expect(failed).toHaveLength(1);expect(resends).toHaveLength(1);
  expect(failed[0]).toMatchObject({stage:failingStage,errorCode:'invalid_json',retryScheduled:true});
  expect(resends[0]).toMatchObject({callId:failed[0]!.callId,stage:failingStage,status:'succeeded'});
  expect(resends[0]!.targetIds).toEqual(failed[0]!.targetIds);expect(resends[0]!.batch).toBe(failed[0]!.batch);
  expect(run.modelAttempts!.length).toBe(4+auditBatches(result,result.verification!).length);
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });

 test('the two review resends are shared across earlier stages and exhausted facts do not start audits',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),counts=new Map<string,number>();
  h.setResponder(async req=>{const stage=req.reviewPass??req.kind,n=(counts.get(stage)??0)+1;counts.set(stage,n);if(n===1)throw new ModelError('invalid_json','JSON format failed.');return defaultResponse(req);});
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect([...counts]).toEqual([['causality',2],['review',2],['facts',1]]);
  expect(run.modelAttempts!.filter(a=>a.attempt===2)).toHaveLength(2);
  expect(run.modelAttempts!.at(-1)).toMatchObject({stage:'facts',status:'failed',errorCode:'invalid_json',retryScheduled:false,retryStoppedReason:'run_limit'});
  expect(run.status).toBe('failed');expect(run.resultId).toBe(result.id);expect(result.verification!.status).toBe('needs_review');
  expect(result.causality!.checks).toHaveLength(2);expect(result.assessments).toHaveLength(5);expect(result.verification!.checks).toEqual([]);
 });

 test('persistent batch format failure stops scheduling, while a previously in-flight batch remains saved',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  let failedIds:string[]|undefined,peerIds:string[]|undefined,releasePeer!:()=>void,peerStarted!:()=>void;
  const began=new Promise<void>(resolve=>{peerStarted=resolve;}),release=new Promise<void>(resolve=>{releasePeer=resolve;});
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   failedIds??=[...req.auditTargetIds!];
   if(JSON.stringify(req.auditTargetIds)===JSON.stringify(failedIds)){await began;throw new ModelError('invalid_json','Final format failure.');}
   peerIds=[...req.auditTargetIds!];peerStarted();await release;return defaultResponse(req);
  });
  const operation=h.call(`/api/revisions/${r.id}/review`,{mode:'live'});await began;
  for(let i=0;i<100&&!h.store.all('runs').at(-1)!.modelAttempts!.some(a=>a.retryStoppedReason==='call_limit');i++)await new Promise(resolve=>setTimeout(resolve,0));
  expect(h.store.all('runs').at(-1)!.modelAttempts!.some(a=>a.retryStoppedReason==='call_limit')).toBe(true);
  releasePeer();const response=await operation,result=response.body as Review,run=h.store.all('runs').at(-1)!;
  expect(response.status).toBe(200);expect(run.status).toBe('failed');expect(run.resultId).toBe(result.id);
  const audits=run.modelAttempts!.filter(a=>a.stage==='verification');expect(audits).toHaveLength(3);expect(audits.filter(a=>a.status==='failed')).toHaveLength(2);
  expect(new Set(audits.map(a=>a.batch)).size).toBe(2);expect(audits.some(a=>a.status==='succeeded')).toBe(true);
  expect(result.verification!.audit!.originalChecks.map(c=>c.targetId)).toEqual(peerIds!);
  expect(result.verification!.errors.some(e=>e.includes('停止后续审计'))).toBe(true);expect(result.verification!.checks.some(c=>failedIds!.includes(c.targetId))).toBe(false);
 });

 test('rewrite has its own single resend budget, preserves failed attempts, and never adopts automatically',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const counts=new Map<string,number>();
  h.setResponder(async req=>{const n=(counts.get(req.instruction!)??0)+1;counts.set(req.instruction!,n);if(n===1)throw new ModelError('invalid_json','JSON format failed.');return defaultResponse(req);});
  for(const instruction of ['Clarify the gesture.','Clarify the pause.']){
   const child=await h.ok<Revision>(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction});
   const run=h.store.all('runs').at(-1)!;expect(run.modelAttempts!.map(a=>[a.attempt,a.status])).toEqual([[1,'failed'],[2,'succeeded']]);
   expect(run.resultId).toBe(child.id);expect(run.status).toBe('succeeded');expect(child.parentId).toBe(r.id);expect(child.scenes[0]).toEqual(r.scenes[0]);
  }
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();expect(h.store.get('revisions',r.id)).toEqual(r);
  h.setResponder(async()=>{throw new ModelError('invalid_json','Final format failure.');});
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction:'Another gesture.'})).status).toBe(502);
  const failed=h.store.all('runs').at(-1)!;expect(failed.status).toBe('failed');expect(failed.resultId).toBeNull();expect(failed.modelAttempts).toHaveLength(2);
  expect(failed.modelAttempts!.at(-1)!.retryStoppedReason).toBe('call_limit');expect(failed.error).toBe('Final format failure.');
 });

 test('a syntax resend does not bypass later semantic or exact-quote validation',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);let first=true;
  h.setResponder(async req=>{
   if(req.reviewPass==='facts'){
    if(first){first=false;throw new ModelError('invalid_json','JSON format failed.');}
    const bad=factsResponse(req);bad.omissions[0]!.evidence[0]!.quote='This sentence is absent from the source.';return JSON.stringify(bad);
   }
   return defaultResponse(req);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(run.modelAttempts!.filter(a=>a.stage==='facts')).toHaveLength(2);expect(run.modelAttempts!.some(a=>a.stage==='verification')).toBe(false);
  expect(run.status).toBe('failed');expect(result.verification!.errors.length).toBeGreaterThan(0);expect(result.verification!.checks).toEqual([]);
  h.setResponder(async()=>'{"scene":{"id":"wrong-scene","heading":"ROOM","content":"Changed."}}');
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction:'Clarify the gesture.'})).status).toBe(502);
  expect(h.store.all('runs').at(-1)!.modelAttempts).toHaveLength(1);expect(h.store.get('revisions',r.id)).toEqual(r);
 });

 test('new generation and localization keep their existing one-call failure behavior',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async()=>{throw new ModelError('invalid_json','JSON format failed.');});
  for(const [path,body] of [[`/api/episodes/${r.episodeId}/generate`,{mode:'live'}],[`/api/revisions/${r.id}/localize`,{mode:'live',language:'zh-CN'}]] as const){
   expect((await h.call(path,body)).status).toBe(502);expect(h.store.all('runs').at(-1)!.modelAttempts).toHaveLength(1);
   expect(h.store.all('runs').at(-1)!.modelAttempts![0]!.retryStoppedReason).toBe('not_eligible');
  }
 });
 test('a successful audit resend can still reject the interpretation and never turns a quality concern into approval',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);let failed=false;
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   if(req.auditTargetIds!.includes('assessment:story')&&!failed){failed=true;throw new ModelError('invalid_json','Bad JSON.');}
   const output=verificationResponse(req);
   for(const c of output.checks)if(c.targetId==='assessment:story')Object.assign(c,{verdict:'unsupported',correction:'This interpretation is not established by the source.'});
   return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(run.status).toBe('succeeded');expect(run.modelAttempts!.some(a=>a.attempt===2&&a.status==='succeeded')).toBe(true);
  expect(result.status).toBe('needs_review');expect(result.verification!.audit!.status).toBe('needs_review');
  expect(result.verification!.checks.find(c=>c.targetId==='assessment:story')!.verdict).toBe('unsupported');
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });
 test('historical-review verification retries its own facts request without rerunning critics or editing the original review',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),old=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  let failed=false;h.setResponder(async req=>{if(req.reviewPass==='facts'&&!failed){failed=true;throw new ModelError('invalid_json','Bad JSON.');}return defaultResponse(req);});
  const checked=await h.ok<Review>(`/api/reviews/${old.id}/verify`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(checked.verificationOfReviewId).toBe(old.id);expect(run.modelAttempts!.slice(0,2).map(a=>[a.stage,a.attempt])).toEqual([['facts',1],['facts',2]]);
  expect(run.modelAttempts!.every(a=>a.stage==='facts'||a.stage==='verification')).toBe(true);expect(h.store.get('reviews',old.id)).toEqual(old);
 });
});

describe('bounded verification structure retries',()=>{
 for(const failure of ['missing explanation','missing field','unknown source reference'])test(`${failure} retries only that frozen batch and retains the rejected response separately`,async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),seen:ModelRequest[]=[];
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification'||!req.auditTargetIds!.includes('causal:0'))return defaultResponse(req);
   seen.push(req);const output=verificationResponse(req);
   if(seen.length===1){
    if(failure==='missing field')output.fieldChecks=output.fieldChecks.filter(c=>!c.targetId.startsWith('causal:0#explanation'));
    else {
     const target=output.checks.find(c=>c.targetId==='causal:0')! as unknown as Record<string,unknown>;
     if(failure==='missing explanation')delete target.explanation;
     else target.evidence=[{refId:'R999999'}];
    }
   }
   return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(seen).toHaveLength(2);expect(seen[0]).toBe(seen[1]);expect(Object.isFrozen(seen[1])).toBe(true);
  expect(result.verification!.errors).toEqual([]);expect(result.verification!.audit!.errors).toEqual([]);expect(run.status).toBe('succeeded');
  const rows=run.modelAttempts!.filter(a=>a.stage==='verification'&&a.targetIds?.includes('causal:0'));
  expect(rows.map(a=>[a.attempt,a.status,a.errorCode])).toEqual([[1,'failed','invalid_audit_format'],[2,'succeeded',undefined]]);
  expect(rows[0]!.validationErrors!.length).toBeGreaterThan(0);expect(rows[0]!.retryScheduled).toBe(true);
  const history=result.verification!.audit!.batchAttempts!.filter(a=>a.targetIds.includes('causal:0'));
  expect(history.map(a=>a.attempt)).toEqual([1,2]);expect(history[0]!.result.errors.length).toBeGreaterThan(0);expect(history[1]!.result.errors).toEqual([]);
  expect(history[1]!.result.fieldChecks).toHaveLength(verificationFieldTargets(seen[1]!.draftReview!,seen[1]!.draftFacts).filter(t=>seen[1]!.auditTargetIds!.includes(t.parentId)).length);
  expect(h.store.get('reviews',result.id)!.verification!.audit!.batchAttempts).toEqual(result.verification!.audit!.batchAttempts);
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });

 for(const negativeKind of ['parent','field'] as const)test(`a valid first-attempt ${negativeKind} rejection survives a complete positive resend and still blocks imported rewriting`,async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),instruction='让小林将空电池收进工具袋。';let calls=0;
  h.setResponder(async req=>{
   if(req.reviewPass==='causality'){
    const output=JSON.parse(defaultResponse(req));Object.assign(output.checks[0],{verdict:'gap',suggestedFix:instruction,suggestedSceneId:'s1'});return JSON.stringify(output);
   }
   if(req.reviewPass!=='verification'||!req.auditTargetIds!.includes('causal:0'))return defaultResponse(req);
   calls++;const output=verificationResponse(req);
   if(calls===1){
    const target=negativeKind==='parent'?output.checks.find(c=>c.targetId==='causal:0')!:output.fieldChecks.find(c=>c.targetId==='causal:0#suggestedFix')!;
    Object.assign(target,{verdict:'unsupported',explanation:'This test auditor rejects the proposed change; this is not a transport failure.',correction:'Retain the original gesture.',...(negativeKind==='field'?{claimQuote:instruction}:{})});
    output.fieldChecks=output.fieldChecks.filter(c=>!c.targetId.startsWith('causal:0#explanation'));
   }
   return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=result.verification!.audit!,run=h.store.all('runs').at(-1)!;
  expect(calls).toBe(2);expect(run.status).toBe('succeeded');expect(result.verification!.errors).toEqual([]);
  expect(audit.checks.find(c=>c.targetId==='causal:0')!.verdict).toBe('unsupported');expect(audit.status).toBe('needs_review');
  const history=audit.batchAttempts!.filter(a=>a.targetIds.includes('causal:0'));
  const targetId=negativeKind==='parent'?'causal:0':'causal:0#suggestedFix',key=negativeKind==='parent'?'checks':'fieldChecks';
  expect(history[0]!.result[key].find(c=>c.targetId===targetId)!.verdict).toBe('unsupported');expect(history[0]!.result.errors.length).toBeGreaterThan(0);
  expect(history[1]!.result[key].find(c=>c.targetId===targetId)!.verdict).toBe('supported');expect(history[1]!.result.errors).toEqual([]);
  if(negativeKind==='field')expect(audit.fieldChecks.find(c=>c.targetId===targetId)!.verdict).toBe('unsupported');
  expect(reviewSuggestion(result,result.id,'causal:0','s1')).toBeUndefined();
  const before=h.requests.length;
  const response=await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s1',instruction,reviewSource:{reviewId:result.id,targetId:'causal:0'}});
  expect(response.status).toBe(409);expect(h.requests).toHaveLength(before);expect(h.store.get('revisions',r.id)).toEqual(r);
 });

 for(const [first,second,winner] of [['unsupported','uncertain',0],['uncertain','contradicted',1],['unsupported','unsupported',0]] as const)test(`retry merge preserves the complete ${first}/${second} winning check without changing either saved answer`,async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);let calls=0;
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification'||!req.auditTargetIds!.includes('assessment:story'))return defaultResponse(req);
   calls++;const output=verificationResponse(req),scene=req.revision!.scenes[calls===1?0:1]!,verdict=calls===1?first:second;
   Object.assign(output.checks.find(c=>c.targetId==='assessment:story')!,{
    verdict,explanation:calls===1?'First independent rationale.':'Second different rationale.',correction:calls===1?'First correction remains attached.':'Second correction remains attached.',
    evidence:[{sourceId:`scene:${scene.id}`,quote:scene.content}],counterEvidence:verdict==='contradicted'?[{sourceId:`scene:${scene.id}`,quote:scene.content}]:[]
   });
   if(calls===1)output.checks=output.checks.filter(c=>c.targetId!=='assessment:character');
   return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=result.verification!.audit!;
  const history=audit.batchAttempts!.filter(a=>a.targetIds.includes('assessment:story'));
  expect(history).toHaveLength(2);expect(history[0]!.result.errors.length).toBeGreaterThan(0);expect(history[1]!.result.errors).toEqual([]);
  const originals=history.map(a=>a.result.checks.find(c=>c.targetId==='assessment:story')!);
  expect(originals.map(c=>[c.verdict,c.explanation,c.correction,c.evidence[0]!.sourceId])).toEqual([
   [first,'First independent rationale.','First correction remains attached.','scene:s1'],
   [second,'Second different rationale.','Second correction remains attached.','scene:s2']
  ]);
  expect(audit.originalChecks.find(c=>c.targetId==='assessment:story')).toEqual(originals[winner]);
  expect(audit.checks.find(c=>c.targetId==='assessment:story')).toEqual(originals[winner]);
  expect(result.verification!.errors).toEqual([]);expect(h.store.all('runs').at(-1)!.status).toBe('succeeded');expect(result.status).toBe('needs_review');
  expect(h.store.get('reviews',result.id)!.verification!.audit!.batchAttempts).toEqual(audit.batchAttempts);
 });

 test('two complementary incomplete answers cannot be stitched into a completed audit',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);let calls=0;
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification'||!req.auditTargetIds!.includes('assessment:story'))return defaultResponse(req);
   calls++;const output=verificationResponse(req),missing=calls===1?'assessment:story':'assessment:character';
   return JSON.stringify({...output,checks:output.checks.filter(c=>c.targetId!==missing)});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=result.verification!.audit!,run=h.store.all('runs').at(-1)!;
  expect(calls).toBe(2);expect(run.status).toBe('failed');expect(run.resultId).toBe(result.id);expect(result.status).toBe('needs_review');
  expect(audit.errors.length).toBeGreaterThan(0);expect(result.verification!.errors.length).toBeGreaterThan(0);
  const history=audit.batchAttempts!.filter(a=>a.targetIds.includes('assessment:story'));
  expect(history).toHaveLength(2);expect(history.every(a=>a.result.errors.length>0)).toBe(true);
  expect(history[0]!.result.checks.some(c=>c.targetId==='assessment:story')).toBe(false);
  expect(history[1]!.result.checks.some(c=>c.targetId==='assessment:character')).toBe(false);
  expect(run.modelAttempts!.find(a=>a.stage==='verification'&&a.attempt===2&&a.targetIds?.includes('assessment:story'))).toMatchObject({status:'failed',errorCode:'invalid_audit_format',retryStoppedReason:'call_limit'});
  expect(result.verification!.omissions).toHaveLength(5);expect(result.causality!.checks).toHaveLength(2);expect(result.assessments).toHaveLength(5);
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });

 test('an intact unsupported audit does not request another opinion',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);let calls=0;
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification'||!req.auditTargetIds!.includes('assessment:story'))return defaultResponse(req);
   calls++;const output=verificationResponse(req);Object.assign(output.checks.find(c=>c.targetId==='assessment:story')!,{verdict:'unsupported',correction:'Keep the original source.'});return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(calls).toBe(1);expect(run.modelAttempts!.some(a=>a.attempt===2)).toBe(false);expect(run.status).toBe('succeeded');
  expect(result.verification!.errors).toEqual([]);expect(result.verification!.checks.find(c=>c.targetId==='assessment:story')!.verdict).toBe('unsupported');expect(result.status).toBe('needs_review');
 });

 test('earlier syntax retries exhaust the shared budget before an incomplete audit and preserve its partial output',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),counts=new Map<string,number>();let audits=0;
  h.setResponder(async req=>{
   const stage=req.reviewPass??req.kind,n=(counts.get(stage)??0)+1;counts.set(stage,n);
   if(['causality','review'].includes(stage)&&n===1)throw new ModelError('invalid_json','Bad JSON.');
   if(req.reviewPass==='verification'&&req.auditTargetIds!.includes('assessment:story')){
    audits++;const output=verificationResponse(req);return JSON.stringify({...output,checks:output.checks.filter(c=>c.targetId!=='assessment:story')});
   }
   return defaultResponse(req);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(audits).toBe(1);expect(run.modelAttempts!.filter(a=>a.attempt===2)).toHaveLength(2);expect(run.status).toBe('failed');
  expect(run.modelAttempts!.find(a=>a.stage==='verification'&&a.targetIds?.includes('assessment:story'))).toMatchObject({status:'failed',errorCode:'invalid_audit_format',retryStoppedReason:'run_limit'});
  const history=result.verification!.audit!.batchAttempts!.filter(a=>a.targetIds.includes('assessment:story'));
  expect(history).toHaveLength(1);expect(history[0]!.result.errors.length).toBeGreaterThan(0);expect(history[0]!.result.checks.some(c=>c.targetId==='assessment:character')).toBe(true);
  expect(result.verification!.omissions).toHaveLength(5);expect(h.store.get('reviews',result.id)!.verification!.audit!.batchAttempts).toEqual(result.verification!.audit!.batchAttempts);
 });
});

describe('review, failed outputs and execution state',()=>{
 test('audit batches cap concurrency at two and retain the completed peer when another fails',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  let firstFail!:(reason:Error)=>void,secondFinish!:()=>void,started=0,active=0,maximum=0;
  const first=new Promise<void>((_resolve,reject)=>{firstFail=reject;}),second=new Promise<void>(resolve=>{secondFinish=resolve;});
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   started++;active++;maximum=Math.max(maximum,active);const ordinal=started;
   try{await(ordinal===1?first:second);return defaultResponse(req);}finally{active--;}
  });
  const pending=h.call(`/api/revisions/${r.id}/review`,{mode:'live'});
  for(let i=0;i<20&&started<2;i++)await new Promise(resolve=>setTimeout(resolve,0));
  expect(started).toBe(2);expect(maximum).toBe(2);
  firstFail(new Error('private upstream error'));
  await new Promise(resolve=>setTimeout(resolve,0));secondFinish();
  const response=await pending,result=response.body as Review;
  expect(response.status).toBe(200);expect(started).toBe(2);expect(active).toBe(0);
  expect(result.verification!.audit!.originalChecks.some(c=>c.targetId==='assessment:filmability')).toBe(true);
  expect(result.verification!.errors.some(e=>e.includes('第 1 批'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private upstream');
  expect(result.verification!.omissions).toHaveLength(5);expect(h.store.all('runs').at(-1)!.status).toBe('failed');
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('server revalidates imported suggestions and keeps their provenance on the immutable child',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const instruction='用工具箱的移动表达让座，保留小林和阿禾自行决定留下。';
  h.setResponder(async req=>{
   if(req.kind==='review'&&!req.reviewPass){
    const v=JSON.parse(defaultResponse(req));Object.assign(v.assessments[0],{status:'issue',issueType:'craft_preference',suggestedFix:instruction,suggestedSceneId:'s2'});return JSON.stringify(v);
   }
   return defaultResponse(req);
  });
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  const reviewSource={reviewId:review.id,targetId:'assessment:story'},before=h.requests.length;
  for(const request of [
   {sceneId:'s1',instruction,reviewSource},
   {sceneId:'s2',instruction:'伪造的新指令',reviewSource},
   {sceneId:'s2',instruction,reviewSource:{reviewId:'missing',targetId:'assessment:story'}},
   {sceneId:'s2',instruction,reviewSource:{reviewId:review.id,targetId:'omission:other'}},
  ])expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',...request})).status).toBe(409);
  expect(h.requests).toHaveLength(before);
  const child=await h.ok<Revision>(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction,reviewSource});
  expect(child.reviewSource).toEqual(reviewSource);expect(child.instruction).toBe(instruction);
  expect(child.scenes[0]).toEqual(r.scenes[0]);expect(h.store.get('revisions',r.id)).toEqual(r);
  const latest=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),after=h.requests.length;
  expect(latest.id).not.toBe(review.id);
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction,reviewSource})).status).toBe(409);
  expect(h.requests).toHaveLength(after);
  const author=await h.ok<Revision>(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction:'作者的新意图：只改让座动作。'});
  expect(author.reviewSource).toBeUndefined();expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });
 test('a separately grounded omission repair is allowed while a refuted review claim remains quarantined',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id),instruction='只让本场让座动作更清楚，不改变电池状态。';
  h.setResponder(async req=>{
   if(req.reviewPass==='facts'){
    const v=factsResponse(req);return JSON.stringify({...v,omissions:v.omissions.map(o=>o.category==='continuity'?{...o,status:'issue',sceneIds:['s2'],suggestedFix:instruction,suggestedSceneId:'s2'}:o)});
   }
   if(req.reviewPass==='verification'){
    const v=verificationResponse(req);return JSON.stringify({...v,fieldChecks:v.fieldChecks.map(c=>c.targetId.startsWith('causal:0#state')&&verificationFieldTargets(req.draftReview!,req.draftFacts).find(t=>t.id===c.targetId)!.claim.includes('没有新增资源')?{...c,verdict:'unsupported',claimQuote:'没有新增资源',explanation:'This fixture leaves the broader resource inference unproved.',correction:'Keep the visible battery state only.'}:c)});
   }
   return defaultResponse(req);
  });
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(review.status).toBe('needs_review');expect(review.verification!.errors).toEqual([]);
  const before=h.requests.length;
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s1',instruction:'假建议',reviewSource:{reviewId:review.id,targetId:'causal:0'}})).status).toBe(409);
  expect(h.requests).toHaveLength(before);
  const reviewSource={reviewId:review.id,targetId:'omission:continuity'};
  const child=await h.ok<Revision>(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s2',instruction,reviewSource});
  expect(child.reviewSource).toEqual(reviewSource);
  expect(h.requests.at(-1)!.instruction).toBe(instruction);
  expect(JSON.stringify(h.requests.at(-1))).not.toContain('broader resource inference');
  expect(child.scenes[0]).toEqual(r.scenes[0]);expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('a rejected clause of an otherwise supported fix blocks the server before a rewrite call',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const instruction='保留人物等待的选择；新增无法离开的机械死锁。';
  h.setResponder(async req=>{
   if(req.reviewPass==='causality'){
    const audit=JSON.parse(defaultResponse(req));
    Object.assign(audit.checks[0],{verdict:'gap',suggestedFix:instruction,suggestedSceneId:'s1'});
    return JSON.stringify(audit);
   }
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const audit=verificationResponse(req),fields=verificationFieldTargets(req.draftReview!,req.draftFacts);
   return JSON.stringify({...audit,fieldChecks:audit.fieldChecks.map(c=>fields.find(f=>f.id===c.targetId)?.claim.includes('新增无法离开的机械死锁')?{
    ...c,verdict:'unsupported',claimQuote:'新增无法离开的机械死锁',explanation:'The proposed restriction is not established by the source.',correction:'Keep the voluntary choice without a new mechanical restriction.'
   }:c)});
  });
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=review.verification!.audit!;
  expect(audit.errors).toEqual([]);
  expect(audit.originalChecks.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
  expect(audit.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
  expect(audit.fieldChecks.filter(c=>c.targetId.startsWith('causal:0#suggestedFix@')).map(c=>c.verdict)).toEqual(['supported','unsupported']);
  expect(audit.fieldChecks.find(c=>c.targetId==='causal:0#suggestedFix')?.verdict).toBe('unsupported');
  const before=h.requests.length;
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:'s1',instruction,reviewSource:{reviewId:review.id,targetId:'causal:0'}})).status).toBe(409);
  expect(h.requests).toHaveLength(before);expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('invalid causal structure preserves partial findings and stops before the five-dimension call',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const historical=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),before=JSON.stringify(historical),start=h.requests.length;
  h.setResponder(async req=>{
   if(req.reviewPass!=='causality')throw new Error('A structurally incomplete causal pass must stop later calls.');
   const audit=JSON.parse(defaultResponse(req));delete audit.checks[1].choice;return JSON.stringify(audit);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(h.requests.slice(start).map(req=>req.reviewPass??req.kind)).toEqual(['causality']);
  expect(result.causality!.checks).toEqual([historical.causality!.checks[0]!]);expect(result.causality!.errors.length).toBeGreaterThan(0);
  expect(result.errors).toEqual(expect.arrayContaining(result.causality!.errors));expect(result.assessments).toEqual([]);
  expect(result.status).toBe('needs_review');expect(result.verification!.status).toBe('needs_review');expect(result.verification!.checks).toEqual([]);
  expect(result.verification!.errors[0]).toContain('未继续五维审稿');
  expect(run.status).toBe('failed');expect(run.resultId).toBe(result.id);expect(run.error).toContain('因果审稿未通过');
  expect(run.modelAttempts!.map(a=>[a.stage,a.attempt])).toEqual([['causality',1]]);
  expect(h.store.get('reviews',result.id)).toEqual(result);expect(JSON.stringify(h.store.get('reviews',historical.id))).toBe(before);
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('invalid five-dimension evidence preserves both partial critics and stops before facts or audits',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass==='causality')return defaultResponse(req);
   if(req.kind!=='review'||req.reviewPass)throw new Error('Invalid broad evidence must stop facts and audits.');
   const broad=JSON.parse(defaultResponse(req));broad.assessments[2].evidence[0].draftQuote='This sentence is absent from the frozen scene.';return JSON.stringify(broad);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(h.requests.filter(req=>req.kind==='review').map(req=>req.reviewPass??'dimensions')).toEqual(['causality','dimensions']);
  expect(result.causality!.checks).toHaveLength(2);expect(result.causality!.errors).toEqual([]);
  expect(result.assessments.map(a=>a.dimension)).toEqual(DIMENSIONS.filter(d=>d!=='dialogue'));
  expect(result.assessments.every(a=>a.explanation==='本次未发现问题；不等于质量验收。')).toBe(true);
  expect(result.errors).toContain('dialogue 的引用无法与冻结资料和对应场景原文核对。');
  expect(result.status).toBe('needs_review');expect(result.verification!.status).toBe('needs_review');expect(result.verification!.checks).toEqual([]);
  expect(result.verification!.errors[0]).toContain('未继续事实整理');
  expect(run.status).toBe('failed');expect(run.resultId).toBe(result.id);expect(run.error).toContain('五维审稿未通过');
  expect(run.modelAttempts!.map(a=>[a.stage,a.attempt])).toEqual([['causality',1],['review',1]]);
  expect(h.store.get('reviews',result.id)).toEqual(result);expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('valid issue and uncertain judgments still receive facts and independent audits without being treated as format failure',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   const output=JSON.parse(defaultResponse(req));
   if(req.reviewPass==='causality')output.checks[0].verdict='uncertain';
   if(req.kind==='review'&&!req.reviewPass){
    Object.assign(output.assessments[0],{status:'issue',issueType:'craft_preference',suggestedFix:'让让座动作更清楚，保留等待的选择。',suggestedSceneId:'s2'});
    Object.assign(output.assessments[1],{status:'uncertain',evidence:[]});
   }
   return JSON.stringify(output);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),run=h.store.all('runs').at(-1)!;
  expect(result.causality!.status).toBe('needs_review');expect(result.causality!.errors).toEqual([]);expect(result.errors).toEqual([]);
  expect(result.assessments[0]!.status).toBe('issue');expect(result.assessments[1]!.status).toBe('uncertain');
  expect(h.requests.filter(req=>req.kind==='review').map(req=>req.reviewPass??'dimensions')).toEqual(['causality','dimensions','facts',...auditBatches(result,result.verification!).map(()=>'verification' as const)]);
  expect(result.verification!.errors).toEqual([]);expect(result.verification!.audit!.status).toBe('completed');expect(result.status).toBe('needs_review');
  expect(run.status).toBe('succeeded');expect(run.error).toBeNull();expect(run.modelAttempts!.every(a=>a.attempt===1)).toBe(true);
 });
 test('demo keeps its single illustrative review call even when its output has parser errors',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async()=>'{}');
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'demo'}),run=h.store.all('runs').at(-1)!;
  expect(h.requests.filter(req=>req.kind==='review').map(req=>req.reviewPass??'dimensions')).toEqual(['dimensions']);
  expect(result.errors.length).toBeGreaterThan(0);expect(result.status).toBe('needs_review');expect(result.verification).toBeUndefined();
  expect(run.status).toBe('succeeded');expect(run.mode).toBe('demo');
 });
 test('review is tied to exact immutable revision and keeps all five evidence-based assessments',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(review.revisionId).toBe(r.id);expect(review.status).toBe('completed');expect(review.assessments).toHaveLength(5);
  expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
  expect(h.requests.filter(x=>x.kind==='review').map(x=>x.reviewPass??'dimensions')).toEqual(['causality','dimensions','facts',...auditBatches(review,review.verification!).map(()=>'verification' as const)]);
  expect(review.causality?.checks).toHaveLength(r.scenes.length);
  expect(review.verification?.status).toBe('completed');
  const facts=h.requests.find(x=>x.reviewPass==='facts')!;
  expect(facts.revision).toEqual(r);expect(facts.context).toEqual(r.context);
  expect(facts.draftReview).toBeUndefined();expect(facts.draftFacts).toBeUndefined();
  const checked=h.requests.at(-1)!;
  expect(checked.revision).toEqual(r);expect(checked.draftReview?.assessments).toEqual(review.assessments);
  expect(checked.draftReview?.causality).toEqual(review.causality);
  expect(checked.draftFacts?.status).toBe('completed');
  expect(checked.draftFacts?.omissions).toEqual(review.verification?.omissions);
  expect(review.verification?.audit?.status).toBe('completed');
  expect(review.verification?.audit?.schemaVersion).toBe(5);
  expect(review.verification?.audit?.fieldChecks).toHaveLength(verificationFieldTargets(review,review.verification).length);
  expect(review.verification?.audit?.originalChecks).toEqual(review.verification?.audit?.checks);
  expect(review.verification?.audit?.checks).toHaveLength(reviewTargets(review).length+5);
 });
 test('fourth-pass rejection persists the original review but prevents a clean result',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const v=verificationResponse(req),check=v.checks.find(c=>c.targetId==='causal:0')!;
   return JSON.stringify({...v,checks:v.checks.map(c=>c===check?{...c,verdict:'unsupported',explanation:'The critic inferred physical inability from preference.',correction:'The character can leave; preserve the voluntary choice.'}:c)});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.status).toBe('needs_review');expect(result.verification?.status).toBe('needs_review');
  expect(result.assessments).toHaveLength(5);expect(result.assessments.every(a=>a.status==='no_issue')).toBe(true);
  expect(result.causality?.checks).toHaveLength(2);expect(result.causality?.status).toBe('completed');
  expect(result.verification?.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
  expect(h.store.all('runs').at(-1)?.resultId).toBe(result.id);
 });
 test('a conflicting time fact prevents completion despite positive critics and clean omission summaries',async()=>{
  const h=harness(),p=await h.project();
  const timedScript=structuredClone(script);
  timedScript.scenes[0]!.content+='\nELAPSED: 240 HOURS.\nThe first five days ran automated.\nBolt says he worked manually for ten uninterrupted days.';
  h.setResponder(async req=>req.kind==='generate'?JSON.stringify(timedScript):defaultResponse(req));
  const r=await h.generate(p.episodes[0]!.id);expect(timelineTargets(r).length).toBeGreaterThan(0);
  h.setResponder(async req=>{
   if(req.reviewPass!=='facts')return defaultResponse(req);
   const v=factsResponse(req);
   expect(v.timelineFacts.length).toBe(timelineTargets(r).length);
   return JSON.stringify({...v,timelineFacts:v.timelineFacts.map((fact,i)=>i===0?{...fact,status:'conflict',
    meaning:{subject:'Bolt',activity:'Presence versus asserted uninterrupted manual labor',durationKind:'Elapsed interval versus work duration',clock:'Chamber time',basis:'Elapsed time alone cannot prove continuous work'},
    explanation:'The time statement is being used as total labor despite the separately stated automated interval.'}:fact)});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.assessments.every(a=>a.status==='no_issue')).toBe(true);
  expect(result.causality?.status).toBe('completed');
  expect(result.verification?.timelineFacts.some(f=>f.status==='conflict')).toBe(true);
  expect(result.verification?.status).toBe('needs_review');expect(result.status).toBe('needs_review');
  expect(result.verification?.errors.length).toBeGreaterThan(0);
  expect(h.requests.filter(x=>x.kind==='review').map(x=>x.reviewPass??'dimensions')).toEqual(['causality','dimensions','facts']);
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });
 test('a rejected causal explanation overrides its supported parent without rewriting the model original',async()=>{
  const h=harness(),p=await h.project(),timed=structuredClone(script);
  timed.scenes[0]!.content+='\nELAPSED: 240 HOURS.\nThe first five days ran automated.\nTen days in here is enough.';
  h.setResponder(async req=>req.kind==='generate'?JSON.stringify(timed):defaultResponse(req));
  const r=await h.generate(p.episodes[0]!.id),claim='The script explicitly proves ten continuous days of manual labor.';
  h.setResponder(async req=>{
   if(req.reviewPass==='causality'){
    const causal=JSON.parse(defaultResponse(req));causal.checks[0].explanation=claim;return JSON.stringify(causal);
   }
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const fields=verificationFieldTargets(req.draftReview!,req.draftFacts);
   expect(fields.find(f=>f.id==='causal:0#explanation')?.claim).toBe(claim);
   const audit=verificationResponse(req);
   // Deliberately reproduce the live failure: parent says supported while the specific claim lacks support.
   if(req.auditTargetIds?.includes('causal:0'))expect(audit.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
   return JSON.stringify({...audit,fieldChecks:audit.fieldChecks.map(c=>c.targetId==='causal:0#explanation'?{...c,verdict:'unsupported',claimQuote:'ten continuous days of manual labor',
    explanation:'The elapsed record and automated interval do not establish continuous manual work.',
    correction:'Ten days elapsed; exact manual labor duration and continuity are not stated.',
    evidence:[{sourceId:'scene:s1',quote:'ELAPSED: 240 HOURS.'},{sourceId:'scene:s1',quote:'The first five days ran automated.'}]}:c)});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=result.verification?.audit;
  expect(audit?.schemaVersion).toBe(5);
  expect(audit?.originalChecks?.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
  expect(audit?.fieldChecks?.find(c=>c.targetId==='causal:0#explanation')?.verdict).toBe('unsupported');
  expect(audit?.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
  expect(result.verification?.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
  expect(result.causality?.checks[0]?.explanation).toBe(claim);
  expect(audit?.status).toBe('needs_review');expect(result.status).toBe('needs_review');
  expect(result.verification?.errors).toEqual([]);expect(h.store.all('runs').at(-1)?.status).toBe('succeeded');
  expect(h.requests.filter(req=>req.kind==='review')).toHaveLength(3+auditBatches(result,result.verification!).length);
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });
 test('a missing causal explanation field cannot hide behind complete supported parent rows',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const audit=verificationResponse(req);
   return JSON.stringify({...audit,fieldChecks:audit.fieldChecks.filter(c=>!c.targetId.startsWith('causal:0#explanation'))});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'}),audit=result.verification?.audit;
  expect(audit?.originalChecks?.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
  expect(audit?.fieldChecks?.some(c=>c.targetId.startsWith('causal:0#explanation'))).toBe(false);
  expect(audit?.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('uncertain');
  expect(audit?.errors.some(error=>error.includes('causal:0#explanation'))).toBe(true);
  expect(audit?.status).toBe('needs_review');expect(result.status).toBe('needs_review');
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');
  expect(result.verification?.omissions).toHaveLength(5);
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('the fourth pass can reject an invented continuous-work claim introduced by the fact extractor itself',async()=>{
  const h=harness(),p=await h.project(),timed=structuredClone(script);
  timed.scenes[0]!.content+='\nELAPSED: 240 HOURS.\nThe first five days ran automated.\nTen days in here is enough.';
  h.setResponder(async req=>req.kind==='generate'?JSON.stringify(timed):defaultResponse(req));
  const r=await h.generate(p.episodes[0]!.id),target=timelineTargets(r).find(t=>t.quote==='ELAPSED: 240 HOURS.')!;
  const invented='Bolt worked manually for ten continuous days.';
  h.setResponder(async req=>{
   if(req.reviewPass==='facts'){
    expect(req.draftReview).toBeUndefined();
    const facts=factsResponse(req);
    return JSON.stringify({...facts,timelineFacts:facts.timelineFacts.map(f=>f.targetId===target.id?{...f,explanation:invented}:f)});
   }
   if(req.reviewPass!=='verification')return defaultResponse(req);
   expect(req.draftFacts?.timelineFacts.find(f=>f.targetId===target.id)?.explanation).toBe(invented);
   const audit=verificationResponse(req);
   // This fixture proves API gating and evidence retention, not live semantic detection.
   return JSON.stringify({...audit,checks:audit.checks.map(c=>c.targetId===target.id?{...c,verdict:'contradicted',
    explanation:'The extractor added continuous manual labor that the elapsed display does not establish.',
    correction:'Ten days elapsed; the first five ran automated. Exact manual labor time and continuity are not specified.',
    evidence:[{sourceId:target.sourceId,quote:target.quote}],
    counterEvidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}]}:c)});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.assessments.every(a=>a.status==='no_issue')).toBe(true);
  expect(result.verification?.checks).toHaveLength(reviewTargets(result).length);
  expect(result.verification?.checks.every(c=>c.verdict==='supported')).toBe(true);
  expect(result.verification?.timelineFacts.find(f=>f.targetId===target.id)?.explanation).toBe(invented);
  expect(result.verification?.omissions.every(o=>o.status==='no_issue')).toBe(true);
  const rejected=result.verification?.audit?.checks.find(c=>c.targetId===target.id);
  expect(rejected?.verdict).toBe('contradicted');expect(rejected?.correction).toContain('not specified');
  expect(rejected?.counterEvidence).toEqual([{sourceId:'scene:s1',quote:'The first five days ran automated.'}]);
  expect(result.verification?.audit?.status).toBe('needs_review');expect(result.status).toBe('needs_review');
  expect(h.store.all('runs').at(-1)?.status).toBe('succeeded');
  expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 });
 test('a failed source-only fact call preserves both critics and does not spend a fourth call',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{if(req.reviewPass==='facts')throw new Error('fact-provider-private-secret');return defaultResponse(req);});
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.assessments).toHaveLength(5);expect(result.causality?.checks).toHaveLength(2);
  expect(result.status).toBe('needs_review');expect(result.verification?.audit?.status).toBe('needs_review');
  expect(result.verification?.audit?.checks).toEqual([]);expect(result.verification?.errors.length).toBeGreaterThan(0);
  expect(h.requests.filter(x=>x.kind==='review').map(x=>x.reviewPass??'dimensions')).toEqual(['causality','dimensions','facts']);
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');expect(h.store.all('runs').at(-1)?.resultId).toBe(result.id);
  expect(JSON.stringify({result,runs:h.store.all('runs')})).not.toContain('fact-provider-private-secret');
 });
 test('invalid source-only fact evidence retains valid partial facts and stops before the audit',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='facts')return defaultResponse(req);
   const facts=factsResponse(req);
   facts.omissions[0]!.evidence=[{sourceId:'scene:s1',quote:'This text does not occur in the source.'}];
   return JSON.stringify(facts);
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.status).toBe('needs_review');expect(result.assessments).toHaveLength(5);
  expect(result.verification?.omissions).toHaveLength(4);expect(result.verification?.audit?.checks).toEqual([]);
  expect(result.verification?.errors.length).toBeGreaterThan(0);
  expect(h.requests.filter(x=>x.kind==='review')).toHaveLength(3);
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');
 });
 test('fourth-pass service failure retains the source-only facts and both earlier reviews and redacts upstream details',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{if(req.reviewPass==='verification')throw new Error('verifier-secret-at-private-provider');return defaultResponse(req);});
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.status).toBe('needs_review');expect(result.verification?.status).toBe('needs_review');expect(result.verification?.errors.length).toBeGreaterThan(0);
  expect(result.assessments).toHaveLength(5);expect(result.causality?.checks).toHaveLength(2);
  expect(result.verification?.omissions).toEqual(h.requests.at(-1)?.draftFacts?.omissions);
  expect(result.verification?.omissions).toHaveLength(5);
  expect(result.verification?.audit?.status).toBe('needs_review');expect(result.verification?.audit?.checks).toEqual([]);
  expect(h.requests.filter(x=>x.kind==='review')).toHaveLength(5);expect(h.store.all('reviews')).toHaveLength(1);
  expect(h.store.all('runs').at(-1)?.resultId).toBe(result.id);expect(h.store.all('runs').at(-1)?.finishedAt).not.toBeNull();
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');
  expect(JSON.stringify({result,runs:h.store.all('runs')})).not.toContain('verifier-secret');
 });
 test('empty audit coverage remains incomplete even after positive reviews and source-only facts',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>req.reviewPass==='verification'?'{}':defaultResponse(req));
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.status).toBe('needs_review');expect(result.assessments).toHaveLength(5);
  expect(result.verification?.status).toBe('needs_review');expect(result.verification?.errors.length).toBeGreaterThan(0);
  expect(result.verification?.omissions).toHaveLength(5);expect(result.verification?.audit?.status).toBe('needs_review');
  expect(h.store.all('runs').at(-1)?.status).toBe('failed');
 });
 test('auditing only the original critics cannot leave the newly extracted facts unchecked',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='verification')return defaultResponse(req);
   const audit=verificationResponse(req),originalIds=new Set(reviewTargets(req.draftReview!).map(t=>t.id));
   return JSON.stringify({...audit,checks:audit.checks.filter(c=>originalIds.has(c.targetId))});
  });
  const result=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(result.verification?.checks).toHaveLength(reviewTargets(result).length);
  expect(result.verification?.checks.every(c=>c.verdict==='supported')).toBe(true);
  expect(result.verification?.omissions).toHaveLength(5);
  expect(result.verification?.audit?.status).toBe('needs_review');expect(result.verification?.audit?.errors.length).toBeGreaterThan(0);
  expect(result.status).toBe('needs_review');expect(h.store.all('runs').at(-1)?.status).toBe('failed');
 });
 test('reverification checks the exact historical review without replacing its errors or its source',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  const legacy=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  const bad:Review={...structuredClone(legacy),id:'historical-bad-review',verification:undefined};
  bad.causality!.checks[0]!.explanation='Elapsed ten days proves uninterrupted manual work for ten days.';
  h.store.insert('reviews',bad);const before=JSON.stringify(bad),requestCount=h.requests.length;
  h.setResponder(async req=>{
   if(req.reviewPass==='facts'){expect(req.draftReview).toBeUndefined();return JSON.stringify(factsResponse(req));}
   expect(req.reviewPass).toBe('verification');
   expect(req.draftReview?.causality?.checks[0]!.explanation).toBe(bad.causality!.checks[0]!.explanation);
   const v=verificationResponse(req);
   return JSON.stringify({...v,checks:v.checks.map(c=>c.targetId==='causal:0'?{...c,verdict:'unsupported',explanation:'The claim is not in the script.',correction:'Do not convert elapsed time into labor time.'}:c)});
  });
  const result=await h.ok<Review>(`/api/reviews/${bad.id}/verify`,{mode:'live'});
  expect(result.id).not.toBe(bad.id);expect(result.verificationOfReviewId).toBe(bad.id);expect(result.revisionId).toBe(r.id);
  expect(result.status).toBe('needs_review');expect(result.assessments).toEqual(bad.assessments);expect(result.causality).toEqual(bad.causality);
  expect(h.requests.length-requestCount).toBe(1+auditBatches(result,result.verification!).length);expect(JSON.stringify(h.store.get('reviews',bad.id))).toBe(before);
  expect(h.requests.slice(requestCount).map(req=>req.reviewPass)).toEqual(['facts',...auditBatches(result,result.verification!).map(()=>'verification' as const)]);
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('reverification cannot erase an original extra-dimension parse error after the invalid row was discarded',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   const value=defaultResponse(req);
   if(req.kind!=='review'||req.reviewPass!==undefined)return value;
   const broad=JSON.parse(value);
   broad.assessments.push({...broad.assessments[0],dimension:'unknown-sixth-dimension'});
   return JSON.stringify(broad);
  });
  const original=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(original.status).toBe('needs_review');expect(original.assessments).toHaveLength(5);
  expect(original.errors).toContain('审稿维度未知或重复。');
  expect(original.verification?.status).toBe('needs_review');
  expect(h.store.all('runs').at(-1)!.status).toBe('failed');
  expect(h.requests.filter(req=>req.kind==='review').map(req=>req.reviewPass??'dimensions')).toEqual(['causality','dimensions']);
  const before=JSON.stringify(original),requestCount=h.requests.length;
  h.setResponder(async req=>defaultResponse(req));
  const result=await h.ok<Review>(`/api/reviews/${original.id}/verify`,{mode:'live'});
  expect(result.verification?.status).toBe('completed');
  expect(result.verification?.checks.every(c=>c.verdict==='supported')).toBe(true);
  expect(result.status).toBe('needs_review');expect(result.errors).toEqual(original.errors);
  expect(result.assessments).toEqual(original.assessments);expect(result.verificationOfReviewId).toBe(original.id);
  expect(h.requests.length-requestCount).toBe(1+auditBatches(result,result.verification!).length);expect(JSON.stringify(h.store.get('reviews',original.id))).toBe(before);
  expect(h.store.get('revisions',r.id)).toEqual(r);
 });
 test('if second review request fails, the independent causal findings persist without retry or false completion',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>{
   if(req.reviewPass!=='causality')throw new Error('provider-private-detail');
   return JSON.stringify({pressures:[],checks:r.scenes.map(s=>({sceneId:s.id,state:'已停下。',choice:'等待。',obstacleKind:'none',alternative:'离开。',verdict:'not_applicable',explanation:'没有物理困境声明。',evidence:[{sourceId:`scene:${s.id}`,sourceQuote:s.content,sceneId:s.id,draftQuote:s.content}],constraintEvidence:[]}))});
  });
  expect((await h.call(`/api/revisions/${r.id}/review`,{mode:'live'})).status).toBe(502);
  const saved=h.store.all('reviews')[0]!;
  expect(saved.status).toBe('needs_review');expect(saved.causality?.checks).toHaveLength(2);expect(saved.assessments).toEqual([]);
  expect(h.store.all('runs').at(-1)?.resultId).toBe(saved.id);expect(h.store.all('runs').at(-1)?.status).toBe('failed');
  expect(h.requests.filter(x=>x.kind==='review')).toHaveLength(2);expect(JSON.stringify(saved)).not.toContain('provider-private-detail');
 });
 test('length setting is frozen, changes context token, and adopting outside range needs separate explicit acknowledgement',async()=>{
  const h=harness(),p=await h.project();
  const before=h.store.contextToken(h.store.get('episodes',p.episodes[0]!.id)!);
  await h.ok(`/api/projects/${p.project.id}`,{...brief,lengthTarget:{min:1,max:2,unit:'characters'}},'PUT');
  const e=h.store.get('episodes',p.episodes[0]!.id)!;
  expect(h.store.contextToken(e)).not.toBe(before);
  const r=await h.generate(e.id);
  expect(r.context.brief.lengthTarget?.max).toBe(2);
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(review.lengthCheck?.status).toBe('too_long');expect(review.status).toBe('needs_review');
  const accept={revisionId:r.id,expectedAcceptedRevisionId:null,expectedContextToken:h.store.contextToken(e),acknowledgeReview:true};
  expect((await h.call(`/api/episodes/${e.id}/accept`,accept)).status).toBe(409);
  expect(h.store.get('episodes',e.id)!.acceptedRevisionId).toBeNull();
  expect((await h.call(`/api/episodes/${e.id}/accept`,{...accept,acknowledgeLengthException:true})).status).toBe(200);
  await h.ok(`/api/projects/${p.project.id}`,{...brief},'PUT');
  expect(h.store.get('projects',p.project.id)!.lengthTarget).toBeUndefined();expect(r.context.brief.lengthTarget?.max).toBe(2);
 });
 test('invalid review quotes remain needs_review, never silently become a passed audit',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async req=>req.reviewPass?defaultResponse(req):JSON.stringify({assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'虚假结论',evidence:[{sourceId:'worldRules',sourceQuote:'不存在的原文',sceneId:'s1',draftQuote:script.scenes[0]!.content}]}))}));
  const review=await h.ok<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
  expect(review.status).toBe('needs_review');expect(review.errors.length).toBeGreaterThan(0);expect(review.assessments).toEqual([]);
 });
 test('malformed generation and failed rewrite retain originals and durable failure records',async()=>{
  const h=harness(),p=await h.project(),r=await h.generate(p.episodes[0]!.id);
  h.setResponder(async()=>'{"title":"incomplete"');
  expect((await h.call(`/api/episodes/${r.episodeId}/generate`,{mode:'live'})).status).toBe(502);
  expect(h.store.all('revisions')).toHaveLength(1);
  h.setResponder(async()=>JSON.stringify({scene:{id:'wrong-scene',heading:'错场',content:'越界修改'}}));
  expect((await h.call(`/api/revisions/${r.id}/rewrite`,{sceneId:'s2',instruction:'局部修改',mode:'live'})).status).toBe(502);
  expect(h.store.get('revisions',r.id)).toEqual(r);
  expect(h.store.all('runs').filter(x=>x.status==='failed')).toHaveLength(2);
  expect(h.store.all('runs').every(x=>x.finishedAt!==null)).toBe(true);
 });
 test('upstream exception details are redacted, never returned or persisted as credentials',async()=>{
  const h=harness(),p=await h.project();
  h.setResponder(async()=>{throw new Error('secret-token-at-private-provider');});
  const result=await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`,{mode:'live'});
  expect(result.status).toBe(502);expect(JSON.stringify(result.body)).not.toContain('secret-token');
  expect(JSON.stringify(h.store.all('runs'))).not.toContain('secret-token');
 });
 test('in-flight duplicate requests do not create or pay for a second model operation',async()=>{
  const h=harness(),p=await h.project();
  let release!:(value:string)=>void,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  h.setResponder(async()=>{started();return new Promise<string>(resolve=>{release=resolve;});});
  const first=h.call(`/api/episodes/${p.episodes[0]!.id}/generate`,{mode:'live'});await began;
  expect((await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`,{mode:'live'})).status).toBe(409);
  expect(h.requests).toHaveLength(1);expect(h.store.all('runs')).toHaveLength(1);
  release(JSON.stringify(script));expect((await first).status).toBe(200);
  expect(h.store.all('runs')[0]!.status).toBe('succeeded');
 });
 test('brief changes during first generation cannot make a stale result appear current',async()=>{
  const h=harness(),p=await h.project();
  let release!:(value:string)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  h.setResponder(async()=>{started();return new Promise<string>(resolve=>{release=resolve;});});
  const pending=h.call(`/api/episodes/${p.episodes[0]!.id}/generate`,{mode:'live'});await began;
  await h.ok(`/api/projects/${p.project.id}`,{...brief,worldRules:'作者已改成两次。'},'PUT');
  release(JSON.stringify(script));const result=await pending;
  if(result.status===200)expect(h.store.get('episodes',p.episodes[0]!.id)!.needsReview).toBe(true);
  else expect(result.status).toBe(409);
 });
 test('upstream adoption during first generation marks a result based on the older accepted episode stale',async()=>{
  const h=harness(),p=await h.project(),r1=await h.generate(p.episodes[0]!.id);await h.accept(r1);
  const r1b=await h.generate(r1.episodeId);
  const added=await h.ok<ProjectBundle>(`/api/projects/${p.project.id}/episodes`,{title:'第二集'}),e2=added.episodes[1]!;
  let release!:(value:string)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  h.setResponder(async()=>{started();return new Promise<string>(resolve=>{release=resolve;});});
  const pending=h.call(`/api/episodes/${e2.id}/generate`,{mode:'live'});await began;
  await h.accept(r1b,r1.id);
  release(JSON.stringify(script));const result=await pending;
  if(result.status===200){
   expect((result.body as Revision).context.previousEpisodes[0]!.revisionId).toBe(r1.id);
   expect(h.store.get('episodes',e2.id)!.needsReview).toBe(true);
  }else expect(result.status).toBe(409);
 });
});

describe('storage and local API boundary',()=>{
 test('saved versions, adopted pointer and reviews survive reopening SQLite',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sci-epo-test-'));tempDirs.push(directory);
  const path=join(directory,'studio.sqlite');const h=harness(path),p=await h.project(),r=await h.generate(p.episodes[0]!.id);await h.accept(r);
  await h.ok(`/api/revisions/${r.id}/review`,{mode:'live'});
  h.store.close();
  const reloaded=new Store(path);stores.push(reloaded);
  expect(reloaded.bundle(p.project.id)!.episodes[0]!.acceptedRevisionId).toBe(r.id);
  expect(reloaded.get('revisions',r.id)).toEqual(r);
  expect(reloaded.bundle(p.project.id)!.reviews).toHaveLength(1);
 });
 test('interrupted runs become failed on recovery and no longer block a new operation',async()=>{
  const h=harness(),p=await h.project(),eid=p.episodes[0]!.id;
  h.store.insert('runs',{id:'interrupted',episodeId:eid,kind:'generate',status:'running',mode:'live',resultId:null,error:null,createdAt:new Date().toISOString(),finishedAt:null});
  h.store.recoverInterrupted();
  expect(h.store.get('runs','interrupted')!.status).toBe('failed');
  expect(h.store.get('runs','interrupted')!.error).toContain('中断');
  await h.generate(eid);
 });
 test('cross-site writes are rejected and status reveals no provider configuration',async()=>{
  const h=harness();
  expect((await h.call('/api/projects',brief,'POST','https://unrelated.example')).status).toBe(403);
  const status=await h.ok<Record<string,unknown>>('/api/status');
  expect(Object.keys(status).sort()).toEqual(['mode','modelLabel']);
 });
});
