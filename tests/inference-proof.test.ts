import {expect,test} from 'bun:test';
import {inferenceTargets,inferenceGaps,parseInferenceProofs,constrainInference,type InferenceProof} from '../src/core/inferenceProof';
import type {VerificationFieldTarget,VerificationCheck} from '../src/core/reviewVerification';
const quote={sourceId:'scene:s1',quote:'One worker needs 90 minutes.',sourceRef:'line:scene%3As1:1'};
const field:VerificationFieldTarget={id:'pressure:0#explanation',parentId:'pressure:0',field:'explanation',sceneIds:['s1'],claim:'One worker needs 90 minutes, so two workers cannot finish in 45.',fullClaim:'One worker needs 90 minutes, so two workers cannot finish in 45.',start:0,end:62};
const base:InferenceProof={targetId:field.id,scope:'fact',capacity:{workers:'different',basis:'conditional',taskAndClock:'matched',parallelism:'unknown',evidence:[quote],bridgeEvidence:[]},missingPremises:[],counterexamplePossible:false,explanation:'The tasks may or may not be parallel.'};
const check:VerificationCheck={targetId:field.id,verdict:'supported',explanation:'An overconfident auditor accepted the arithmetic.',evidence:[quote],counterEvidence:[]};
test('different staffing cannot inherit single-worker duration without a bridge, in either direction',()=>{
 for(const claim of [field.claim,'Two workers always finish twice as fast.']){
  const f={...field,claim,fullClaim:claim};const result=constrainInference([check],[f],inferenceTargets([f]),[base]);
  expect(result[0]!.verdict).toBe('unsupported');expect(result[0]!.claimQuote).toBe(claim);expect(check.verdict).toBe('supported');
 }
 expect(inferenceGaps({...base,capacity:{...base.capacity!,parallelism:'explicit',bridgeEvidence:[]}})).not.toHaveLength(0);
});
test('a program restriction does not repeat an unverified model explanation as its own conclusion',()=>{
 const misleading={...base,explanation:'Two workers objectively cannot finish. This is an unverified model interpretation.'};
 const result=constrainInference([check],[field],inferenceTargets([field]),[misleading])[0]!;
 expect(result.verdict).toBe('unsupported');expect(result.explanation).not.toContain(misleading.explanation);
 expect(result.explanation).toContain('另存供对照');expect(misleading.explanation).toContain('objectively cannot');
});
test('explicit serial bottleneck / explicit parallel division can support a conditional comparison',()=>{
 for(const text of ['The only sorter admits one worker at a time.','Each worker processes an independent identical half.']){
  const p={...base,capacity:{...base.capacity!,parallelism:'explicit' as const,bridgeEvidence:[{...quote,quote:text}]}};
  expect(inferenceGaps(p)).toEqual([]);expect(constrainInference([check],[field],inferenceTargets([field]),[p])[0]).toEqual(check);
 }
});
test('chosen output is not a hard capacity and an unknown clock cannot support a calculation',()=>{
 expect(inferenceGaps({...base,capacity:{...base.capacity!,basis:'chosen_output',workers:'same'}}).join(' ')).toContain('上限');
 expect(inferenceGaps({...base,capacity:{...base.capacity!,workers:'same',taskAndClock:'unknown'}}).join(' ')).toContain('时钟');
});
test('an observed output is allowed without converting it into a capacity ceiling',()=>{
 const p={...base,capacity:{...base.capacity!,claimKind:'observation' as const,basis:'chosen_output' as const}};
 expect(inferenceGaps(p)).toEqual([]);
 expect(inferenceGaps({...p,capacity:{...p.capacity,claimKind:'limit'}})).not.toHaveLength(0);
});
const obj:InferenceProof={targetId:field.id,scope:'fact',object:{needs:['identity','completed_action'],claimTerms:[],sourceTerms:[],nounMatch:'faithful',identity:'unknown',state:'proposed',locationRelation:'not_needed',identityEvidence:[],actionEvidence:[],locationEvidence:[]},missingPremises:[],counterexamplePossible:false,explanation:'Two containers have no explicit identity bridge.'};
test('same experiment is not same object, and a destination proposal is not a completed move',()=>{
 expect(inferenceGaps(obj)).toHaveLength(2);
 expect(inferenceGaps({...obj,object:{...obj.object!,identity:'explicit_link',identityEvidence:[quote]}})).toHaveLength(1);
 expect(inferenceGaps({...obj,object:{...obj.object!,identity:'explicit_link',identityEvidence:[quote],state:'shown',actionEvidence:[quote]}})).toEqual([]);
});
test('different place names without proven separation cannot produce a definite contradiction',()=>{
 const f={...field,claim:'The terrarium was placed on the wrong bench.',fullClaim:'The terrarium was placed on the wrong bench.'};
 const p={...obj,targetId:field.id+':object',object:{...obj.object!,needs:['separate_locations' as const],locationRelation:'unknown' as const}};
 const result=constrainInference([{...check,verdict:'contradicted',correction:'Move it.',counterEvidence:[quote]}],[f],inferenceTargets([f]),[p]);
 expect(result[0]!.verdict).toBe('unsupported');expect(result[0]!.counterEvidence).toEqual([]);
});
test('ordinary optional action and explicitly acknowledged unknowns are not automatically rejected',()=>{
 expect(inferenceGaps({...obj,scope:'uncertainty'})).toEqual([]);
 expect(inferenceGaps({...obj,scope:'option',object:{...obj.object!,needs:[]}})).toEqual([]);
 expect(inferenceGaps({...base,scope:'attribution'})).toEqual([]);
});
test('proof coverage, unique IDs, enums and frozen source references are required',()=>{
 const targets=inferenceTargets([field]),bind=(v:unknown)=>Array.isArray(v)&&v.every(x=>x===quote)?v:undefined;
 expect(parseInferenceProofs([base],targets,bind).errors).toEqual([]);
 for(const value of [undefined,[],[base,base],[{...base,targetId:'wrong'}],[{...base,scope:'guaranteed'}],[{...base,capacity:{...base.capacity!,evidence:[{refId:'R9999'}]}}]])expect(parseInferenceProofs(value,targets,bind).errors.length).toBeGreaterThan(0);
});
test('object proof field placement can normalize without inventing missing facts, but two encodings cannot shadow each other',()=>{
 const f={...field,claim:'实验箱在干燥库。',fullClaim:'实验箱在干燥库。'},targets=inferenceTargets([f]);
 const nested={...obj,targetId:targets[0]!.id,object:{...obj.object!,claimTerms:['实验箱'],sourceTerms:['brood trays'],nounMatch:'changed' as const}};
 const {object,...rest}=nested;const flat={...rest,...object};const bind=(v:unknown)=>Array.isArray(v)?v:undefined;
 const a=parseInferenceProofs([nested],targets,bind),b=parseInferenceProofs([flat],targets,bind);
 expect(a.errors).toEqual([]);expect(b.proofs).toEqual(a.proofs);expect(inferenceGaps(b.proofs[0]!)).not.toHaveLength(0);
 expect(parseInferenceProofs([{...flat,object}],targets,bind).errors).not.toHaveLength(0);
 const unbound=parseInferenceProofs([{...flat,claimTerms:['另一箱']}],targets,bind,()=>false);
 expect(unbound.errors).toEqual([]);expect(unbound.proofs[0]!.bindingIssues).toHaveLength(2);
 expect(inferenceGaps(unbound.proofs[0]!).join(' ')).toContain('未能');
});
test('an unrecognized object prerequisite remains visible and cannot silently grant support',()=>{
 expect(inferenceGaps({...obj,object:{...obj.object!,needs:['locationRelation']}}).join(' ')).toContain('locationRelation');
});
test('an omitted subject can bind to the same full field only with an explicit cited identity link',()=>{
 const f={...field,claim:'最终放到了南侧工作台。',fullClaim:'A7托盘装入运输箱，最终放到了南侧工作台。'},targets=inferenceTargets([f]);
 const proof={...obj,targetId:targets[0]!.id,object:{...obj.object!,claimTerms:['A7托盘','南侧工作台'],sourceTerms:['A7 tray','south bench'],needs:['completed_action'],identity:'explicit_link' as const,state:'shown' as const,identityEvidence:[quote],actionEvidence:[quote]}};
 const bind=(v:unknown)=>Array.isArray(v)?v:undefined;
 const parsed=parseInferenceProofs([proof],targets,bind,()=>true);
 expect(parsed.errors).toEqual([]);expect(inferenceGaps(parsed.proofs[0]!)).toEqual([]);expect(targets[0]!.claim).toBe(f.claim);
 for(const object of [{...proof.object,identityEvidence:[]},{...proof.object,identity:'same_mention'},{...proof.object,claimTerms:['B8托盘','南侧工作台']}]){
  const rejected=parseInferenceProofs([{...proof,object}],targets,bind,()=>true);
  expect(rejected.errors).toEqual([]);expect(rejected.proofs[0]!.bindingIssues?.length).toBeGreaterThan(0);
 }
});
test('full-field grouping preserves context and every segment, and proof only lowers confidence',()=>{
 const fields=[{...field,id:field.id+'@0:10',claim:field.claim.slice(0,10),end:10},{...field,id:field.id+'@10:62',claim:field.claim.slice(10),start:10}];
 const groups=inferenceTargets(fields);expect(groups).toHaveLength(1);expect(groups[0]!.claim).toBe(field.fullClaim);expect(groups[0]!.fieldIds).toHaveLength(2);
 const negative={...check,verdict:'unsupported' as const,correction:'Keep unknown.'};expect(constrainInference([negative],[field],inferenceTargets([field]),[{...base,scope:'unrelated'}])[0]).toEqual(negative);
});
