import { expect, test } from 'bun:test';
import type { Review } from '../src/types';
import { verificationFieldTargets, type ReviewVerification } from '../src/core/reviewVerification';
import { fieldTargets } from '../src/core/reviewSuggestions';
import { assessmentView, causalityView, reviewCompletionLabel, reviewIssueCount, reviewSuggestion, reviewTargetSupported, verificationIssueCount, verificationView } from '../web/quality';

const quote={sourceId:'scene:s1',quote:'The first five days ran automated.'};
function fixture():Review {
 const rv:Review={id:'review-current',revisionId:'revision-5',mode:'live',createdAt:'2026-11-06T00:00:00Z',status:'completed',errors:[],assessments:[
  {dimension:'story',status:'no_issue',explanation:'The first five days were automated.',evidence:[{sourceId:quote.sourceId,sourceQuote:quote.quote,sceneId:'s1',draftQuote:quote.quote}]},
  {dimension:'dialogue',status:'issue',issueType:'craft_preference',explanation:'The request is repeated.',suggestedFix:'Remove only the repeated request.',suggestedSceneId:'s1',evidence:[{sourceId:quote.sourceId,sourceQuote:quote.quote,sceneId:'s1',draftQuote:quote.quote}]}
 ],causality:{status:'completed',errors:[],checks:[{sceneId:'s1',state:'The first five days were automated.',choice:'Refuse another shift.',obstacleKind:'emotional',alternative:'Accept another shift.',verdict:'supported',explanation:'He can choose to decline another job.',suggestedFix:'Clarify the new choice while preserving the automated period.',suggestedSceneId:'s1',evidence:[{sourceId:quote.sourceId,sourceQuote:quote.quote,sceneId:'s1',draftQuote:quote.quote}],constraintEvidence:[quote]}],pressures:[{sceneId:'s1',trigger:'A delivery deadline.',threatenedOutcome:'Whole lot delivered.',currentState:'Part is already graded.',directAlternative:'Ship the graded part.',verdict:'background',explanation:'Partial delivery remains possible.',suggestedFix:'Keep the deadline separate from the partial-delivery choice.',suggestedSceneId:'s1',evidence:[{sourceId:quote.sourceId,sourceQuote:quote.quote,sceneId:'s1',draftQuote:quote.quote}],blockingEvidence:[quote]}]}};
 const verification:ReviewVerification={status:'completed',errors:[],timelineFacts:[{targetId:'timeline:s1:1',boundSource:{sourceId:'scene:s1',quote:'The first five days ran automated.'},status:'consistent',meaning:{subject:'The automation system',activity:'The first five days',durationKind:'Automatic operation',clock:'Inside clock',basis:'Shown in the scene'},explanation:'The duration describes automation, not manual labor.',evidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}]}],checks:['assessment:story','assessment:dialogue','causal:0','pressure:0'].map(targetId=>({targetId,verdict:'supported',explanation:'Claim checked.',evidence:[quote],counterEvidence:[]})),omissions:['timeline','accounting','agency','continuity','other'].map(category=>({category:category as ReviewVerification['omissions'][number]['category'],status:'no_issue',explanation:'Compared with the whole scene.',sceneIds:['s1'],evidence:[quote]}))};
 rv.verification=verification;
 const checks=[...verification.checks,...[...verification.timelineFacts.map(f=>f.targetId),...verification.omissions.map(o=>`omission:${o.category}`)].map(targetId=>({targetId,verdict:'supported' as const,explanation:'Independent source-grounded audit.',evidence:[quote],counterEvidence:[]}))];
 verification.audit={schemaVersion:5,status:'completed',errors:[],checks,originalChecks:[...checks],fieldChecks:verificationFieldTargets(rv,rv.verification).map(t=>({targetId:t.id,verdict:'supported',explanation:'This complete field is supported.',evidence:[quote],counterEvidence:[]}))};
 rv.verification=verification;return rv;
}
function syncFields(rv:Review):void {
 const audit=rv.verification!.audit!,prior=new Map(audit.fieldChecks.map(c=>[c.targetId,c]));
 audit.fieldChecks=verificationFieldTargets(rv,rv.verification).map(t=>prior.get(t.id)??{targetId:t.id,verdict:'supported',explanation:'The full field is supported.',evidence:[quote],counterEvidence:[]});
}
function rejectField(rv:Review,id:string):void {
 const target=verificationFieldTargets(rv,rv.verification).find(t=>t.id===id)!,audit=rv.verification!.audit!,child=audit.fieldChecks.find(c=>c.targetId===id)!;
 Object.assign(child,{verdict:'unsupported',claimQuote:target.claim,explanation:'The selected change introduces an unsupported claim.',correction:'Keep established facts and remove only the unsupported qualifier.'});
 const parent={...child,targetId:target.parentId,explanation:`${target.field} 字段核实：${child.explanation}`,correction:`${target.field}：${child.correction}`};
 audit.checks[audit.checks.findIndex(c=>c.targetId===parent.targetId)]=parent;
 const i=rv.verification!.checks.findIndex(c=>c.targetId===parent.targetId);if(i>=0)rv.verification!.checks[i]=parent;
 audit.status='needs_review';rv.verification!.status='needs_review';rv.status='needs_review';
}
const suggestionTargets=['assessment:dialogue','causal:0','pressure:0','omission:timeline'] as const;
function multiClauseSuggestion(targetId:typeof suggestionTargets[number]) {
 const rv=fixture(),suggestion='Remove only the repeated request, preserve the automated period.';
 const item=targetId==='assessment:dialogue'?rv.assessments[1]!:targetId==='causal:0'?rv.causality!.checks[0]!:targetId==='pressure:0'?rv.causality!.pressures![0]!:rv.verification!.omissions[0]!;
 Object.assign(item,{suggestedFix:suggestion,suggestedSceneId:'s1'});
 if(targetId==='omission:timeline')rv.verification!.omissions[0]!.status='issue';
 syncFields(rv);
 const fields=verificationFieldTargets(rv,rv.verification).filter(f=>f.parentId===targetId&&f.field==='suggestedFix');
 return {rv,suggestion,fields,wholeId:`${targetId}#suggestedFix`,parts:fields.filter(f=>f.claim!==f.fullClaim)};
}
function suggestionViews(rv:Review):string {
 return assessmentView(rv,rv.assessments[1]!)+causalityView(rv)+verificationView(rv);
}

