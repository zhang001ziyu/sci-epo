import { describe, expect, test } from 'bun:test';
import { buildModelMessages, getReviewSources, snapshotContext } from '../src/core';
import {
  buildVerificationMessages, parseReviewVerification, reviewTargets, timelineTargets, type TimelineFact,
  buildVerificationFacts, parseVerificationFacts, buildVerificationAudit, parseVerificationAudit, verificationAuditTargets,
  failedVerificationFacts, failedVerificationAudit, verificationFieldTargets, auditBatches, parseVerificationAuditBatch, sourceLineIndex, type VerificationFacts,
} from '../src/core/reviewVerification';
import { DIMENSIONS, type Review, type Revision } from '../src/types';
import { reviewSuggestion, reviewTargetSupported } from '../src/core/reviewSuggestions';
import {inferenceTargets} from '../src/core/inferenceProof';
import {neutralProofs} from './inference-fixtures';

test('fenced JSON binds inference proofs through the same wrapper contract as audit fields',()=>{
 const r=revision(),d=draft(r),f=facts(r,d),ids=['causal:0'],all=auditWire(r,d,f),fields=verificationFieldTargets(d,f).filter(t=>ids.includes(t.parentId));
 const output={checks:all.checks.filter(c=>ids.includes(c.targetId)),fieldChecks:all.fieldChecks.filter(c=>fields.some(f=>f.id===c.targetId)),inferenceProofs:neutralProofs(inferenceTargets(fields))};
 const plain=parseVerificationAuditBatch(JSON.stringify(output),r,d,f,getReviewSources(r),ids,true);
 const fenced=parseVerificationAuditBatch('```json\n'+JSON.stringify(output)+'\n```',r,d,f,getReviewSources(r),ids,true);
 expect(plain.errors).toEqual([]);expect(fenced).toEqual(plain);
});
test('calibrating an unsupported identity contradiction preserves the original model parent',()=>{
 const r=revision(),d=draft(r);d.causality!.checks[0]!.state='物件必定放在另一个工作台。';
 const f=facts(r,d),ids=['causal:0'],all=auditWire(r,d,f),fields=verificationFieldTargets(d,f).filter(t=>ids.includes(t.parentId));
 const proofs=neutralProofs(inferenceTargets(fields));for(const p of proofs){p.counterexamplePossible=true;p.explanation='The locations may be the same surface.';}
 const parent={...all.checks.find(c=>c.targetId==='causal:0')!,verdict:'contradicted',correction:'Move the box.'};parent.counterEvidence=parent.evidence;
 const raw=JSON.stringify({checks:[parent],fieldChecks:all.fieldChecks.filter(c=>fields.some(f=>f.id===c.targetId)),inferenceProofs:proofs});
 const result=parseVerificationAuditBatch(raw,r,d,f,getReviewSources(r),ids,true);
 expect(result.errors).toEqual([]);expect(result.checks[0]!.verdict).toBe('unsupported');expect(result.inferenceOriginalParents?.[0]?.verdict).toBe('contradicted');
 expect(result.inferenceOriginalParents?.[0]?.explanation).toBe(parent.explanation);expect(parent.verdict).toBe('contradicted');
});

// Exact excerpts from the real Borrowed Mornings V5 incident. No ignored
// artifacts or production database are required to run these regressions.
const elapsed = 'Eight hours outside, ten days in here. Did the vines overproduce?';
const automated = 'The first five days ran automated. Then the soft skins began clogging the chute.';
const labor = 'Clearing the remaining twenty-five kilos by hand is ninety minutes of lived labor.';
const conversion = 'Three corridor minutes at thirty times. You can turn the dial yourself.';
const refusal = 'Ninety minutes alone in here sweating syrup after an eight-hour shift. No. I want a shower and my own morning.';
const receipt = 'The terminal flashes: DISPATCH 35 KG CONFIRMED. CREDITS 175. OPS FEE 95. PUBLIC GARDEN DEPOSIT 80.';
const seedPlan = 'Thirty-five kilos base rate gives us one hundred and seventy-five credits. That pays the service fee and leaves eighty for seed stock.';
const chassis = 'He taps his chassis, dislodging dried rind.';
const quote = (sourceId: string, text: string) => ({ sourceId, quote: text });
const categories = ['timeline', 'accounting', 'agency', 'continuity', 'other'] as const;
type Draft = Pick<Review, 'assessments' | 'causality'>;
type Wire = {
  timelineFacts: Omit<TimelineFact, 'boundSource'>[];
  checks: {targetId:string; verdict:string; explanation:string; correction?:string; evidence:ReturnType<typeof quote>[]; counterEvidence:ReturnType<typeof quote>[]}[];
  omissions: {category:string; status:string; explanation:string; sceneIds:string[]; evidence:ReturnType<typeof quote>[]; suggestedFix?:string; suggestedSceneId?:string}[];
};

function revision(): Revision {
  return {
    id:'v5-regression', episodeId:'pilot', parentId:null, title:'Eight Hours, Ten Days',
    logline:'Elapsed time and additional labor are distinct.', kind:'manual', mode:'manual',
    instruction:'Regression excerpts', createdAt:'2026-11-06T00:00:00Z', language:'en',
    context:snapshotContext({title:'Borrowed Mornings', premise:'An operator chooses whether to work another shift.',
      characters:'Nia and Bolt can choose to stop or work.',
      worldRules:'All chamber occupants experience the same local rate. At 30x, eight corridor hours equal ten internal days. Either operator can stop the chamber.',
      authorRules:'A quiet voluntary choice is allowed.', language:'en'}, []),
    scenes:[
      {id:'s1',heading:'CHAMBER',content:`CHAMBER RATE 30x. ELAPSED: 240 HOURS.\nBolt taps STOP.\n${elapsed}\n${automated}\nTen days in here is enough.`,locked:false},
      {id:'s2',heading:'SORTING',content:`GRADED: 35 KG. FULL LOT 60 KG (400 CR) / PARTIAL LOT 35 KG (175 CR).\n45 CORRIDOR MINUTES REMAINING.\n${labor}\n${conversion}\nNIA\nI could.\n${refusal}`,locked:false},
      {id:'s3',heading:'CORRIDOR',content:`${receipt}\nBolt sets the unopened brood box on the corridor-side bench.`,locked:false},
    ],
  };
}

function draft(r = revision()): Draft {
  const evidence = (sceneId:string) => [{sourceId:`scene:${sceneId}`,sourceQuote:r.scenes.find(s=>s.id===sceneId)!.content,
    sceneId,draftQuote:r.scenes.find(s=>s.id===sceneId)!.content}];
  return {
    assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'The operator has an available option and makes a voluntary choice.',evidence:evidence('s2')})),
    causality:{status:'completed',errors:[],checks:r.scenes.map(s=>({sceneId:s.id,state:'Use only the recorded scene state.',
      choice:'Make the choice shown in this scene.',obstacleKind:'emotional',alternative:'The other option remains available.',
      verdict:'supported',explanation:'This is a preference, not physical incapacity.',evidence:evidence(s.id),
      constraintEvidence:[{sourceId:`scene:${s.id}`,quote:s.content}]})),
      pressures:[{sceneId:'s2',trigger:'Collection in 45 corridor minutes.',threatenedOutcome:'Full-lot premium, not survival or all revenue.',
        currentState:'35 kg graded; 25 kg remain.',directAlternative:'Ship the graded partial lot.',verdict:'background',
        explanation:'Partial delivery remains available.',evidence:evidence('s2'),blockingEvidence:[]}]},
  };
}

// These responses represent independent-verifier decisions. Tests prove the
// application gates/preserves those decisions; they do not prove an LLM can
// infer them. Real-model falsification is an additional acceptance step.
function wire(r = revision(), d = draft(r)): Wire {
  return {
    timelineFacts:timelineTargets(r).map(t=>({targetId:t.id,
      meaning:{subject:'The named speaker or display.',activity:'The activity described in the candidate line.',durationKind:'Elapsed time, labor or rate as explicitly stated.',clock:'The clock specified in the passage.',basis:'The displayed fact or character statement as written.'},
      status:'consistent',explanation:'This line was compared with the related time statements without treating elapsed time as labor.',
      evidence:[quote(t.sourceId,t.quote)]})),
    checks:reviewTargets(d).map(t=>({targetId:t.id,verdict:'supported',explanation:'The claim is supported by the supplied passage.',
      evidence:[quote(`scene:${t.sceneIds[0]??'s1'}`,r.scenes.find(s=>s.id===(t.sceneIds[0]??'s1'))!.content)],counterEvidence:[]})),
    omissions:categories.map(category=>({category,status:'no_issue',explanation:'The relevant facts were checked.',sceneIds:['s1','s2','s3'],
      evidence:[quote('scene:s1',r.scenes[0]!.content),quote('scene:s2',r.scenes[1]!.content),quote('scene:s3',r.scenes[2]!.content)]})),
  };
}
function parse(w:unknown, r = revision(), d = draft(r)) {
  return parseReviewVerification(JSON.stringify(w),r,d,getReviewSources(r));
}
function facts(r=revision(),d=draft(r)):VerificationFacts {
  const w=wire(r,d);
  return parseVerificationFacts(JSON.stringify({timelineFacts:w.timelineFacts,omissions:w.omissions}),r,getReviewSources(r));
}
const matchesField=(id:string,base:string)=>id===base||id.startsWith(`${base}@`);
function auditWire(r=revision(),d=draft(r),f=facts(r,d)) {
  const check=(t:{id:string;sceneIds:string[]})=>({targetId:t.id,verdict:'supported',explanation:'Every field was checked against the current source, without adding qualifications.',
    evidence:[quote(`scene:${t.sceneIds[0]??'s1'}`,r.scenes.find(s=>s.id===(t.sceneIds[0]??'s1'))!.content)],counterEvidence:[] as ReturnType<typeof quote>[],correction:undefined as string|undefined});
  return {fieldChecks:verificationFieldTargets(d,f).map(t=>({...check(t),claimQuote:t.claim})),checks:verificationAuditTargets(d,f).map(check)};
}

