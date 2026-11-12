import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { Localization, ProjectBundle, Revision, ShotList } from '../src/types';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const brief = {title: 'Last Order', premise: 'Midnight deliveries pull a rider into strangers\' secrets.', characters: 'MAYA: a rider.\nLEO: seventy.', worldRules: 'An ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en', format: 'vertical_short_drama'};
const profile = {style: 'Live-action, cinematic', music: 'N/A', characters: [
  {name: 'MAYA', appearance: 'a woman in her twenties in a wet yellow delivery jacket', voice: 'a dry, low female voice', image: 'maya.png'},
  {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'},
]};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function harness(options: {transport?: typeof fetch} = {}) {
  const store = new Store(); stores.push(store);
  let clock = new Date('2026-11-10T08:00:00.000Z');
  const app = createApp(store, {demo: demoProvider}, process.cwd(), {production: {clock: () => clock, ...(options.transport ? {transport: options.transport} : {})}});
  const raw = (path: string, body?: unknown, init: {method?: string; headers?: Record<string, string>} = {}) => app(new Request('http://127.0.0.1:4317' + path, {method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers: {...(body !== undefined ? {'content-type': 'application/json'} : {}), ...init.headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})}));
  const call = async (path: string, body?: unknown, init?: {method?: string; headers?: Record<string, string>}) => { const r = await raw(path, body, init); return {status: r.status, body: r.status === 204 ? null : await r.json()}; };
  const worker = (token: string, path: string, body?: unknown) => call(`/api/worker/v1/${path}`, body, {method: body === undefined && path === 'hello' ? 'GET' : 'POST', headers: {authorization: `Bearer ${token}`}});
  async function setup() {
    const p = (await call('/api/projects', brief)).body as ProjectBundle, e = p.episodes[0]!;
    const r = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
    const l = (await call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'})).body as Localization;
    const list = (await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).body as ShotList;
    return {p, e, r, l, list};
  }
  async function adopt(r: Revision, list: ShotList) {
    const episode = store.get('episodes', r.episodeId)!;
    expect((await call(`/api/episodes/${r.episodeId}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: episode.acceptedRevisionId, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true})).status).toBe(200);
    expect((await call(`/api/episodes/${r.episodeId}/production-shot-list`, {shotListId: list.id, expectedShotListId: store.get('episodes', r.episodeId)!.productionShotListId ?? null})).status).toBe(200);
  }
  async function ready() {
    const s = await setup();
    expect((await call(`/api/projects/${s.p.project.id}/production`, profile, {method: 'PUT'})).status).toBe(200);
    await adopt(s.r, s.list);
    const created = await call(`/api/shot-lists/${s.list.id}/render-batches`, {version: 1});
    expect(created.status).toBe(200);
    const bundle = created.body as ProjectBundle;
    return {...s, bundle, batch: bundle.renderBatches!.at(-1)!, jobs: bundle.renderJobs!};
  }
  const token = async (label = 'Colab A100') => (await call('/api/worker-tokens', {label})).body as {token: string; worker: {id: string}};
  return {store, app, raw, call, worker, setup, adopt, ready, token, tick(minutes: number) { clock = new Date(clock.getTime() + minutes * 60_000); }};
}

describe('production profile and batches', () => {
  test('the profile is saved outside the brief and never marks episodes for recheck', async () => {
    const h = harness(), {p, e} = await h.setup();
    const before = h.store.contextToken(h.store.get('episodes', e.id)!);
    const saved = await h.call(`/api/projects/${p.project.id}/production`, profile, {method: 'PUT'});
    expect(saved.status).toBe(200);
    expect((saved.body as ProjectBundle).project.production).toEqual(profile);
    expect(h.store.contextToken(h.store.get('episodes', e.id)!)).toBe(before);
    expect(h.store.get('episodes', e.id)!.needsReview).toBe(false);
    const bad = await h.call(`/api/projects/${p.project.id}/production`, {...profile, characters: [{name: 'MAYA', image: 'C:\\maya.png'}]}, {method: 'PUT'});
    expect(bad.status).toBe(400);
  });

  test('only the current production shot list can be rendered', async () => {
    const h = harness(), {r, list} = await h.setup();
    expect((await h.call(`/api/shot-lists/${list.id}/render-batches`, {})).status).toBe(409);
    await h.adopt(r, list);
    const created = await h.call(`/api/shot-lists/${list.id}/render-batches`, {version: 1, clipLimitSeconds: 15});
    expect(created.status).toBe(200);
    const bundle = created.body as ProjectBundle;
    expect(bundle.renderBatches!.length).toBe(1);
    expect(bundle.renderJobs!.length).toBe(12);
    expect(bundle.renderJobs!.every(j => j.status === 'queued' && j.attempts === 0)).toBe(true);
    expect((await h.call(`/api/shot-lists/${list.id}/render-batches`, {clipLimitSeconds: 3})).status).toBe(400);
    expect((await h.call(`/api/shot-lists/${list.id}/render-batches`, {languages: ['ja']})).status).toBe(400);
  });

  test('a package carries every job and results apply once', async () => {
    const h = harness(), {batch, jobs} = await h.ready();
    const response = await h.raw(`/api/render-batches/${batch.id}/package`);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="sciepo-render-${batch.id}.json"`);
    const text = await response.text(), pkg = JSON.parse(text);
    expect(pkg.format).toBe('sciepo-render-package');
    expect(pkg.jobs.length).toBe(12);
    expect(pkg.references).toEqual({images: ['maya.png'], audio: []});
    expect(text).not.toMatch(/sciepo_wk_|premise/u);
    const [first, second] = [jobs.find(j => j.order === 0)!, jobs.find(j => j.order === 1)!];
    const results = {format: 'sciepo-render-results', version: 1, batchId: batch.id, results: [
      {jobId: first.id, status: 'succeeded', file: 'ep01-c01-en.mp4', seconds: 12.25, bytes: 2048, sha256: 'b'.repeat(64)},
      {jobId: second.id, status: 'failed', error: 'CUDA out of memory'},
      {jobId: 'unknown', status: 'succeeded', file: 'x.mp4'},
    ]};
    const applied = await h.call(`/api/render-batches/${batch.id}/results`, results);
    expect(applied.body).toMatchObject({applied: 2, unchanged: 0, ignored: 1});
    expect((await h.call(`/api/render-batches/${batch.id}/results`, results)).body).toMatchObject({applied: 0, unchanged: 2, ignored: 1});
    const downgrade = {...results, results: [{jobId: first.id, status: 'failed', error: 'late failure'}]};
    expect((await h.call(`/api/render-batches/${batch.id}/results`, downgrade)).body).toMatchObject({applied: 0, ignored: 1});
    expect(h.store.get('render_jobs', first.id)).toMatchObject({status: 'succeeded', output: {file: 'ep01-c01-en.mp4', seconds: 12.25, bytes: 2048}});
    expect((await h.call(`/api/render-batches/${batch.id}/results`, {...results, batchId: 'other'})).status).toBe(400);
    expect((await h.call(`/api/render-jobs/${first.id}/requeue`, {})).status).toBe(409);
    const requeued = await h.call(`/api/render-jobs/${second.id}/requeue`, {});
    expect(requeued.status).toBe(200);
    expect(h.store.get('render_jobs', second.id)).toMatchObject({status: 'queued'});
    expect(h.store.get('render_jobs', second.id)!.error).toBeUndefined();
  });
});

describe('worker tokens and the worker API', () => {
  test('tokens are shown once, stored as hashes, listed without secrets and revocable', async () => {
    const h = harness(), {token, worker} = await h.token();
    expect(token).toMatch(/^sciepo_wk_[A-Za-z0-9_-]{43}$/u);
    const rows = h.store.all('worker_tokens');
    expect(rows[0]!.hash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const listed = (await h.call('/api/worker-tokens')).body as Record<string, unknown>[];
    expect(listed[0]).toMatchObject({id: worker.id, label: 'Colab A100'});
    expect(JSON.stringify(listed)).not.toMatch(/hash|sciepo_wk_/u);
    expect((await h.call('/api/worker-tokens', {label: ''})).status).toBe(400);
    expect((await h.worker(token, 'hello')).body).toEqual({service: 'sci-epo', worker: 'Colab A100'});
    await h.call(`/api/worker-tokens/${worker.id}/revoke`, {});
    expect((await h.worker(token, 'hello')).status).toBe(401);
  });

  test('claims follow job order, leases expire, and only the claiming worker may report', async () => {
    const h = harness(), {jobs} = await h.ready(), a = (await h.token('A')).token, b = (await h.token('B')).token;
    expect((await h.call('/api/worker/v1/claim', {})).status).toBe(401);
    expect((await h.worker('sciepo_wk_' + 'x'.repeat(43), 'claim', {})).status).toBe(401);
    const first = await h.worker(a, 'claim', {});
    expect(first.status).toBe(200);
    expect(first.body.job).toMatchObject({clipId: 'c01', language: 'en', mode: 'r2v', images: ['maya.png'], output: 'ep01-c01-en.mp4', frames: 294, leaseExpiresAt: '2026-11-10T09:00:00.000Z'});
    expect(first.body.job.prompt).toContain('<d>[English] Singing costs extra.</d>');
    const second = await h.worker(b, 'claim', {});
    expect(second.body.job).toMatchObject({clipId: 'c01', language: 'zh-CN'});
    expect((await h.worker(b, `jobs/${first.body.job.id}/heartbeat`, {})).status).toBe(409);
    expect((await h.worker(b, `jobs/${first.body.job.id}/result`, {status: 'succeeded', file: 'ep01-c01-en.mp4'})).status).toBe(409);
    h.tick(30);
    expect((await h.worker(a, `jobs/${first.body.job.id}/heartbeat`, {})).body).toEqual({leaseExpiresAt: '2026-11-10T09:30:00.000Z'});
    expect((await h.worker(a, `jobs/${first.body.job.id}/result`, {status: 'succeeded', file: '../escape.mp4'})).status).toBe(400);
    expect((await h.worker(a, `jobs/${first.body.job.id}/result`, {status: 'succeeded', file: 'ep01-c01-en.mp4', seconds: 12.25, sha256: 'c'.repeat(64)})).body).toEqual({ok: true});
    expect(h.store.get('render_jobs', first.body.job.id)).toMatchObject({status: 'succeeded', attempts: 1, workerLabel: 'A', output: {file: 'ep01-c01-en.mp4'}});
    expect(h.store.get('render_jobs', first.body.job.id)!.leaseExpiresAt).toBeUndefined();
    // B's lease (from 08:00) expires at 09:00; another worker may then take the job again.
    h.tick(31);
    const retaken = await h.worker(a, 'claim', {});
    expect(retaken.body.job).toMatchObject({id: second.body.job.id, clipId: 'c01', language: 'zh-CN'});
    expect(h.store.get('render_jobs', second.body.job.id)).toMatchObject({attempts: 2, workerLabel: 'A'});
    expect((await h.worker(b, `jobs/${second.body.job.id}/result`, {status: 'failed', error: 'late'})).status).toBe(409);
    expect(jobs.length).toBe(12);
  });

  test('batches stop being served when the production shot list changes', async () => {
    const h = harness(), {r, list} = await h.ready(), a = (await h.token()).token;
    const claimed = await h.worker(a, 'claim', {});
    const edited = (await h.call(`/api/shot-lists/${list.id}/edit`, {cast: list.cast, shots: list.shots.map((s, i) => i === 0 ? {...s, durationSeconds: 6} : s), adaptations: list.adaptations})).body as ShotList;
    expect((await h.call(`/api/episodes/${r.episodeId}/production-shot-list`, {shotListId: edited.id, expectedShotListId: list.id})).status).toBe(200);
    expect((await h.worker(a, 'claim', {})).status).toBe(204);
    expect((await h.worker(a, `jobs/${claimed.body.job.id}/heartbeat`, {})).status).toBe(410);
    expect(r.id).toBeTruthy();
  });

  test('on a deployment with login, workers need no cookie or CSRF, and tokens open nothing else', async () => {
    const h = harness(), {token} = await h.token(), origin = 'https://studio.example.com';
    const hosted = createApp(h.store, {demo: demoProvider}, process.cwd(), {publicOrigin: origin});
    const call = (path: string, init: RequestInit = {}) => hosted(new Request(origin + path, init));
    expect((await call('/api/worker/v1/claim', {method: 'POST', headers: {authorization: `Bearer ${token}`}})).status).toBe(204);
    expect((await call('/api/worker/v1/hello', {headers: {authorization: `Bearer ${token}`}})).status).toBe(200);
    expect((await call('/api/worker/v1/claim', {method: 'POST', headers: {authorization: `Bearer ${token}`, origin: 'https://evil.example'}})).status).toBe(403);
    expect((await call('/api/worker/v1/claim', {method: 'POST', headers: {cookie: '__Host-sciepo-session=anything'}})).status).toBe(401);
    expect((await call('/api/projects', {headers: {authorization: `Bearer ${token}`}})).status).toBe(401);
    expect((await call('/api/worker-tokens', {headers: {authorization: `Bearer ${token}`}})).status).toBe(401);
  });
});

describe('push to a worker URL', () => {
  test('sends the package, syncs results, and never leaks the key', async () => {
    const seen: {url: string; init: RequestInit}[] = [];
    let batchId = '', jobId = '';
    const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({url: String(url), init: init ?? {}});
      if (String(url) === 'https://worker.trycloudflare.com/v1/batches') return Response.json({batchId, jobs: 12});
      if (String(url) === `https://worker.trycloudflare.com/v1/batches/${batchId}/results`) return Response.json({format: 'sciepo-render-results', version: 1, batchId, results: [{jobId, status: 'succeeded', file: 'ep01-c01-en.mp4', seconds: 12.25}]});
      return new Response('secret-worker-key leaked body', {status: 500});
    }) as typeof fetch;
    const h = harness({transport}), {batch, jobs} = await h.ready();
    batchId = batch.id; jobId = jobs.find(j => j.order === 0)!.id;
    const key = 'secret-worker-key';
    expect((await h.call(`/api/render-batches/${batch.id}/push`, {url: 'https://worker.trycloudflare.com/', key})).body).toEqual({sent: true, accepted: 12});
    expect(seen[0]!.url).toBe('https://worker.trycloudflare.com/v1/batches');
    expect(seen[0]!.init.redirect).toBe('error');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(String(seen[0]!.init.body)).jobs.length).toBe(12);
    const synced = await h.call(`/api/render-batches/${batch.id}/sync`, {url: 'https://worker.trycloudflare.com', key});
    expect(synced.body).toMatchObject({applied: 1});
    expect(h.store.get('render_jobs', jobId)).toMatchObject({status: 'succeeded', workerLabel: '推送的工作机'});
    const failed = await h.call(`/api/render-batches/${batch.id}/sync`, {url: 'https://worker.trycloudflare.com/other', key});
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain(key);
    expect((await h.call(`/api/render-batches/${batch.id}/push`, {url: 'http://worker.example.com', key})).status).toBe(400);
    expect((await h.call(`/api/render-batches/${batch.id}/push`, {url: 'https://user:pw@worker.example.com', key})).status).toBe(400);
    expect((await h.call(`/api/render-batches/${batch.id}/push`, {url: 'http://127.0.0.1:8765', key: 'short'})).status).toBe(400);
  });
});