test('a contradicted positive review is quarantined, with correction visible and original collapsed',()=>{
 const rv=fixture(),c=rv.verification!.checks[0]!;rv.assessments[0]!.explanation='He continuously worked ten days.';
 Object.assign(c,{verdict:'contradicted',explanation:'Elapsed time is not manual labor.',correction:'Ten days elapsed; exact manual hours are unknown.',counterEvidence:[quote]});
 rv.verification!.status='needs_review';rv.status='needs_review';
 const html=assessmentView(rv,rv.assessments[0]!);
 expect(html).toContain('class="assessment uncertain"');
 expect(html).toContain('审稿说法与原文冲突');
 expect(html.indexOf('Ten days elapsed')).toBeLessThan(html.indexOf('original-review'));
 expect(html.indexOf('He continuously worked ten days.')).toBeGreaterThan(html.indexOf('original-review'));
 expect(html).not.toContain('data-action="use-suggestion"');
 expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');
});

test('causal and pressure suggestions with invalid premises cannot enter rewrite',()=>{
 const rv=fixture();rv.causality!.checks[0]!.suggestedFix='Invent a rest lock.';
 for(const c of rv.verification!.checks.slice(2))Object.assign(c,{verdict:'unsupported',explanation:'The premise is not established.',correction:'The available alternative remains possible.'});
 const html=causalityView(rv);
 expect(html.match(/original-review/g)).toHaveLength(2);
 expect(html).not.toContain('class="assessment no_issue"');
 expect(html).not.toContain('data-action="use-suggestion"');
 expect(reviewSuggestion(rv,rv.id,'causal:0','s1')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'pressure:0','s1')).toBeUndefined();
 expect(html).toContain('Invent a rest lock.'); // retained only in historical trace
});

test('a supported suggestion resolves from current record and rejects stale IDs or changed trust',()=>{
 const rv=fixture();
 const html=assessmentView(rv,rv.assessments[1]!);
 expect(html).toContain('data-review-id="review-current"');expect(html).toContain('data-target="assessment:dialogue"');
 expect(html).not.toContain('data-instruction=');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toEqual({sceneId:'s1',instruction:rv.assessments[1]!.suggestedFix!});
 expect(reviewSuggestion(rv,'previous-review','assessment:dialogue','s1')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','wrong-scene')).toBeUndefined();
 rv.verification!.checks[1]!.verdict='uncertain';
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
});

test('cross-scene evidence never substitutes for the explicitly audited edit scene',()=>{
 const rv=fixture(),item=rv.assessments[1]!;
 const evidence=(sceneId:string,text:string)=>({sceneId,sourceId:`scene:${sceneId}`,sourceQuote:text,draftQuote:text});
 item.evidence=[evidence('s3','The later request was already answered.'),evidence('s2','Please deliver it. Please deliver it.')];
 item.suggestedSceneId='s2';
 rv.verification!.audit!.fieldChecks.find(c=>c.targetId==='assessment:dialogue#suggestedSceneId')!.evidence=[{sourceId:'scene:s2',quote:'Please deliver it. Please deliver it.'}];
 const html=assessmentView(rv,item);
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s2')).toEqual({sceneId:'s2',instruction:item.suggestedFix!});
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s3')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 expect(html).toContain('data-target="assessment:dialogue" data-scene="s2"');
 expect(html).not.toContain('data-target="assessment:dialogue" data-scene="s3"');
});

test('all suggestion kinds require an explicit supported scope and cannot infer missing or mismatched edit targets',()=>{
 for(const targetId of ['assessment:dialogue','causal:0','pressure:0','omission:timeline']){
  const prepare=()=>{
   const rv=fixture();Object.assign(rv.verification!.omissions[0]!,{status:'issue',suggestedFix:'Clarify the clock in this scene.',suggestedSceneId:'s1'});syncFields(rv);
   const item=targetId==='assessment:dialogue'?rv.assessments[1]!:targetId==='causal:0'?rv.causality!.checks[0]!:targetId==='pressure:0'?rv.causality!.pressures![0]!:rv.verification!.omissions[0]!;
   return {rv,item};
  };
  const {rv:baseline}=prepare();expect(reviewSuggestion(baseline,baseline.id,targetId,'s1')).toBeDefined();
  for(const change of ['missing','empty','not-a-scene','unaudited','wrong-evidence','rejected']){
   const {rv,item}=prepare(),audit=rv.verification!.audit!;
   if(change==='missing'){delete item.suggestedSceneId;syncFields(rv);}
   if(change==='empty'){item.suggestedSceneId='';}
   if(change==='not-a-scene'){item.suggestedSceneId='s404';}
   if(change==='unaudited')audit.fieldChecks=audit.fieldChecks.filter(c=>c.targetId!==`${targetId}#suggestedSceneId`);
   if(change==='wrong-evidence')audit.fieldChecks.find(c=>c.targetId===`${targetId}#suggestedSceneId`)!.evidence=[{sourceId:'scene:s3',quote:'Only the consequence appears here.'}];
   if(change==='rejected')rejectField(rv,`${targetId}#suggestedSceneId`);
   const before=JSON.stringify(rv);
   expect(reviewSuggestion(rv,rv.id,targetId,'s1')).toBeUndefined();
   expect(reviewSuggestion(rv,rv.id,targetId,'s404')).toBeUndefined();
   expect(assessmentView(rv,rv.assessments[1]!)+causalityView(rv)+verificationView(rv)).not.toContain(`data-target="${targetId}" data-scene="s1"`);
   expect(JSON.stringify(rv)).toBe(before);
  }
 }
});

test('legacy complete records are visibly unverified without being mutated',()=>{
 const rv=fixture();delete rv.verification;const before=JSON.stringify(rv);
 expect(reviewCompletionLabel(rv)).toBe('旧审稿未核实解释');
 expect(verificationView(rv)).toContain('旧审稿未核实解释');
 expect(assessmentView(rv,rv.assessments[1]!)).toContain('original-review');
 expect(assessmentView(rv,rv.assessments[1]!)).not.toContain('data-action="use-suggestion"');
 expect(verificationIssueCount(rv)).toBeGreaterThan(0);
 expect(JSON.stringify(rv)).toBe(before);
});

test('legacy verification without per-line time coverage cannot provide rewrite suggestions',()=>{
 const rv=fixture();delete (rv.verification as Partial<ReviewVerification>).timelineFacts;const before=JSON.stringify(rv);
 expect(verificationView(rv)).toContain('尚未逐条核对时间陈述');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 expect(assessmentView(rv,rv.assessments[1]!)).not.toContain('data-action="use-suggestion"');
 expect(verificationIssueCount(rv)).toBe(1);expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');
 expect(JSON.stringify(rv)).toBe(before);
});

test('legacy verification without independent claim audit is untrusted without changing saved status',()=>{
 const rv=fixture();delete rv.verification!.audit;const before=JSON.stringify(rv),html=verificationView(rv);
 expect(html).toContain('旧审稿尚未完成独立解释审计');
 expect(html).not.toContain('本次核实未发现未解决项');
 expect(html).toContain('original-verifier');expect(html).toContain('系统绑定原句');
 expect(reviewCompletionLabel(rv)).toBe('旧审稿尚未完成独立解释审计');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 expect(verificationIssueCount(rv)).toBe(1);expect(JSON.stringify(rv)).toBe(before);
});

test('old audit protocols cannot provide rewrite shortcuts or claim new field coverage',()=>{
 for(const schemaVersion of [undefined,1,2,3,4,'5']){
  const rv=fixture();Object.assign(rv.verification!.audit!,{schemaVersion});const before=JSON.stringify(rv);
  expect(verificationView(rv)).toContain('旧审计尚未逐句核对复合陈述');
  expect(reviewCompletionLabel(rv)).toBe('旧审计尚未逐句核对复合陈述');
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationIssueCount(rv)).toBeGreaterThan(0);expect(JSON.stringify(rv)).toBe(before);
 }
});