describe('independent source scan and whole-output audit',()=>{
  test('facts builder contains sources and every candidate but no original review; audit sees every untrusted field',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[0]!.state='UNSUPPORTED_REVIEW_SENTINEL';
    const sources=getReviewSources(r),messages=buildVerificationFacts(r,sources),payload=JSON.parse(messages[1]!.content);
    expect(payload.sources).toEqual(sources);expect(payload.targets).toBeUndefined();expect(payload.draftReview).toBeUndefined();
    expect(messages.map(m=>m.content).join('\n')).not.toContain('UNSUPPORTED_REVIEW_SENTINEL');
    expect(payload.timelineTargets.map((t:{id:string;quote:string})=>[t.id,t.quote])).toEqual(timelineTargets(r).map(t=>[t.id,t.quote]));
    const f=facts(r,d);f.timelineFacts[0]!.meaning.durationKind='UNSUPPORTED_CONTINUITY_SENTINEL';f.omissions[0]!.suggestedFix='UNSUPPORTED_FIX_SENTINEL';
    const audit=JSON.parse(buildVerificationAudit(r,d,f,sources)[1]!.content);
    expect(audit.targets.map((t:{id:string})=>t.id)).toEqual([...reviewTargets(d).map(t=>t.id),...f.timelineFacts.map(t=>t.targetId),...categories.map(c=>`omission:${c}`)]);
    expect(audit.targets.find((t:{id:string})=>t.id===f.timelineFacts[0]!.targetId).claim).toEqual(f.timelineFacts[0]);
    expect(audit.targets.find((t:{id:string})=>t.id==='omission:timeline').claim).toEqual(f.omissions[0]);
    expect(audit.fieldTargets).toEqual(verificationFieldTargets(d,f));
    const auditText=JSON.stringify(audit);
    for(const value of ['UNSUPPORTED_REVIEW_SENTINEL','UNSUPPORTED_CONTINUITY_SENTINEL','UNSUPPORTED_FIX_SENTINEL'])expect(auditText).toContain(value);
  });

  test('a valid two-stage audit keeps all checks but exposes only original review IDs in the compatibility array',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),w=auditWire(r,d,f);
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.status).toBe('completed');expect(result.audit?.status).toBe('completed');
    expect(result.audit?.checks).toHaveLength(verificationAuditTargets(d,f).length);
    expect(result.audit?.schemaVersion).toBe(5);
    expect(result.audit?.originalChecks).toEqual(result.audit?.checks);
    expect(result.audit?.fieldChecks).toHaveLength(verificationFieldTargets(d,f).length);
    expect(result.checks.map(c=>c.targetId)).toEqual(reviewTargets(d).map(t=>t.id));
    expect(result.timelineFacts).toEqual(f.timelineFacts);expect(result.omissions).toEqual(f.omissions);
  });

  test('unsupported continuous labor added by either the critic or the fact model is isolated without rewriting either source',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[0]!.state='Bolt worked continuously by hand for all ten days.';
    const f=facts(r,d),timeline=f.timelineFacts.find(t=>t.boundSource.quote===automated)!;
    timeline.meaning.durationKind='Ten days of continuous manual work.';
    const before=JSON.stringify({r,d,f}),w=auditWire(r,d,f);
    for(const targetId of ['causal:0',timeline.targetId]){
      Object.assign(w.checks.find(c=>c.targetId===targetId)!,{verdict:'unsupported',explanation:'The elapsed interval and automation do not establish uninterrupted labor.',
        correction:'Ten days elapsed and an initial interval was automated; actual manual labor and rest allocation remain unknown.',
        evidence:[quote('scene:s1',elapsed),quote('scene:s1',automated)]});
    }
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);expect(result.audit?.status).toBe('needs_review');
    expect(result.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
    expect(result.audit?.checks.find(c=>c.targetId===timeline.targetId)?.correction).toContain('unknown');
    expect(result.timelineFacts.find(t=>t.targetId===timeline.targetId)?.meaning.durationKind).toBe('Ten days of continuous manual work.');
    expect(JSON.stringify({r,d,f})).toBe(before);
  });

  test('omission fixes are audited as whole claims and a clean original review cannot cover their unsupported arithmetic',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),omission=f.omissions.find(o=>o.category==='timeline')!;
    Object.assign(omission,{status:'issue',explanation:'A proposed duration needs correction.',suggestedFix:'Replace the stated ninety minutes of labor with twenty hours.'});
    f.status='needs_review';
    const w=auditWire(r,d,f);
    Object.assign(w.checks.find(c=>c.targetId==='omission:timeline')!,{verdict:'unsupported',explanation:'The suggested duration is not established by the source.',
      correction:'Retain the real inconsistency but withdraw the invented replacement duration.',evidence:[quote('scene:s2',labor),quote('scene:s2',conversion)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.checks.every(c=>c.verdict==='supported')).toBe(true);expect(result.status).toBe('needs_review');
    expect(result.audit?.checks.find(c=>c.targetId==='omission:timeline')?.verdict).toBe('unsupported');
    expect(result.omissions.find(o=>o.category==='timeline')?.suggestedFix).toBe(omission.suggestedFix);
  });

  test('missing, duplicate, unknown and ungrounded audit targets fail closed while the complete fact scan survives',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    for(const mutate of [
      (w:ReturnType<typeof auditWire>)=>{w.checks.pop();},
      (w:ReturnType<typeof auditWire>)=>{w.checks.push(structuredClone(w.checks[0]!));},
      (w:ReturnType<typeof auditWire>)=>{w.checks[0]!.targetId='omission:unknown';},
      (w:ReturnType<typeof auditWire>)=>{w.checks[0]!.evidence=[quote('scene:s1','Invented uninterrupted labor.')];},
    ]){
      const w=auditWire(r,d,f);mutate(w);
      const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
      expect(result.status).toBe('needs_review');expect(result.audit?.errors.length).toBeGreaterThan(0);
      expect(result.errors).toEqual(result.audit!.errors);expect(result.timelineFacts).toEqual(f.timelineFacts);expect(result.omissions).toEqual(f.omissions);
    }
  });

  test('later clean output cannot erase earlier errors or substitute a new fact table',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    f.errors=['An invalid earlier row was discarded.'];f.status='needs_review';f.normalizationNotes=['Source scan syntax was normalized.'];
    const result=parseVerificationAudit(JSON.stringify({...auditWire(r,d,f),timelineFacts:[],omissions:[],status:'completed',errors:[]}),r,d,f,getReviewSources(r));
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual(f.errors);
    expect(result.audit?.status).toBe('completed');expect(result.timelineFacts).toEqual(f.timelineFacts);expect(result.omissions).toEqual(f.omissions);
    expect(result.normalizationNotes).toContain('Source scan syntax was normalized.');
  });

  test('malformed or absent independent audit keeps all valid facts and records the failure',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    const malformed=parseVerificationAudit('Huge count...',r,d,f,getReviewSources(r));
    const failed=failedVerificationAudit(r,d,f,'Independent audit transport failed.');
    for(const result of [malformed,failed]){
      expect(result.status).toBe('needs_review');expect(result.audit?.status).toBe('needs_review');expect(result.audit?.errors.length).toBeGreaterThan(0);
      expect(result.checks).toEqual([]);expect(result.timelineFacts).toEqual(f.timelineFacts);expect(result.omissions).toEqual(f.omissions);
    }
    const absent=failedVerificationFacts('Source scan failed.');
    expect(absent.status).toBe('needs_review');expect(absent.timelineFacts).toEqual([]);expect(absent.omissions).toEqual([]);
    expect(failedVerificationAudit(r,d,absent).errors).toContain('Source scan failed.');
  });

  test('audit target limits are explicit and no oversized coverage is silently truncated',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    f.timelineFacts=Array.from({length:2049},(_,i)=>({...structuredClone(f.timelineFacts[0]!),targetId:`timeline:s1:${i+1}`}));
    const result=parseVerificationAudit('{"checks":[]}',r,d,f,getReviewSources(r));
    expect(result.status).toBe('needs_review');expect(result.errors.some(e=>e.includes('2048'))).toBe(true);
    expect(result.timelineFacts).toHaveLength(2049);
  });
});

describe('causal and pressure field coverage',()=>{
  test('each causal/pressure text field is bound verbatim, including optional fixes',()=>{
    const d=draft();d.causality!.checks[0]!.suggestedFix='Retain the stated duration.';d.causality!.pressures![0]!.suggestedFix='Make the pressure relation explicit.';
    const targets=verificationFieldTargets(d);
    expect([...new Set(targets.filter(t=>t.parentId==='causal:0').map(t=>t.field))]).toEqual(['state','choice','alternative','explanation','suggestedFix']);
    expect([...new Set(targets.filter(t=>t.parentId==='pressure:0').map(t=>t.field))]).toEqual(['trigger','threatenedOutcome','currentState','directAlternative','explanation','suggestedFix']);
    expect(targets.filter(t=>t.parentId==='causal:0'&&t.field==='explanation').map(t=>t.claim).join('')).toBe(d.causality!.checks[0]!.explanation);
    for(const t of targets)expect(t.claim).toBe(t.fullClaim.slice(t.start,t.end));
    expect(targets.find(t=>t.id==='pressure:0#directAlternative')!.claim).toBe(d.causality!.pressures![0]!.directAlternative);
    expect(targets.filter(t=>t.parentId.startsWith('assessment:')).every(t=>t.field==='explanation')).toBe(true);
  });

  test('a parent supported verdict cannot hide an unsupported original explanation or alternative',()=>{
    const r=revision(),d=draft(r);
    d.causality!.checks[0]!.explanation='The text explicitly states ten days of continuous manual labor.';
    d.causality!.checks[0]!.alternative='Continue at 30x for several more days to finish the remaining fruit.';
    const f=facts(r,d),w=auditWire(r,d,f),before=JSON.stringify(w.checks);
    Object.assign(w.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#explanation'))!,{verdict:'unsupported',explanation:'Elapsed time is supported; continuous manual labor is not.',
      correction:'Ten days elapsed; the actual manual-work and rest allocation is unknown.',evidence:[quote('scene:s1',elapsed),quote('scene:s1',automated)]});
    Object.assign(w.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#alternative'))!,{verdict:'contradicted',explanation:'The stated remaining work is ninety lived minutes, not several days.',
      correction:'Use the stated ninety lived minutes and three corridor minutes.',evidence:[quote('scene:s2',labor)],counterEvidence:[quote('scene:s2',conversion)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.status).toBe('needs_review');expect(result.audit?.schemaVersion).toBe(5);
    expect(result.audit?.originalChecks.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
    const parent=result.checks.find(c=>c.targetId==='causal:0')!;
    expect(parent.verdict).toBe('contradicted');expect(parent.explanation).toContain('alternative');expect(parent.counterEvidence).toEqual([quote('scene:s2',conversion)]);
    expect(result.audit?.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#explanation'))?.verdict).toBe('unsupported');
    expect(JSON.stringify(w.checks)).toBe(before);
  });

  test('missing or duplicate field coverage holds the parent while preserving the original model answer',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    for(const mutate of [
      (w:ReturnType<typeof auditWire>)=>{w.fieldChecks=w.fieldChecks.filter(c=>!matchesField(c.targetId,'causal:0#explanation'));},
      (w:ReturnType<typeof auditWire>)=>{w.fieldChecks.push(structuredClone(w.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#explanation'))!));},
      (w:ReturnType<typeof auditWire>)=>{w.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#explanation'))!.evidence=[quote('scene:s1','Invented work.')];},
    ]){
      const w=auditWire(r,d,f);mutate(w);const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
      expect(result.status).toBe('needs_review');expect(result.audit?.errors.some(e=>e.includes('causal:0#explanation'))).toBe(true);
      expect(result.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('uncertain');
      expect(result.audit?.originalChecks.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
    }
  });

  test('a stronger model parent verdict is not softened by supported child fields',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),w=auditWire(r,d,f);
    const original=w.checks.find(c=>c.targetId==='causal:0')!;
    Object.assign(original,{verdict:'contradicted',correction:'Withdraw the unsupported premise.',counterEvidence:[quote('scene:s1',automated)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.checks.find(c=>c.targetId==='causal:0')).toEqual(result.audit?.originalChecks.find(c=>c.targetId==='causal:0'));
    expect(result.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('contradicted');
  });

  test('counterEvidence may be absent for noncontradicted decisions; null, malformed and missing contradiction evidence still fail',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),w=auditWire(r,d,f);
    for(const c of [...w.checks,...w.fieldChecks])delete (c as {counterEvidence?:unknown}).counterEvidence;
    const valid=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(valid.errors).toEqual([]);expect(valid.status).toBe('completed');
    expect([...valid.audit!.originalChecks,...valid.audit!.fieldChecks].every(c=>Array.isArray(c.counterEvidence)&&!c.counterEvidence.length)).toBe(true);
    for(const value of [null,'',{},[quote('scene:s1','Invented counterevidence.')]]){
      const bad=structuredClone(w);Object.assign(bad.fieldChecks[0]!,{counterEvidence:value});
      expect(parseVerificationAudit(JSON.stringify(bad),r,d,f,getReviewSources(r)).audit!.errors.length).toBeGreaterThan(0);
    }
    const contradicted=structuredClone(w);Object.assign(contradicted.fieldChecks[0]!,{verdict:'contradicted',correction:'Withdraw this premise.'});
    expect(parseVerificationAudit(JSON.stringify(contradicted),r,d,f,getReviewSources(r)).audit!.errors.length).toBeGreaterThan(0);
  });

  test('a dimensions-only review checks its explanations and omissions without inventing causal fields',()=>{
    const r=revision(),d=draft(r);delete d.causality;
    const f=facts(r,d),w=auditWire(r,d,f);
    expect(verificationFieldTargets(d).map(t=>t.id)).toEqual(DIMENSIONS.map(dim=>`assessment:${dim}#explanation`));
    expect(w.fieldChecks.some(c=>c.targetId.startsWith('causal:')||c.targetId.startsWith('pressure:'))).toBe(false);
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)).status).toBe('completed');
    const missing={checks:w.checks};expect(parseVerificationAudit(JSON.stringify(missing),r,d,f,getReviewSources(r)).status).toBe('needs_review');
    w.fieldChecks.push({...w.checks[0]!,targetId:'causal:0#explanation',claimQuote:'Unknown field.'});
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)).status).toBe('needs_review');
  });
});

