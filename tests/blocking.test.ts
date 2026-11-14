import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { foldBlocking, openingState } from '../src/core/blocking';
import { planRenderBatch, type RenderPlanInput } from '../src/core/h3';
import { lineIndex, logicFindings, parseLedger } from '../src/core/logic';
import { shotListWarnings } from '../src/core/shotList';
import { SHORT_DRAMA_DEMO, shortDramaDemoLedger, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { LogicBlocking, LogicLedger, Revision, ShotList } from '../src/types';

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

  test('the parser refuses unknown zones, things and kinds; older ledgers without blocking still parse', () => {
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'move', {zone: 'z9'})]}), revision)).toThrow('不在区域表里');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'use', {thing: 't9'})]}), revision)).toThrow('不在东西表里');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'fly' as 'at')]}), revision)).toThrow('动作类型');
    expect(() => parseLedger(ledger({...broken, events: [ev('s1:1', 'LEO', 'move')]}), revision)).toThrow('zone');
    expect(() => parseLedger(ledger({...broken, zones: [{id: 'z1', name: 'x', en: 'by <d>'}]}), revision)).toThrow('不能含有');
    const {blocking: _, ...old} = ledger(broken);
    expect(parseLedger(old, revision).blocking).toBeUndefined();
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

  test('the demo ledger keeps its clean check with blocking', () => {
    const r = demo();
    expect(logicFindings(parseLedger(shortDramaDemoLedger('en'), r), r)).toEqual([]);
  });

  test('a hand on a flame is flagged as a hard action to split into action and result', () => {
    const r = demo(); r.scenes[2]!.content = r.scenes[2]!.content.replace('Maya reads it. Her smile fades.', 'Leo smothers the match flame with his palm.');
    const warnings = shotListWarnings(list(), {revision: r, adaptations: {}}).filter(w => w.kind === 'hard_action');
    expect(warnings.map(w => w.shotId)).toEqual(['sh8']);
    expect(warnings[0]!.message).toContain('“动作”和“结果”两个镜头');
  });
});