test('one supported clause cannot authorize an unsupported clause in the same suggested fix',()=>{
 const rv=fixture(),item=rv.assessments[1]!;
 item.suggestedFix='Remove the repeated request, add an unsupported twenty-hour shift.';syncFields(rv);
 const parts=verificationFieldTargets(rv,rv.verification).filter(f=>f.parentId==='assessment:dialogue'&&f.field==='suggestedFix'&&f.claim!==f.fullClaim);
 expect(parts).toHaveLength(2);expect(parts[1]!.claim).toContain('twenty-hour');
 for(const part of parts)expect(part.claim).toBe(part.fullClaim.slice(part.start,part.end));
 // The second clause must be checked independently from the legitimate first clause.
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 const incomplete=structuredClone(rv);incomplete.verification!.audit!.fieldChecks=incomplete.verification!.audit!.fieldChecks.filter(c=>c.targetId!==parts[1]!.id);
 expect(reviewSuggestion(incomplete,incomplete.id,'assessment:dialogue','s1')).toBeUndefined();
 rejectField(rv,parts[1]!.id);
 expect(rv.verification!.audit!.fieldChecks.find(c=>c.targetId===parts[0]!.id)!.verdict).toBe('supported');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'pressure:0','s1')).toBeDefined();
 const html=assessmentView(rv,item);
 expect(html).toContain('本次核对的原文片段');expect(html).toContain(`<mark>${parts[1]!.claim}</mark>`);
 expect(html).toContain('<details class="evidence field-context"><summary>查看完整字段上下文</summary>');
 expect(html).not.toContain('field-context" open');expect(html).not.toContain('data-action="use-suggestion"');
 expect(html.indexOf('<mark>')).toBeLessThan(html.indexOf('original-parent-audit'));
});

test('supported suggested-fix segments cannot authorize a legacy record missing its whole-fix check',()=>{
 for(const targetId of suggestionTargets){
  const {rv,parts,wholeId}=multiClauseSuggestion(targetId),audit=rv.verification!.audit!;
  expect(parts).toHaveLength(2);
  audit.fieldChecks=audit.fieldChecks.filter(c=>c.targetId!==wholeId);
  for(const part of parts)expect(audit.fieldChecks.find(c=>c.targetId===part.id)!.verdict).toBe('supported');
  const before=JSON.stringify(rv),html=suggestionViews(rv);
  expect(reviewSuggestion(rv,rv.id,targetId,'s1')).toBeUndefined();
  expect(html).not.toContain(`data-target="${targetId}" data-scene="s1"`);
  expect(html).toContain('独立解释审计记录不完整或校验未通过');
  expect(JSON.stringify(rv)).toBe(before);
 }
});

test('a rejected whole fix blocks rewrite even when every segment is supported and shows the full result check',()=>{
 for(const targetId of suggestionTargets){
  const {rv,suggestion,parts,wholeId}=multiClauseSuggestion(targetId);
  rejectField(rv,wholeId);
  for(const part of parts)expect(rv.verification!.audit!.fieldChecks.find(c=>c.targetId===part.id)!.verdict).toBe('supported');
  const before=JSON.stringify(rv),html=suggestionViews(rv);
  expect(reviewSuggestion(rv,rv.id,targetId,'s1')).toBeUndefined();
  expect(html).not.toContain(`data-target="${targetId}" data-scene="s1"`);
  expect(html).toContain('<strong>完整改法及修改后结果 · 审稿说法依据不足</strong>');
  expect(html).toContain(`<p class="small">本次核对的完整改法</p><blockquote>${suggestion}</blockquote>`);
  expect(html).not.toContain('本次核对的原文片段');
  expect(html).not.toContain('<mark>');
  expect(html).not.toContain('独立解释审计记录不完整或校验未通过');
  const otherTarget=targetId==='assessment:dialogue'?'pressure:0':'assessment:dialogue';
  expect(reviewSuggestion(rv,rv.id,otherTarget,'s1')).toBeDefined();
  expect(JSON.stringify(rv)).toBe(before);
 }
});