describe('claim scope, state and proposal evidence boundaries',()=>{
  const proposal='Then we install mesh baffles. They need flowering forage, Nia, not an empty room.';
  const agreement='Fine. But if your bees learn to pick berries, they take your shift on the sorter.';
  const lockedCord="Bolt clicks a physical lock over his incubator's power cord, slipping the key ring onto his sensor mast.";
  const cart='Bolt wheels the small cart past the airlock threshold and hoists the vented container onto the metal work surface.';
  const unopened='Bolt sets an empty nursery tray beside the unopened brood box and pulls a netting sleeve over both.';
  function sceneFixture(content:string){
    const r=revision();r.scenes[2]!.content=content;
    const d=draft(r);
    return {r,d};
  }

  test('unsupported fields must identify actual original words rather than an invented attachment location',()=>{
    const {r,d}=sceneFixture(`${proposal}\n${agreement}\n${lockedCord}`);
    d.causality!.checks[2]!.state='Bolt已将保温箱推至南侧工作台并加装物理锁。';
    const f=facts(r,d),w=auditWire(r,d,f),field=w.fieldChecks.find(c=>matchesField(c.targetId,'causal:2#state'))!;
    Object.assign(field,{verdict:'contradicted',claimQuote:'锁在南侧工作台上',explanation:'The lock is on a cord, not attached to the bench.',
      correction:'Keep the cord location.',evidence:[quote('scene:s3',lockedCord)],counterEvidence:[quote('scene:s3',lockedCord)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors.some(e=>e.includes('causal:2#state')&&e.includes('争议片段'))).toBe(true);
    expect(result.audit!.fieldChecks.some(c=>c.targetId===field.targetId)).toBe(false);
    expect(result.checks.find(c=>c.targetId==='causal:2')!.verdict).toBe('uncertain');
    expect(result.audit!.originalChecks.find(c=>c.targetId==='causal:2')!.verdict).toBe('supported');
  });

  test('broad compatible claims and reasonable ordinary inference are not mechanically contradicted',()=>{
    const {r,d}=sceneFixture(`${cart}\n${unopened}\n${lockedCord}`);
    d.causality!.checks[2]!.state='Bolt给孵化设备加装了物理锁。';
    d.causality!.checks[2]!.alternative='先保持箱体未开封，暂缓后续操作。';
    const f=facts(r,d),w=auditWire(r,d,f);
    Object.assign(w.fieldChecks.find(c=>matchesField(c.targetId,'causal:2#state'))!,{explanation:'The broad lock statement is compatible with the more precise power-cord action.',evidence:[quote('scene:s3',lockedCord)]});
    Object.assign(w.fieldChecks.find(c=>matchesField(c.targetId,'causal:2#alternative'))!,{explanation:'Leaving the currently unopened box closed is an ordinary inference and introduces no new equipment.',evidence:[quote('scene:s3',unopened)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.audit!.status).toBe('completed');
    expect(result.checks.find(c=>c.targetId==='causal:2')!.verdict).toBe('supported');
  });

  test('a planned installation can be held while agreement and demonstrated completion remain valid',()=>{
    const {r,d}=sceneFixture(`${proposal}\n${agreement}`);
    d.causality!.checks[2]!.choice='双方已安装隔离网，风险已经消除。';
    const f=facts(r,d),w=auditWire(r,d,f),field=w.fieldChecks.find(c=>matchesField(c.targetId,'causal:2#choice'))!;
    Object.assign(field,{verdict:'unsupported',claimQuote:'已安装隔离网',explanation:'The scene records a proposal and acceptance, not completed installation.',
      correction:'The parties agree to install the baffles; completion remains unstated.',evidence:[quote('scene:s3',proposal),quote('scene:s3',agreement)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.checks.find(c=>c.targetId==='causal:2')!.verdict).toBe('unsupported');
    expect(result.audit!.fieldChecks.find(c=>c.targetId===field.targetId)!.claimQuote).toBe('已安装隔离网');
    for(const [claim,content] of [
      ['双方已同意安装隔离网。',`${proposal}\n${agreement}`],
      ['双方已安装隔离网。','Bolt bolts the final mesh panel into place. The enclosure is sealed.'],
    ]){
      const positive=sceneFixture(content!);positive.d.causality!.checks[2]!.choice=claim!;
      const pf=facts(positive.r,positive.d),pw=auditWire(positive.r,positive.d,pf);
      expect(parseVerificationAudit(JSON.stringify(pw),positive.r,positive.d,pf,getReviewSources(positive.r)).audit!.status).toBe('completed');
    }
  });

  test('one supported alternative does not certify an extra object attribute in another branch',()=>{
    const {r,d}=sceneFixture(`${cart}\n${unopened}`);
    d.causality!.checks[2]!.alternative='先保持授粉箱未开封，或直接放回带盖推车内。';
    const f=facts(r,d),w=auditWire(r,d,f),field=w.fieldChecks.find(c=>matchesField(c.targetId,'causal:2#alternative')&&c.claimQuote.includes('带盖'))!;
    Object.assign(field,{verdict:'unsupported',claimQuote:'带盖推车',explanation:'The unopened box supports waiting; the cart lid is an unstated extra property.',
      correction:'Retain the option to wait with the box closed; do not assume the cart has a lid.',evidence:[quote('scene:s3',cart),quote('scene:s3',unopened)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.checks.find(c=>c.targetId==='causal:2')!.verdict).toBe('unsupported');
    const positive=sceneFixture(`${cart}\nThe cart's hinged lid snaps shut over the container.`);
    positive.d.causality!.checks[2]!.alternative='可将容器留在带盖推车内。';
    const pf=facts(positive.r,positive.d),pw=auditWire(positive.r,positive.d,pf);
    expect(parseVerificationAudit(JSON.stringify(pw),positive.r,positive.d,pf,getReviewSources(positive.r)).audit!.status).toBe('completed');
  });

  test('assessment and omission explanations and fixes are covered, including an unsupported window-to-work substitution',()=>{
    const r=revision(),d=draft(r);d.assessments[0]!.suggestedFix='Clarify the duration without changing the proposed activity.';
    const f=facts(r,d),omission=f.omissions.find(o=>o.category==='timeline')!;
    Object.assign(omission,{status:'issue',explanation:'The proposal and the later stated consequence use different durations.',suggestedFix:'将本次提议的所需工时改为22.5小时。'});f.status='needs_review';
    const targets=verificationFieldTargets(d,f);
    expect(targets.some(t=>t.id===`assessment:${d.assessments[0]!.dimension}#explanation`)).toBe(true);
    expect(targets.some(t=>t.id===`assessment:${d.assessments[0]!.dimension}#suggestedFix`)).toBe(true);
    expect(targets.find(t=>t.id==='omission:timeline#suggestedFix')!.claim).toBe(omission.suggestedFix!);
    const w=auditWire(r,d,f),field=w.fieldChecks.find(c=>matchesField(c.targetId,'omission:timeline#suggestedFix'))!;
    Object.assign(field,{verdict:'unsupported',claimQuote:'所需工时改为22.5小时',explanation:'Available corridor time multiplied by the rate is an upper bound, not the stated required labor.',
      correction:'Keep the stated ninety-minute activity; do not substitute the maximum available interval.',evidence:[quote('scene:s2',labor),quote('scene:s2',conversion),quote('scene:s2','45 CORRIDOR MINUTES REMAINING.')]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.audit!.checks.find(c=>c.targetId==='omission:timeline')!.verdict).toBe('unsupported');
    expect(result.audit!.fieldChecks.find(c=>matchesField(c.targetId,'omission:timeline#explanation'))!.verdict).toBe('supported');
    expect(result.omissions.find(o=>o.category==='timeline')!.suggestedFix).toBe(omission.suggestedFix!);
  });

  test('claim anchors are required only for non-supported fields, but supplied anchors always stay literal',()=>{
    const r=revision(),d=draft(r),f=facts(r,d);
    for(const claimQuote of [undefined,null,'',automated,'workshop lock invented']){
      const w=auditWire(r,d,f),field=w.fieldChecks.find(c=>matchesField(c.targetId,'causal:0#explanation'))!;
      Object.assign(field,{verdict:'unsupported',claimQuote,correction:'Withdraw this claim.'});
      expect(parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)).audit!.fieldChecks.some(c=>c.targetId===field.targetId)).toBe(false);
    }
    const w=auditWire(r,d,f);for(const c of w.fieldChecks)delete (c as {claimQuote?:unknown}).claimQuote;
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)).errors).toEqual([]);
    Object.assign(w.fieldChecks[0]!,{claimQuote:'A statement absent from this exact field.'});
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)).errors.length).toBeGreaterThan(0);
  });

  test('field enumeration does not depend on historical timeline binding metadata',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),expected=verificationFieldTargets(d,f);
    for(const t of f.timelineFacts)delete (t as Partial<TimelineFact>).boundSource;
    expect(verificationFieldTargets(d,f)).toEqual(expected);
  });
});

describe('unique whitespace-only source quotation recovery',()=>{
  const sourceLine='We take the manual bypass.\nHe flips a diverter lever. Fruit rolls down an unpowered chute onto a scale.';
  const modelLine=sourceLine.replace(/\s+/gu,' ');
  function fixture(passage=sourceLine){
    const r=revision();r.scenes[1]!.content+=`\n${passage}`;
    const d=draft(r),f=facts(r,d),w=auditWire(r,d,f);
    const field=w.fieldChecks.find(c=>matchesField(c.targetId,'pressure:0#currentState'))!;
    field.evidence=[quote('scene:s2',modelLine)];
    return {r,d,f,w,field,parse:()=>parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r))};
  }

  test('the real V1 newline-to-space quote is bound to the exact source substring with traceable metadata',()=>{
    const x=fixture(),raw=JSON.stringify(x.w),result=x.parse();
    const citation=result.audit!.fieldChecks.find(c=>c.targetId===x.field.targetId)!.evidence[0]!;
    expect(result.errors).toEqual([]);expect(result.status).toBe('completed');
    expect(citation).toEqual({sourceId:'scene:s2',quote:sourceLine,modelQuote:modelLine});
    expect(x.r.scenes[1]!.content.includes(citation.quote)).toBe(true);
    expect(result.normalizationNotes?.some(n=>n.includes('恢复了原文空白')&&n.includes('未改词或标点'))).toBe(true);
    expect(JSON.stringify(x.w)).toBe(raw);
    const replay=parseVerificationAudit(JSON.stringify({checks:result.audit!.originalChecks,fieldChecks:result.audit!.fieldChecks}),x.r,x.d,x.f,getReviewSources(x.r));
    expect(replay).toEqual(result);
  });

  test('whitespace runs and UTF-16 characters retain the source text exactly',()=>{
    const original='🛰️ 原句：We take the manual bypass.\r\n\t  He flips a diverter lever.  Fruit rolls down an unpowered chute onto a scale.';
    const x=fixture(original);x.field.evidence=[quote('scene:s2',original.replace(/\s+/gu,' '))];
    const result=x.parse(),citation=result.audit!.fieldChecks.find(c=>c.targetId===x.field.targetId)!.evidence[0]!;
    expect(result.errors).toEqual([]);expect(citation.quote).toBe(original);expect(citation.modelQuote).toBe(original.replace(/\s+/gu,' '));
  });

  test('exact quotes remain unchanged even when repeated, while ambiguous normalized matches are rejected',()=>{
    const x=fixture(`${sourceLine}\nREPEAT\n${sourceLine.replace('\n','\t')}`);
    expect(x.parse().audit!.fieldChecks.some(c=>c.targetId===x.field.targetId)).toBe(false);
    expect(x.parse().errors.length).toBeGreaterThan(0);
    x.field.evidence=[quote('scene:s2',sourceLine)];
    const exact=x.parse().audit!.fieldChecks.find(c=>c.targetId===x.field.targetId)!.evidence[0]!;
    expect(exact).toEqual(quote('scene:s2',sourceLine));
    expect(exact.modelQuote).toBeUndefined();
  });

  test('word deletion, punctuation or case changes, speaker omission and wrong sources never become whitespace repairs',()=>{
    for(const bad of [modelLine.replace('unpowered ',''),modelLine.replace('bypass.','bypass,'),modelLine.replace('We take','we take')]){
      const x=fixture();x.field.evidence=[quote('scene:s2',bad)];
      expect(x.parse().errors.length).toBeGreaterThan(0);expect(x.parse().audit!.fieldChecks.some(c=>c.targetId===x.field.targetId)).toBe(false);
    }
    const speaker=fixture(sourceLine.replace('\n','\nBOLT\n'));
    expect(speaker.parse().errors.length).toBeGreaterThan(0);
    const wrong=fixture();wrong.field.evidence=[quote('scene:s1',modelLine)];
    expect(wrong.parse().errors.length).toBeGreaterThan(0);
  });

  test('null values and forged modelQuote metadata remain invalid',()=>{
    for(const citation of [
      {sourceId:'scene:s2',quote:null},
      {sourceId:'scene:s2',quote:sourceLine,modelQuote:null},
      {sourceId:'scene:s2',quote:sourceLine,modelQuote:modelLine.replace('unpowered ','')},
      {sourceId:'scene:s2',quote:sourceLine,modelQuote:modelLine.replace('bypass.','bypass!')},
      {sourceId:'scene:s2',quote:sourceLine,modelQuote:sourceLine},
    ]){
      const x=fixture();Object.assign(x.field,{evidence:[citation]});
      expect(x.parse().errors.length).toBeGreaterThan(0);expect(x.parse().audit!.fieldChecks.some(c=>c.targetId===x.field.targetId)).toBe(false);
    }
  });
});

