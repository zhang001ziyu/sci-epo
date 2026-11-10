import type { Review } from '../types';
import { inferenceTargets, inferenceGaps, parseInferenceProofs } from './inferenceProof';
import { verificationFieldTargets, type OmissionCheck, type TimelineFact, type VerificationCheck, type VerificationQuote } from './reviewVerification';
const meaningLabels={subject:'',activity:'',durationKind:'',clock:'',basis:''};
const omissionLabels={timeline:'',accounting:'',agency:'',continuity:'',other:''};

const verdictRank:Record<VerificationCheck['verdict'],number>={supported:0,uncertain:1,unsupported:2,contradicted:3};
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
export function timelineAddress(targetId:unknown):{sceneId:string;line:string}|undefined {
 if(typeof targetId!=='string')return;
 const match=/^timeline:([^:]+):([1-9]\d*)$/.exec(targetId);if(!match)return;
 try{const sceneId=decodeURIComponent(match[1]!);return nonempty(sceneId)?{sceneId,line:match[2]!}:undefined;}catch{return;}
}
export function timelineRecords(review:Review):{state:'missing'|'unbound'|'invalid'|'valid';facts:TimelineFact[]} {
 const rows:unknown=review.verification?.timelineFacts;
 if(!Array.isArray(rows))return {state:'missing',facts:[]};
 const seen=new Set<string>();let unbound=false;
 for(const row of rows){
  if(!row||typeof row!=='object'||!timelineAddress(row.targetId)||seen.has(row.targetId)
   ||!['consistent','conflict','uncertain'].includes(row.status)||!nonempty(row.explanation)
   ||!row.meaning||typeof row.meaning!=='object'||Object.keys(meaningLabels).some(key=>!nonempty(row.meaning[key]))
   ||!validQuotes(row.evidence)||!row.evidence.length)return {state:'invalid',facts:[]};
  if(row.boundSource===undefined)unbound=true;
  else if(!validQuote(row.boundSource)
   ||row.boundSource.sourceId!==`scene:${timelineAddress(row.targetId)!.sceneId}`
   ||!row.evidence.some((e:{sourceId:string;quote:string})=>e.sourceId===row.boundSource.sourceId&&e.quote===row.boundSource.quote))return {state:'invalid',facts:[]};
  seen.add(row.targetId);
 }
 return unbound?{state:'unbound',facts:[]}:{state:'valid',facts:rows as TimelineFact[]};
}
function targetIds(review:Review):string[] {
 return [...review.assessments.map(a=>`assessment:${a.dimension}`),...(review.causality?.checks.map((_,i)=>`causal:${i}`)??[]),...(review.causality?.pressures?.map((_,i)=>`pressure:${i}`)??[])];
}
/** Shared enumeration prevents browser and server authorization from drifting. */
export function fieldTargets(review:Review){
 const facts=review.verification;
 // Preserve time claims in coverage. Malformed legacy rows may be displayed, but
 // cannot supply trusted targets; auditIntact checks the complete source arrays.
 const safeFacts=facts?{...facts,timelineFacts:Array.isArray(facts.timelineFacts)?facts.timelineFacts.filter(f=>f&&typeof f==='object'&&!Array.isArray(f)):[],
  omissions:Array.isArray(facts.omissions)?facts.omissions.filter(o=>o&&typeof o==='object'&&Array.isArray(o.sceneIds)):[]}:undefined;
 try{return verificationFieldTargets(review,safeFacts);}catch{return [];}
}
function verificationCheck(review:Review,targetId:string) {
 const checks=review.verification?.checks;
 if(!Array.isArray(checks))return;
 const matches=checks.filter(c=>c?.targetId===targetId);
 return matches.length===1?matches[0]:undefined;
}
function validQuote(value:unknown):value is VerificationQuote {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const e=value as VerificationQuote;
 if(!nonempty(e.sourceId)||!nonempty(e.quote))return false;
 if(e.modelQuote!==undefined&&(!nonempty(e.modelQuote)||e.modelQuote===e.quote||e.modelQuote.replace(/\s+/gu,' ')!==e.quote.replace(/\s+/gu,' ')))return false;
 if(e.sourceRef!==undefined){
  if(!nonempty(e.sourceRef)||e.modelQuote!==undefined)return false;
  const match=/^line:([^:]+):([1-9]\d*)$/.exec(e.sourceRef);
  if(!match||!Number.isSafeInteger(Number(match[2])))return false;
  try{if(decodeURIComponent(match[1]!)!==e.sourceId||encodeURIComponent(e.sourceId)!==match[1])return false;}catch{return false;}
 }
 return true;
}
function validQuotes(value:unknown):value is VerificationCheck['evidence'] {
 return Array.isArray(value)&&value.every(validQuote);
}
export function validOmission(value:unknown):value is OmissionCheck {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const o=value as OmissionCheck;
 return Object.hasOwn(omissionLabels,o.category)&&['no_issue','issue','uncertain','not_applicable'].includes(o.status)&&nonempty(o.explanation)
  &&Array.isArray(o.sceneIds)&&o.sceneIds.length>0&&o.sceneIds.every(nonempty)&&validQuotes(o.evidence)&&o.evidence.length>0
  &&(o.suggestedFix===undefined||nonempty(o.suggestedFix))&&(o.status!=='issue'||nonempty(o.suggestedFix))
  &&(o.suggestedSceneId===undefined||nonempty(o.suggestedSceneId));
}
export function validAuditCheck(value:unknown):value is VerificationCheck {
 if(!value||typeof value!=='object')return false;
 const c=value as VerificationCheck;
 return nonempty(c.targetId)&&['supported','contradicted','unsupported','uncertain'].includes(c.verdict)&&nonempty(c.explanation)
  &&validQuotes(c.evidence)&&c.evidence.length>0&&validQuotes(c.counterEvidence)
  &&(c.verdict!=='contradicted'||c.counterEvidence.length>0)&&(c.correction===undefined||nonempty(c.correction))&&(c.verdict==='supported'||nonempty(c.correction));
}
export function auditCheck(review:Review,targetId:string):VerificationCheck|undefined {
 const checks=review.verification?.audit?.checks;if(!Array.isArray(checks))return;
 const matches=checks.filter(c=>c?.targetId===targetId);
 return matches.length===1&&validAuditCheck(matches[0])?matches[0]:undefined;
}
function checkIndex(value:unknown,ids:string[]):Map<string,VerificationCheck>|undefined {
 if(!Array.isArray(value)||value.some(c=>!validAuditCheck(c)))return;
 const byId=new Map(value.map(c=>[c.targetId,c as VerificationCheck]));
 return value.length===ids.length&&byId.size===ids.length&&ids.every(id=>byId.has(id))?byId:undefined;
}
function sameCheck(left:VerificationCheck|undefined,right:VerificationCheck|undefined):boolean {
 if(!validAuditCheck(left)||!validAuditCheck(right))return false;
 const fields=(c:VerificationCheck)=>[c.targetId,c.verdict,c.explanation,c.correction??null,c.claimQuote??null,c.evidence?.map(e=>[e.sourceId,e.quote,e.modelQuote??null,e.sourceRef??null]),c.counterEvidence?.map(e=>[e.sourceId,e.quote,e.modelQuote??null,e.sourceRef??null])];
 return JSON.stringify(fields(left))===JSON.stringify(fields(right));
}
export function auditIntact(review:Review):boolean {
 const audit=review.verification?.audit;
 if(!audit||audit.schemaVersion!==5||!['completed','needs_review'].includes(audit.status)||!Array.isArray(audit.errors)||audit.errors.length)return false;
 if(timelineRecords(review).state!=='valid'||!Array.isArray(review.verification?.omissions)||review.verification.omissions.some(o=>!validOmission(o)))return false;
 const originalIds=targetIds(review),ids=[...originalIds,...timelineRecords(review).facts.map(f=>f.targetId),...Object.keys(omissionLabels).map(category=>`omission:${category}`)];
 const fields=fieldTargets(review),byId=checkIndex(audit.checks,ids),originals=checkIndex(audit.originalChecks,ids),children=checkIndex(audit.fieldChecks,fields.map(f=>f.id));
 if(new Set(ids).size!==ids.length||!fields.length||fields.some(f=>!nonempty(f.claim))||!byId||!originals||!children)return false;
 if(audit.inferenceChecks!==undefined){
  const expected=inferenceTargets(fields),proofs=audit.inferenceChecks;
  if(!Array.isArray(proofs)||proofs.length!==expected.length||expected.some(t=>proofs.filter(p=>p.targetId===t.id).length!==1))return false;
  if(parseInferenceProofs(proofs,expected,value=>validQuotes(value)?value:undefined).errors.length)return false;
  try{if(expected.some(t=>inferenceGaps(proofs.find(p=>p.targetId===t.id)!).length&&t.fieldIds.some(id=>children.get(id)?.verdict==='supported')))return false;}catch{return false;}
 }
 if(fields.some(field=>{const child=children.get(field.id)!;return (child.verdict!=='supported'||child.claimQuote!==undefined)&&(!nonempty(child.claimQuote)||!field.claim.includes(child.claimQuote));}))return false;
 return originalIds.every(id=>sameCheck(verificationCheck(review,id),byId.get(id)))&&ids.every(id=>{
  let expected=originals.get(id)!;
  for(const field of fields.filter(f=>f.parentId===id)){
   const child=children.get(field.id)!;
   if(verdictRank[child.verdict]>verdictRank[expected.verdict])expected={...child,targetId:id,explanation:`${field.field} 字段核实：${child.explanation}`,...(child.correction?{correction:`${field.field}：${child.correction}`}:{})};
  }
  return sameCheck(expected,byId.get(id));
 });
}
export function auditedFactSupported(review:Review,targetId:string):boolean {
 return auditIntact(review)&&auditCheck(review,targetId)?.verdict==='supported';
}
export function verificationIntact(review:Review):boolean {
 const v=review.verification;
 if(!v||!['completed','needs_review'].includes(v.status)||!Array.isArray(v.errors)||v.errors.length||!Array.isArray(v.checks)||!Array.isArray(v.omissions)||timelineRecords(review).state!=='valid')return false;
 if(v.checks.some(c=>!validAuditCheck(c)))return false;
 const ids=targetIds(review);
 if(v.checks.length!==ids.length||ids.some(id=>!verificationCheck(review,id)))return false;
 if(v.omissions.length!==Object.keys(omissionLabels).length||v.omissions.some(o=>!validOmission(o)))return false;
 return Object.keys(omissionLabels).every(category=>v.omissions.filter(o=>o.category===category).length===1);
}
export function reviewTargetSupported(review:Review,targetId:string):boolean {
 return verificationIntact(review)&&auditIntact(review)&&verificationCheck(review,targetId)?.verdict==='supported'&&auditCheck(review,targetId)?.verdict==='supported';
}
/** Resolve suggestions from the current record, never from stale or edited DOM text. */
export function reviewSuggestion(review:Review|undefined,reviewId:string|undefined,targetId:string|undefined,sceneId:string|undefined):{sceneId:string;instruction:string}|undefined {
 if(!review||review.id!==reviewId||!targetId||!sceneId||!(verificationIntact(review)&&auditIntact(review)&&auditCheck(review,targetId)?.verdict==='supported'))return;
 if(review.errors.length||review.causality?.errors.length)return;
 // A real problem elsewhere is not permission to apply a bad suggestion, nor a veto on a separately grounded repair.
 const fields=fieldTargets(review).filter(f=>f.parentId===targetId);
 if(!fields.some(f=>f.field==='suggestedFix')||!fields.some(f=>f.field==='suggestedSceneId')||fields.some(f=>review.verification!.audit!.fieldChecks.find(c=>c.targetId===f.id)?.verdict!=='supported'))return;
 let suggestion:string|undefined,sourceScene:string|undefined;
 if(targetId.startsWith('assessment:')){
  const a=review.assessments.find(a=>`assessment:${a.dimension}`===targetId);suggestion=a?.suggestedFix;sourceScene=a?.suggestedSceneId;
 }else if(targetId.startsWith('causal:')){
  const c=review.causality?.checks.find((_,i)=>`causal:${i}`===targetId);suggestion=c?.suggestedFix;sourceScene=c?.suggestedSceneId;
 }else if(targetId.startsWith('omission:')){
  const o=review.verification!.omissions.find(o=>`omission:${o.category}`===targetId);
  if(o?.status!=='issue'||!o.sceneIds.includes(sceneId))return;
  suggestion=o.suggestedFix;sourceScene=o.suggestedSceneId;
 }else if(targetId.startsWith('pressure:')){
  const p=review.causality?.pressures?.find((_,i)=>`pressure:${i}`===targetId);suggestion=p?.suggestedFix;sourceScene=p?.suggestedSceneId;
 }
 const scope=review.verification!.audit!.fieldChecks.find(c=>c.targetId===`${targetId}#suggestedSceneId`);
 return suggestion&&sourceScene===sceneId&&scope?.evidence.some(e=>e.sourceId===`scene:${sceneId}`)?{sceneId,instruction:suggestion}:undefined;
}
export function verificationIssueCount(review:Review):number {
 const v=review.verification;if(!v)return 1;
 const errors=new Set([...(Array.isArray(v.errors)?v.errors:['核实错误记录缺失']),...(Array.isArray(v.audit?.errors)?v.audit.errors:[])]).size;
 const claims=targetIds(review).filter(id=>verificationCheck(review,id)?.verdict!=='supported'||(v.audit&&auditCheck(review,id)?.verdict!=='supported')).length;
 const factProblem=(id:string,problem:boolean)=>v.audit?auditCheck(review,id)?.verdict!=='supported'||problem&&auditedFactSupported(review,id):false;
 const omissions=Array.isArray(v.omissions)?v.omissions.filter(o=>!validOmission(o)||factProblem(`omission:${o.category}`,o.status==='issue'||o.status==='uncertain')).length:1;
 const timeline=timelineRecords(review);
 const timeIssues=timeline.state==='valid'?timeline.facts.filter(f=>factProblem(f.targetId,f.status!=='consistent')).length:1;
 const count=errors+claims+omissions+timeIssues;
 return count||(!verificationIntact(review)||!auditIntact(review)||v.audit?.status!=='completed'||v.status!=='completed'?1:0);
}
export function reviewIssueCount(review:Review,lengthProblem=false):number {
 const issues=review.assessments.filter(a=>reviewTargetSupported(review,`assessment:${a.dimension}`)&&['issue','uncertain'].includes(a.status)).length
  +(review.causality?.checks.filter((c,i)=>reviewTargetSupported(review,`causal:${i}`)&&['gap','uncertain'].includes(c.verdict)).length??0)
  +(review.causality?.pressures?.filter((p,i)=>reviewTargetSupported(review,`pressure:${i}`)&&['gap','uncertain'].includes(p.verdict)).length??0);
 const otherErrors=review.errors.filter(e=>!review.verification?.errors?.includes(e)&&!review.verification?.audit?.errors?.includes(e)).length;
 return issues+verificationIssueCount(review)+otherErrors+Number(lengthProblem);
}
export function reviewCompletionLabel(review:Review):string {
 if(!review.verification)return review.mode==='demo'?'演示记录未核实解释':'旧审稿未核实解释';
 if(!review.verification.audit)return '旧审稿尚未完成独立解释审计';
 if(review.verification.audit.schemaVersion!==5)return '旧审计尚未逐句核对复合陈述';
 return review.status==='completed'&&verificationIssueCount(review)===0?'本次审读与解释核对已完成':'本次审读需复核';
}
