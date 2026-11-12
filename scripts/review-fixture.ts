/** Live review check: review examples/last-order-draft.json with the configured model and report which of its expected
 * findings the review raised. Makes real model calls; run with --run against a server with a live provider.
 * The match is a hint, not a verdict: a finding counts as raised when an issue or causal gap in one of its dimensions
 * mentions all of its keywords. Read the review itself before changing prompts. */
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ProjectBundle,Review,Revision} from '../src/types';
if(!process.argv.includes('--run')){console.log('This reviews examples/last-order-draft.json with the live model. Run with --run to execute.');process.exit(0);}
const url=new URL(process.env.SCIEPO_SMOKE_BASE_URL??'http://127.0.0.1:4317');
if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('Use an HTTPS origin or a local loopback origin.');
const base=url.origin,token=process.env.SCIEPO_SMOKE_AUTH_TOKEN;
if(token&&(!/^[\w-]{43}$/.test(token)||url.protocol!=='https:'))throw new Error('A private session needs HTTPS.');
let csrf='';
async function call<T>(path:string,body?:unknown):Promise<T>{
 // A live review runs several model calls; allow it up to an hour, as smoke-live does for its review stages.
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,...(token?{cookie:`__Host-sciepo-session=${token}`}:{}),...(body!==undefined?{'content-type':'application/json','x-csrf-token':csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'error',timeout:false,signal:AbortSignal.timeout(3_600_000)});
 if(!r.ok)throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0,200)}`);
 return await r.json() as T;
}
if(token)csrf=(await call<{csrf:string}>('/api/auth/session')).csrf;
const fixture=JSON.parse(readFileSync(resolve(import.meta.dir,'../examples/last-order-draft.json'),'utf8')) as {title:string;brief:Record<string,unknown>;language:string;scenes:{id:string;heading:string;content:string}[];expected_findings:{id:string;dimensions:string[];keywords:string[];problem:string}[]};
const dir=resolve(process.env.SCIEPO_SMOKE_ARTIFACT_DIR??resolve(import.meta.dir,`../artifacts/review-fixture-${new Date().toISOString().replace(/[:.]/g,'-')}`));
mkdirSync(dir,{recursive:true,mode:0o700});
const p=await call<ProjectBundle>('/api/projects',{...fixture.brief,format:'vertical_short_drama',language:fixture.language});
const e=p.episodes[0]!;
// The demo generation gives the episode a first revision; the fixture replaces its scenes as an author edit.
const demo=await call<Revision>(`/api/episodes/${e.id}/generate`,{mode:'demo'});
const draft=await call<Revision>(`/api/revisions/${demo.id}/edit`,{title:fixture.title,logline:'',scenes:fixture.scenes.map(s=>({...s,locked:false}))});
const review=await call<Review>(`/api/revisions/${draft.id}/review`,{mode:'live'});
writeFileSync(resolve(dir,'review.json'),JSON.stringify(review,null,2));
const raised=[...review.assessments.filter(a=>a.status==='issue').map(a=>({dimension:a.dimension as string,text:`${a.explanation} ${a.suggestedFix??''} ${a.evidence.map(x=>x.draftQuote).join(' ')}`})),
 ...(review.causality?.checks??[]).filter(c=>c.verdict==='gap').map(c=>({dimension:'story',text:`${c.explanation} ${c.alternative} ${c.evidence.map(x=>x.draftQuote).join(' ')}`})),
 ...(review.causality?.pressures??[]).filter(c=>c.verdict==='gap').map(c=>({dimension:'story',text:`${c.explanation} ${c.directAlternative}`}))];
const report=fixture.expected_findings.map(f=>({id:f.id,found:raised.some(r=>f.dimensions.includes(r.dimension)&&f.keywords.every(k=>r.text.toLowerCase().includes(k.toLowerCase())))}));
writeFileSync(resolve(dir,'findings.json'),JSON.stringify({reviewId:review.id,status:review.status,report},null,2));
for(const r of report)console.log(`${r.found?'found ':'MISSED'} ${r.id}`);
console.log(`${report.filter(r=>r.found).length} of ${report.length} expected findings raised. Review saved in ${dir}.`);
