import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { shotListStatus } from '../src/core/shotList';
import { createApp } from '../src/server/app';
import { ModelError } from '../src/server/provider';
import { ProviderManager } from '../src/server/providerManager';
import { Store } from '../src/server/store';
import type { Localization, ModelRequest, ProjectBundle, Revision, ShotList, ShotListContent } from '../src/types';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const brief = {title: 'Last Order', premise: 'A rider delivers at midnight.', characters: 'MAYA, LEO', worldRules: 'Ordinary city.', authorRules: 'End on a reveal.', language: 'en', format: 'vertical_short_drama', durationTarget: {min: 10, max: 20}};
const script = {title: 'The Last Order', logline: 'A rider sings.', scenes: [
  {id: 's1', heading: 'INT. ELEVATOR - NIGHT', content: 'Maya holds one cupcake.\nMAYA: Singing costs extra.\nThe doors open.'},
  {id: 's2', heading: 'INT. HALLWAY - CONTINUOUS', content: 'LEO opens the door a crack.\nLEO: I didn\'t order anything.\nMAYA: Then who did?'},
]};
const chinese = {title: '最后一单', logline: '外卖员唱歌。', scenes: [
  {id: 's1', heading: '内景 · 电梯 · 夜', content: '玛雅捧着一个纸杯蛋糕。\n玛雅：唱歌得加钱。\n电梯门打开。'},
  {id: 's2', heading: '内景 · 走廊 · 连续', content: '老林把门开了一条缝。\n老林：我没点外卖。\n玛雅：那是谁点的？'},
]};
const shots = (): ShotListContent => ({cast: [{id: 'C1', name: 'MAYA'}, {id: 'C2', name: 'LEO'}], shots: [
  {id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'push_in', characters: ['C1'], spoken: [{line: 2, castId: 'C1'}], durationSeconds: 4},
  {id: 'sh2', sceneId: 's1', firstLine: 3, lastLine: 3, size: 'medium', camera: 'static', characters: ['C1'], spoken: [], durationSeconds: 2},
  {id: 'sh3', sceneId: 's2', firstLine: 1, lastLine: 2, size: 'medium_close_up', camera: 'static', characters: ['C2'], spoken: [{line: 2, castId: 'C2'}], durationSeconds: 4},
  {id: 'sh4', sceneId: 's2', firstLine: 3, lastLine: 3, size: 'close_up', camera: 'static', characters: ['C1'], spoken: [{line: 3, castId: 'C1'}], durationSeconds: 3},
]});

