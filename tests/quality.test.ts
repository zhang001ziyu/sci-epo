import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildModelMessages, parseCausalAudit, parseReview, snapshotContext } from '../src/core';
import { checkLength, countScript, parseLengthTarget, resolveLengthTarget } from '../src/core/length';
import { DIMENSIONS, type Brief, type Revision } from '../src/types';
import { causalityView, lengthView } from '../web/quality';

const brief:Brief={title:'Transfer',premise:'A courier chooses what to keep.',characters:'Jo and Kit',worldRules:'One parcel; no copies.',authorRules:'A quiet ending is allowed.',language:'en',lengthTarget:{min:20,max:40,unit:'words'}};
const scenes=[{id:'a',heading:'COUNTER',content:'Jo holds the parcel outside the locked vault. Kit waits beside the exit.',locked:false},{id:'b',heading:'EXIT',content:'KIT: Cancel the vault cycle or the parcel is gone. Jo keeps holding it.',locked:false}];
const revision=():Revision=>({id:'r',episodeId:'e',parentId:null,title:'Transfer',logline:'A choice.',scenes:structuredClone(scenes),context:snapshotContext(brief,[]),kind:'generated',instruction:'',mode:'live',language:'en',createdAt:'2026-11-06T00:00:00Z'});
function audit(){return {pressures:[],checks:scenes.map((s,i)=>({sceneId:s.id,state:i?'Jo still holds the parcel outside.':'Jo has the parcel.',choice:i?'Cancel a vault cycle.':'Wait at the counter.',obstacleKind:i?'physical':'none',alternative:'Walk away with the parcel.',verdict:i?'gap':'not_applicable',explanation:i?'The vault cycle has no established effect on the parcel already outside.':'This scene establishes possession without claiming a physical dilemma.',suggestedFix:i?'Remove the unsupported threat in this scene or establish a real restriction before it matters.':undefined,evidence:[{sourceId:'scene:a',sourceQuote:scenes[0]!.content,sceneId:s.id,draftQuote:s.content}],constraintEvidence:[]}))};}
const broad=()=>({assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'No issue reported by the broad critic.',evidence:[{sourceId:'scene:a',sourceQuote:scenes[0]!.content,sceneId:'b',draftQuote:scenes[1]!.content}]}))});

describe('measurable screenplay length',()=>{
 test('the actual 0.2.2 missed regression cannot remain complete despite all five no_issue verdicts',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/lost-property-oversize.json',import.meta.url),'utf8'));
  const review=parseReview(JSON.stringify(fixture.legacyReview),fixture.revision);
  expect(review.assessments).toHaveLength(5);expect(review.assessments.every(a=>a.status==='no_issue')).toBe(true);
  expect(review.lengthCheck?.count).toBe(850);expect(review.lengthCheck?.target?.max).toBe(650);
  expect(review.status).toBe('needs_review');expect(review.errors).toEqual([]);
 });
 test('counts only body with a documented Unicode rule and inclusive boundaries',()=>{
  expect(countScript([{content:"JO: Don't re-enter 7 rooms. — ...\n\t Wait."}],'words')).toBe(6);
  expect(countScript([{content:'阿渡： 好。\n 🚀'}],'characters')).toBe(6);
  const b={...brief,lengthTarget:{min:2,max:3,unit:'words' as const}};
  for(const [content,status] of [['one','too_short'],['one two','within_range'],['one two three','within_range'],['one two three four','too_long']] as const)expect(checkLength(b,[{content}]).status).toBe(status);
 });
 test('legacy explicit episode range is recognized; ambiguous scopes do not silently pass',()=>{
  const b={...brief,lengthTarget:undefined,premise:'Write 450–650 words in 3 scenes.'};
  expect(resolveLengthTarget(b)).toEqual({target:{min:450,max:650,unit:'words'},source:'brief'});
  expect(checkLength({...b,authorRules:'Write 800-900 words.'},[]).status).toBe('ambiguous');
  expect(checkLength({...b,premise:'Write 450–650 words per scene.'},[]).status).toBe('ambiguous');
  expect(resolveLengthTarget({...b,premise:'A 90 minute episode.'})).toEqual({source:'none'});
  expect(resolveLengthTarget({...b,lengthTarget:{min:10,max:20,unit:'words'}}).source).toBe('structured');
  expect(resolveLengthTarget({...b,premise:'全剧本 300到500 字。'}).target?.unit).toBe('characters');
 });
 test('invalid targets rejected and targets participate in frozen context',()=>{
  for(const target of [{min:0,max:4,unit:'words'},{min:10,max:2,unit:'words'},{min:2.5,max:3,unit:'words'},{min:2,max:3,unit:'tokens'}])expect(()=>parseLengthTarget(target)).toThrow();
  const mutable=structuredClone(brief),snapshot=snapshotContext(mutable,[]);mutable.lengthTarget!.max=50;
  expect(snapshot.brief.lengthTarget!.max).toBe(40);expect(snapshot.hash).not.toBe(snapshotContext(mutable,[]).hash);
 });
 test('five positive dimensions cannot override a deterministic length violation',()=>{
  const r=revision();r.context=snapshotContext({...brief,lengthTarget:{min:2,max:3,unit:'words'}},[]);
  const review=parseReview(JSON.stringify(broad()),r);
  expect(review.lengthCheck?.status).toBe('too_long');expect(review.status).toBe('needs_review');expect(review.errors).toEqual([]);
  expect(lengthView(r.context.brief,r.scenes)).toContain('超出');
 });
 test('generation gets explicit budget; local rewrite gets budget remaining after untouched scenes',()=>{
  const r=revision();
  const generation=buildModelMessages({kind:'generate',context:r.context,episodeTitle:r.title});
  expect(generation[0]!.content).toContain('20–40');
  const rewrite=buildModelMessages({kind:'rewrite',revision:r,sceneId:'b',instruction:'Clarify the choice.',context:r.context,episodeTitle:r.title});
  expect(rewrite[0]!.content).toContain(`其他场景已占 ${countScript([r.scenes[0]!],'words')}`);
 });
});