test('a complete supported whole fix and all supported segments authorize only the exact saved suggestion',()=>{
 for(const targetId of suggestionTargets){
  const {rv,suggestion,fields,parts,wholeId}=multiClauseSuggestion(targetId);
  expect(parts).toHaveLength(2);expect(fields).toHaveLength(3);
  const whole=fields.find(f=>f.id===wholeId)!;
  expect(whole).toMatchObject({claim:suggestion,fullClaim:suggestion,start:0,end:suggestion.length});
  expect(parts.map(p=>p.claim).join('')).toBe(suggestion);
  for(const field of fields)expect(rv.verification!.audit!.fieldChecks.find(c=>c.targetId===field.id)!.verdict).toBe('supported');
  const before=JSON.stringify(rv);
  expect(reviewSuggestion(rv,rv.id,targetId,'s1')).toEqual({sceneId:'s1',instruction:suggestion});
  expect(suggestionViews(rv)).toContain(`data-target="${targetId}" data-scene="s1"`);
  expect(JSON.stringify(rv)).toBe(before);
 }
});

test('timeline meaning and explanation segments require coverage and show their rejected claim with full context',()=>{
 const rv=fixture(),fact=rv.verification!.timelineFacts[0]!;
 fact.meaning.activity='A short manual task. Continuous labor for ten days.';
 fact.explanation='The first five days were automated. He never rested during those five days.';syncFields(rv);
 const targets=verificationFieldTargets(rv,rv.verification).filter(t=>t.parentId===fact.targetId);
 for(const field of ['meaning.subject','meaning.activity','meaning.durationKind','meaning.clock','meaning.basis','explanation'])expect(targets.some(t=>t.field===field)).toBe(true);
 expect(targets.filter(t=>t.field==='meaning.activity')).toHaveLength(2);
 expect(targets.filter(t=>t.field==='explanation')).toHaveLength(2);
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 for(const target of targets){
  const missing=structuredClone(rv);missing.verification!.audit!.fieldChecks=missing.verification!.audit!.fieldChecks.filter(c=>c.targetId!==target.id);
  expect(reviewSuggestion(missing,missing.id,'assessment:dialogue','s1')).toBeUndefined();
 }
 const rejected=targets.find(t=>t.field==='meaning.activity'&&t.claim.includes('Continuous'))!;rejectField(rv,rejected.id);
 const html=verificationView(rv),start=html.indexOf('timeline-fact');
 expect(html.slice(start)).toContain('时间陈述的活动');expect(html).toContain(`<mark>${rejected.claim}</mark>`);
 expect(html.indexOf('系统绑定原句')).toBeLessThan(html.indexOf('本次核对的原文片段'));
 expect(html).toContain('original-verifier');expect(html).toContain('查看完整字段上下文');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
});

test('segment excerpts and complete-field context are escaped without rewriting model text',()=>{
 const rv=fixture(),payload='<img src=x onerror="alert(1)">',item=rv.assessments[1]!;
 item.suggestedFix=`Keep the original request. Add ${payload}.`;syncFields(rv);
 const target=verificationFieldTargets(rv,rv.verification).find(t=>t.parentId==='assessment:dialogue'&&t.field==='suggestedFix'&&t.claim!==t.fullClaim&&t.claim.includes(payload))!;
 expect(target.claim).not.toBe(target.fullClaim);rejectField(rv,target.id);
 const before=JSON.stringify(rv),html=assessmentView(rv,item);
 expect(html).toContain('field-context');expect(html).toContain('&lt;img');expect(html).toContain('&quot;alert(1)&quot;');expect(html).not.toContain('<img');
 expect(JSON.stringify(rv)).toBe(before);
});

test('a rejected explanation downgrades the effective parent and keeps the original positive model judgment collapsed',()=>{
 const rv=fixture(),audit=rv.verification!.audit!,child=audit.fieldChecks.find(c=>c.targetId==='causal:0#explanation')!;
 Object.assign(child,{claimQuote:rv.causality!.checks[0]!.explanation,verdict:'unsupported',explanation:'Ten elapsed days do not prove continuous solo labor.',correction:'The manual working hours and rest periods remain unknown.'});
 const merged={...child,targetId:'causal:0',explanation:`explanation 字段核实：${child.explanation}`,correction:`explanation：${child.correction}`};
 audit.checks[audit.checks.findIndex(c=>c.targetId==='causal:0')]=merged;
 rv.verification!.checks[rv.verification!.checks.findIndex(c=>c.targetId==='causal:0')]=merged;
 audit.status='needs_review';
 const before=JSON.stringify(rv),html=causalityView(rv),start=html.indexOf('data-review-target="causal:0"'),section=html.slice(start);
 expect(audit.originalChecks.find(c=>c.targetId==='causal:0')!.verdict).toBe('supported');
 expect(section).toContain('关键陈述逐项核对');expect(section).toContain(child.explanation);expect(section).toContain(child.correction!);
 expect(section.indexOf(child.explanation)).toBeLessThan(section.indexOf('original-parent-audit'));
 expect(section).toContain('<details class="evidence original-parent-audit"><summary>原模型整体判断（逐项核对前）');
 expect(section).not.toContain('original-parent-audit" open');
 expect(section.indexOf('Claim checked.')).toBeGreaterThan(section.indexOf('original-parent-audit'));
 expect(section).not.toContain('data-action="use-suggestion"');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 expect(verificationIssueCount(rv)).toBe(1);expect(reviewIssueCount(rv)).toBe(2);
 expect(JSON.stringify(rv)).toBe(before);
 // A matching pessimistic verdict is insufficient if its copied explanation no longer matches the program's aggregation.
 merged.explanation='The parent approves the uninterrupted work claim.';
 expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
});

