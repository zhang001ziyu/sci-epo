import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { actionRefs, describeState, foldBlocking, openingState } from '../src/core/blocking';
import { buildLogicMessages } from '../src/core/logicPrompt';
import { buildStoryboardMessages } from '../src/core/storyboardPrompt';
import { createModelCaller } from '../src/server/modelAttempts';
import { planRenderBatch, type RenderPlanInput } from '../src/core/h3';
import { carryKept, lineIndex, logicFindings, parseLedger, parseLedgerOutput } from '../src/core/logic';
import { HARD_ACTION, shotListWarnings } from '../src/core/shotList';
import { SHORT_DRAMA_DEMO, shortDramaDemoLedger, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { LogicBlocking, LogicCheck, LogicLedger, Revision, ShotList } from '../src/types';

const time = '2026-11-14T08:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA, LEO', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const};
// The break of the first rendered episode: Leo rises from the armchair and holds a lit match to an envelope taped to
// the kitchen fridge, without ever crossing to the kitchen. Line 5 is a reaction; scene 2 cuts away and back.
const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, title: 'Last Order', logline: '', language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: time, context: snapshotContext(brief, []),
  scenes: [
    {id: 's1', heading: 'INT. LEO\'S APARTMENT - NIGHT', locked: false, content: 'Leo sits in the armchair.\nA blue envelope is taped to the side of the fridge.\nLeo heaves himself up and strikes a match from the red box.\nLeo holds the flame to the blue envelope.\nLeo freezes.'},
    {id: 's2', heading: 'INT. HALLWAY - NIGHT', locked: false, content: 'Maya waits outside the door.\nInside, Leo stares at the flame.'},
  ]};
const zones = [{id: 'z1', name: '客厅扶手椅', en: 'in the armchair in the living room'}, {id: 'z2', name: '厨房冰箱旁', en: 'at the kitchen fridge'}, {id: 'z3', name: '门外走廊', en: 'in the hallway outside the door'}];
const things = [
  {id: 't1', name: '蓝信封', en: 'a blue envelope', ref: 's1:2', zone: 'z2', holder: null},
  {id: 't2', name: '红火柴盒', en: 'a red box of matches', ref: 's1:3', zone: null, holder: 'LEO'},
  {id: 't3', name: '一根火柴', en: 'a single match', ref: 's1:3', zone: null, holder: 'LEO'},
];
const ev = (ref: string, who: string, kind: LogicBlocking['events'][number]['kind'], extra: Partial<LogicBlocking['events'][number]> = {}) => ({ref, who, kind, zone: null, posture: null, thing: null, with: null, to: null, state: null, ...extra});
const broken: LogicBlocking = {zones, things, events: [
  ev('s1:1', 'LEO', 'at', {zone: 'z1', posture: 'sitting'}),
  ev('s1:3', 'LEO', 'stand'),
  ev('s1:3', 'LEO', 'use', {thing: 't3', with: 't2', state: 'lit'}),
  ev('s1:4', 'LEO', 'use', {thing: 't1', with: 't3'}),
  ev('s2:1', 'MAYA', 'at', {zone: 'z3', posture: 'standing'}),
]};
// The author's fix: Leo crosses to the fridge before the flame reaches the envelope.
const fixed: LogicBlocking = {...broken, events: [...broken.events.slice(0, 3), ev('s1:4', 'LEO', 'move', {zone: 'z2'}), ...broken.events.slice(3)]};
const index = lineIndex(revision);
const ledger = (blocking: LogicBlocking): LogicLedger => ({protagonist: 'LEO', offscreen: [], ending: {ref: 's2:2', question: '他会烧掉信吗？', dependsOn: []}, setups: [], instructions: [], sightings: [], choices: [{ref: 's1:3', choice: '点火', cost: '信'}], blocking});

