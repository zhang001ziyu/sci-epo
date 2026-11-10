import { expect, test } from 'bun:test';
import { DIMENSIONS, type ProjectBundle, type Review } from '../src/types';
import { snapshotContext } from '../src/core';
import { verificationFieldTargets } from '../src/core/reviewVerification';
import { RewriteInstruction } from '../web/rewriteInstruction';

function review(id='review-1'):Review {
 const evidence={sourceId:'scene:s1',sourceQuote:'The first five days ran automated.',sceneId:'s1',draftQuote:'The first five days ran automated.'};
 const rv:Review={id,revisionId:'revision-1',status:'completed',mode:'live',createdAt:'2026-11-06T00:00:00Z',errors:[],assessments:DIMENSIONS.map(dimension=>({dimension,status:dimension==='story'?'issue':'no_issue',explanation:'A checked interpretation.',...(dimension==='story'?{issueType:'craft_preference' as const,suggestedFix:'Clarify the later request without altering the automated period.',suggestedSceneId:'s1'}:{}),evidence:[evidence]})),verification:{status:'completed',errors:[],timelineFacts:[{targetId:'timeline:s1:1',boundSource:{sourceId:'scene:s1',quote:'The first five days ran automated.'},status:'consistent',meaning:{subject:'The automation system',activity:'The first five days',durationKind:'Automatic operation',clock:'Inside clock',basis:'Shown in the scene'},explanation:'The duration describes automation, not manual labor.',evidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}]}],checks:DIMENSIONS.map(dimension=>({targetId:`assessment:${dimension}`,verdict:'supported',explanation:'Earlier verification supports this suggestion.',evidence:[{sourceId:'scene:s1',quote:evidence.sourceQuote}],counterEvidence:[]})),omissions:['timeline','accounting','agency','continuity','other'].map(category=>({category:category as NonNullable<Review['verification']>['omissions'][number]['category'],status:'no_issue',explanation:'Inspected.',sceneIds:['s1'],evidence:[{sourceId:'scene:s1',quote:evidence.sourceQuote}]}))}};
 const v=rv.verification!,checks=[...v.checks,...[...v.timelineFacts.map(f=>f.targetId),...v.omissions.map(o=>`omission:${o.category}`)].map(targetId=>({targetId,verdict:'supported' as const,explanation:'Independent audit confirms the statement.',evidence:[{sourceId:'scene:s1',quote:evidence.sourceQuote}],counterEvidence:[]}))];
 v.audit={schemaVersion:5,status:'completed',errors:[],checks,originalChecks:[...checks],fieldChecks:verificationFieldTargets(rv,rv.verification).map(t=>({targetId:t.id,verdict:'supported',explanation:'Checked field.',evidence:[{sourceId:'scene:s1',quote:evidence.sourceQuote}],counterEvidence:[]}))};return rv;
}
function disproved(original:Review):Review {
 const updated=structuredClone(original);updated.id='review-2';updated.status='needs_review';updated.verification!.status='needs_review';
 Object.assign(updated.verification!.checks[0]!,{verdict:'contradicted',explanation:'Elapsed time is not continuous labor.',correction:'Actual manual work duration is unknown.',counterEvidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}]});return updated;
}
const context=(rv:Review|undefined,sceneId='s1')=>({revisionId:'revision-1',sceneId,review:rv});

test('imported instruction retains provenance through a same-revision review replacement',()=>{
 const old=review(),draft=new RewriteInstruction();
 expect(draft.useSuggestion(context(old),old.id,'assessment:story')).toBe(true);
 const copied=draft.value;expect(draft.prepare(context(old))).toEqual({ok:true,instruction:copied,reviewSource:{reviewId:old.id,targetId:'assessment:story'}});
 const latest=disproved(old);
 expect(draft.prepare(context(latest)).ok).toBe(false);
 expect(draft.value).toBe(copied); // no silent destruction of the text
 expect(draft.problem(context(latest))).toContain('已失效');
 draft.edit(copied);expect(draft.prepare(context(latest)).ok).toBe(false); // unchanged input is not a manual override
 draft.edit('Keep the automated period and clarify only the final request.');
 expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:'Keep the automated period and clarify only the final request.'});
});