test('assessment, causal, pressure and omission fields require complete coverage and conservative aggregation',()=>{
 const baseline=fixture(),targets=verificationFieldTargets(baseline,baseline.verification);
 expect(targets.filter(t=>t.id.startsWith('causal:')||t.id.startsWith('pressure:')).map(t=>t.id)).toEqual(['causal:0#state','causal:0#choice','causal:0#alternative','causal:0#explanation','causal:0#suggestedFix','causal:0#suggestedSceneId','pressure:0#trigger','pressure:0#threatenedOutcome','pressure:0#currentState','pressure:0#directAlternative','pressure:0#explanation','pressure:0#suggestedFix','pressure:0#suggestedSceneId']);
 for(const target of targets){
  const rv=fixture();rv.verification!.audit!.fieldChecks=rv.verification!.audit!.fieldChecks.filter(c=>c.targetId!==target.id);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
 }
 for(const change of [
  (v:ReviewVerification)=>{v.audit!.fieldChecks.push(v.audit!.fieldChecks[0]!);},
  (v:ReviewVerification)=>{v.audit!.originalChecks.pop();},
  (v:ReviewVerification)=>{v.audit!.originalChecks.push(v.audit!.originalChecks[0]!);},
  (v:ReviewVerification)=>{Object.assign(v.audit!.fieldChecks[0]!,{verdict:'unsupported',correction:'The continuous-work claim is unsupported.'});},
  (v:ReviewVerification)=>{const i=v.audit!.originalChecks.findIndex(c=>c.targetId==='causal:0');v.audit!.originalChecks[i]={...v.audit!.originalChecks[i]!,verdict:'contradicted',correction:'Original parent already rejected.',counterEvidence:[quote]};},
  (v:ReviewVerification)=>{Object.assign(v.audit!,{fieldChecks:[null]});},
 ]){
  const rv=fixture();change(rv.verification!);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
  expect(verificationIssueCount(rv)).toBeGreaterThan(0);
 }
});

test('field-level explanations and original parent traces are escaped',()=>{
 const rv=fixture(),audit=rv.verification!.audit!,payload='<img src=x onerror="alert(1)">';
 Object.assign(audit.fieldChecks.find(c=>c.targetId==='causal:0#explanation')!,{claimQuote:rv.causality!.checks[0]!.explanation,verdict:'contradicted',explanation:payload,correction:payload,evidence:[{sourceId:payload,quote:payload}],counterEvidence:[{sourceId:payload,quote:payload}]});
 audit.originalChecks[audit.originalChecks.findIndex(c=>c.targetId==='causal:0')]={...audit.originalChecks.find(c=>c.targetId==='causal:0')!,explanation:payload};
 const html=causalityView(rv);
 expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).toContain('&quot;alert(1)&quot;');
 expect(html).toContain('逐项反向依据');expect(html).toContain('original-parent-audit');expect(html).not.toContain('data-action="use-suggestion"');
});

test('quote normalization metadata must match across review copies and aggregated field results',()=>{
 const rv=fixture(),v=rv.verification!,audit=v.audit!,modelQuote='The first five days\nran automated.';
 const i=audit.checks.findIndex(c=>c.targetId==='assessment:dialogue'),copied={...audit.checks[i]!,evidence:[{...quote,modelQuote}]};
 audit.checks[i]=copied;audit.originalChecks[audit.originalChecks.findIndex(c=>c.targetId===copied.targetId)]=copied;
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined(); // canonical quotes match; modelQuote does not
 v.checks[v.checks.findIndex(c=>c.targetId===copied.targetId)]=copied;
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 const child=audit.fieldChecks.find(c=>c.targetId==='causal:0#explanation')!;
 Object.assign(child,{claimQuote:rv.causality!.checks[0]!.explanation,verdict:'unsupported',explanation:'Manual labor is not established.',correction:'Keep elapsed time separate.',evidence:[{...quote,modelQuote}]});
 const merged:ReviewVerification['checks'][number]={...child,targetId:'causal:0',explanation:`explanation 字段核实：${child.explanation}`,correction:`explanation：${child.correction}`,evidence:[quote]};
 audit.checks[audit.checks.findIndex(c=>c.targetId==='causal:0')]=merged;v.checks[v.checks.findIndex(c=>c.targetId==='causal:0')]=merged;
 expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
 merged.evidence=[{...quote,modelQuote}];audit.status='needs_review';
 expect(verificationView(rv)).not.toContain('独立解释审计记录不完整或校验未通过');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined(); // only the rejected causal suggestion is blocked
 expect(reviewSuggestion(rv,rv.id,'causal:0','s1')).toBeUndefined();
});

test('frozen source-line metadata must agree across both quote lists and the aggregated parent',()=>{
 const sourceRef='line:scene%3As1:1';
 for(const list of ['evidence','counterEvidence'] as const){
  const rv=fixture(),v=rv.verification!,audit=v.audit!,i=audit.checks.findIndex(c=>c.targetId==='assessment:dialogue');
  const copied={...audit.checks[i]!,[list]:[{...quote,sourceRef}]};
  audit.checks[i]=copied;audit.originalChecks[audit.originalChecks.findIndex(c=>c.targetId===copied.targetId)]=copied;
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  v.checks[v.checks.findIndex(c=>c.targetId===copied.targetId)]=copied;
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
  audit.originalChecks[audit.originalChecks.findIndex(c=>c.targetId===copied.targetId)]={...copied,[list]:[{...quote,sourceRef:'line:scene%3As1:2'}]};
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 }
 const rv=fixture();rejectField(rv,'causal:0#explanation');
 const audit=rv.verification!.audit!,child=audit.fieldChecks.find(c=>c.targetId==='causal:0#explanation')!,merged=audit.checks.find(c=>c.targetId==='causal:0')!;
 child.evidence=[{...quote,sourceRef}];
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 merged.evidence=[{...quote,sourceRef}];
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 expect(reviewSuggestion(rv,rv.id,'causal:0','s1')).toBeUndefined();
});