describe('independent causal evidence',()=>{
 test('causal and pressure fixes preserve an explicit source-scene scope, independent of the scene containing the issue',()=>{
  const r=revision(),a=audit();
  Object.assign(a.checks[1]!,{suggestedSceneId:'a'});
  const p={sceneId:'b',trigger:'Vault cycle completes.',threatenedOutcome:'Parcel destroyed.',currentState:'Jo is outside.',directAlternative:'Leave.',verdict:'gap',explanation:'The parcel is outside.',blockingEvidence:[],suggestedFix:'Clarify possession at the counter.',suggestedSceneId:'a'};
  const parsed=parseCausalAudit(JSON.stringify({...a,pressures:[p]}),r);
  expect(parsed.errors).toEqual([]);expect(parsed.checks[1]!.sceneId).toBe('b');expect(parsed.checks[1]!.suggestedSceneId).toBe('a');
  expect(parsed.pressures![0]!.suggestedSceneId).toBe('a');
  const legacy=parseCausalAudit(JSON.stringify(audit()),r);
  expect(legacy.errors).toEqual([]);expect(legacy.checks[1]!.suggestedSceneId).toBeUndefined();
  for(const scope of [null,'','missing',['a','b']]){
   Object.assign(a.checks[1]!,{suggestedSceneId:scope});
   expect(parseCausalAudit(JSON.stringify(a),r).errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
   expect(parseCausalAudit(JSON.stringify({...audit(),pressures:[{...p,suggestedSceneId:scope}]}),r).errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
  }
  const unrelated=structuredClone(audit());unrelated.checks[1]!.evidence[0]!.sourceId='scene:b';unrelated.checks[1]!.evidence[0]!.sourceQuote=r.scenes[1]!.content;
  Object.assign(unrelated.checks[1]!,{suggestedSceneId:'a'});
  expect(parseCausalAudit(JSON.stringify(unrelated),r).errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
 });
 test('an irrelevant physical cost remains a gap even when every character choice is supported',()=>{
  const r=revision(),a=audit();
  a.checks=a.checks.map(c=>({...c,obstacleKind:'emotional',verdict:'supported',constraintEvidence:[{sourceId:'scene:'+c.sceneId,quote:r.scenes.find(s=>s.id===c.sceneId)!.content}]})) as typeof a.checks;
  const p={sceneId:'b',trigger:'Vault cycle completes.',threatenedOutcome:'Parcel destroyed.',currentState:'Jo holds the parcel outside.',directAlternative:'Leave with the parcel without cancelling the vault.',verdict:'gap',explanation:'The cycle cannot reach the parcel outside; a cost to cancel is not a cost to keep it.',evidence:[{sourceId:'scene:a',sourceQuote:scenes[0]!.content,sceneId:'b',draftQuote:scenes[1]!.content}],blockingEvidence:[],suggestedFix:'Remove the false necessity of cancellation in scene b.'};
  const parsed=parseCausalAudit(JSON.stringify({...a,pressures:[p]}),r);
  expect(parsed.errors).toEqual([]);expect(parsed.checks.every(c=>c.verdict==='supported')).toBe(true);expect(parsed.status).toBe('needs_review');
  expect(parseReview(JSON.stringify(broad()),r,parsed).status).toBe('needs_review');
  expect(parseCausalAudit(JSON.stringify({...a,pressures:[{...p,verdict:'binding'}]}),r).errors.length).toBeGreaterThan(0);
  const {evidence:_quotes,...linked}=p;
  expect(parseCausalAudit(JSON.stringify({...a,pressures:[linked]}),r).pressures?.[0]?.evidence).toEqual(a.checks[1]!.evidence);
  const missing={checks:a.checks};expect(parseCausalAudit(JSON.stringify(missing),r).status).toBe('needs_review');
 });
 test('cross-scene gap survives a unanimous positive broad review and has a usable rewrite target',()=>{
  const r=revision(),a=parseCausalAudit(JSON.stringify(audit()),r),review=parseReview(JSON.stringify(broad()),r,a);
  expect(a.errors).toEqual([]);expect(a.checks[1]!.verdict).toBe('gap');expect(review.status).toBe('needs_review');
  const html=causalityView({...review,id:'rv',revisionId:r.id,mode:'live',createdAt:r.createdAt});
  expect(html).toContain('因果缺口');expect(html).toContain('data-scene="b"');expect(html).toContain('Walk away with the parcel.');
 });
 test('unsupported approval, missing scenes, invented quotes and mislabeled scenes fail closed',()=>{
  const r=revision();
  const variants=[audit(),audit(),audit(),audit()];
  variants[0]!.checks[1]!.verdict='supported';
  variants[1]!.checks.pop();
  variants[2]!.checks[1]!.evidence[0]!.sourceQuote='The parcel is inside the vault.';
  variants[3]!.checks[1]!.evidence[0]!.sceneId='a';
  for(const v of variants){const result=parseCausalAudit(JSON.stringify(v),r);expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);}
  expect(parseCausalAudit('{}',r).status).toBe('needs_review');
 });
 test('a calm emotional choice is not forcibly converted to a physical plot hole',()=>{
  const r=revision();r.scenes[1]!.content='KIT: Keep it if you want. Jo leaves the parcel on the counter and goes home.';
  const a=audit();a.checks[1]={...a.checks[1]!,obstacleKind:'emotional',verdict:'not_applicable',explanation:'Keeping it is possible; Jo voluntarily leaves it. No false necessity is claimed.',evidence:[{sourceId:'scene:b',sourceQuote:r.scenes[1]!.content,sceneId:'b',draftQuote:r.scenes[1]!.content}]};
  const result=parseCausalAudit(JSON.stringify(a),r);
  expect(result.errors).toEqual([]);expect(result.status).toBe('completed');
 });
 test('causal prompt is independent and UI treats model text as text',()=>{
  const r=revision(),messages=buildModelMessages({kind:'review',reviewPass:'causality',revision:r,context:r.context,episodeTitle:r.title});
  expect(messages[0]!.content).toContain('constraintEvidence');expect(messages[1]!.content).not.toContain('assessments');
  const a=audit();a.checks[0]!.state='<script>alert(1)</script>';
  const review=parseReview(JSON.stringify(broad()),r,parseCausalAudit(JSON.stringify(a),r));
  const html=causalityView({...review,id:'rv',revisionId:r.id,mode:'live',createdAt:r.createdAt});
  expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
 });
});