describe('review interpretation verification',()=>{
  test('the real continuous-ten-days misread cannot remain verified once contradicted',()=>{
    const r=revision(),d=draft(r);
    d.causality!.checks[0]!.explanation='正文明确写出他已连续独自工作10天、关节被糖浆糊死产生严重疲惫。';
    const before=JSON.stringify({r,d}),w=wire(r,d),target=w.checks.find(c=>c.targetId==='causal:0')!;
    Object.assign(target,{verdict:'contradicted',explanation:'Elapsed presence is not continuous manual labor.',
      correction:'Ten days elapsed; the first five days ran automated. The exact manual-work duration is unspecified.',
      evidence:[quote('scene:s1',elapsed)],counterEvidence:[quote('scene:s1',automated)]});
    const result=parse(w,r,d);
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);
    expect(result.checks.find(c=>c.targetId==='causal:0')?.counterEvidence).toEqual([quote('scene:s1',automated)]);
    expect(result.checks.find(c=>c.targetId==='causal:0')?.correction).toContain('unspecified');
    expect(JSON.stringify({r,d})).toBe(before); // no repair of either source to fit the verdict
  });

  test('ten elapsed minus five automated does not silently become five exact working days',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[0]!.state='Bolt worked manually for exactly five days.';
    const w=wire(r,d),target=w.checks.find(c=>c.targetId==='causal:0')!;
    Object.assign(target,{verdict:'unsupported',explanation:'No continuous-work interval or rest schedule is specified.',
      correction:'Actual manual-work duration remains unknown; do not subtract elapsed intervals into exact labor.',
      evidence:[quote('scene:s1',elapsed),quote('scene:s1',automated)]});
    const result=parse(w,r,d);
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);
    expect(result.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('unsupported');
  });

  test('explicit continuous work can be supported: no ban on ten days or continuous labor',()=>{
    const r=revision();r.scenes[0]!.content='For ten uninterrupted days, Bolt sorts fruit by hand without automation or rest.';
    const d=draft(r);d.causality!.checks[0]!.explanation='Bolt continuously sorts fruit for ten days.';
    const result=parse(wire(r,d),r,d);
    expect(result.errors).toEqual([]);expect(result.status).toBe('completed');
    expect(result.checks.find(c=>c.targetId==='causal:0')?.verdict).toBe('supported');
  });

  test('a timeline omission overrides unanimous no-issue review and supported interpretations',()=>{
    const r=revision();r.scenes[1]!.content+= '\nBOLT\nThose ninety minutes would take another ten corridor days.';
    const d=draft(r),w=wire(r,d),timeline=w.omissions.find(o=>o.category==='timeline')!;
    Object.assign(timeline,{status:'issue',explanation:'The extra-work conversion contradicts the stated thirtyfold rate.',
      sceneIds:['s2'],evidence:[quote('scene:s2',conversion),quote('scene:s2','Those ninety minutes would take another ten corridor days.')],
      suggestedFix:'Use three corridor minutes for ninety lived minutes at 30x.'});
    const result=parse(w,r,d);
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);
    expect(result.checks.every(c=>c.verdict==='supported')).toBe(true);
    expect(result.omissions.find(o=>o.category==='timeline')?.status).toBe('issue');
  });

  test('a balanced amount does not resolve a change from planned seed stock to actual deposit',()=>{
    // The real V1 verifier quoted the plan, then missed its conflict with the
    // later destination because 175 - 95 = 80 still balanced. Keep "leaves for"
    // as a plan: do not silently turn it into a completed prior expense.
    const r=revision();r.scenes[1]!.content+=`\n${seedPlan}`;
    const d=draft(r),w=wire(r,d),accounting=w.omissions.find(o=>o.category==='accounting')!;
    Object.assign(accounting,{status:'issue',sceneIds:['s2','s3'],explanation:'s2 plans the 80-credit remainder for seed stock; s3 allocates it to a garden deposit. 175 - 95 = 80 credits balances, but no changed plan or additional funds explain the different destination.',
      evidence:[quote('scene:s2',seedPlan),quote('scene:s3',receipt)],
      suggestedFix:'Unify the destination or explicitly establish the changed allocation and what happens to the seed plan.'});
    const result=parse(w,r,d);
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);
    expect(result.omissions.find(o=>o.category==='accounting')?.evidence).toHaveLength(2);
  });

  test('physical inability inferred from a voluntary refusal remains an unverified critic claim',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[1]!.explanation='Nia is physically incapable of taking the shift.';
    const w=wire(r,d),target=w.checks.find(c=>c.targetId==='causal:1')!;
    Object.assign(target,{verdict:'unsupported',explanation:'Fatigue and a preference do not establish incapacity.',
      correction:'Nia can do the work and chooses not to.',evidence:[quote('scene:s2','I could.'),quote('scene:s2',refusal)]});
    expect(parse(w,r,d).status).toBe('needs_review');
  });

  test('uncertain interpretations and unexamined issue categories never become completed',()=>{
    for(const category of categories){const w=wire();w.omissions.find(o=>o.category===category)!.status='uncertain';expect(parse(w).status).toBe('needs_review');}
    const w=wire();Object.assign(w.checks[0]!,{verdict:'uncertain',correction:'The motive is not established; retain uncertainty.'});
    expect(parse(w).status).toBe('needs_review');
  });
});

describe('explicit time candidate coverage',()=>{
  test('extracts English and Chinese unit lines and clocks/rates with stable addresses and speaker context',()=>{
    const r=revision();r.scenes=[{id:'room:2',heading:'CLOCK ROOM',locked:false,content:[
      'NIA','We have eight hours, then three days to wait.','BOLT','The first five weeks ran automated.',
      '屏幕：剩余三十分钟；一小时后交接。','她在两个月后回来，已经过了半年。','RATE 24x. CLOCK 09:45.',
      'NIA','The delay is two seconds and the repair takes one year.',
      '一年之后，相差五秒；倍率为三十倍。','The yearning remains.','天花板上没有裂缝。',
    ].join('\n')}];
    const targets=timelineTargets(r);
    expect(targets.map(t=>t.line)).toEqual([2,4,5,6,7,9,10]);
    expect(targets.map(t=>t.id)).toEqual([2,4,5,6,7,9,10].map(n=>`timeline:room%3A2:${n}`));
    expect(targets.every(t=>t.sourceId==='scene:room:2'&&r.scenes[0]!.content.includes(t.quote))).toBe(true);
    expect(targets[0]!.context).toContain('NIA\nWe have eight hours');
    expect(timelineTargets(structuredClone(r))).toEqual(targets);
    const payload=JSON.parse(buildVerificationMessages(r,draft(),getReviewSources(r))[1]!.content);
    expect(payload.timelineTargets).toEqual(targets.map(({context,...target})=>target));
  });

  test('repeated time lines remain separately addressed and extraction never decides their meaning',()=>{
    const r=revision();r.scenes=[{id:'s1',heading:'ROOM',locked:false,content:'A minute detail.\nNIA\nA minute detail.'}];
    const targets=timelineTargets(r);
    expect(targets).toHaveLength(2);expect(targets[0]!.quote).toBe(targets[1]!.quote);
    expect(targets[0]!.id).not.toBe(targets[1]!.id);
    expect(targets.every(t=>!('status' in t)&&!('meaning' in t))).toBe(true);
  });

  test('a feared future duration cannot be omitted even when another category quotes that line',()=>{
    const r=revision(),future='Ten days inside alone, and you will drop a crate into the gears.';
    r.scenes[1]!.content+=`\nBOLT\n${future}`;
    const d=draft(r),w=wire(r,d),target=timelineTargets(r).find(t=>t.quote===future)!;
    w.omissions.find(o=>o.category==='agency')!.evidence.push(quote('scene:s2',future));
    w.timelineFacts=w.timelineFacts.filter(f=>f.targetId!==target.id);
    const result=parse(w,r,d);
    expect(result.status).toBe('needs_review');
    expect(result.errors.some(e=>e.includes(target.id))).toBe(true);
    expect(result.omissions.find(o=>o.category==='timeline')?.status).toBe('no_issue');
  });

  test('a conflict or uncertain candidate prevents a clean result and cannot coexist with a clean timeline summary',()=>{
    for(const status of ['conflict','uncertain'] as const){
      const r=revision(),d=draft(r),w=wire(r,d);
      Object.assign(w.timelineFacts[0]!,{status,explanation:'The activity reference must be reconciled with the later proposal.'});
      const result=parse(w,r,d);
      expect(result.status).toBe('needs_review');
      expect(result.timelineFacts[0]!.status).toBe(status);
      expect(result.errors.some(e=>e.includes('时间遗漏检查不能宣称无问题'))).toBe(true);
      const omission=w.omissions.find(o=>o.category==='timeline')!;
      Object.assign(omission,{status:status==='conflict'?'issue':'uncertain',suggestedFix:'Clarify which activity and clock the duration refers to.'});
      const consistentSummary=parse(w,r,d);
      expect(consistentSummary.status).toBe('needs_review');expect(consistentSummary.errors).toEqual([]);
    }
  });

  test('missing, duplicate, unknown or malformed time facts fail closed',()=>{
    for(const mutate of [
      (w:Wire)=>{delete (w as Partial<Wire>).timelineFacts;},
      (w:Wire)=>{w.timelineFacts.pop();},
      (w:Wire)=>{w.timelineFacts.push(structuredClone(w.timelineFacts[0]!));},
      (w:Wire)=>{w.timelineFacts[0]!.targetId='timeline:unknown:1';},
      (w:Wire)=>{w.timelineFacts[0]!.meaning.activity='';},
      (w:Wire)=>{w.timelineFacts[0]!.status='no_issue' as TimelineFact['status'];},
      (w:Wire)=>{delete (w.timelineFacts[0] as Partial<TimelineFact>).evidence;},
    ]){
      const w=wire();mutate(w);const result=parse(w);
      expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    }
    const w=wire(),id=w.timelineFacts[0]!.targetId;
    w.timelineFacts.push({...structuredClone(w.timelineFacts[0]!),status:'conflict'});
    expect(parse(w).timelineFacts.some(f=>f.targetId===id)).toBe(false);
  });

  test('the real partial self-quote gets its complete immutable line bound without changing the verdict',()=>{
    const r=revision(),partial="Ten days inside alone, scrubbing wet sugar on three hours of sleep, and you'll drop a crate into the gears.";
    const full=`You just worked eight hours on station hydro. ${partial}`;
    r.scenes[1]!.content+=`\nBOLT\n${full}`;
    const d=draft(r),w=wire(r,d),target=timelineTargets(r).find(t=>t.quote===full)!;
    const fact=w.timelineFacts.find(f=>f.targetId===target.id)!;
    Object.assign(fact,{status:'conflict',explanation:'The claimed future duration conflicts with the immediately proposed work.',
      evidence:[quote('scene:s2',partial),quote('scene:s2',labor)]});
    Object.assign(w.omissions.find(o=>o.category==='timeline')!,{status:'issue',suggestedFix:'Reconcile the duration of the same proposed activity.'});
    const raw=JSON.stringify(w),before=JSON.stringify({r,d}),result=parseReviewVerification(raw,r,d,getReviewSources(r));
    const bound=result.timelineFacts.find(f=>f.targetId===target.id)!;
    expect(result.status).toBe('needs_review');expect(result.errors).toEqual([]);
    expect(bound.status).toBe('conflict');expect(bound.boundSource).toEqual(quote('scene:s2',full));
    expect(bound.evidence).toEqual([quote('scene:s2',full),quote('scene:s2',partial),quote('scene:s2',labor)]);
    expect(JSON.stringify({r,d})).toBe(before);expect(JSON.stringify(w)).toBe(raw);
  });

  test('binding is deduplicated and does not require the model to repeat its own line',()=>{
    const r=revision(),d=draft(r),w=wire(r,d),target=timelineTargets(r)[0]!;
    const repeated=parse(w,r,d).timelineFacts[0]!;
    expect(repeated.boundSource).toEqual(quote(target.sourceId,target.quote));
    expect(repeated.evidence).toEqual([repeated.boundSource]);
    w.timelineFacts[0]!.evidence=[];
    // This model-supplied field must never redirect the program's binding.
    Object.assign(w.timelineFacts[0]!,{boundSource:quote('scene:s2',labor)});
    const result=parse(w,r,d),bound=result.timelineFacts[0]!;
    expect(result.status).toBe('completed');expect(result.errors).toEqual([]);
    expect(bound.boundSource).toEqual(quote(target.sourceId,target.quote));
    expect(bound.evidence).toEqual([bound.boundSource]);
    expect(parseReviewVerification(JSON.stringify(result),r,d,getReviewSources(r))).toEqual(result);
  });

  test('binding rejects unknown scene/line IDs and a line available only under the wrong source',()=>{
    const r=revision(),d=draft(r);
    for(const targetId of ['timeline:absent:1','timeline:s1:9999']){
      const w=wire(r,d);w.timelineFacts[0]!.targetId=targetId;
      const result=parse(w,r,d);
      expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
      expect(result.timelineFacts.some(f=>f.targetId===targetId)).toBe(false);
    }
    const w=wire(r,d),target=timelineTargets(r)[0]!;
    w.timelineFacts[0]!.evidence=[];
    const sources=getReviewSources(r).map(s=>s.id===target.sourceId?{...s,text:'A room with no time statement.'}:s.id==='scene:s3'?{...s,text:`${s.text}\n${target.quote}`}:s);
    const result=parseReviewVerification(JSON.stringify(w),r,d,sources);
    expect(result.status).toBe('needs_review');
    expect(result.errors.some(e=>e.includes('冻结候选原行与对应事实来源不符'))).toBe(true);
    expect(result.timelineFacts.some(f=>f.targetId===target.id)).toBe(false);
  });

  test('automatic binding never excuses a fabricated or wrongly attributed additional quote',()=>{
    for(const extra of [quote('scene:s1','An invented twelve-hour shift.'),quote('scene:s1',labor),quote('unknown',elapsed)]){
      const w=wire(),id=w.timelineFacts[0]!.targetId;
      w.timelineFacts[0]!.evidence.push(extra);
      const result=parse(w);
      expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
      expect(result.timelineFacts.some(f=>f.targetId===id)).toBe(false);
    }
  });

  test('no lexical candidates requires an explicit empty array and keeps the independent omission scan',()=>{
    const r=revision();for(const scene of r.scenes)scene.content='A silent room. A character leaves.';
    const d=draft(r),w=wire(r,d);
    expect(timelineTargets(r)).toEqual([]);expect(w.timelineFacts).toEqual([]);
    expect(parse(w,r,d).status).toBe('completed');
    delete (w as Partial<Wire>).timelineFacts;
    expect(parse(w,r,d).status).toBe('needs_review');
  });
});