test('invalid reference or whitespace metadata cannot authorize a suggestion even when copied consistently',()=>{
 const invalidRefs=[null,'',42,{},'line:scene%3As1:0','line:scene%3As1:01','line:scene%3As1:9007199254740992','line:%ZZ:1','line:scene%3As2:1','line:scene%3as1:1'];
 for(const sourceRef of invalidRefs){
  for(const location of ['check','omission','timeline','bound'] as const){
   const rv=fixture(),v=rv.verification!,bad={...quote,sourceRef};
   if(location==='check')Object.assign(v.checks[1]!,{evidence:[bad]});
   if(location==='omission')Object.assign(v.omissions[0]!,{evidence:[bad]});
   if(location==='timeline')Object.assign(v.timelineFacts[0]!,{evidence:[bad]});
   if(location==='bound')Object.assign(v.timelineFacts[0]!,{boundSource:bad});
   expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
   expect(verificationIssueCount(rv)).toBeGreaterThan(0);expect(()=>verificationView(rv)).not.toThrow();
  }
 }
 for(const metadata of [{modelQuote:null},{modelQuote:quote.quote},{modelQuote:'The operator worked for five days.'},{sourceRef:'line:scene%3As1:1',modelQuote:'The first five days\nran automated.'}]){
  const rv=fixture();Object.assign(rv.verification!.checks[1]!,{evidence:[{...quote,...metadata}]});
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 }
 expect(reviewSuggestion(fixture(),'review-current','assessment:dialogue','s1')).toBeDefined(); // Legacy literal quotations remain valid.
});

test('line-reference details preserve the actual quotation without exposing opaque IDs or implying semantic approval',()=>{
 const rv=fixture(),sourceRef='line:scene%3As1:15',canonical='BOLT (CONT\'D) <img src=x onerror="alert(1)">';
 rv.verification!.omissions[0]!.evidence=[{sourceId:'scene:s1',quote:canonical,sourceRef}];
 const before=JSON.stringify(rv),html=verificationView(rv);
 expect(html).toContain('原文行引用：按冻结原文行定位');expect(html).toContain('定位不等于解释已核实');expect(html).toContain('不是另一份独立依据');
 expect(html).toContain('BOLT (CONT&#39;D) &lt;img');expect(html).not.toContain('<img');expect(html).not.toContain(sourceRef);
 const at=html.indexOf('source-line-reference');expect(html.lastIndexOf('<details',at)).toBeGreaterThan(html.lastIndexOf('</details>',at));
 expect(html).not.toContain('class="evidence" open');expect(JSON.stringify(rv)).toBe(before);
});