describe('blocking', () => {
  test('acting on a thing in another zone without moving is a finding; the confirmed move passes', () => {
    const findings = logicFindings(parseLedger(ledger(broken), revision), revision);
    expect(findings.map(f => [f.kind, f.ref])).toEqual([['out_of_reach', 's1:4']]);
    expect(findings[0]!.title).toBe('LEO 在客厅扶手椅，够不着“蓝信封”');
    expect(findings[0]!.detail).toContain('（“Leo sits in the armchair.”（s1:1））');
    expect(findings[0]!.fix).toContain('LEO 走到厨房冰箱旁');
    expect(logicFindings(parseLedger(ledger(fixed), revision), revision)).toEqual([]);
  });

  test('a reaction keeps the state; the matchbox and the match stay two things; a hold survives a cut', () => {
    const fold = foldBlocking(fixed, revision, index);
    const reaction = fold.before('s1', 5)!;
    expect(reaction.people.get('LEO')).toMatchObject({zone: 'z2', posture: 'standing'});
    expect(reaction.things.get('t3')).toEqual({zone: null, holder: 'LEO', state: 'lit'});
    expect(reaction.things.get('t2')).toEqual({zone: null, holder: 'LEO', state: null});
    expect(openingState(fixed, reaction, [{key: 'LEO', name: 'LEO'}]).text).toBe('Continuity at the start of this clip: LEO is standing at the kitchen fridge, holding a red box of matches and a single match (lit). A blue envelope is at the kitchen fridge.');
    // Scene 2 does not show Leo's position, so it is unknown; what he holds off screen is not cleared.
    const later = fold.before('s2', 2)!;
    expect(later.people.has('LEO')).toBe(false);
    expect(later.things.get('t3')!.holder).toBe('LEO');
    expect(openingState(fixed, later, [{key: 'LEO', name: 'LEO'}]).text).toBe('Continuity at the start of this clip: LEO is holding a red box of matches and a single match (lit).');
  });

  test('a position change without an action, and using a thing not in hand, are findings', () => {
    const jumped: LogicBlocking = {...fixed, events: [...fixed.events, ev('s1:5', 'LEO', 'at', {zone: 'z1', posture: 'sitting'})]};
    expect(logicFindings(ledger(jumped), revision).map(f => [f.kind, f.ref])).toEqual([['no_move', 's1:5']]);
    const lighter: LogicBlocking = {...fixed, things: [...things, {id: 't4', name: '打火机', en: 'a lighter', ref: 's1:2', zone: 'z1', holder: null}],
      events: fixed.events.map(e => e.ref === 's1:4' && e.kind === 'use' ? {...e, with: 't4'} : e)};
    const findings = logicFindings(ledger(lighter), revision);
    expect(findings.map(f => [f.kind, f.ref])).toEqual([['not_holding', 's1:4']]);
    expect(findings[0]!.detail).toContain('放在客厅扶手椅');
  });

  test('a kept reason survives a rerun that words the finding differently, and a rerun that lost it', () => {
    const f = (id: string, ref = 's1:3') => ({id, kind: 'offscreen_knowledge' as const, ref, title: id, detail: '', fix: ''});
    const oldest: LogicCheck = {id: 'c1', revisionId: 'r1', episodeId: 'e1', mode: 'live', ledger: ledger(fixed), findings: [f('offscreen:s1:3:她知道他心脏不好'), f('a', 's1:4')], kept: {'offscreen:s1:3:她知道他心脏不好': {reason: '订单里写明她是女儿', at: time}}, createdAt: '2026-11-13T00:00:00.000Z'};
    const lost: LogicCheck = {...oldest, id: 'c2', findings: [f('offscreen:s1:3:父亲有心脏病')], kept: undefined, createdAt: '2026-11-14T00:00:00.000Z'};
    expect(carryKept([lost, oldest], [f('offscreen:s1:3:心脏病和警笛'), f('b', 's1:4')])).toEqual({'offscreen:s1:3:心脏病和警笛': {reason: '订单里写明她是女儿', at: time}});
    // Two new findings on the same line cannot tell which one the reason was for.
    expect(carryKept([oldest], [f('x'), f('y')])).toEqual({});
  });

  test('the parser refuses unknown zones, things and kinds; older ledgers without blocking still parse', () => {
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'move', {zone: 'z9'})]}), revision)).toThrow('不在区域表里');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'use', {thing: 't9'})]}), revision)).toThrow('不在东西表里');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'fly' as 'at')]}), revision)).toThrow('动作类型');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'move')]}), revision)).toThrow('zone');
    expect(() => parseLedger(ledger({...broken, zones: [{id: 'z1', name: 'x', en: 'by <d>'}]}), revision)).toThrow('不能含有');
    expect(parseLedger(ledger({...broken, things: things.map(t => t.id === 't2' ? {...t, zone: 'z1'} : t)}), revision).blocking!.things[1]).toMatchObject({zone: null, holder: 'LEO'});
    const {blocking: _, ...old} = ledger(broken);
    expect(parseLedger(old, revision).blocking).toBeUndefined();
  });
});