test('review changes do not discard unrelated author instructions; changing scene blocks imported suggestions',()=>{
 const old=review(),draft=new RewriteInstruction();draft.edit('My independent author direction.');
 expect(draft.prepare(context(disproved(old)))).toEqual({ok:true,instruction:'My independent author direction.'});
 expect(draft.useSuggestion(context(old),old.id,'assessment:story')).toBe(true);
 expect(draft.prepare(context(old,'s2')).ok).toBe(false);
 expect(draft.prepare({...context(old),revisionId:'other-revision'}).ok).toBe(false);
 expect(draft.prepare(context(undefined)).ok).toBe(false);
 draft.clear();expect(draft.value).toBe('');expect(draft.problem(context(disproved(old)))).toBeUndefined();
});

test('an unrelated time conflict preserves a valid imported suggestion, but missing coverage blocks it',()=>{
 const old=review(),draft=new RewriteInstruction();
 expect(draft.useSuggestion(context(old),old.id,'assessment:story')).toBe(true);
 const copied=draft.value,latest=structuredClone(old);
 // A separately verified time issue does not invalidate this already grounded suggestion.
 latest.verification!.timelineFacts[0]!.status='conflict';
 expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:copied,reviewSource:{reviewId:old.id,targetId:'assessment:story'}});expect(draft.value).toBe(copied);
 const legacy=structuredClone(old);delete (legacy.verification as Partial<NonNullable<Review['verification']>>).timelineFacts;
 expect(draft.prepare(context(legacy)).ok).toBe(false);
 draft.edit('Clarify the proposed ninety minutes; preserve the automated five-day history.');
 expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:draft.value});
});

test('an imported instruction is blocked when its selected target loses support or audit structure fails',()=>{
 const old=review(),draft=new RewriteInstruction();
 for(const invalidate of [
  (rv:Review)=>{delete rv.verification!.audit;},
  (rv:Review)=>{(rv.verification!.omissions as unknown[])[0]=null;},
  (rv:Review)=>{rv.verification!.audit!.errors.push('Audit coverage failed.');},
  (rv:Review)=>{const c=rv.verification!.audit!.checks.find(c=>c.targetId==='assessment:story')!;Object.assign(c,{verdict:'unsupported',correction:'Do not infer work hours from elapsed time.'});},
  (rv:Review)=>{rv.verification!.audit!.checks[0]={...rv.verification!.audit!.checks[0]!,explanation:'A stale copied explanation.'};},
 ]){
  expect(draft.useSuggestion(context(old),old.id,'assessment:story')).toBe(true);
  const latest=structuredClone(old);invalidate(latest);
  expect(latest.verification!.timelineFacts[0]!.status).toBe('consistent');
  expect(draft.prepare(context(latest)).ok).toBe(false);
  draft.edit('Author direction: retain the five-day automation and clarify the short manual job.');
  expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:draft.value});
 }
});