test('canonical quotations remain primary and model whitespace variants are escaped folded diagnostics',()=>{
 const rv=fixture(),canonical='<img\n\nsrc=x onerror="alert(1)">',modelQuote='<img src=x onerror="alert(1)">';
 rv.verification!.omissions[0]!.evidence=[{sourceId:'scene:s1',quote:canonical,modelQuote}];
 const html=verificationView(rv);
 expect(html).toContain('&lt;img\n\nsrc=x');expect(html).not.toContain('<img');
 expect(html).toContain('<details class="evidence quote-normalization"><summary>模型原引文（格式对照）</summary>');
 expect(html).not.toContain('quote-normalization" open');
 expect(html).toContain('不是另一份独立依据');
 expect(html.indexOf('&lt;img\n\nsrc=x')).toBeLessThan(html.indexOf('quote-normalization'));
 expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('unsupported fact interpretations are quarantined while system-bound lines and audit corrections remain visible',()=>{
 for(const verdict of ['unsupported','contradicted','uncertain'] as const){
  const rv=fixture(),fact=rv.verification!.timelineFacts[0]!;
  fact.status='conflict';fact.explanation='The verifier invents an uninterrupted labor shift.';syncFields(rv);
  const audit=rv.verification!.audit!;
  for(const targetId of [fact.targetId,'omission:timeline'])Object.assign(audit.checks.find(c=>c.targetId===targetId)!,{verdict,explanation:'Elapsed time alone cannot establish manual labor.',correction:'Keep the stated duration; distinguish automation and later work.',counterEvidence:[quote]});
  audit.status='needs_review';
  const html=verificationView(rv),section=html.slice(html.indexOf('class="evidence timeline-fact"'),html.indexOf('<h4>补查遗漏'));
  expect(section).toContain('<details class="evidence original-verifier"><summary>原核实器解释与判断（尚不采信）');
  expect(section).not.toContain('original-verifier" open');
  expect(section.indexOf('系统绑定原句')).toBeLessThan(section.indexOf('original-verifier'));
  expect(section.indexOf('Keep the stated duration')).toBeLessThan(section.indexOf('original-verifier'));
  expect(section.indexOf(fact.explanation)).toBeGreaterThan(section.indexOf('original-verifier'));
  expect(section.indexOf('时间陈述存在冲突')).toBeGreaterThan(section.indexOf('original-verifier'));
  expect(section).toContain('审计反向依据');
  expect(html.match(/original-verifier/g)).toHaveLength(2);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
  expect(assessmentView(rv,rv.assessments[1]!)).toContain('data-action="use-suggestion"');
  expect(verificationIssueCount(rv)).toBe(2); // two unsupported explanations, not an extra presumed time flaw
 }
});

test('audit coverage, malformed fields and divergent copies all fail closed',()=>{
 for(const change of [
  (v:ReviewVerification)=>{v.audit!.checks.pop();},
  (v:ReviewVerification)=>{v.audit!.checks.push(v.audit!.checks[0]!);},
  (v:ReviewVerification)=>{v.audit!.errors.push('Independent audit rejected a quote.');},
  (v:ReviewVerification)=>{v.audit!.checks.find(c=>c.targetId.startsWith('timeline:'))!.evidence=[];},
  (v:ReviewVerification)=>{Object.assign(v.audit!.checks.at(-1)!,{verdict:'unsupported',correction:undefined});},
  (v:ReviewVerification)=>{Object.assign(v.audit!.checks.at(-1)!,{verdict:'contradicted',correction:'Unknown.',counterEvidence:[]});},
  (v:ReviewVerification)=>{Object.assign(v.audit!.checks.at(-1)!,{verdict:'trusted'});},
  (v:ReviewVerification)=>{Object.assign(v.audit!,{checks:[null]});},
  (v:ReviewVerification)=>{v.audit!.checks[0]={...v.audit!.checks[0]!,explanation:'A stale but still supported duplicate.'};},
 ]){
  const rv=fixture();change(rv.verification!);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
  expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');expect(verificationIssueCount(rv)).toBeGreaterThan(0);
 }
 const rv=fixture();rv.verification!.audit!.status='needs_review';
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');
});

test('independent audit corrections, evidence, errors and normalization notes are escaped',()=>{
 const rv=fixture(),audit=rv.verification!.audit!,payload='<img src=x onerror="alert(1)">';
 Object.assign(audit.checks.find(c=>c.targetId==='omission:accounting')!,{verdict:'contradicted',explanation:payload,correction:payload,evidence:[{sourceId:payload,quote:payload}],counterEvidence:[{sourceId:payload,quote:payload}]});
 audit.errors=[payload];audit.normalizationNotes=[payload];
 const html=verificationView(rv);
 expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).toContain('&quot;alert(1)&quot;');
 expect(html).toContain('独立审计输出格式整理记录');expect(html).toContain('审计反向依据');
 expect(html).not.toContain('data-action="use-suggestion"');
});

test('system-bound time lines are distinct from model relations, and legacy bindings do not enable quick rewrite',()=>{
 const rv=fixture(),fact=rv.verification!.timelineFacts[0]!;
 fact.evidence.push({sourceId:'scene:s1',quote:'The next proposal takes ninety minutes.'});
 const html=verificationView(rv),section=html.slice(html.indexOf('class="evidence timeline-fact"'),html.indexOf('<h4>补查遗漏'));
 expect(section).toContain('系统绑定原句');expect(section).toContain('绑定原句不等于确认模型解释');
 expect(section.match(/The first five days ran automated\./g)).toHaveLength(1);
 expect(section).toContain('时间关系依据');expect(section).toContain('The next proposal takes ninety minutes.');
 delete (fact as Partial<typeof fact>).boundSource;const before=JSON.stringify(rv);
 expect(fieldTargets(rv).some(t=>t.parentId===fact.targetId&&t.field==='explanation')).toBe(true); // Legacy text remains enumerable, never trusted.
 expect(verificationView(rv)).toContain('旧版时间核对未标注系统绑定原句');
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
 expect(JSON.stringify(rv)).toBe(before);
});

test('time conflicts expand with meaning and quotes without vetoing an independently verified suggestion',()=>{
 const rv=fixture(),fact=rv.verification!.timelineFacts[0]!;
 const clean=verificationView(rv);
 expect(clean).toContain('<details class="evidence timeline-fact"><summary>s1 第 1 行 · 时间陈述相容');
 expect(clean).not.toContain('timeline-fact" open');
 for(const status of ['conflict','uncertain'] as const){
  fact.status=status;fact.explanation='Ten days for the same proposed ninety-minute activity is not established.';syncFields(rv);
  const html=verificationView(rv);
  expect(html).toContain('<details class="evidence timeline-fact" open>');
  expect(html).toContain('具体活动');expect(html).toContain('时钟与参照系');expect(html).toContain(fact.explanation);expect(html).toContain(quote.quote);
  expect(verificationIssueCount(rv)).toBe(1);expect(reviewIssueCount(rv)).toBe(2);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
  expect(assessmentView(rv,rv.assessments[1]!)).toContain('data-action="use-suggestion"');
  expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');
 }
});

test('malformed temporal records fail closed without rendering invalid objects',()=>{
 for(const rows of [null,{},[null],[],]){
  const rv=fixture();(rv.verification as unknown as Record<string,unknown>).timelineFacts=rows;
  if(Array.isArray(rows)&&!rows.length){expect(verificationView(rv)).toContain('本次记录没有时间核对条目');continue;}
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationIssueCount(rv)).toBeGreaterThan(0);expect(verificationView(rv)).toContain('原建议已暂停带入改稿');
 }
 for(const change of [
  (v:ReviewVerification)=>{v.timelineFacts.push(structuredClone(v.timelineFacts[0]!));},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.meaning.clock=' ';},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.evidence=[];},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.evidence[0]!.quote='';},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.targetId='timeline:s1:0';},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.targetId='timeline:%ZZ:1';},
  (v:ReviewVerification)=>{Object.assign(v.timelineFacts[0]!,{status:'okay'});},
  (v:ReviewVerification)=>{Object.assign(v.timelineFacts[0]!,{boundSource:null});},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.boundSource.quote='Unbound changed source line.';},
  (v:ReviewVerification)=>{v.timelineFacts[0]!.boundSource.sourceId='scene:other';},
 ]){
  const rv=fixture();change(rv.verification!);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('时间核对记录含重复标识或无效字段');
  expect(verificationIssueCount(rv)).toBe(1);
 }
});

test('damaged omission rows remain readable as needing review and never authorize suggestions',()=>{
 const healthy=fixture();expect(reviewSuggestion(healthy,healthy.id,'assessment:dialogue','s1')).toBeDefined();
 for(const damaged of [null,{},'corrupt',{...healthy.verification!.omissions[0]!,sceneIds:'s1'},{...healthy.verification!.omissions[0]!,evidence:[null]}]){
  const rv=fixture();(rv.verification!.omissions as unknown[])[0]=damaged;
  const before=JSON.stringify(rv),html=verificationView(rv)+assessmentView(rv,rv.assessments[1]!);
  expect(html).toContain('遗漏检查记录含无效条目，需重新核实');
  expect(html).not.toContain('独立解释审计已完成');expect(html).not.toContain('data-action="use-suggestion"');
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(reviewSuggestion(rv,rv.id,'omission:timeline','s1')).toBeUndefined();
  expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');expect(verificationIssueCount(rv)).toBeGreaterThan(0);
  expect(JSON.stringify(rv)).toBe(before);expect(()=>fieldTargets(rv)).not.toThrow();
 }
 expect(reviewSuggestion(healthy,healthy.id,'assessment:dialogue','s1')).toBeDefined();
});

test('incomplete verifier coverage and parser failures block all one-click suggestions',()=>{
 for(const change of [
  (v:ReviewVerification)=>{v.errors.push('Unmatched quote.');},
  (v:ReviewVerification)=>{v.checks.pop();},
  (v:ReviewVerification)=>{v.checks[1]={...v.checks[0]!};},
  (v:ReviewVerification)=>{v.omissions.pop();},
  (v:ReviewVerification)=>{v.omissions[1]={...v.omissions[0]!};},
  (v:ReviewVerification)=>{v.checks[1]!.evidence=[];},
 ]){
  const rv=fixture();change(rv.verification!);
  expect(reviewTargetSupported(rv,'assessment:dialogue')).toBe(false);
  expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('核实记录不完整或校验未通过');
  expect(reviewCompletionLabel(rv)).toBe('本次审读需复核');
 }
});