describe('verification coverage and provenance boundaries',()=>{
  test('prompt deduplication preserves every source, whole review target, candidate line and scene order',()=>{
    const r=revision(),d=draft(r),sources=getReviewSources(r),before=JSON.stringify({r,d,sources});
    const payload=JSON.parse(buildVerificationMessages(r,d,sources)[1]!.content);
    expect(payload.sources).toEqual(sources);
    expect(payload.targets).toEqual(reviewTargets(d));
    expect(payload.script).toEqual({synopsisSourceId:'synopsis',scenes:r.scenes.map(s=>({id:s.id,heading:s.heading,sourceId:`scene:${s.id}`}))});
    expect(payload.script.scenes.map((s:{id:string})=>s.id)).toEqual(r.scenes.map(s=>s.id));
    for(const scene of r.scenes){
      const source=payload.sources.find((s:{id:string})=>s.id===`scene:${scene.id}`);
      expect(source.text).toBe(`${scene.heading}\n${scene.content}`);
    }
    expect(payload.sources.find((s:{id:string})=>s.id==='synopsis').text).toBe(`${r.title}\n${r.logline}`);
    const targets=timelineTargets(r);
    expect(payload.timelineTargets).toEqual(targets.map(({context,...target})=>target));
    expect(payload.timelineTargets.map((t:{id:string;quote:string})=>[t.id,t.quote])).toEqual(targets.map(t=>[t.id,t.quote]));
    expect(targets.every(t=>t.context.includes(t.quote))).toBe(true);
    expect(JSON.stringify({r,d,sources})).toBe(before);
  });

  test('all reviewer fields, not only verdict explanations, are sent for verification',()=>{
    const r=revision(),d=draft(r);
    const c=d.causality!.checks[0]!;c.state='STATE_SENTINEL';c.choice='CHOICE_SENTINEL';c.alternative='ALTERNATIVE_SENTINEL';c.suggestedFix='FIX_SENTINEL';
    const p=d.causality!.pressures![0]!;p.currentState='PRESSURE_STATE_SENTINEL';p.directAlternative='PRESSURE_ALTERNATIVE_SENTINEL';
    const targets=reviewTargets(d);
    expect(targets.map(t=>t.id)).toEqual([...DIMENSIONS.map(dimension=>`assessment:${dimension}`),'causal:0','causal:1','causal:2','pressure:0']);
    const messages=buildVerificationMessages(r,d,getReviewSources(r)),payload=messages.map(m=>m.content).join('\n');
    for(const value of ['STATE_SENTINEL','CHOICE_SENTINEL','ALTERNATIVE_SENTINEL','FIX_SENTINEL','PRESSURE_STATE_SENTINEL','PRESSURE_ALTERNATIVE_SENTINEL',automated,receipt])expect(payload).toContain(value);
  });

  test('missing or duplicate target coverage cannot masquerade as a fully checked review',()=>{
    for(const mutate of [(w:Wire)=>{w.checks.pop();},(w:Wire)=>{w.checks.push(structuredClone(w.checks[0]!));},(w:Wire)=>{w.checks[0]!.targetId='assessment:unknown';}]){
      const w=wire();mutate(w);const result=parse(w);expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('conflicting duplicate verifier verdicts are both withheld rather than first-one-wins',()=>{
    const w=wire();w.checks.push({...structuredClone(w.checks[0]!),verdict:'unsupported',correction:'Withdraw this claim.'});
    const result=parse(w);
    expect(result.status).toBe('needs_review');
    expect(result.checks.some(c=>c.targetId===w.checks[0]!.targetId)).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('duplicate source or original target IDs make the entire binding ambiguous',()=>{
    const r=revision(),d=draft(r),sources=getReviewSources(r);
    const duplicateSource=parseReviewVerification(JSON.stringify(wire(r,d)),r,d,[...sources,sources[0]!]);
    expect(duplicateSource.status).toBe('needs_review');expect(duplicateSource.checks).toEqual([]);
    d.assessments.push(structuredClone(d.assessments[0]!));
    const duplicateTarget=parseReviewVerification(JSON.stringify(wire(r,d)),r,d,sources);
    expect(duplicateTarget.status).toBe('needs_review');expect(duplicateTarget.checks).toEqual([]);
  });

  test('every omission category must be explicitly covered exactly once',()=>{
    for(const category of categories){const w=wire();w.omissions=w.omissions.filter(o=>o.category!==category);expect(parse(w).status).toBe('needs_review');}
    const w=wire();w.omissions.push(structuredClone(w.omissions[0]!));expect(parse(w).errors.length).toBeGreaterThan(0);
    w.omissions[0]!.category='unrecognized';expect(parse(w).status).toBe('needs_review');
  });

  test('a model-supplied completed flag cannot certify uninspected scenes',()=>{
    const w=wire();w.omissions[0]!.sceneIds=['s1'];
    const result=parse({...w,status:'completed'});
    expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    expect(result.omissions.some(o=>o.category===w.omissions[0]!.category)).toBe(false);
  });

  test('fabricated quote, source mismatch, empty evidence and invented counterevidence fail closed',()=>{
    const mutations=[
      (w:Wire)=>{w.checks[0]!.evidence[0]!.quote='Bolt has never rested in ten days.';},
      (w:Wire)=>{w.checks[0]!.evidence=[quote('scene:s2',automated)];},
      (w:Wire)=>{w.checks[0]!.evidence=[];},
      (w:Wire)=>{Object.assign(w.checks[0]!,{verdict:'contradicted',correction:'Withdraw the claim.',counterEvidence:[quote('scene:s1','There are five rest days.')]} );},
    ];
    for(const mutate of mutations){const w=wire();mutate(w);const result=parse(w);expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);}
  });

  test('contradiction requires a genuine counterquote and every nonsupported result needs a correction',()=>{
    const w=wire();Object.assign(w.checks[0]!,{verdict:'contradicted',correction:'Withdraw the claim.'});
    expect(parse(w).errors.length).toBeGreaterThan(0);
    for(const verdict of ['contradicted','unsupported','uncertain']){
      const v=wire();Object.assign(v.checks[0]!,{verdict,counterEvidence:[quote('scene:s1',automated)]});
      expect(parse(v).errors.length).toBeGreaterThan(0);
    }
  });

  test('omissions need real scene references, exact evidence and an actionable fix for issues',()=>{
    for(const mutate of [(w:Wire)=>{w.omissions[0]!.sceneIds=['missing'];},(w:Wire)=>{w.omissions[0]!.evidence=[];},
      (w:Wire)=>{w.omissions[0]!.evidence=[quote('worldRules',automated)];},(w:Wire)=>{w.omissions[0]!.status='issue';}]){
      const w=wire();mutate(w);const result=parse(w);expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('absent, malformed, oversized and invalid-enum verifier output fails closed',()=>{
    const r=revision(),d=draft(r),sources=getReviewSources(r);
    for(const raw of ['not json','{}','null','[]','{"checks":[],"omissions":[]}']){
      const result=parseReviewVerification(raw,r,d,sources);expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    }
    const large=wire();large.checks=Array.from({length:1001},()=>structuredClone(large.checks[0]!));expect(parse(large).status).toBe('needs_review');
    const invalid=wire();invalid.checks[0]!.verdict='probably_fine';expect(parse(invalid).errors.length).toBeGreaterThan(0);
  });
});

describe('narrow quote-key syntax normalization',()=>{
  function fixture() {
    const r=revision();r.scenes[0]!.content+=`\n${chassis}`;
    const d=draft(r),w=wire(r,d);w.checks[0]!.evidence=[quote('scene:s1',chassis)];
    const strict=JSON.stringify(w);
    // Exact malformed object from the live V1 diagnostic response.
    const bare=strict.replace(JSON.stringify(quote('scene:s1',chassis)),
      '{"sourceId": "scene:s1", quote: "He taps his chassis, dislodging dried rind."}');
    return {r,d,w,strict,bare,sources:getReviewSources(r)};
  }

  test('the real bare quote key is normalized with an audit note, without changing claims',()=>{
    const f=fixture(),raw=f.bare;
    expect(()=>JSON.parse(raw)).toThrow();
    const result=parseReviewVerification(raw,f.r,f.d,f.sources);
    const strictResult=parseReviewVerification(f.strict,f.r,f.d,f.sources);
    expect(result.normalizationNotes).toHaveLength(1);
    expect(result.normalizationNotes![0]).toContain('1 处裸 quote');
    expect(result.normalizationNotes![0]).toContain('原始输出不是规范 JSON');
    const {normalizationNotes,...semanticResult}=result;
    expect(semanticResult).toEqual(strictResult);
    expect(raw).toBe(f.bare);
    expect(result.status).toBe('completed');
  });

  test('quote colon text, escaped quotes and backslashes inside strings remain byte-exact',()=>{
    const f=fixture();
    const literal='The display reads {"sourceId": "scene:s1", quote: "keep this"}; path C:\\quote: remains literal.';
    f.r.scenes[0]!.content+=`\n${literal}`;
    f.w.checks[0]!.explanation=literal;
    f.w.checks[0]!.evidence.push(quote('scene:s1',literal));
    const strict=JSON.stringify(f.w),sources=getReviewSources(f.r);
    expect(parseReviewVerification(strict,f.r,f.d,sources).normalizationNotes).toBeUndefined();
    const bare=strict.replace(JSON.stringify(quote('scene:s1',chassis)),
      '{"sourceId":"scene:s1", quote : '+JSON.stringify(chassis)+'}');
    const result=parseReviewVerification(bare,f.r,f.d,sources);
    expect(result.errors).toEqual([]);
    expect(result.normalizationNotes![0]).toContain('1 处裸 quote');
    expect(result.checks[0]!.explanation).toBe(literal);
    expect(result.checks[0]!.evidence[1]!.quote).toBe(literal);
  });

  test('other bare keys, value positions, comments, single quotes and trailing commas stay rejected',()=>{
    const f=fixture();
    const invalid=[
      f.bare.replace('"explanation":','explanation:'),
      f.bare.replace('quote:','quoteExtra:'),
      f.bare.replace('quote:',"'quote':"),
      f.bare.replace('quote:','quote /* comment */:'),
      f.bare.replace('"counterEvidence":[]','"counterEvidence":[quote: "value"]'),
      f.bare.replace('"counterEvidence":[]','"counterEvidence":[quote]'),
      f.bare.replace('"counterEvidence":[]','"counterEvidence":quote'),
      f.bare.slice(0,-1)+',}',
      f.bare.replace(JSON.stringify(chassis),'"unterminated'),
    ];
    for(const raw of invalid){
      const result=parseReviewVerification(raw,f.r,f.d,f.sources);
      expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
      expect(result.checks).toEqual([]);expect(result.omissions).toEqual([]);
      expect(result.normalizationNotes).toBeUndefined();
    }
  });

  test('syntax normalization never bypasses source validation, coverage or value types',()=>{
    const f=fixture();
    for(const raw of [
      f.bare.replace(chassis,'An invented action absent from every source.'),
      f.bare.replace('"category":"timeline"','"category":"unknown"'),
      f.bare.replace('quote: '+JSON.stringify(chassis),'quote: 42'),
    ]){
      const result=parseReviewVerification(raw,f.r,f.d,f.sources);
      expect(result.normalizationNotes).toHaveLength(1);
      expect(result.status).toBe('needs_review');expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('explicit single-scene suggestion scope',()=>{
  test('source-scene edits are distinct from the first evidence draft scene and audited as their own field',()=>{
    const r=revision();r.scenes[1]!.content+=`\n${seedPlan}`;
    const d=draft(r),a=d.assessments.find(a=>a.dimension==='continuity')!;
    Object.assign(a,{status:'issue',issueType:'fact_conflict',suggestedFix:'Change the earlier seed-stock allocation to the garden deposit in the sorting scene.',suggestedSceneId:'s2',
      evidence:[{sourceId:'scene:s2',sourceQuote:seedPlan,sceneId:'s3',draftQuote:receipt}]});
    const f=facts(r,d),target=verificationFieldTargets(d,f).find(t=>t.id==='assessment:continuity#suggestedSceneId')!;
    expect(target.claim).toBe('s2');expect(target.sceneIds).toEqual(['s2']);expect(a.evidence[0]!.sceneId).toBe('s3');
    const w=auditWire(r,d,f),result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.audit!.schemaVersion).toBe(5);
    expect(result.audit!.fieldChecks.find(c=>c.targetId===target.id)!.evidence[0]!.sourceId).toBe('scene:s2');
    expect(a.suggestedSceneId).toBe('s2');
    const messages=buildVerificationAudit(r,d,f,getReviewSources(r));
    expect(messages[0]!.content).toContain('只改这一场能否成立');
    expect(messages[0]!.content).toContain('不能据此替代编辑目标');
  });
  test('scope field needs the proposed scene quote and a rejected scope cannot be masked by supported text',()=>{
    const r=revision(),d=draft(r);Object.assign(d.assessments[0]!,{suggestedFix:'Clarify the earlier sorting action.',suggestedSceneId:'s3'});
    const f=facts(r,d),w=auditWire(r,d,f),id='assessment:story#suggestedSceneId';
    const scope=w.fieldChecks.find(c=>c.targetId===id)!;
    scope.evidence=[quote('scene:s2',labor)];
    const bad=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(bad.errors.some(e=>e.includes('没有引用明确改稿目标场景'))).toBe(true);
    expect(bad.checks.find(c=>c.targetId==='assessment:story')!.verdict).toBe('uncertain');
    scope.evidence=[quote('scene:s3',receipt)];Object.assign(scope,{verdict:'unsupported',claimQuote:'s3',explanation:'The proposed passage is in the earlier sorting scene; the named scene contains a later receipt.',correction:'Do not apply the suggestion to the receipt scene.'});
    const checked=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(checked.errors).toEqual([]);expect(checked.audit!.originalChecks.find(c=>c.targetId==='assessment:story')!.verdict).toBe('supported');
    expect(checked.checks.find(c=>c.targetId==='assessment:story')!.verdict).toBe('unsupported');
    expect(d.assessments[0]!.suggestedSceneId).toBe('s3');
  });
  test('omission affected scenes do not become edit scope; a declared scope needs affected-scene membership and source evidence',()=>{
    const r=revision(),d=draft(r),w=wire(r,d),o=w.omissions.find(o=>o.category==='accounting')!;
    Object.assign(o,{status:'issue',sceneIds:['s2','s3'],suggestedFix:'Clarify the allocation at its first mention.',suggestedSceneId:'s2'});
    const read=()=>parseVerificationFacts(JSON.stringify({timelineFacts:w.timelineFacts,omissions:w.omissions}),r,getReviewSources(r));
    const good=read();expect(good.errors).toEqual([]);expect(good.omissions.find(o=>o.category==='accounting')!.suggestedSceneId).toBe('s2');
    for(const suggestedSceneId of ['s1','missing','',null,['s2','s3']]){
      Object.assign(o,{suggestedSceneId});expect(read().errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
    }
    o.suggestedSceneId='s2';o.evidence=[quote('scene:s3',receipt)];expect(read().errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
    delete o.suggestedSceneId;
    const legacy=read();expect(legacy.errors).toEqual([]);expect(legacy.omissions.find(o=>o.category==='accounting')!.suggestedSceneId).toBeUndefined();
    expect(verificationFieldTargets(d,legacy).some(t=>t.id==='omission:accounting#suggestedSceneId')).toBe(false);
  });
});

describe('bounded atomic audit batches',()=>{
  function fixture(){
    const r=revision(),d=draft(r),f=facts(r,d);
    for(const a of d.assessments)Object.assign(a,{suggestedFix:'Clarify the sorting dialogue without changing its facts.',suggestedSceneId:'s2'});
    for(const c of d.causality!.checks)Object.assign(c,{suggestedFix:'Clarify this scene without changing its facts.',suggestedSceneId:c.sceneId});
    for(const p of d.causality!.pressures!)Object.assign(p,{suggestedFix:'Clarify this pressure without changing its facts.',suggestedSceneId:p.sceneId});
    Object.assign(f.omissions[0]!,{status:'issue',suggestedFix:'Clarify the time display in the first scene.',suggestedSceneId:'s1'});
    return {r,d,f,sources:getReviewSources(r)};
  }
  test('every parent and all its fields appear once, grouped by kind within the bounded output budget',()=>{
    const {d,f}=fixture(),parents=verificationAuditTargets(d,f),fields=verificationFieldTargets(d,f),batches=auditBatches(d,f);
    expect(batches.flat()).toEqual(parents.map(t=>t.id));expect(new Set(batches.flat()).size).toBe(parents.length);
    for(const ids of batches){
      expect(ids.length).toBeLessThanOrEqual(4);
      expect(ids.length+fields.filter(t=>ids.includes(t.parentId)).length).toBeLessThanOrEqual(ids.length===1?32:16);
      expect(new Set(parents.filter(p=>ids.includes(p.id)).map(p=>p.kind)).size).toBe(1);
    }
    expect(batches.find(ids=>ids.includes('pressure:0'))).toEqual(['pressure:0']);
  });
  test('each request retains every original source and scene order while exposing only its parent group and children',()=>{
    const {r,d,f,sources}=fixture(),parents=verificationAuditTargets(d,f),fields=verificationFieldTargets(d,f);
    for(const ids of auditBatches(d,f)){
      const messages=buildModelMessages({kind:'review',reviewPass:'verification',context:r.context,revision:r,episodeTitle:r.title,draftReview:d,draftFacts:f,auditTargetIds:ids});
      const payload=JSON.parse(messages[1]!.content);
      expect(payload.sources).toEqual(sources);expect(payload.script.scenes.map((s:{id:string})=>s.id)).toEqual(r.scenes.map(s=>s.id));
      expect(payload.targets).toEqual(parents.filter(p=>ids.includes(p.id)));
      expect(payload.fieldTargets).toEqual(fields.filter(c=>ids.includes(c.parentId)));
    }
    for(const ids of [[],['missing'],['causal:0','causal:0']])expect(()=>buildVerificationAudit(r,d,f,sources,ids)).toThrow();
  });
  test('complete independent batches merge into the same full verification; missing, extra and crossed-parent fields fail closed',()=>{
    const {r,d,f,sources}=fixture(),whole=auditWire(r,d,f),fields=verificationFieldTargets(d,f),batches=auditBatches(d,f);
    const merged={checks:[] as typeof whole.checks,fieldChecks:[] as typeof whole.fieldChecks};
    for(const ids of batches){
      const children=new Set(fields.filter(t=>ids.includes(t.parentId)).map(t=>t.id));
      const part={checks:whole.checks.filter(c=>ids.includes(c.targetId)),fieldChecks:whole.fieldChecks.filter(c=>children.has(c.targetId))};
      const result=parseVerificationAuditBatch(JSON.stringify(part),r,d,f,sources,ids);
      expect(result.errors).toEqual([]);
      merged.checks.push(...result.checks as typeof whole.checks);merged.fieldChecks.push(...result.fieldChecks as typeof whole.fieldChecks);
    }
    expect(parseVerificationAudit(JSON.stringify(merged),r,d,f,sources)).toEqual(parseVerificationAudit(JSON.stringify(whole),r,d,f,sources));
    const ids=batches[0]!,children=new Set(fields.filter(t=>ids.includes(t.parentId)).map(t=>t.id));
    const partial={checks:whole.checks.filter(c=>ids.includes(c.targetId)),fieldChecks:whole.fieldChecks.filter(c=>children.has(c.targetId))};
    partial.fieldChecks.pop();
    expect(parseVerificationAuditBatch(JSON.stringify(partial),r,d,f,sources,ids).errors.some(e=>e.includes('未覆盖'))).toBe(true);
    expect(parseVerificationAuditBatch(JSON.stringify(whole),r,d,f,sources,ids).errors.some(e=>e.includes('未知的原审稿编号'))).toBe(true);
    for(const badIds of [[],['missing'],[ids[0]!,ids[0]!]])expect(parseVerificationAuditBatch(JSON.stringify(whole),r,d,f,sources,badIds).errors.length).toBeGreaterThan(0);
    const missing=structuredClone(merged);missing.checks.pop();
    expect(parseVerificationAudit(JSON.stringify(missing),r,d,f,sources).errors.length).toBeGreaterThan(0);
  });
});

describe('literal segment coverage without narrowing the original claims',()=>{
  const explanation='南侧台位具备营养泵平稳供热和成虫花蜜来源的实际生态需求，通风口空台无法满足；Bolt提出的mesh baffles符合世界规则6中普通物理隔离即可奏效的设定，以极低成本解决了农艺纯度被扣分的物理阻碍。';
  const proposedFix="修正s2的阻断理由与账目用途：将Bolt的阻断台词改为强调45分钟内进料口机械死锁无法靠90分钟软磨、或Nia极度缺乏睡眠操作高速机械会导致停机全损与工伤，删去与45分钟死线矛盾的'Ten days inside alone'；同时统一80信用点的分配口径，明确其为押金还是种子款，避免跨场两用。";
  test('each disputed clause gets its own stable exact address while retaining full context',()=>{
    const d=draft();d.causality!.checks[2]!.explanation=explanation;d.causality!.checks[1]!.suggestedFix=proposedFix;
    const targets=verificationFieldTargets(d),parts=targets.filter(t=>t.parentId==='causal:2'&&t.field==='explanation');
    expect(parts.map(t=>t.claim)).toEqual([
      '南侧台位具备营养泵平稳供热和成虫花蜜来源的实际生态需求，','通风口空台无法满足；',
      'Bolt提出的mesh baffles符合世界规则6中普通物理隔离即可奏效的设定，','以极低成本解决了农艺纯度被扣分的物理阻碍。',
    ]);
    for(const t of parts){expect(t.fullClaim).toBe(explanation);expect(t.claim).toBe(explanation.slice(t.start,t.end));expect(t.id).toBe(`causal:2#explanation@${t.start}:${t.end}`);}
    const fixParts=targets.filter(t=>t.parentId==='causal:1'&&t.field==='suggestedFix'&&t.id.includes('@'));
    expect(fixParts.some(t=>t.claim.includes('机械死锁'))).toBe(true);expect(fixParts.some(t=>t.claim.includes('停机全损与工伤'))).toBe(true);
    expect(fixParts.find(t=>t.claim.includes('机械死锁'))!.id).not.toBe(fixParts.find(t=>t.claim.includes('停机全损与工伤'))!.id);
    expect(fixParts.map(t=>t.claim).join('')).toBe(proposedFix);
  });
  test('a correct premise cannot override a rejected impossibility, completion or catastrophic-risk segment',()=>{
    const r=revision();r.scenes[2]!.content+='\nI am claiming the south bench. It gets steady warmth from the nutrient pump.\nThen we install mesh baffles.';
    const d=draft(r);d.causality!.checks[2]!.explanation=explanation;d.causality!.checks[1]!.suggestedFix=proposedFix;
    const f=facts(r,d),w=auditWire(r,d,f),targets=verificationFieldTargets(d,f);
    for(const [fragment,sourceId,sourceText] of [['通风口空台无法满足','scene:s3','I am claiming the south bench.'],['以极低成本解决了','scene:s3','Then we install mesh baffles.'],['机械死锁','scene:s2',labor],['停机全损与工伤','scene:s2',refusal]]){
      const target=targets.find(t=>t.claim.includes(fragment!))!,check=w.fieldChecks.find(c=>c.targetId===target.id)!;
      Object.assign(check,{verdict:'unsupported',claimQuote:fragment,explanation:'This precise added necessity or completed consequence is not established by the quoted narrower fact.',correction:'Retain the stated fact without adding necessity or completed consequences.',evidence:[quote(sourceId!,sourceText!)]});
    }
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);
    for(const id of ['causal:1','causal:2']){
      expect(result.audit!.originalChecks.find(c=>c.targetId===id)!.verdict).toBe('supported');
      expect(result.checks.find(c=>c.targetId===id)!.verdict).toBe('unsupported');
    }
    expect(result.audit!.fieldChecks.filter(c=>c.verdict==='unsupported')).toHaveLength(4);
    expect(d.causality!.checks[1]!.suggestedFix).toBe(proposedFix);
  });
  test('missing or substituted segment answers cannot be replaced by a whole-field approval or a quote from its neighbor',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[2]!.explanation=explanation;
    const f=facts(r,d),targets=verificationFieldTargets(d,f),selected=targets.find(t=>t.claim==='通风口空台无法满足；')!;
    for(const mode of ['missing','whole-field','wrong-offset','neighbor-quote','duplicate']){
      const w=auditWire(r,d,f),check=w.fieldChecks.find(c=>c.targetId===selected.id)!;
      if(mode==='missing')w.fieldChecks=w.fieldChecks.filter(c=>c!==check);
      if(mode==='whole-field')check.targetId='causal:2#explanation';
      if(mode==='wrong-offset')check.targetId=`causal:2#explanation@${selected.start+1}:${selected.end}`;
      if(mode==='neighbor-quote')Object.assign(check,{verdict:'unsupported',claimQuote:'营养泵平稳供热',correction:'Withdraw the stronger claim.'});
      if(mode==='duplicate')w.fieldChecks.push(structuredClone(check));
      const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
      expect(result.errors.length).toBeGreaterThan(0);expect(result.checks.find(c=>c.targetId==='causal:2')!.verdict).toBe('uncertain');
    }
  });
  test('timeline meaning and explanations receive the same segment coverage and constrain their parent interpretation',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),time=f.timelineFacts[0]!;
    time.meaning.durationKind='总共经历十天，全部是连续手工劳动。';
    time.explanation='前五天自动运行，因此余下五天全是手工。';
    const targets=verificationFieldTargets(d,f).filter(t=>t.parentId===time.targetId);
    for(const name of ['subject','activity','durationKind','clock','basis'])expect(targets.some(t=>t.field===`meaning.${name}`)).toBe(true);
    const disputed=targets.filter(t=>t.claim.includes('全部是连续手工劳动')||t.claim.includes('余下五天全是手工'));
    expect(disputed).toHaveLength(2);
    const w=auditWire(r,d,f);
    for(const t of disputed)Object.assign(w.fieldChecks.find(c=>c.targetId===t.id)!,{verdict:'unsupported',claimQuote:t.claim,explanation:'The stated elapsed and automatic periods do not establish continuous manual labor.',correction:'Keep the known elapsed and automatic periods; manual-work distribution remains unknown.',evidence:[quote('scene:s1',automated)]});
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]);expect(result.audit!.checks.find(c=>c.targetId===time.targetId)!.verdict).toBe('unsupported');
    expect(result.timelineFacts[0]).toEqual(time);
    const missing=auditWire(r,d,f);missing.fieldChecks=missing.fieldChecks.filter(c=>c.targetId!==disputed[0]!.id);
    expect(parseVerificationAudit(JSON.stringify(missing),r,d,f,getReviewSources(r)).audit!.errors.some(e=>e.includes(disputed[0]!.id))).toBe(true);
  });
  test('offsets preserve repeated clauses, numeric punctuation, Unicode, negation and full conditional context',()=>{
    const d=draft();const original='\n 🚀若只剩1,000毫升，就保留1.5小时窗口；不是完成安装，而是同意以后安装。重复，重复。  ';
    d.causality!.checks[0]!.explanation=original;Object.assign(d.causality!.checks[0]!,{suggestedFix:'Clarify the action.',suggestedSceneId:'s1'});
    const targets=verificationFieldTargets(d),parts=targets.filter(t=>t.parentId==='causal:0'&&t.field==='explanation');
    expect(parts.map(t=>t.claim).join('')).toBe(original);expect(parts.every(t=>t.fullClaim===original&&t.claim===original.slice(t.start,t.end))).toBe(true);
    expect(parts.some(t=>t.claim.includes('1,000'))).toBe(true);expect(parts.some(t=>t.claim.includes('1.5'))).toBe(true);
    const repeated=parts.filter(t=>t.claim.includes('重复'));expect(repeated).toHaveLength(2);expect(repeated[0]!.id).not.toBe(repeated[1]!.id);
    const scope=targets.filter(t=>t.parentId==='causal:0'&&t.field==='suggestedSceneId');expect(scope).toHaveLength(1);expect(scope[0]!.id).toBe('causal:0#suggestedSceneId');
    const r=revision(),f=facts(r,d),w=auditWire(r,d,f),result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(result.errors).toEqual([]); // The segmenter never rules out a conditional or creative preference by itself.
  });
  test('large parents are isolated within 32 outputs and over-limit parents fail without losing source text',()=>{
    const r=revision(),d=draft(r);d.causality!.checks[0]!.explanation=Array.from({length:19},(_,i)=>`第${i+1}个待核陈述，`).join('');
    const f=facts(r,d),fields=verificationFieldTargets(d,f),batches=auditBatches(d,f),ids=batches.find(ids=>ids.includes('causal:0'))!;
    expect(ids).toEqual(['causal:0']);expect(fields.filter(t=>t.parentId==='causal:0').length+1).toBeGreaterThan(16);
    expect(fields.filter(t=>t.parentId==='causal:0').length+1).toBeLessThanOrEqual(32);
    d.causality!.checks[0]!.explanation='待核陈述，'.repeat(40);const before=d.causality!.checks[0]!.explanation;
    expect(()=>auditBatches(d,f)).toThrow('32');expect(d.causality!.checks[0]!.explanation).toBe(before);
  });
  test('multi-part fixes retain their segments and exactly one complete post-edit target for every suggestion kind',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),fix='Keep the stated allocation. Change the later destination.';
    Object.assign(d.assessments[0]!,{suggestedFix:fix,suggestedSceneId:'s2'});
    Object.assign(d.causality!.checks[0]!,{suggestedFix:fix,suggestedSceneId:'s1'});
    Object.assign(d.causality!.pressures![0]!,{suggestedFix:fix,suggestedSceneId:'s2'});
    Object.assign(f.omissions[1]!,{status:'issue',suggestedFix:fix,suggestedSceneId:'s2'});
    const fields=verificationFieldTargets(d,f),all=auditWire(r,d,f);
    for(const parentId of ['assessment:story','causal:0','pressure:0','omission:accounting']){
      const targets=fields.filter(t=>t.parentId===parentId&&t.field==='suggestedFix'),full=targets.filter(t=>t.id===`${parentId}#suggestedFix`);
      expect(full).toHaveLength(1);expect(full[0]!).toMatchObject({claim:fix,fullClaim:fix,start:0,end:fix.length});
      const parts=targets.filter(t=>t.id!==`${parentId}#suggestedFix`);
      expect(parts).toHaveLength(2);expect(parts.map(t=>t.claim).join('')).toBe(fix);
      const ids=auditBatches(d,f).find(ids=>ids.includes(parentId))!,partIds=new Set(fields.filter(t=>ids.includes(t.parentId)).map(t=>t.id));
      expect(ids.length+partIds.size).toBeLessThanOrEqual(ids.length===1?32:16);
      const payload=JSON.parse(buildVerificationAudit(r,d,f,getReviewSources(r),ids)[1]!.content);
      expect(payload.fieldTargets.filter((t:{parentId:string;field:string})=>t.parentId===parentId&&t.field==='suggestedFix')).toEqual(targets);
      const batch={checks:all.checks.filter(c=>ids.includes(c.targetId)),fieldChecks:all.fieldChecks.filter(c=>partIds.has(c.targetId))};
      expect(parseVerificationAuditBatch(JSON.stringify(batch),r,d,f,getReviewSources(r),ids).errors).toEqual([]);
      batch.fieldChecks=batch.fieldChecks.filter(c=>c.targetId!==`${parentId}#suggestedFix`);
      expect(parseVerificationAuditBatch(JSON.stringify(batch),r,d,f,getReviewSources(r),ids).errors.some(e=>e.includes(`${parentId}#suggestedFix`))).toBe(true);
    }
    d.causality!.checks[0]!.suggestedFix='Keep the stated allocation.';
    expect(verificationFieldTargets(d,f).filter(t=>t.parentId==='causal:0'&&t.field==='suggestedFix').map(t=>t.id)).toEqual(['causal:0#suggestedFix']);
  });
  test('whole-fix rejection or missing coverage blocks approved fragments, and whole approval cannot override a rejected fragment',()=>{
    const r=revision();r.scenes[1]!.content+=`\n${seedPlan}`;
    const d=draft(r),fix='Split the balance between uses. Keep the earlier full seed allocation unchanged.';
    Object.assign(d.causality!.checks[1]!,{suggestedFix:fix,suggestedSceneId:'s2'});
    const f=facts(r,d),fields=verificationFieldTargets(d,f).filter(t=>t.parentId==='causal:1'&&t.field==='suggestedFix');
    for(const mode of ['whole-rejected','whole-missing','fragment-rejected']){
      const w=auditWire(r,d,f),id=mode==='fragment-rejected'?fields.find(t=>t.id.includes('@'))!.id:'causal:1#suggestedFix';
      if(mode==='whole-missing')w.fieldChecks=w.fieldChecks.filter(c=>c.targetId!==id);
      else Object.assign(w.fieldChecks.find(c=>c.targetId===id)!,{verdict:'unsupported',claimQuote:fields.find(t=>t.id===id)!.claim,
        explanation:'The unchanged earlier full allocation and the complete split are not reconciled.',correction:'Reconcile the complete proposed allocation with the unchanged earlier commitment.',
        evidence:[quote('scene:s2',seedPlan),quote('scene:s3',receipt)]});
      const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
      expect(result.audit!.originalChecks.find(c=>c.targetId==='causal:1')!.verdict).toBe('supported');
      expect(result.checks.find(c=>c.targetId==='causal:1')!.verdict).toBe(mode==='whole-missing'?'uncertain':'unsupported');
      expect(result.audit!.schemaVersion).toBe(5);expect(d.causality!.checks[1]!.suggestedFix).toBe(fix);
      if(mode==='whole-missing')expect(result.errors.some(e=>e.includes('causal:1#suggestedFix'))).toBe(true);
      else expect(result.errors).toEqual([]);
    }
  });
});

// Prompt contracts only: these assertions do not establish that the model will
// correctly identify an unsupported premise. Real replay remains separate.
describe('source-compatible counterexample audit prompt',()=>{
  test('requires the original strength, unproved premises and independent spatial relations without banning ordinary editing',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),sources=getReviewSources(r);
    for(const ids of [undefined,['causal:2']]){
      const messages=buildVerificationAudit(r,d,f,sources,ids),system=messages[0]!.content,payload=JSON.parse(messages[1]!.content);
      for(const contract of [
        '当前原句按原强度有来源依据','保持所有明确来源事实不变','不能用这个条件句支持原文无条件的Q',
        '未提及某设施不是证明该设施不存在','提出或接受解决方案不是证明措施已实施',
        'A 靠近 B 不等于 C 远离 B','不同地点名称本身不证明物理分离','是否为同一地点或物件',
        '移动到已给地点可以是普通可选行动','未证的位置、隔离范围或作用机制',
        '该片段依赖的未证前提：无／具体内容','确定断言的 verdict 就不能 supported',
        '普通可选行动不需原文已执行','审美建议不需被当成客观事实','不要为制造反例假定角色无端撒谎',
        '两种交付方案的数量相减只得到方案差额','剩余待处理量需要同一时点已经完成或已分级的明确证据',
        '后续完成部分交付不能倒推决策前已经完成','各操作数的状态与时间，并引用已完成依据',
      ])expect(system).toContain(contract);
      expect(payload.sources).toEqual(sources);
      expect(payload.targets).toEqual(verificationAuditTargets(d,f).filter(t=>!ids||ids.includes(t.id)));
      expect(payload.fieldTargets).toEqual(verificationFieldTargets(d,f).filter(t=>!ids||ids.includes(t.parentId)));
    }
  });
  test('asks for short continuous quotes and separate relationship evidence while retaining the existing schema',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),sources=getReviewSources(r),system=buildVerificationAudit(r,d,f,sources)[0]!.content;
    for(const contract of ['每条 quote 取足够表达限定的短片段','必须逐字连续','不相邻句子时，分别放进多条 evidence',
      '不得省掉中间台词、动作、说话人标签或其他文字后拼成一条','不要用省略号代替'])expect(system).toContain(contract);
    const parsed=parseVerificationAudit(JSON.stringify(auditWire(r,d,f)),r,d,f,sources);
    expect(parsed.errors).toEqual([]);expect(parsed.audit!.schemaVersion).toBe(5);
  });
  test('requires complete post-edit consistency, concrete examples and unchanged outside scope',()=>{
    const r=revision(),d=draft(r),f=facts(r,d),sources=getReviewSources(r),system=buildVerificationAudit(r,d,f,sources)[0]!.content;
    for(const contract of ['裸 parentId#suggestedFix 全文目标','所有片段与全文都必须核实','只在 suggestedSceneId 指定的一场',
      '全部具体示例和指令','其他场景与简报保持不动','修改前承诺与修改后结果','相关未改原句、具体改后句',
      '金额相加正确、修改位置可编辑，不等于跨场承诺一致','具体示例不是可忽略的占位','全文目标不能 supported'])expect(system).toContain(contract);
    for(const prompt of [system,buildVerificationFacts(r,sources)[0]!.content]){
      expect(prompt).toContain('英文撇号直接写在 JSON 双引号字符串中，不在其前加反斜杠');
      expect(prompt).toContain('同一对象键不得重复');
    }
  });
});

describe('program-bound source line references',()=>{
  function fixture(){
    const r=revision();r.scenes[1]!.content+="\n  BOLT (CONT'D)  \nAt one-to-one, we hand-sort thirty-five kilos together.";
    const d=draft(r),f=facts(r,d),sources=getReviewSources(r),index=sourceLineIndex(sources);
    const line=index.find(row=>row.sourceId==='scene:s2'&&row.quote==="  BOLT (CONT'D)  ")!;
    return {r,d,f,sources,index,line};
  }
  test('directory retains every nonblank original line, stable source IDs, blank-line gaps and exact whitespace',()=>{
    const sources=[{id:'scene:甲/1',text:"HEADING\r\n\r\n  BOLT (CONT'D)  \r\nRepeated.\r\nRepeated.\r\n\t\r\nLast."},{id:'worldRules',text:'A\nB'}];
    const before=JSON.stringify(sources),rows=sourceLineIndex(sources);
    expect(rows.filter(r=>r.sourceId==='scene:甲/1').map(r=>[r.line,r.quote])).toEqual([[1,'HEADING'],[3,"  BOLT (CONT'D)  "],[4,'Repeated.'],[5,'Repeated.'],[7,'Last.']]);
    for(const [index,row] of rows.entries()){expect(row.refId).toBe(`R${index+1}`);expect(row.sourceRef).toBe(`line:${encodeURIComponent(row.sourceId)}:${row.line}`);expect(sources.find(s=>s.id===row.sourceId)!.text.includes(row.quote)).toBe(true);}
    expect(new Set(rows.map(r=>r.refId)).size).toBe(rows.length);
    const reversed=sourceLineIndex([...sources].reverse());
    const canonical=(rs:typeof rows)=>rs.map(({refId:_refId,...row})=>row).sort((a,b)=>a.sourceRef.localeCompare(b.sourceRef));
    expect(canonical(reversed)).toEqual(canonical(rows));
    expect(reversed[0]!.refId).toBe('R1');expect(reversed[0]!.sourceId).toBe('worldRules');expect(rows[0]!.sourceId).toBe('scene:甲/1');
    expect(JSON.stringify(sources)).toBe(before);
    expect(()=>sourceLineIndex([...sources,{id:sources[0]!.id,text:'Different text.'}])).toThrow('重复');
  });
  test('audit sends the unchanged full sources and complete line directory in every batch; facts retain the old protocol',()=>{
    const {r,d,f,sources,index}=fixture();
    for(const ids of auditBatches(d,f)){
      const messages=buildVerificationAudit(r,d,f,sources,ids),payload=JSON.parse(messages[1]!.content),prompt=messages[0]!.content;
      expect(payload.sources).toEqual(sources);expect(payload.sourceLineIndex).toEqual(index.map(({sourceRef:_sourceRef,...row})=>row));
      expect(payload.sourceLineIndex.every((row:Record<string,unknown>)=>row.sourceRef===undefined)).toBe(true);
      expect(prompt).toContain('只输出 {"refId":"R1"}');expect(prompt).toContain('不用手抄 quote/sourceId/说话人标签');
      expect(prompt).toContain('短编号仅在本次冻结目录有效');expect(prompt).toContain('不从 sourceId 或 line 推导');
      expect(prompt).toContain('line 是 source 全文行号');expect(prompt).toContain('关系跨行用多条 {refId}');
      expect(prompt).toContain('当前原句按原强度有来源依据');
    }
    expect(JSON.parse(buildVerificationFacts(r,sources)[1]!.content).sourceLineIndex).toBeUndefined();
  });
  test('a reference binds the exact speaker label and survives batch normalization and full merge parsing',()=>{
    const {r,d,f,sources,index,line}=fixture(),w=auditWire(r,d,f);
    const replace=(checks:typeof w.checks)=>{
      for(const check of checks){const sourceId=check.evidence[0]!.sourceId,ref=index.find(row=>row.sourceId===sourceId)!;
        Object.assign(check,{evidence:[{refId:ref.refId}]});}
    };
    replace(w.checks);replace(w.fieldChecks);
    const chosen=w.fieldChecks.find(c=>matchesField(c.targetId,'pressure:0#currentState'))!;
    Object.assign(chosen,{evidence:[{refId:line.refId}]});
    const parent=w.checks.find(c=>c.targetId==='causal:0')!;
    Object.assign(parent,{verdict:'contradicted',correction:'Retain the limiting source facts.',counterEvidence:[{refId:index.find(row=>row.quote===automated)!.refId}]});
    const merged:{checks:unknown[];fieldChecks:unknown[]}={checks:[],fieldChecks:[]},fields=verificationFieldTargets(d,f);
    for(const ids of auditBatches(d,f)){
      const childIds=new Set(fields.filter(t=>ids.includes(t.parentId)).map(t=>t.id));
      const raw=JSON.stringify({checks:w.checks.filter(c=>ids.includes(c.targetId)),fieldChecks:w.fieldChecks.filter(c=>childIds.has(c.targetId))});
      const batch=parseVerificationAuditBatch(raw,r,d,f,sources,ids);expect(batch.errors).toEqual([]);
      merged.checks.push(...batch.checks);merged.fieldChecks.push(...batch.fieldChecks);
    }
    const result=parseVerificationAudit(JSON.stringify(merged),r,d,f,sources);
    expect(result.errors).toEqual([]);
    const q=result.audit!.fieldChecks.find(c=>c.targetId===chosen.targetId)!.evidence[0]!;
    expect(q).toEqual({sourceId:line.sourceId,quote:line.quote,sourceRef:line.sourceRef});expect(q.modelQuote).toBeUndefined();
    expect(result.audit!.originalChecks.find(c=>c.targetId==='causal:0')!.counterEvidence[0]!.sourceRef).toBe(index.find(row=>row.quote===automated)!.sourceRef);
    const replay=parseVerificationAudit(JSON.stringify({checks:result.audit!.originalChecks,fieldChecks:result.audit!.fieldChecks}),r,d,f,sources);
    expect(replay).toEqual(result);
  });
  test('unknown refs, conflicting metadata and partial speaker quotations never fall back to handwritten evidence',()=>{
    const {r,d,f,sources,index,line}=fixture(),other=index.find(row=>row.sourceId==='scene:s1')!;
    const invalid=[
      {refId:'line:scene%3As2:99999'}, {refId:`line:scene:s2:${line.line}`}, {refId:''}, {refId:null}, {refId:3},
      ...['R0','R999999','r1','R01',' R1','R1 '].map(refId=>({refId})),
      {refId:line.refId,sourceId:'scene:s1'}, {refId:line.refId,quote:'BOLT'},
      {refId:line.refId,quote:line.quote.trim()}, {refId:line.refId,quote:"  BOLT  "},
      {refId:line.refId,sourceId:null}, {refId:line.refId,quote:null},
      {refId:line.refId,sourceRef:other.sourceRef,sourceId:line.sourceId,quote:line.quote},
      {refId:line.refId,modelQuote:line.quote}, {sourceRef:line.refId},
      {sourceRef:line.refId,sourceId:line.sourceId,quote:line.quote},
      {sourceRef:line.sourceRef,sourceId:line.sourceId,quote:'BOLT'},
      {sourceRef:line.sourceRef,sourceId:line.sourceId,quote:line.quote,modelQuote:line.quote},
      {refId:line.refId,sourceRef:null,sourceId:line.sourceId,quote:line.quote},
    ];
    for(const invalidQuote of invalid){
      const w=auditWire(r,d,f),check=w.checks[0]!;Object.assign(check,{evidence:[invalidQuote]});
      const result=parseVerificationAudit(JSON.stringify(w),r,d,f,sources);
      expect(result.errors.length).toBeGreaterThan(0);expect(result.audit!.originalChecks.some(c=>c.targetId===check.targetId)).toBe(false);
    }
    const w=auditWire(r,d,f);Object.assign(w.checks[0]!,{evidence:[{refId:line.refId},{refId:line.refId,quote:'BOLT'}]});
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,sources).errors.length).toBeGreaterThan(0);
  });
  test('reference metadata is checked against this frozen directory, never model-supplied mappings or another source snapshot',()=>{
    const {r,d,f,sources,line}=fixture(),canonical={sourceId:line.sourceId,quote:line.quote,sourceRef:line.sourceRef};
    for(const item of [{refId:line.refId},{refId:line.sourceRef},{refId:line.refId,sourceId:line.sourceId,quote:line.quote},canonical,{refId:line.refId,...canonical},{refId:line.sourceRef,...canonical}]){
      const w=auditWire(r,d,f);Object.assign(w.checks[0]!,{evidence:[item]});
      const result=parseVerificationAudit(JSON.stringify(w),r,d,f,sources);
      expect(result.errors).toEqual([]);expect(result.audit!.originalChecks[0]!.evidence).toEqual([canonical]);
    }
    const w=auditWire(r,d,f);Object.assign(w.checks[0]!,{evidence:[canonical]});
    const changed=sources.map(s=>s.id===line.sourceId?{...s,text:s.text.replace(line.quote,'Different speaker.')}:s);
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,changed).errors.length).toBeGreaterThan(0);
    expect(parseVerificationAudit(JSON.stringify(w),r,d,f,[...sources,{id:line.sourceId,text:'Conflicting directory.'}]).errors.length).toBeGreaterThan(0);
    const forged=Object.assign(w,{sourceLineIndex:[{refId:line.refId,sourceId:line.sourceId,line:line.line,quote:'BOLT'}]});
    Object.assign(w.checks[0]!,{evidence:[{refId:line.refId,quote:'BOLT'}]});
    expect(parseVerificationAudit(JSON.stringify(forged),r,d,f,sources).errors.length).toBeGreaterThan(0);
  });
  test('legacy exact quotations stay unchanged and refs do not bypass evidence scene scope or the facts protocol',()=>{
    const {r,d,f,sources,line}=fixture(),w=auditWire(r,d,f),baseline=parseVerificationAudit(JSON.stringify(w),r,d,f,sources);
    expect(baseline.errors).toEqual([]);expect(baseline.audit!.originalChecks[0]!.evidence[0]!.sourceRef).toBeUndefined();
    Object.assign(d.assessments[0]!,{suggestedFix:'Clarify the first scene.',suggestedSceneId:'s1'});
    const scoped=auditWire(r,d,f),scope=scoped.fieldChecks.find(c=>c.targetId==='assessment:story#suggestedSceneId')!;
    Object.assign(scope,{evidence:[{refId:line.refId}]});
    expect(parseVerificationAudit(JSON.stringify(scoped),r,d,f,sources).errors.some(e=>e.includes('明确改稿目标场景'))).toBe(true);
    const factWire=wire(r,d);Object.assign(factWire.omissions[0]!,{evidence:[{refId:line.refId}]});
    expect(parseVerificationFacts(JSON.stringify(factWire),r,sources).errors.length).toBeGreaterThan(0);
  });
});

