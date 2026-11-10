/** Explicit live workflow check: generation, batched review and rewriting, visible bounded JSON resends, no automatic adoption. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ProjectBundle,Revision,Review} from '../src/types';
import {checkLength} from '../src/core/length';
import {getReviewSources} from '../src/core';
import {parseVerificationFacts,parseVerificationAudit} from '../src/core/reviewVerification';
import {reviewIssueCount,reviewSuggestion} from '../src/core/reviewSuggestions';
if(!process.argv.includes('--run')){console.log('This makes real model calls (generation, review stages with bounded audit batches, revision). Run with --run to execute.');process.exit(0);}
const url=new URL(process.env.SCIEPO_SMOKE_BASE_URL??'http://127.0.0.1:4317');
if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('Smoke test requires an HTTPS origin or a local loopback origin.');
const base=url.origin,token=process.env.SCIEPO_SMOKE_AUTH_TOKEN;
if(token&&(!/^[\w-]{43}$/.test(token)||url.protocol!=='https:'))throw new Error('Private test session requires HTTPS.');
let csrf='';
async function response(path:string,body?:unknown):Promise<Response>{
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,...(token?{cookie:`__Host-sciepo-session=${token}`} :{}),...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',timeout:false,signal:AbortSignal.timeout(20500000)});
 if(!r.ok){let message='Request failed';try{message=(await r.json() as {error:string}).error;}catch{}throw new Error(`HTTP ${r.status}: ${message}`);}
 return r;
}
async function api<T>(path:string,body?:unknown):Promise<T>{return await(await response(path,body)).json() as T;}
const dir=resolve(process.env.SCIEPO_SMOKE_ARTIFACT_DIR??resolve(import.meta.dir,'../artifacts/live-smoke-'+new Date().toISOString().replace(/[:.]/g,'-')));
mkdirSync(dir,{recursive:true,mode:0o700});
const summary:Record<string,unknown>={startedAt:new Date().toISOString(),live:true,language:'en',adopted:false,endpoint:base};
const save=()=>writeFileSync(dir+'/result.json',JSON.stringify(summary,null,2),{mode:0o600});
const artifact=(name:string,value:unknown)=>writeFileSync(dir+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
try{
 const session=await api<{csrf:string}>('/api/auth/session');csrf=session.csrf;
 const b=await api<ProjectBundle>('/api/projects',{
  title:'失物轨道 · 英文真实流程验证',language:'en',lengthTarget:{min:450,max:650,unit:'words'},
  premise:'Write a complete English screenplay for a short science-fiction animation, 450–650 words in 3 scenes. At an orbital station, a lost-property clerk has one last chance to help a technician recover a storage chip containing a message from his late mother. He insists he has lost nothing. Let conflicting wants drive observable choices, with room for an understated ending.',
  characters:'Lin: the lost-property clerk; precise about objects, but willing to stop and listen when someone refuses help. Adu: a maintenance technician; defensive and practical. He says keeping his mother\'s recording stops him moving on, yet he has never confirmed its deletion. They are ordinary colleagues, with no romance. Give them distinct, restrained voices.',
  worldRules:'The recording exists only on one damaged storage chip. No cloud backup, duplicate, resurrection, or magical repair is possible. Before the waste chamber clears, one manual cancellation is possible, at the cost of tonight\'s only maintenance window. Characters act only on things they observe or are told.',
  authorRules:'Use actions, pauses, and specific choices instead of explaining emotions or summarizing a theme. Lin cannot decide for Adu whether to preserve the recording. Do not require the mother\'s voice to play in the ending. No forced twist, exposition lecture, or new technology that removes the cost. All screenplay text, dialogue, title, headings and logline must be in English.',
  glossary:'Lin / 林禾; Adu / 阿渡; orbital station / 轨道站; waste chamber / 废物舱.'
 });
 const e=b.episodes[0]!;summary.projectId=b.project.id;summary.episodeId=e.id;save();console.log('Created an independent English live-verification series.');
 let started=Date.now();
 const r=await api<Revision>(`/api/episodes/${e.id}/generate`,{mode:'live'});
 assert(r.mode==='live'&&r.language==='en'&&r.scenes.length>=2,'Generation must be a real English revision with multiple scenes.');
 const original=JSON.stringify(r);summary.generatedRevisionId=r.id;summary.scenes=r.scenes.length;summary.lengthCheck=checkLength(r.context.brief,r.scenes);summary.generateMs=Date.now()-started;
 artifact('01-generated.json',r);artifact('01-generated.md',await(await response(`/api/revisions/${r.id}/export`)).text());save();console.log('Real English script saved.');assert(checkLength(r.context.brief,r.scenes).status==='within_range','Generated length is outside the brief; preserve the candidate for editing.');
 started=Date.now();
 const review=await api<Review>(`/api/revisions/${r.id}/review`,{mode:'live'});
 artifact('02-review.json',review);summary.review={id:review.id,status:review.status,assessments:review.assessments.length,errors:review.errors};summary.reviewMs=Date.now()-started;summary.causality=review.causality;save();
 assert(review.mode==='live'&&review.assessments.length===5&&review.errors.length===0,'Review must include all five dimensions with valid evidence.');
 assert(review.revisionId===r.id,'Review must belong to the generated revision.');
 assert(review.causality&&review.causality.errors.length===0&&r.scenes.every(s=>review.causality!.checks.some(c=>c.sceneId===s.id)),'Independent causal pass must cover every scene.');
 if(!review.verification)throw new Error('Interpretation verification is missing; stop before revision.');
 assert(['completed','needs_review'].includes(review.verification.status)&&Array.isArray(review.verification.errors)&&review.verification.errors.length===0,'Saved interpretation verification has unresolved validation errors; stop before revision.');
 // Revalidate coverage and exact quotations against this immutable script; do not trust a saved status flag.
 assert(review.verification.audit?.schemaVersion===5&&review.verification.audit.errors.length===0&&Array.isArray(review.verification.audit.originalChecks)&&Array.isArray(review.verification.audit.fieldChecks),'Independent segment audit is missing or invalid; stop before revision.');
 const sources=getReviewSources(r);
 const facts=parseVerificationFacts(JSON.stringify(review.verification),r,sources);
 const verification=parseVerificationAudit(JSON.stringify({checks:review.verification.audit!.originalChecks,fieldChecks:review.verification.audit!.fieldChecks}),r,review,facts,sources);
 summary.verification=verification;artifact('02-verification-validation.json',verification);save();
 assert(verification.errors.length===0,'Interpretation verification is incomplete or invalid; stop before revision.');
 const checkedReview:Review={...review,verification};
 console.log('Real review with batched segment audits saved: '+review.status+', '+review.assessments.length+' dimensions.');
 const candidates=[
  ...(review.causality?.pressures??[]).flatMap((c,i)=>['gap','uncertain'].includes(c.verdict)?[{targetId:`pressure:${i}`,sceneId:c.suggestedSceneId??''}]:[]),
  ...(review.causality?.checks??[]).flatMap((c,i)=>['gap','uncertain'].includes(c.verdict)?[{targetId:`causal:${i}`,sceneId:c.suggestedSceneId??''}]:[]),
  ...review.assessments.flatMap(a=>a.status==='issue'&&a.evidence[0]?[{targetId:`assessment:${a.dimension}`,sceneId:a.suggestedSceneId??''}]:[]),
  ...review.verification!.omissions.flatMap(o=>o.status==='issue'?o.suggestedSceneId?[{targetId:`omission:${o.category}`,sceneId:o.suggestedSceneId}]:[]:[]),
 ];
 const approved=candidates.map(c=>({...c,suggestion:reviewSuggestion(checkedReview,review.id,c.targetId,c.sceneId)}))
  .find(c=>c.suggestion&&r.scenes.some(s=>s.id===c.sceneId&&!s.locked));
 // A generic craft exercise is allowed only after a clean review; it cannot bypass an unverified finding.
 if(!approved)assert(review.status==='completed'&&verification.status==='completed'&&reviewIssueCount(checkedReview)===0,'No verified actionable suggestion is available; preserve unresolved findings and stop before revision.');
 const selected=approved?r.scenes.find(s=>s.id===approved.sceneId)!:[...r.scenes].reverse().find(s=>!s.locked);
 if(!selected)throw new Error('No unlocked scene is available for revision.');
 const instruction=approved?.suggestion?.instruction??'Revise only this scene, keeping all screenplay text in English. Preserve the established events, character choices, object locations, and ending outcome. Make dialogue more specific without adding facts.';
 summary.rewriteTarget={sceneId:selected.id,reviewId:approved?review.id:null,targetId:approved?.targetId??null,instruction};save();
 started=Date.now();
 const revised=await api<Revision>(`/api/revisions/${r.id}/rewrite`,{mode:'live',sceneId:selected.id,instruction,...(approved?{reviewSource:{reviewId:review.id,targetId:approved.targetId}}:{})});
 summary.revisedRevisionId=revised.id;summary.revisedLengthCheck=checkLength(revised.context.brief,revised.scenes);summary.rewriteMs=Date.now()-started;
 summary.unchangedScenesPreserved=r.scenes.filter(s=>s.id!==selected.id).every(s=>JSON.stringify(s)===JSON.stringify(revised.scenes.find(x=>x.id===s.id)));
 summary.targetChanged=selected.content!==revised.scenes.find(s=>s.id===selected.id)?.content;
 artifact('03-revised.json',revised);artifact('03-revised.md',await(await response(`/api/revisions/${revised.id}/export`)).text());save();
 assert(revised.mode==='live'&&revised.language==='en'&&revised.parentId===r.id,'Rewrite must be a separate real English child revision.');
 assert(summary.unchangedScenesPreserved&&summary.targetChanged&&revised.scenes.length===r.scenes.length,'Rewrite must change only the requested scene.');
 const persisted=await api<ProjectBundle>(`/api/projects/${b.project.id}`);
 summary.originalPreserved=JSON.stringify(persisted.revisions.find(x=>x.id===r.id))===original;
 summary.persistedRuns=persisted.runs.map(x=>({id:x.id,kind:x.kind,mode:x.mode,status:x.status}));
 assert(summary.originalPreserved,'Original revision was changed.');
 assert(persisted.episodes[0]?.acceptedRevisionId===null,'Verification must not adopt the script for the author.');
 assert(persisted.runs.length===3&&persisted.runs.every(x=>x.mode==='live'&&x.status==='succeeded'),'All three real workflow runs must persist as succeeded.');
 summary.completedAt=new Date().toISOString();save();console.log(JSON.stringify({...summary,artifactDirectory:dir}));
}catch(error){summary.failed=true;summary.error=error instanceof Error?error.message:'verification failed';save();console.log(JSON.stringify({...summary,artifactDirectory:dir}));process.exitCode=1;}