test('reviewer corrections, omission findings and counterquotes are escaped text',()=>{
 const rv=fixture();const payload='<img src=x onerror="alert(1)">';
 expect(verificationView(rv)).not.toContain('输出格式整理记录');
 rv.verification!.normalizationNotes=[payload];
 Object.assign(rv.verification!.timelineFacts[0]!,{targetId:`timeline:${encodeURIComponent(payload)}:1`,boundSource:{sourceId:`scene:${payload}`,quote:payload},meaning:{subject:payload,activity:payload,durationKind:payload,clock:payload,basis:payload},explanation:payload,evidence:[{sourceId:`scene:${payload}`,quote:payload}]});
 Object.assign(rv.verification!.checks[0]!,{verdict:'contradicted',explanation:payload,correction:payload,counterEvidence:[{sourceId:payload,quote:payload}]});
 Object.assign(rv.verification!.omissions[0]!,{status:'issue',explanation:payload,suggestedFix:payload,evidence:[{sourceId:'scene:s1',quote:payload}]});
 const html=assessmentView(rv,rv.assessments[0]!)+verificationView(rv);
 expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).toContain('&quot;alert(1)&quot;');
 expect(html).toContain('补查遗漏');expect(html).toContain('模型提出的改法（尚未核实）');
 expect(html).toContain('<details class="evidence normalization-notes"><summary>输出格式整理记录</summary>');
 expect(html).not.toContain('normalization-notes" open');
 expect(html).not.toContain('data-action="use-suggestion"');
});

test('verified time repairs target only the audited edit scene despite broader affected scenes and another rejected claim',()=>{
 const rv=fixture(),suggestion='Preserve the stated ninety-minute proposal; clarify the unsupported ten-day consequence.';
 Object.assign(rv.verification!.omissions[0]!,{status:'issue',explanation:'The future duration needs clarification.',suggestedFix:suggestion,suggestedSceneId:'s2',sceneIds:['s1','s2'],evidence:[quote,{sourceId:'scene:s2',quote:'Ninety minutes. No ten-day shift.'}]});
 rv.verification!.timelineFacts[0]!.status='conflict';syncFields(rv);
 rv.verification!.audit!.fieldChecks.find(c=>c.targetId==='omission:timeline#suggestedSceneId')!.evidence=[{sourceId:'scene:s2',quote:'Ninety minutes. No ten-day shift.'}];
 rejectField(rv,'causal:0#explanation');
 const before=JSON.stringify(rv),html=verificationView(rv);
 expect(html).toContain('<details class="evidence unverified-suggestion"><summary>模型提出的改法（待作者确认）</summary>');
 expect(html).not.toContain('unverified-suggestion" open');
 expect(html).toContain('已核对这项建议的原文依据与改法');
 expect(html).not.toContain('data-target="omission:timeline" data-scene="s1"');
 expect(html).toContain('data-target="omission:timeline" data-scene="s2"');
 expect(reviewSuggestion(rv,rv.id,'omission:timeline','s2')).toEqual({sceneId:'s2',instruction:suggestion});
 expect(reviewSuggestion(rv,rv.id,'omission:timeline','s1')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'omission:timeline','s3')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'causal:0','s1')).toBeUndefined();
 expect(JSON.stringify(rv)).toBe(before);
});

test('a rejected omission fix stays folded and cannot be imported, while unrelated valid suggestions remain usable',()=>{
 const rv=fixture(),suggestion='Replace the stated ninety minutes with twenty hours.';
 Object.assign(rv.verification!.omissions[0]!,{status:'issue',explanation:'The future duration needs clarification.',suggestedFix:suggestion,suggestedSceneId:'s1'});syncFields(rv);
 rejectField(rv,'omission:timeline#suggestedFix');
 const html=verificationView(rv);
 expect(html).toContain('<details class="evidence unverified-suggestion"><summary>模型提出的改法（尚未核实）</summary>');
 expect(html).not.toContain('unverified-suggestion" open');
 expect(html).toContain('不能作为已确认事实，也不可直接带入改稿');
 expect(html).not.toContain('data-target="omission:timeline"');
 expect(reviewSuggestion(rv,rv.id,'omission:timeline','s1')).toBeUndefined();
 expect(reviewSuggestion(rv,rv.id,'assessment:dialogue','s1')).toBeDefined();
 expect(rv.verification!.omissions[0]!.suggestedFix).toBe(suggestion);
});

test('missing or unrelated disputed-field anchors invalidate the audit and never authorize an otherwise supported suggestion',()=>{
 for(const claimQuote of [undefined,'not present in the reviewed claim']){
  const rv=fixture();rejectField(rv,'assessment:dialogue#suggestedFix');
  const audit=rv.verification!.audit!,child=audit.fieldChecks.find(c=>c.targetId==='assessment:dialogue#suggestedFix')!;
  Object.assign(child,{claimQuote});
  expect(reviewSuggestion(rv,rv.id,'pressure:0','s1')).toBeUndefined();
  expect(verificationView(rv)).toContain('独立解释审计记录不完整或校验未通过');
 }
});

test('attention count includes verifier errors and omissions without treating a refuted flaw as a script flaw',()=>{
 const rv=fixture();expect(reviewIssueCount(rv)).toBe(1); // only supported dialogue issue
 rv.verification!.checks[1]!.verdict='unsupported';rv.verification!.checks[1]!.correction='No reason to delete that line.';
 expect(reviewIssueCount(rv)).toBe(1); // the unsupported claim, not its old flaw plus a claim
 rv.verification!.omissions[0]!.status='issue';rv.verification!.omissions[0]!.suggestedFix='Check the clock basis.';syncFields(rv);
 expect(verificationIssueCount(rv)).toBe(2);
 rv.verification!.errors.push('A quote was rejected.');rv.errors.push('A quote was rejected.');
 expect(reviewIssueCount(rv)).toBe(3);
 expect(reviewIssueCount(rv,true)).toBe(4);
});