// These are supplied auditor decisions over synthetic source fixtures. They
// verify preservation, parent aggregation and the shared rewrite gate, not
// whether a live model can discover the missing capacity or staffing premise.
describe('capacity and staffing claim regression gates',()=>{
  const selection='At 1x we hand-sort thirty-five kilograms together and ship the partial lot.';
  const singleWorker='One person needs ninety minutes of local work to finish the full sixty.';
  const delivered='MANIFEST: 35 KG ACCEPTED.';
  const explicitCap='CALIBRATED SHARED PORT: MAXIMUM 35 KG PER 45 LOCAL MINUTES WITH BOTH OPERATORS; NO SHIPMENT CAN BYPASS THIS PORT.';
  function setup(hardLimit=false){
    const r=revision();r.id=hardLimit?'explicit-port-capacity':'quantity-is-not-capacity';
    r.scenes[1]!.content=[
      'COLLECTION IN 45 CORRIDOR MINUTES. FULL LOT 60 KG / PARTIAL LOT 35 KG.',
      ...(hardLimit?[
        'Nia and Bolt must both feed the same single weighing port.',explicitCap,
        'At 1x the collection window contains forty-five local minutes.'
      ]:[singleWorker]),selection,
    ].join('\n');
    r.scenes[2]!.content=`${delivered}\nNia puts the receipt on the bench.`;
    const d=draft(r),p=d.causality!.pressures![0]!;
    Object.assign(p,{currentState:'The partners select a thirty-five kilogram partial lot.',directAlternative:'Deliver the selected partial lot.',
      explanation:'The selected lot is available for partial delivery.',suggestedSceneId:'s2'});
    const saved=(verification:ReturnType<typeof parseVerificationAudit>):Review=>({id:`review-${r.id}`,revisionId:r.id,mode:'live',createdAt:r.createdAt,status:verification.status,errors:[],...d,verification});
    return {r,d,p,saved};
  }

  for(const [name,claim,anchor,correction,fix] of [
    ['selected lot','Choosing thirty-five kilograms proves that thirty-five is the maximum capacity of both workers.',selection,
      'The selected output is known; maximum capacity is not established.',
      'Add a line declaring that thirty-five kilograms is the maximum both workers can sort.'],
    ['completed shipment','Delivering thirty-five kilograms proves that thirty-five is the maximum capacity of both workers.',delivered,
      'The completed shipment is known; it does not establish what the pair could have completed.',
      'Treat the delivered thirty-five kilograms as a measured maximum in the decision dialogue.'],
    ['single-worker estimate','One person needs ninety minutes so two people cannot finish sixty kilograms within forty-five minutes at 1x.',singleWorker,
      'The two-person completion time is unknown; neither guaranteed completion nor impossibility follows without the staffing and bottleneck conditions.',
      'Make Nia say that even two people cannot finish the full lot in forty-five minutes.'],
  ] as const)test(`${name} cannot authorize a capacity-based rewrite after its supplied audit rejection`,()=>{
    const {r,d,p,saved}=setup();Object.assign(p,{explanation:claim,suggestedFix:fix});
    const f=facts(r,d),w=auditWire(r,d,f),targets=verificationFieldTargets(d,f),field=targets.find(t=>t.parentId==='pressure:0'&&t.field==='explanation'&&t.claim===claim)!;
    expect(field).toBeDefined();
    // Establish that the target, scope and suggestion are structurally usable;
    // the later rejection, rather than an unrelated schema error, closes it.
    const beforeAudit=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r));
    expect(beforeAudit.errors).toEqual([]);
    const beforeReview=saved(beforeAudit);
    expect(reviewSuggestion(beforeReview,beforeReview.id,'pressure:0','s2')).toEqual({sceneId:'s2',instruction:fix});
    const frozen=JSON.stringify({r,d,f}),originalParents=JSON.stringify(w.checks);
    Object.assign(w.fieldChecks.find(c=>c.targetId===field.id)!,{
      verdict:'unsupported',claimQuote:claim,explanation:'The stated evidence does not establish this capacity or two-person impossibility premise.',correction,
      evidence:[quote(anchor===delivered?'scene:s3':'scene:s2',anchor)],
    });
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)),review=saved(result);
    expect(result.errors).toEqual([]);expect(result.status).toBe('needs_review');
    expect(result.audit!.originalChecks.find(c=>c.targetId==='pressure:0')!.verdict).toBe('supported');
    expect(result.audit!.fieldChecks.find(c=>c.targetId===field.id)!.verdict).toBe('unsupported');
    expect(result.audit!.checks.find(c=>c.targetId==='pressure:0')!.verdict).toBe('unsupported');
    expect(result.checks.find(c=>c.targetId==='pressure:0')!.correction).toContain(correction);
    expect(result.audit!.fieldChecks.filter(c=>c.targetId.startsWith('pressure:0#suggestedFix')).every(c=>c.verdict==='supported')).toBe(true);
    expect(reviewTargetSupported(review,'pressure:0')).toBe(false);
    expect(reviewSuggestion(review,review.id,'pressure:0','s2')).toBeUndefined();
    expect(JSON.stringify({r,d,f})).toBe(frozen);expect(JSON.stringify(w.checks)).toBe(originalParents);
    expect(p.suggestedFix).toBe(fix);expect(p.explanation).toBe(claim);
  });

  test('an explicitly measured shared bottleneck with stated staffing can retain a supported real capacity limit',()=>{
    const {r,d,p,saved}=setup(true),instruction='Keep the existing shared-port capacity reading visible while the partners choose the partial lot.';
    Object.assign(p,{verdict:'binding',currentState:'Both operators share a single mandatory grading port.',
      explanation:'The shared port limits both operators to thirty-five kilograms in forty-five local minutes, so sixty kilograms cannot pass it before collection at 1x.',
      blockingEvidence:[quote('scene:s2',explicitCap)],suggestedFix:instruction});
    const f=facts(r,d),w=auditWire(r,d,f),before=JSON.stringify({r,d,f});
    for(const check of [...w.checks,...w.fieldChecks].filter(c=>c.targetId==='pressure:0'||c.targetId.startsWith('pressure:0#'))){
      check.explanation='This supplied positive decision uses an explicit shared bottleneck measured with both operators and the stated local window.';
      check.evidence=[quote('scene:s2',explicitCap),quote('scene:s2','At 1x the collection window contains forty-five local minutes.')];
    }
    const result=parseVerificationAudit(JSON.stringify(w),r,d,f,getReviewSources(r)),review=saved(result);
    expect(result.errors).toEqual([]);expect(result.status).toBe('completed');expect(result.audit!.checks.find(c=>c.targetId==='pressure:0')!.verdict).toBe('supported');
    expect(reviewTargetSupported(review,'pressure:0')).toBe(true);
    expect(reviewSuggestion(review,review.id,'pressure:0','s2')).toEqual({sceneId:'s2',instruction});
    expect(result.audit!.fieldChecks.filter(c=>c.targetId.startsWith('pressure:0#')).every(c=>c.verdict==='supported')).toBe(true);
    expect(JSON.stringify({r,d,f})).toBe(before);
  });
});
