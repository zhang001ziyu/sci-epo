import {describe,expect,test} from 'bun:test';
import {buildModelMessages,getReviewSources,parseCausalAudit,parseReview,snapshotContext} from '../src/core';
import {createEvidenceReader} from '../src/core/evidence';
import {sourceLineIndex} from '../src/core/reviewVerification';
import {DIMENSIONS,type Evidence,type Revision} from '../src/types';

function fixture(){
 const scenes=[
  {id:'s1',heading:'INT. FARM — NIGHT',content:"BOLT (CONT'D)\nTen days in here, Nia.\nA warning light dims.",locked:false},
  {id:'s2',heading:'INT. BAY — DAY\nCONTINUOUS',content:'NIA\nShe chooses the reduced shipment.\nEighty credits toward the deposit.',locked:false},
  {id:'s3',heading:'INT. AIRLOCK — LATER',content:'BOLT\nThe mesh stays folded.',locked:false}
 ];
 const context=snapshotContext({title:'Clock harvest',premise:'She chooses the reduced shipment.\nNo one is trapped.',characters:'BOLT chooses his own time.\nNIA can work alone.',worldRules:'The rate can always return to 1x.',authorRules:'Keep the ordinary choices.'},[
  {episodeId:'earlier',ordinal:1,revisionId:'old',title:'The old harvest',scenes:[{id:'s1',heading:'OLD FARM',content:"BOLT (CONT'D)\nThe old valve closes.",locked:false}]}
 ]);
 const revision:Revision={id:'r1',episodeId:'episode',parentId:null,title:'The harvest',logline:'A voluntary choice.',scenes,context,kind:'generated',instruction:'',mode:'live',createdAt:'2026-11-07T00:00:00Z'};
 const sources=getReviewSources(revision),index=sourceLineIndex(sources);
 const line=(sourceId:string,quote:string)=>{const row=index.find(r=>r.sourceId===sourceId&&r.quote===quote);if(!row)throw new Error(`Missing fixture line ${sourceId}: ${quote}`);return row;};
 const brief=line('brief','She chooses the reduced shipment.'),speaker=line('scene:s1',"BOLT (CONT'D)"),choice=line('scene:s2','She chooses the reduced shipment.');
 const pair=(source=brief,draft=choice)=>({sourceRef:source.refId,draftRef:draft.refId});
 const canonical=(source=brief,draft=choice):Evidence=>({sourceId:source.sourceId,sourceQuote:source.quote,sceneId:draft.sourceId.slice('scene:'.length),draftQuote:draft.quote,sourceRef:source.sourceRef,draftRef:draft.sourceRef});
 const reviews=()=>({assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'A structurally grounded test opinion, not proof of literary quality.',evidence:[pair()]}))});
 const causal=()=>({checks:revision.scenes.map(s=>({sceneId:s.id,state:'The characters can choose.',choice:'They wait voluntarily.',alternative:'They can leave.',obstacleKind:'none',verdict:'not_applicable',explanation:'There is no claim that leaving is impossible.',evidence:[pair(brief,line(`scene:${s.id}`,s.content.split('\n')[0]!))],constraintEvidence:[]})),pressures:[]});
 return {revision,sources,index,line,brief,speaker,choice,pair,canonical,reviews,causal,read:createEvidenceReader(revision,sources)};
}