describe('line-by-line answers and conditions', () => {
  // The model's format: one entry per action line of the script.
  const byLine = (blocking: LogicBlocking, drop: string[] = []) => {
    const {events, ...rest} = blocking;
    return {...rest, lines: actionRefs(revision).filter(r => !drop.includes(r)).map(ref => ({ref, events: events.filter(e => e.ref === ref).map(({ref: _, ...e}) => e)}))};
  };
  const live = (value: unknown) => parseLedgerOutput(JSON.stringify({...ledger(broken), blocking: value}), revision, {coverage: true});

  test('a live answer must cover every action line; a skipped line is refused by number', () => {
    expect(actionRefs(revision)).toEqual(['s1:1', 's1:2', 's1:3', 's1:4', 's1:5', 's2:1', 's2:2']);
    expect(live(byLine(fixed)).blocking!.events).toEqual(fixed.events);
    expect(() => live(byLine(fixed, ['s1:4']))).toThrow('逐行走位漏了 1 个动作行：s1:4');
    expect(() => live(fixed)).toThrow('逐行填写 lines');
    expect(() => parseLedgerOutput(JSON.stringify({...ledger(broken), blocking: undefined}), revision, {coverage: true})).toThrow('缺少走位');
    // Dialogue lines are not asked for.
    const talk: Revision = {...revision, scenes: [{...revision.scenes[0]!, content: 'Leo sits.\nLEO: Go.\nMAYA\nNo.'}, revision.scenes[1]!]};
    expect(actionRefs(talk)).toEqual(['s1:1', 's2:1', 's2:2']);
  });

  test('a burn lasts into later scenes and clips until the script ends it', () => {
    const burned: LogicBlocking = {...fixed, events: [...fixed.events, ev('s1:5', 'LEO', 'condition', {state: 'a burned right palm'})]};
    const fold = foldBlocking(burned, revision, index);
    expect(fold.before('s2', 2)!.conditions.get('LEO')).toEqual(['a burned right palm']);
    expect(openingState(burned, fold.before('s2', 2)!, [{key: 'LEO', name: 'LEO'}]).text).toContain('LEO has a burned right palm.');
    expect(describeState(burned, fold.before('s2', 2)!, [{key: 'LEO', name: 'LEO'}])).toEqual(['LEO：拿着红火柴盒、一根火柴（lit），a burned right palm']);
    const healed: LogicBlocking = {...burned, events: [...burned.events, ev('s2:1', 'LEO', 'recover', {state: 'a burned right palm'})]};
    expect(foldBlocking(healed, revision, index).before('s2', 2)!.conditions.has('LEO')).toBe(false);
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'condition')]}), revision)).toThrow('状况');
  });
});

