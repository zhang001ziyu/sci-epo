import { afterEach, describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { logicFindings, logicGate, parseLedger } from '../src/core/logic';
import { buildLogicMessages } from '../src/core/logicPrompt';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { LogicCheck, LogicLedger, ProjectBundle, Revision } from '../src/types';

const time = '2026-11-13T08:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA: a rider.\nLEO: seventy, Anna\'s father.', worldRules: 'A real city.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const};
// A two-scene draft with the problems of the first real run: a message that knows the room, a late prop, a dead key,
// an order without a reason, a find that cannot be seen and a rider who never chooses.
const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, title: 'Last Order', logline: '', language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: time, context: snapshotContext(brief, []),
  scenes: [
    {id: 's1', heading: 'INT. CORRIDOR - NIGHT', locked: false, content: 'Maya walks to door 402.\nThe note reads: "Do NOT call 911. Check he is breathing."\nUnder the mat lies a bent brass key.\nThe door drifts open by itself.'},
    {id: 's2', heading: 'INT. LEO\'S APARTMENT', locked: false, content: 'Leo sits in the dark.\nLEO: Get out.\nMaya glances toward the kitchen.\nA blue envelope is taped behind the fridge coil.\nA text from Anna: "Don\'t let him light the match."\nLeo grips a box of matches.'},
  ]};
const ledger: LogicLedger = {protagonist: 'MAYA',
  offscreen: [{character: 'ANNA', messageRef: 's2:5', claims: [{fact: '老林此刻要点火柴', sourceKind: 'none', sourceRef: null}, {fact: '她在担心父亲', sourceKind: 'self', sourceRef: null}]}],
  ending: {ref: 's2:6', question: '老林会不会点火？', dependsOn: [{thing: '火柴', kind: 'prop', firstRef: 's2:6'}, {thing: '安娜是老林的女儿', kind: 'relationship', firstRef: null}, {thing: '蓝信封', kind: 'prop', firstRef: 's2:4'}]},
  setups: [{thing: '弯钥匙', ref: 's1:3', payoffRef: null, bearsOnEnding: false}, {thing: '蓝信封', ref: 's2:4', payoffRef: null, bearsOnEnding: true}],
  instructions: [{text: '不许叫 911', ref: 's1:2', reasonRef: null}],
  sightings: [{who: 'MAYA', what: '冰箱背后的信封', ref: 's2:4', visible: 'no', why: '从客厅瞥一眼看不到冰箱背面的散热管。'}],
  choices: []};