test('an imported suggestion cannot survive losing, changing or failing its audited edit scope',()=>{
 const old=review(),targetId='assessment:story',scopeId=`${targetId}#suggestedSceneId`;
 for(const invalidate of [
  (rv:Review)=>{delete rv.assessments[0]!.suggestedSceneId;rv.verification!.audit!.fieldChecks=rv.verification!.audit!.fieldChecks.filter(c=>c.targetId!==scopeId);},
  (rv:Review)=>{rv.assessments[0]!.suggestedSceneId='s2';rv.verification!.audit!.fieldChecks.find(c=>c.targetId===scopeId)!.evidence=[{sourceId:'scene:s2',quote:'The later request is here.'}];},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks=rv.verification!.audit!.fieldChecks.filter(c=>c.targetId!==scopeId);},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks.find(c=>c.targetId===scopeId)!.evidence=[{sourceId:'scene:s3',quote:'Only the consequence is shown.'}];},
  (rv:Review)=>{
   const audit=rv.verification!.audit!,child=audit.fieldChecks.find(c=>c.targetId===scopeId)!;
   Object.assign(child,{verdict:'unsupported',claimQuote:'s1',explanation:'The repeated request is in another scene.',correction:'Do not edit the cited consequence instead of the request.'});
   const merged={...child,targetId,explanation:`suggestedSceneId 字段核实：${child.explanation}`,correction:`suggestedSceneId：${child.correction}`};
   audit.checks[audit.checks.findIndex(c=>c.targetId===targetId)]=merged;
   rv.verification!.checks[rv.verification!.checks.findIndex(c=>c.targetId===targetId)]=merged;
  },
 ]){
  const draft=new RewriteInstruction();expect(draft.useSuggestion(context(old),old.id,targetId)).toBe(true);
  const copied=draft.value,latest=structuredClone(old);invalidate(latest);
  expect(latest.id).toBe(old.id);expect(draft.prepare(context(latest)).ok).toBe(false);
  expect(draft.value).toBe(copied);expect(draft.problem(context(latest))).toContain('已失效');
  draft.edit('My independent direction: retain all established automation facts.');
  expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:draft.value});
 }
});

test('imported compound instructions require every sentence check and reject old whole-field coverage',()=>{
 const old=review(),targetId='assessment:story';
 old.assessments[0]!.suggestedFix='Keep the automated period. Clarify the later request.';
 const audit=old.verification!.audit!;
 audit.fieldChecks=verificationFieldTargets(old,old.verification).map(t=>({targetId:t.id,verdict:'supported',explanation:'This exact statement was checked.',evidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}],counterEvidence:[]}));
 const wholeId=`${targetId}#suggestedFix`,segments=verificationFieldTargets(old,old.verification).filter(t=>t.parentId===targetId&&t.field==='suggestedFix'&&t.id.startsWith(`${wholeId}@`));expect(segments).toHaveLength(2);
 expect(audit.fieldChecks.filter(c=>c.targetId===wholeId)).toHaveLength(1);
 for(const invalidate of [
  (rv:Review)=>{Object.assign(rv.verification!.audit!,{schemaVersion:4});},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks=rv.verification!.audit!.fieldChecks.filter(c=>c.targetId!==segments[1]!.id);},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks=rv.verification!.audit!.fieldChecks.filter(c=>c.targetId!==wholeId);},
  (rv:Review)=>{const a=rv.verification!.audit!;a.fieldChecks=a.fieldChecks.filter(c=>c.targetId!==wholeId&&!c.targetId.startsWith(`${wholeId}@`));a.fieldChecks.push({targetId:wholeId,verdict:'supported',explanation:'The full field looks fine.',evidence:[{sourceId:'scene:s1',quote:'The first five days ran automated.'}],counterEvidence:[]});expect(a.fieldChecks.filter(c=>c.targetId===wholeId||c.targetId.startsWith(`${wholeId}@`)).map(c=>c.targetId)).toEqual([wholeId]);},
  (rv:Review)=>{
   const a=rv.verification!.audit!,part=segments[1]!,child=a.fieldChecks.find(c=>c.targetId===part.id)!;
   Object.assign(child,{verdict:'uncertain',claimQuote:part.claim,explanation:'The later request is not established by this quotation.',correction:'Recheck the request before changing it.'});
   const merged={...child,targetId,explanation:`suggestedFix 字段核实：${child.explanation}`,correction:`suggestedFix：${child.correction}`};
   a.checks[a.checks.findIndex(c=>c.targetId===targetId)]=merged;rv.verification!.checks[rv.verification!.checks.findIndex(c=>c.targetId===targetId)]=merged;
  },
 ]){
  const draft=new RewriteInstruction();expect(draft.useSuggestion(context(old),old.id,targetId)).toBe(true);
  const copied=draft.value,updated=structuredClone(old);invalidate(updated);
  expect(draft.prepare(context(updated)).ok).toBe(false);expect(draft.value).toBe(copied);
  expect(draft.problem(context(updated))).toContain('已失效');
  draft.edit('Author direction: keep the current request unchanged.');
  expect(draft.prepare(context(updated))).toEqual({ok:true,instruction:draft.value});
 }
});