function harness() {
  const store = new Store(); stores.push(store);
  const requests: ModelRequest[] = [], demoCalls: ModelRequest[] = [];
  let storyboard: (request: ModelRequest) => Promise<string> = async () => JSON.stringify(shots());
  const live = {mode: 'live' as const, async complete(request: ModelRequest) {
    requests.push(request);
    if (request.kind === 'generate') return JSON.stringify(script);
    if (request.kind === 'localize') return JSON.stringify(chinese);
    if (request.kind === 'storyboard') return storyboard(request);
    throw new Error('unexpected request');
  }};
  const demo = {mode: 'demo' as const, async complete(request: ModelRequest) { demoCalls.push(request); return '{}'; }};
  const app = createApp(store, {live, demo});
  const raw = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    app(new Request('http://127.0.0.1:4317' + path, {method, headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
  const call = async (path: string, body?: unknown, method?: string) => { const response = await raw(path, body, method); return {status: response.status, body: await response.json()}; };
  async function setup() {
    const p = (await call('/api/projects', brief)).body as ProjectBundle, episode = p.episodes[0]!;
    const r = (await call(`/api/episodes/${episode.id}/generate`, {mode: 'live'})).body as Revision;
    const l = (await call(`/api/revisions/${r.id}/localize`, {mode: 'live', language: 'zh-CN'})).body as Localization;
    return {p, episode, r, l};
  }
  const accept = async (r: Revision, expected: string | null = null) =>
    call(`/api/episodes/${r.episodeId}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: expected, expectedContextToken: store.contextToken(store.get('episodes', r.episodeId)!), acknowledgeReview: true, acknowledgeLengthException: true});
  return {store, requests, demoCalls, raw, call, setup, accept, setStoryboard(fn: typeof storyboard) { storyboard = fn; }};
}

describe('shot-list generation', () => {
  test('binds the shot list to the revision, its frozen frame and the newest aligned adaptation', async () => {
    const h = harness(), {r, l} = await h.setup();
    const result = await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'});
    expect(result.status).toBe(200);
    const list = result.body as ShotList;
    expect(list).toMatchObject({sourceRevisionId: r.id, episodeId: r.episodeId, parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': l.id}, mode: 'live', ...shots()});
    expect(h.requests.at(-1)!.kind).toBe('storyboard');
    expect(h.store.all('runs').at(-1)).toMatchObject({kind: 'storyboard', status: 'succeeded', resultId: list.id});
    expect(h.store.get('revisions', r.id)).toEqual(r);
    const bundle = (await h.call(`/api/projects/${(await h.call('/api/projects')).body[0].id}`)).body as ProjectBundle;
    expect(bundle.shotLists!.map(s => s.id)).toEqual([list.id]);
  });

  test('invalid output and model errors fail the run without saving or substituting the demo', async () => {
    const h = harness(), {r} = await h.setup();
    h.setStoryboard(async () => JSON.stringify({...shots(), shots: shots().shots.slice(0, 3)}));
    const invalid = await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'});
    expect(invalid.status).toBe(502);
    expect(invalid.body.error).toContain('场景 s2 第 3–3 行没有镜头覆盖');
    h.setStoryboard(async () => { throw new ModelError('upstream_http', '模型服务返回 HTTP 500，本次操作未完成。'); });
    expect((await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'})).status).toBe(502);
    expect(h.store.all('shot_lists')).toHaveLength(0);
    expect(h.store.all('runs').filter(run => run.kind === 'storyboard').map(run => run.status)).toEqual(['failed', 'failed']);
    expect(h.demoCalls).toHaveLength(0);
  });
});

describe('shot-list versions, adoption and export', () => {
  test('edits save new immutable versions that keep shot IDs; invalid edits change nothing', async () => {
    const h = harness(), {r, l} = await h.setup();
    const first = (await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'})).body as ShotList;
    const edited = shots(); edited.shots[1]!.durationSeconds = 3.5;
    const second = await h.call(`/api/shot-lists/${first.id}/edit`, {...edited, adaptations: {'zh-CN': l.id}});
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({parentId: first.id, mode: 'manual', sourceRevisionId: r.id, adaptations: {'zh-CN': l.id}});
    expect((second.body as ShotList).shots.map(s => s.id)).toEqual(first.shots.map(s => s.id));
    expect(h.store.get('shot_lists', first.id)).toEqual(first);
    const gap = shots(); gap.shots.splice(3, 1);
    expect((await h.call(`/api/shot-lists/${first.id}/edit`, {...gap, adaptations: {}})).status).toBe(400);
    expect((await h.call(`/api/shot-lists/${first.id}/edit`, {...shots(), adaptations: {ja: l.id}})).status).toBe(400);
    expect(h.store.all('shot_lists')).toHaveLength(2);
  });

  test('adoption requires the accepted revision and rejects stale tabs; a newer accepted script makes it not current', async () => {
    const h = harness(), {p, episode, r} = await h.setup();
    const first = (await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'})).body as ShotList;
    const second = (await h.call(`/api/shot-lists/${first.id}/edit`, {...shots(), adaptations: {}})).body as ShotList;
    const adopt = (shotListId: string, expectedShotListId: string | null) => h.call(`/api/episodes/${episode.id}/production-shot-list`, {shotListId, expectedShotListId});
    expect((await adopt(first.id, null)).status).toBe(409);
    expect((await h.accept(r)).status).toBe(200);
    const adopted = await adopt(first.id, null);
    expect(adopted.status).toBe(200);
    expect((adopted.body as ProjectBundle).episodes[0]!.productionShotListId).toBe(first.id);
    expect((await adopt(second.id, null)).status).toBe(409);
    expect((await adopt(second.id, first.id)).status).toBe(200);
    const other = (await h.call(`/api/projects/${p.project.id}/episodes`, {title: 'Episode 2'})).body as ProjectBundle;
    expect((await h.call(`/api/episodes/${other.episodes[1]!.id}/production-shot-list`, {shotListId: second.id, expectedShotListId: null})).status).toBe(400);
    const newer = (await h.call(`/api/episodes/${episode.id}/generate`, {mode: 'live'})).body as Revision;
    expect((await h.accept(newer, r.id)).status).toBe(200);
    const current = h.store.get('episodes', episode.id)!;
    expect(current.productionShotListId).toBe(second.id);
    expect(shotListStatus(h.store.get('shot_lists', second.id)!, current)).toEqual({adopted: true, current: false, adoptable: false});
  });

  test('export is a CSV attachment with a byte order mark and both languages', async () => {
    const h = harness(), {r} = await h.setup();
    const list = (await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'live'})).body as ShotList;
    const response = await h.raw(`/api/shot-lists/${list.id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain(`sci-epo-shots-${list.id}.csv`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"not_adopted"');
    expect(text).toContain('玛雅：唱歌得加钱。');
    expect((await h.raw('/api/shot-lists/missing/export')).status).toBe(404);
  });
});

test('managed providers route shot lists to the writing role', () => {
  const store = new Store(); stores.push(store);
  const manager = new ProviderManager(store.db, randomBytes(32), (async () => Response.json({})) as unknown as typeof fetch);
  manager.importEnvironment({SCIEPO_MODEL_PROVIDER: 'openai', SCIEPO_MODEL_ID: 'writer', SCIEPO_MODEL_BASE_URL: 'https://provider.example.test/v1', SCIEPO_MODEL_API_KEY: 'test-only-key'});
  expect(manager.resolve('storyboard').snapshot.role).toBe('writing');
  expect(manager.resolve('generate').snapshot.role).toBe('writing');
  expect(manager.resolve('rewrite').snapshot.role).toBe('revision');
});