describe('ledger and findings', () => {
  test('the program finds each break of the draft from the ledger, in script order', () => {
    const findings = logicFindings(parseLedger(ledger, revision), revision);
    expect(findings.map(f => [f.kind, f.ref])).toEqual([
      ['unexplained_instruction', 's1:2'], ['dead_setup', 's1:3'], ['unseen', 's2:4'], ['offscreen_knowledge', 's2:5'],
      ['ending_late', 's2:6'], ['ending_unstated', 's2:6'], ['no_choice', 's2:6'],
    ]);
    expect(new Set(findings.map(f => f.kind))).toEqual(new Set(['unexplained_instruction', 'dead_setup', 'unseen', 'offscreen_knowledge', 'ending_unstated', 'ending_late', 'no_choice']));
    const knows = findings.find(f => f.kind === 'offscreen_knowledge')!;
    expect(knows.title).toContain('ANNA 不在场');
    expect(knows.detail).toContain('Don\'t let him light the match');
    // A fact about the sender herself needs no source; the envelope bears on the ending, so it is not a dead setup.
    expect(findings.some(f => f.title.includes('她在担心父亲'))).toBe(false);
    expect(findings.some(f => f.kind === 'dead_setup' && f.title.includes('蓝信封'))).toBe(false);
  });

  test('a ledger with references outside the script is refused', () => {
    expect(() => parseLedger({...ledger, ending: {...ledger.ending, ref: 's2:40'}}, revision)).toThrow('不在剧本里');
    expect(() => parseLedger({...ledger, sightings: [{...ledger.sightings[0]!, visible: 'maybe'}]}, revision)).toThrow('visible');
    expect(() => parseLedger({...ledger, offscreen: [{...ledger.offscreen[0]!, claims: [{fact: 'x', sourceKind: 'guess', sourceRef: null}]}]}, revision)).toThrow('信息来源');
  });

  test('the prompt carries the numbered lines and no story-specific examples', () => {
    const [system, user] = buildLogicMessages(revision);
    expect(system!.content).toContain('sourceKind');
    expect(system!.content).not.toMatch(/911|火柴|冰箱|女儿/u);
    expect(JSON.parse(user!.content).scenes[1].lines[4]).toEqual({n: 5, text: 'A text from Anna: "Don\'t let him light the match."'});
  });

  test('the gate opens only when every finding of the accepted revision is kept with a reason', () => {
    const episode = {acceptedRevisionId: 'r1', needsReview: false};
    const findings = logicFindings(ledger, revision);
    const check: LogicCheck = {id: 'c1', revisionId: 'r1', episodeId: 'e1', mode: 'live', ledger, findings, createdAt: time};
    expect(logicGate({acceptedRevisionId: null, needsReview: false}, [check])).toMatchObject({passed: false, reason: 'not_accepted'});
    expect(logicGate(episode, [])).toMatchObject({passed: false, reason: 'missing'});
    const open = logicGate(episode, [check]);
    expect(open).toMatchObject({passed: false, reason: 'open', message: expect.stringContaining(`还有 ${findings.length} 个问题没处理`)});
    const kept = Object.fromEntries(findings.map(f => [f.id, {reason: '作者保留', at: time}]));
    expect(logicGate(episode, [{...check, kept}]).passed).toBe(true);
    // A check of an older revision does not count for the accepted one.
    expect(logicGate(episode, [{...check, revisionId: 'r0', kept}]).passed).toBe(false);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

test('routes: shot lists wait for the logic check, findings are kept with a reason, and the check reruns per revision', async () => {
  const store = new Store();
  cleanups.push(() => store.close());
  const app = createApp(store, {demo: demoProvider}, process.cwd());
  const call = async (path: string, body?: unknown) => {
    const r = await app(new Request('http://127.0.0.1:4317' + path, {method: body === undefined ? 'GET' : 'POST', ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})}));
    return {status: r.status, body: await r.json() as any};
  };
  const p = (await call('/api/projects', {...brief, characters: 'MAYA, LEO'})).body as ProjectBundle, e = p.episodes[0]!;
  const r = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
  const unaccepted = await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'});
  expect(unaccepted.status).toBe(409);
  expect(unaccepted.body.error).toContain('先把剧本捋顺');
  const episode = store.get('episodes', e.id)!;
  expect((await call(`/api/episodes/${e.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true})).status).toBe(200);
  const blocked = await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'});
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toContain('剧本逻辑检查');
  expect((await call(`/api/episodes/${e.id}/bible-draft`, {mode: 'demo'})).status).toBe(409);
  expect((await call(`/api/episodes/${e.id}/readiness`)).body.items.find((i: {id: string}) => i.id === 'logic')).toMatchObject({status: 'failed', link: {tab: 'review'}});

  // The prepared example checks clean, so shot lists can start.
  const check = (await call(`/api/revisions/${r.id}/logic-check`, {mode: 'demo'})).body as LogicCheck;
  expect(check.findings).toEqual([]);
  expect((await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).status).toBe(200);

  // A check with a finding blocks again until the author keeps it with a reason.
  const finding = logicFindings({...check.ledger, choices: []}, r)[0]!;
  store.insert('logic_checks', {...check, id: 'c2', findings: [finding], createdAt: '2999-01-01T00:00:00.000Z'});
  expect((await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).status).toBe(409);
  expect((await call('/api/logic-checks/c2/keep', {findingId: finding.id, reason: '   '})).status).toBe(400);
  expect((await call('/api/logic-checks/c2/keep', {findingId: 'nope', reason: 'x'})).status).toBe(404);
  const kept = await call('/api/logic-checks/c2/keep', {findingId: finding.id, reason: '第二集再让她做选择'});
  expect(kept.status).toBe(200);
  expect((kept.body as ProjectBundle).logicChecks!.find(c => c.id === 'c2')!.kept![finding.id]!.reason).toBe('第二集再让她做选择');
  expect((await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).status).toBe(200);
  expect((await call('/api/logic-checks/c2/keep', {findingId: finding.id, reason: null})).status).toBe(200);
  expect((await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).status).toBe(409);
});

test('the whole-script revision fixes open findings together, keeps locked scenes and saves a candidate', async () => {
  const store = new Store();
  cleanups.push(() => store.close());
  let answer = '';
  const requests: any[] = [];
  const live = {mode: 'live' as const, async complete(request: any) { requests.push(request); return answer; }};
  const app = createApp(store, {demo: demoProvider, live}, process.cwd());
  const call = async (path: string, body?: unknown) => {
    const r = await app(new Request('http://127.0.0.1:4317' + path, {method: body === undefined ? 'GET' : 'POST', ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})}));
    return {status: r.status, body: await r.json() as any};
  };
  const p = (await call('/api/projects', {...brief, characters: 'MAYA, LEO'})).body as ProjectBundle, e = p.episodes[0]!;
  const r0 = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
  const r = (await call(`/api/revisions/${r0.id}/locks`, {sceneId: 's1', locked: true})).body as Revision;
  expect((await call(`/api/revisions/${r.id}/revise`, {mode: 'live'})).status).toBe(409);
  const finding = {id: 'no_choice', kind: 'no_choice' as const, ref: 's3:5', title: 'MAYA 没有选择', detail: 'd', fix: 'f'};
  store.insert('logic_checks', {id: 'c1', revisionId: r.id, episodeId: e.id, mode: 'live', ledger, findings: [finding], createdAt: time});
  const scenes = r.scenes.map(s => ({id: s.id, heading: s.heading, content: s.id === 's1' ? 'CHANGED' : `${s.content}\nMaya puts the phone away and chooses to stay.`}));
  answer = JSON.stringify({plan: [{findings: ['no_choice', 'made-up'], change: '让玛雅在结尾做选择', scenes: ['s3']}], title: r.title, logline: r.logline, scenes: scenes.map((s, i) => i === 0 ? {...s, id: 'sX'} : s)});
  expect((await call(`/api/revisions/${r.id}/revise`, {mode: 'live'})).body.error).toContain('编号或顺序');
  answer = JSON.stringify({plan: [{findings: ['no_choice'], change: '让玛雅在结尾做选择', scenes: ['s3']}], title: r.title, logline: r.logline, scenes});
  const saved = await call(`/api/revisions/${r.id}/revise`, {mode: 'live', note: '保留结尾的问题'});
  expect(saved.status).toBe(200);
  const next = saved.body as Revision;
  expect(next.parentId).toBe(r.id);
  expect(next.instruction).toContain('让玛雅在结尾做选择（s3）');
  expect(next.scenes[0]).toEqual(r.scenes[0]!);
  expect(next.scenes[2]!.content).toContain('chooses to stay');
  // A candidate only: the accepted script does not change.
  expect(store.get('episodes', e.id)!.acceptedRevisionId).toBeNull();
  const request = requests.at(-1);
  expect(request.findings.map((f: {id: string}) => f.id)).toEqual(['no_choice']);
  expect(request.instruction).toBe('保留结尾的问题');
});