test('field audit coverage and parent-child disagreement invalidate a previously imported instruction on the same review',()=>{
 const old=review(),v=old.verification!,audit=v.audit!,quote={sourceId:'scene:s1',quote:'The first five days ran automated.'};
 old.causality={status:'completed',errors:[],checks:[{sceneId:'s1',state:'Time elapsed.',choice:'Decline another job.',obstacleKind:'emotional',alternative:'Take another job.',verdict:'supported',explanation:'The later job is optional.',suggestedFix:'Clarify the decision.',suggestedSceneId:'s1',evidence:[{sceneId:'s1',sourceId:quote.sourceId,sourceQuote:quote.quote,draftQuote:quote.quote}],constraintEvidence:[quote]}],pressures:[]};
 const parent={targetId:'causal:0',verdict:'supported' as const,explanation:'The parent was approved.',evidence:[quote],counterEvidence:[]};
 v.checks.push(parent);audit.checks.push(parent);audit.originalChecks.push(parent);
 audit.fieldChecks=verificationFieldTargets(old,old.verification).map(t=>({targetId:t.id,verdict:'supported',explanation:'The field was approved.',evidence:[quote],counterEvidence:[]}));
 const draft=new RewriteInstruction();
 for(const invalidate of [
  (rv:Review)=>{Object.assign(rv.verification!.audit!,{schemaVersion:undefined});},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks.pop();},
  (rv:Review)=>{rv.verification!.audit!.fieldChecks.push(rv.verification!.audit!.fieldChecks[0]!);},
  (rv:Review)=>{Object.assign(rv.verification!.audit!.fieldChecks.find(c=>c.targetId==='causal:0#explanation')!,{verdict:'unsupported',correction:'Elapsed time does not establish uninterrupted labor.'});},
 ]){
  expect(draft.useSuggestion(context(old),old.id,'assessment:story')).toBe(true);
  const copied=draft.value,latest=structuredClone(old);invalidate(latest);
  expect(latest.id).toBe(old.id);expect(latest.verification!.checks[0]!.verdict).toBe('supported');
  expect(draft.prepare(context(latest)).ok).toBe(false);expect(draft.value).toBe(copied);
  draft.edit('Author direction: preserve the automated days, clarify only the later work.');
  expect(draft.prepare(context(latest))).toEqual({ok:true,instruction:draft.value});
 }
});