describe('clips and shots', () => {
  const demo = (): Revision => ({id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(SHORT_DRAMA_DEMO.en), language: 'en', kind: 'generated', instruction: '', mode: 'demo', createdAt: time, context: snapshotContext(brief, [])});
  const list = (): ShotList => ({...shortDramaDemoShotList('en'), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en'], adaptations: {}, mode: 'demo', createdAt: time});
  const blocking: LogicBlocking = {
    zones: [{id: 'z1', name: '电梯里', en: 'in the elevator'}, {id: 'z2', name: '门外走廊', en: 'in the hallway outside the door'}],
    things: [{id: 't1', name: '蛋糕盒', en: 'a clear box with one cupcake', ref: 's1:1', zone: null, holder: 'MAYA'}, {id: 't2', name: '手机', en: 'her phone', ref: 's1:2', zone: null, holder: 'MAYA'}],
    events: [ev('s1:1', 'MAYA', 'at', {zone: 'z1', posture: 'standing'}), ev('s1:4', 'MAYA', 'move', {zone: 'z2'}), ev('s2:1', 'LEO', 'at', {zone: 'z2', posture: 'standing'}), ev('s2:3', 'MAYA', 'at', {zone: 'z2', posture: 'standing'}), ev('s2:7', 'MAYA', 'give', {thing: 't1', to: 'LEO'})]};
  const input = (extra: Partial<RenderPlanInput> = {}): RenderPlanInput => ({batchId: 'b1', createdAt: time, episodeId: 'e1', list: list(), revision: demo(), adaptations: {}, profile: {style: 'Live-action, cinematic', music: 'N/A', characters: []}, ...extra});

  test('every clip opens with the state of its first line', () => {
    const clips = planRenderBatch(input({blocking})).batch.clips;
    expect(clips[0]!.prompts.en!.text).toContain('Continuity at the start of this clip: MAYA is standing in the elevator, holding a clear box with one cupcake and her phone.');
    expect(clips[3]!.prompts.en!.text).toContain('Continuity at the start of this clip: MAYA is standing in the hallway outside the door, holding a clear box with one cupcake and her phone. LEO is standing in the hallway outside the door.');
    // After the handover the box is Leo's; scene 3 does not place Maya, so only what she holds is stated.
    expect(clips[4]!.prompts.en!.text).toContain('Continuity at the start of this clip: MAYA is holding her phone.');
    expect(planRenderBatch(input()).batch.clips[0]!.prompts.en!.text).not.toContain('Continuity');
  });

  test('the logic request lists the lines to answer; the storyboard request carries the blocking', () => {
    const user = JSON.parse(buildLogicMessages(revision)[1]!.content);
    expect(user.blockingLines).toEqual(actionRefs(revision));
    const [system, request] = buildStoryboardMessages(demo(), undefined, blocking);
    expect(system!.content).toContain('反应镜头、特写和切回来的镜头不改变它们');
    expect(JSON.parse(request!.content).blocking[1]).toEqual({sceneId: 's2', start: ['MAYA：站着，在门外走廊，拿着蛋糕盒、手机', 'LEO：站着，在门外走廊'], actions: [{n: 1, action: 'LEO：在门外走廊，站着'}, {n: 3, action: 'MAYA：在门外走廊，站着'}, {n: 7, action: 'MAYA：把“蛋糕盒”递给 LEO'}]});
    expect(JSON.parse(buildStoryboardMessages(demo())[1]!.content).blocking).toBeUndefined();
  });

  test('a logic answer the program refuses is sent again once', async () => {
    let calls = 0;
    const caller = createModelCaller({mode: 'live', async complete() { calls++; return calls === 1 ? 'bad' : 'good'; }}, 'logic', () => {});
    const { AuditValidationError } = await import('../src/server/modelAttempts');
    const raw = await caller.complete({kind: 'logic', context: revision.context, revision, episodeTitle: 'x'}, {validate: value => { if (value === 'bad') throw new AuditValidationError(['逐行走位漏了 1 个动作行：s1:4。']); }});
    expect(raw).toBe('good');
    expect(caller.attempts.map(a => [a.attempt, a.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
  });

  test('the demo ledger keeps its clean check with blocking', () => {
    const r = demo();
    expect(logicFindings(parseLedger(shortDramaDemoLedger('en'), r), r)).toEqual([]);
  });

  test('a hand on a flame is flagged as a hard action to split into action and result', () => {
    const r = demo(); r.scenes[2]!.content = r.scenes[2]!.content.replace('Maya reads it. Her smile fades.', 'Leo smothers the match flame with his palm.');
    const warnings = shotListWarnings(list(), {revision: r, adaptations: {}}).filter(w => w.kind === 'hard_action');
    expect(warnings.map(w => w.shotId)).toEqual(['sh8']);
    expect(warnings[0]!.message).toContain('“动作”和“结果”两个镜头');
    // The wording of the rendered episode, and ordinary hand actions that are not flagged.
    for (const line of ['Maya lunges across the counter and claps her bare palm over the burning match.', '玛雅用手掌死死捂住燃烧的火柴。']) expect(HARD_ACTION.test(line)).toBe(true);
    for (const line of ['Leo lowers the flame straight toward the blue envelope.', 'She taps her cracked phone screen.', 'A bright flame flares up between his trembling fingers.']) expect(HARD_ACTION.test(line)).toBe(false);
  });
});