describe('exact short references for original reviews',()=>{
 test('both review stages receive the same frozen line directory with complete source text',()=>{
  const f=fixture(),before=JSON.stringify(f.revision),context=snapshotContext({...f.revision.context.brief,premise:'Mutable unrelated new premise.'},[]);
  const payloads=[undefined,'causality' as const].map(reviewPass=>JSON.parse(buildModelMessages({kind:'review',reviewPass,context,revision:f.revision,episodeTitle:f.revision.title})[1]!.content));
  const expected=f.index.map(({sourceRef:_canonical,...row})=>row);
  for(const p of payloads){expect(p.sourceLineIndex).toEqual(expected);expect(p.sources).toEqual(f.sources);expect(p.script.scenes).toEqual(f.revision.scenes);expect(JSON.stringify(p)).not.toContain('Mutable unrelated new premise.');}
  expect(payloads[0].requiredDimensions).toEqual(DIMENSIONS);expect(payloads[1].requiredSceneIds).toEqual(['s1','s2','s3']);
  expect(payloads[0].sourceLineIndex).toEqual(payloads[1].sourceLineIndex);expect(JSON.stringify(f.revision)).toBe(before);
 });

 test('short references resolve exact four fields and canonical metadata without rewriting She or speaker punctuation',()=>{
  const f=fixture(),before=JSON.stringify(f.revision);
  expect(f.read(f.pair())).toEqual(f.canonical());
  expect(f.read(f.pair(f.speaker,f.speaker),'s1')).toEqual(f.canonical(f.speaker,f.speaker));
  expect(f.read(f.pair(f.brief,f.speaker),'s1')).toMatchObject({sourceQuote:'She chooses the reduced shipment.',draftQuote:"BOLT (CONT'D)"});
  const wire=f.reviews();wire.assessments[0]!.evidence=[f.pair(f.brief,f.speaker)];
  const review=parseReview(JSON.stringify(wire),f.revision);
  expect(review.errors).toEqual([]);expect(review.assessments).toHaveLength(5);expect(review.assessments[0]!.evidence[0]).toEqual(f.canonical(f.brief,f.speaker));
  const causal=parseCausalAudit(JSON.stringify(f.causal()),f.revision);
  expect(causal.errors).toEqual([]);expect(causal.checks).toHaveLength(3);expect(causal.checks[0]!.evidence[0]).toEqual(f.canonical(f.brief,f.speaker));
  expect(JSON.stringify(f.revision)).toBe(before);
 });

 test('source reference may bind brief, current scene or accepted history while draft always binds a current scene',()=>{
  const f=fixture(),historic=f.line('history:earlier:s1','The old valve closes.');
  for(const source of [f.brief,f.speaker,historic])expect(f.read(f.pair(source,f.choice))).toEqual(f.canonical(source,f.choice));
  for(const forbidden of [f.brief,historic,f.line('characters','BOLT chooses his own time.'),f.line('synopsis','The harvest')])expect(f.read(f.pair(f.brief,forbidden))).toBeUndefined();
  expect(f.read(f.pair(),'s1')).toBeUndefined();expect(f.read(f.pair(),'s2')).toEqual(f.canonical());
 });

 test('draft references reject every heading line, including a multiline heading, but accept the first body line',()=>{
  const f=fixture();
  for(const [sourceId,heading] of [['scene:s1','INT. FARM — NIGHT'],['scene:s2','INT. BAY — DAY'],['scene:s2','CONTINUOUS'],['scene:s3','INT. AIRLOCK — LATER']])expect(f.read(f.pair(f.brief,f.line(sourceId!,heading!)))).toBeUndefined();
  const body=f.line('scene:s2','NIA');expect(body.line).toBe(3);expect(f.read(f.pair(f.brief,body),'s2')).toEqual(f.canonical(f.brief,body));
 });

 test('unknown, lowercase, padded and partial reference IDs are rejected instead of normalized',()=>{
  const f=fixture();
  for(const ref of ['R999999',f.brief.refId.toLowerCase(),` ${f.brief.refId}`,`${f.brief.refId} `,f.brief.refId.replace('R','R0'),'',null,42,{},[]]){
   expect(f.read({sourceRef:ref,draftRef:f.choice.refId})).toBeUndefined();
   expect(f.read({sourceRef:f.brief.refId,draftRef:ref})).toBeUndefined();
  }
  expect(f.read({sourceRef:f.brief.refId})).toBeUndefined();expect(f.read({draftRef:f.choice.refId})).toBeUndefined();
 });

 test('explicit source, scene and text fields may corroborate short refs but cannot conflict or repair wording',()=>{
  const f=fixture(),full=f.canonical(),base={...full,...f.pair()};
  expect(f.read(base)).toEqual(full);
  for(const conflict of [{sourceId:'characters'},{sceneId:'s1'},{sourceQuote:'Nia chooses the reduced shipment.'},{draftQuote:'Nia chooses the reduced shipment.'},{sourceQuote:null},{draftQuote:''}])expect(f.read({...base,...conflict})).toBeUndefined();
  expect(f.read({...f.pair(f.speaker,f.speaker),sourceQuote:'BOLT'})).toBeUndefined();
  expect(f.read({...f.pair(f.speaker,f.speaker),draftQuote:'BOLT (CONT’D)'})).toBeUndefined();
  expect(f.read({...f.pair(f.speaker,f.speaker),draftQuote:'BOLT (CONT\'D) '})).toBeUndefined();
 });

 test('persisted canonical metadata is revalidated and cannot be used as a second shorthand',()=>{
  const f=fixture(),full=f.canonical();
  expect(f.read(JSON.parse(JSON.stringify(full)))).toEqual(full);
  const forged=[
   {sourceRef:f.brief.sourceRef,draftRef:f.choice.sourceRef},
   {...full,sourceQuote:'Nia chooses the reduced shipment.'},
   {...full,draftQuote:'Nia chooses the reduced shipment.'},
   {...full,sourceRef:f.speaker.sourceRef},
   {...full,draftRef:f.speaker.sourceRef},
   {...full,sourceRef:f.brief.sourceRef.replace('line:brief:','line:characters:')},
   {...full,draftRef:f.choice.sourceRef.replace('scene%3As2','scene:s2')},
   {...full,sourceRef:f.brief.refId},
   {...full,draftRef:f.choice.refId},
   {...full,sourceRef:null},
   {...full,draftRef:null}
  ];
  for(const evidence of forged){
   expect(f.read(evidence)).toBeUndefined();
   const response=f.reviews();response.assessments[0]!.evidence=[evidence as ReturnType<typeof f.pair>];
   const parsed=parseReview(JSON.stringify(response),f.revision);expect(parsed.status).toBe('needs_review');expect(parsed.assessments.some(a=>a.dimension==='story')).toBe(false);
  }
  const causal=parseCausalAudit(JSON.stringify(f.causal()),f.revision);
  expect(parseCausalAudit(JSON.stringify(causal),f.revision).checks).toEqual(causal.checks);
  causal.checks[0]!.evidence[0]!.draftRef=f.choice.sourceRef;
  expect(parseCausalAudit(JSON.stringify(causal),f.revision).checks.some(c=>c.sceneId==='s1')).toBe(false);
 });

 test('legacy four-key evidence remains exact, and text is not an alias for sourceQuote',()=>{
  const f=fixture(),{sourceRef:_s,draftRef:_d,...legacy}=f.canonical();
  expect(f.read(legacy)).toEqual(legacy);
  const response=f.reviews();for(const row of response.assessments)row.evidence=[legacy as unknown as ReturnType<typeof f.pair>];
  const parsed=parseReview(JSON.stringify(response),f.revision);expect(parsed.errors).toEqual([]);expect(parsed.assessments[0]!.evidence[0]).toEqual(legacy);
  const {sourceQuote:quote,...rest}=legacy;
  expect(f.read({...rest,text:quote})).toBeUndefined();expect(f.read({...legacy,sourceQuote:quote.replace('She','Nia')})).toBeUndefined();
  const causal=f.causal();for(const c of causal.checks){const draft=f.line(`scene:${c.sceneId}`,f.revision.scenes.find(s=>s.id===c.sceneId)!.content.split('\n')[0]!);const {sourceRef:_,draftRef:__,...e}=f.canonical(f.brief,draft);c.evidence=[e as unknown as ReturnType<typeof f.pair>];}
  expect(parseCausalAudit(JSON.stringify(causal),f.revision).errors).toEqual([]);
 });

 test('a correct reference does not excuse missing dimensions, missing causal scenes or missing constraint evidence',()=>{
  const f=fixture(),review=f.reviews();review.assessments.pop();expect(parseReview(JSON.stringify(review),f.revision).status).toBe('needs_review');
  const causal=f.causal();causal.checks.pop();expect(parseCausalAudit(JSON.stringify(causal),f.revision).errors.some(e=>e.includes('s3'))).toBe(true);
  const unsupported=f.causal();unsupported.checks[0]!.verdict='supported';
  const parsed=parseCausalAudit(JSON.stringify(unsupported),f.revision);expect(parsed.status).toBe('needs_review');expect(parsed.checks.some(c=>c.sceneId==='s1')).toBe(false);
  const wrongScene=f.causal();wrongScene.checks[0]!.evidence=[f.pair()];
  expect(parseCausalAudit(JSON.stringify(wrongScene),f.revision).checks.some(c=>c.sceneId==='s1')).toBe(false);
 });

 test('resolved cross-scene sources authorize only the explicitly cited edit scene in both stages',()=>{
  const f=fixture(),review=f.reviews(),row=review.assessments[0]!;
  Object.assign(row,{status:'issue',issueType:'fact_conflict',suggestedFix:'Clarify the first scene.',suggestedSceneId:'s1',evidence:[f.pair(f.speaker,f.choice)]});
  const parsed=parseReview(JSON.stringify(review),f.revision);expect(parsed.errors).toEqual([]);expect(parsed.assessments[0]!.suggestedSceneId).toBe('s1');
  Object.assign(row,{suggestedSceneId:'s3'});expect(parseReview(JSON.stringify(review),f.revision).assessments.some(a=>a.dimension==='story')).toBe(false);
  Object.assign(row,{suggestedSceneId:'s2',evidence:[f.pair(f.choice,f.choice)]});expect(parseReview(JSON.stringify(review),f.revision).errors.some(e=>e.includes('不能只用本场正文'))).toBe(true);
  const causal=f.causal(),check=causal.checks[0]!;
  Object.assign(check,{verdict:'gap',suggestedFix:'Clarify the second scene.',suggestedSceneId:'s2',evidence:[f.pair(f.choice,f.speaker)]});
  const good=parseCausalAudit(JSON.stringify(causal),f.revision);expect(good.errors).toEqual([]);expect(good.checks[0]!.suggestedSceneId).toBe('s2');
  Object.assign(check,{suggestedSceneId:'s3'});expect(parseCausalAudit(JSON.stringify(causal),f.revision).checks.some(c=>c.sceneId==='s1')).toBe(false);
 });

 test('pressure evidence inherited from causal checks retains canonical refs and its scene and edit-scope boundaries',()=>{
  const f=fixture(),causal=f.causal(),pressure={sceneId:'s1',trigger:'The next batch waits.',threatenedOutcome:'A smaller payment.',currentState:'The door can open.',directAlternative:'Leave voluntarily.',verdict:'background',explanation:'This is background, not an impossible choice.',blockingEvidence:[]};
  const parsed=parseCausalAudit(JSON.stringify({...causal,pressures:[pressure]}),f.revision);
  expect(parsed.errors).toEqual([]);expect(parsed.pressures![0]!.evidence).toEqual(parsed.checks[0]!.evidence);expect(parsed.pressures![0]!.evidence[0]!.draftRef).toBe(f.speaker.sourceRef);
  const wrong={...pressure,evidence:[f.pair()]};expect(parseCausalAudit(JSON.stringify({...causal,pressures:[wrong]}),f.revision).pressures).toEqual([]);
  const scope={...pressure,suggestedFix:'Clarify the third scene.',suggestedSceneId:'s3'};expect(parseCausalAudit(JSON.stringify({...causal,pressures:[scope]}),f.revision).pressures).toEqual([]);
 });
});