test('app lifecycle: imported suggestion becomes refuted after verify, stale submit sends no request, author edit can submit',async()=>{
 const brief={title:'Clock farm',premise:'A garden job.',characters:'Two partners.',worldRules:'All clocks can stop.',authorRules:'Keep the automated period.',language:'en'};
 const source={id:'revision-1',episodeId:'episode-1',parentId:null,title:'Pilot',logline:'A choice.',scenes:[{id:'s1',heading:'FARM',content:'The first five days ran automated.',locked:false}],context:snapshotContext(brief,[]),kind:'generated' as const,instruction:'',mode:'live' as const,language:'en',createdAt:'2026-11-06T00:00:00Z'};
 const old=review();
 const state:ProjectBundle={project:{...brief,id:'project-1',createdAt:source.createdAt,updatedAt:source.createdAt},episodes:[{id:'episode-1',projectId:'project-1',ordinal:1,title:'Pilot',acceptedRevisionId:null,needsReview:false,createdAt:source.createdAt}],revisions:[source],reviews:[old],runs:[],localizations:[]};
 const listeners=new Map<string,(event:any)=>void>();
 const root={innerHTML:'',addEventListener:(name:string,fn:(event:any)=>void)=>listeners.set(name,fn)};
 const nodes=new Map<string,any>();
 const local=new Map<string,string>();
 const submitted:{mode:string;sceneId:string;instruction:string;reviewSource?:{reviewId:string;targetId:string}}[]=[];
 const touched=['document','window','location','history','localStorage','requestAnimationFrame','fetch'];
 const descriptors=new Map(touched.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const install=(key:string,value:unknown)=>Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 const settle=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,0));expect(predicate()).toBe(true);};
 const click=(data:Record<string,string>)=>{const button={dataset:data,disabled:false,closest:()=>button};listeners.get('click')!({target:button});};
 try{
  install('document',{querySelector:(selector:string)=>{if(selector==='#app')return root;if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',hidden:false,disabled:false,focus:()=>{},classList:{toggle:()=>{}}});return nodes.get(selector);},querySelectorAll:()=>[],activeElement:null});
  install('window',{addEventListener:()=>{},confirm:()=>true});install('location',{hash:'',pathname:'/'});install('history',{replaceState:()=>{}});
  install('localStorage',{getItem:(key:string)=>local.get(key)??null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)});
  install('requestAnimationFrame',(fn:()=>void)=>{fn();return 0;});
  install('fetch',async(input:string|URL|Request,options?:RequestInit)=>{
   const url=String(input);
   if(url==='/api/auth/session')return json({email:'owner@example.test',csrf:'test-csrf'});
   if(url==='/api/status')return json({mode:'live',modelLabel:'Test provider'});
   if(url==='/api/projects')return json([state.project]);
   if(url==='/api/projects/project-1')return json(state);
   if(url==='/api/reviews/review-1/verify'){const latest=disproved(old);state.reviews.push(latest);return json(latest);}
   if(url==='/api/revisions/revision-1/rewrite'){
    const body=JSON.parse(String(options?.body));submitted.push(body);
    const next={...source,id:`revision-${submitted.length+1}`,parentId:source.id,kind:'rewrite' as const,instruction:body.instruction};state.revisions.push(next);return json(next);
   }
   throw new Error('Unexpected app request: '+url);
  });
  const appModule=new URL('../web/app.ts?rewrite-lifecycle-test',import.meta.url).href;
  await import(appModule);
  await settle(()=>root.innerHTML.includes('script-paper'));
  click({action:'tab',id:'review'});
  click({action:'use-suggestion',reviewId:old.id,target:'assessment:story',scene:'s1'});
  expect(root.innerHTML).toContain(old.assessments[0]!.suggestedFix!);
  click({action:'rewrite',mode:'live'});
  await settle(()=>submitted.length===1&&root.innerHTML.includes('改稿候选已保存'));
  expect(submitted[0]).toEqual({mode:'live',sceneId:'s1',instruction:old.assessments[0]!.suggestedFix!,reviewSource:{reviewId:old.id,targetId:'assessment:story'}});
  click({action:'select-revision',id:'revision-1'});click({action:'tab',id:'review'});
  click({action:'use-suggestion',reviewId:old.id,target:'assessment:story',scene:'s1'});
  click({action:'verify-review'});
  await settle(()=>root.innerHTML.includes('解释核实已另存为新记录'));
  expect(root.innerHTML).toContain('这段修改意图来自已失效');
  // Deliberately bypass the rendered disabled button to prove the submit handler rechecks provenance.
  click({action:'rewrite',mode:'live'});
  await new Promise(r=>setTimeout(r,0));expect(submitted).toHaveLength(1);
  expect(root.innerHTML).toContain('这段修改意图来自已失效');
  listeners.get('input')!({target:{id:'rewrite-instruction',name:'',dataset:{},value:'Keep the automated interval; revise only the final request.'}});
  click({action:'rewrite',mode:'live'});
  await settle(()=>submitted.length===2&&root.innerHTML.includes('改稿候选已保存'));
  expect(submitted[1]).toEqual({mode:'live',sceneId:'s1',instruction:'Keep the automated interval; revise only the final request.'});
  expect(submitted[1]!.reviewSource).toBeUndefined();
 }finally{
  for(const key of touched){const descriptor=descriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
});
