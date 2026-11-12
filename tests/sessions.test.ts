import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { Localization, MediaAsset, ProjectBundle, PublicRenderSession, RenderJobV2, Revision, ShotList } from '../src/types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const brief = {title: 'Last Order', premise: 'Midnight deliveries pull a rider into strangers\' secrets.', characters: 'MAYA: a rider.\nLEO: seventy.', worldRules: 'An ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en', format: 'vertical_short_drama'};
const profile = {style: 'Live-action, cinematic', music: 'A low synth drone.', characters: [
  {name: 'MAYA', appearance: 'a woman in her twenties in a wet yellow delivery jacket', voice: 'a dry, low female voice'},
  {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'},
]};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const mp4 = (fill: number) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...Array.from({length: 64}, () => fill)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function harness() {
  const store = new Store(), dir = mkdtempSync(join(tmpdir(), 'sciepo-sessions-'));
  cleanups.push(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  let clock = new Date('2026-11-12T08:00:00.000Z');
  const app = createApp(store, {demo: demoProvider}, process.cwd(), {production: {clock: () => clock}, media: {dir, quotaMb: 1}});
  const request = (path: string, init: RequestInit = {}) => app(new Request('http://127.0.0.1:4317' + path, init));
  const call = async (path: string, body?: unknown, method?: string) => {
    const r = await request(path, {method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
    return {status: r.status, body: await r.json() as any};
  };
  const upload = async (projectId: string, kind: string, bytes: Uint8Array<ArrayBuffer>) => {
    const r = await request(`/api/projects/${projectId}/media?kind=${kind}&label=test`, {method: 'PUT', body: bytes});
    return {status: r.status, body: await r.json() as any};
  };
  const worker = async (code: string, path: string, body?: unknown, init: {method?: string; raw?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>} = {}) => {
    const token = code.split('#')[1]!;
    const r = await request(`/api/worker/v1/${path}`, {method: init.method ?? (body === undefined && !init.raw ? 'GET' : 'POST'), headers: {authorization: `Bearer ${token}`, ...(body !== undefined ? {'content-type': 'application/json'} : {}), ...init.headers},
      ...(init.raw ? {body: init.raw} : body !== undefined ? {body: JSON.stringify(body)} : {})});
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* the worker program is text */ }
    return {status: r.status, body: parsed};
  };
  async function ready(batchBody: Record<string, unknown> = {}) {
    const p = (await call('/api/projects', brief)).body as ProjectBundle, e = p.episodes[0]!;
    const r = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
    (await call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'})).body as Localization;
    const list = (await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).body as ShotList;
    expect((await call(`/api/projects/${p.project.id}/production`, profile, 'PUT')).status).toBe(200);
    const portrait = await upload(p.project.id, 'reference_image', PNG);
    expect(portrait.status).toBe(200);
    expect((await call(`/api/projects/${p.project.id}/cast`, {name: 'MAYA', portraitAssetId: portrait.body.asset.id})).status).toBe(200);
    const episode = store.get('episodes', e.id)!;
    expect((await call(`/api/episodes/${e.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true})).status).toBe(200);
    expect((await call(`/api/episodes/${e.id}/production-shot-list`, {shotListId: list.id, expectedShotListId: null})).status).toBe(200);
    const created = await call(`/api/shot-lists/${list.id}/render-batches`, batchBody);
    expect(created.status).toBe(200);
    const bundle = created.body as ProjectBundle, batch = bundle.renderBatches!.at(-1)!;
    return {p, e, r, list, bundle, batch, jobs: bundle.renderJobsV2!.filter(j => j.batchId === batch.id), portrait: portrait.body.asset as MediaAsset};
  }
  async function session(projectId: string, batchId: string, extra: Record<string, unknown> = {}) {
    const created = await call(`/api/projects/${projectId}/render-sessions`, {batchIds: [batchId], ...extra});
    expect(created.status).toBe(200);
    return created.body as {session: PublicRenderSession; code: string};
  }
  return {store, app, call, upload, worker, ready, session, dir, tick(minutes: number) { clock = new Date(clock.getTime() + minutes * 60_000); }};
}

describe('v2 render batches', () => {
  test('jobs with the same key are one job, takes get seeds per take, and the bed mode asks for no music', async () => {
    const h = harness(), {batch, jobs} = await h.ready();
    expect(batch.version).toBe(2);
    expect(batch.preset).toMatchObject({width: 480, height: 864, steps: 20, turbo: false, stack: {id: 'h3-lite'}});
    expect(batch.musicMode).toBe('bed');
    expect(batch.references).toEqual([expect.objectContaining({kind: 'image', character: 'MAYA', name: expect.stringMatching(/^maya-[0-9a-f]{8}\.png$/u)})]);
    for (const clip of batch.clips) {
      for (const prompt of Object.values(clip.prompts)) expect(prompt.text).toMatch(/non_diegetic_music:\s*N\/A/u);
      const sameText = new Set(Object.values(clip.prompts).map(p => p.text)).size === 1;
      const clipJobs = jobs.filter(j => j.clipId === clip.id);
      expect(clipJobs.length).toBe(sameText ? 1 : 2);
      if (sameText) expect(clipJobs[0]!).toMatchObject({languages: ['en', 'zh-CN'], outputName: `ep01-${clip.id}.mp4`});
      else expect(clipJobs.map(j => j.outputName)).toEqual([`ep01-${clip.id}-en.mp4`, `ep01-${clip.id}-zh-CN.mp4`]);
      for (const job of clipJobs) expect(job.takes).toEqual([{n: 1, seed: clip.seed, status: 'queued'}]);
      expect(clip.pictureKey).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(new Set(jobs.map(j => j.key)).size).toBe(jobs.length);
  });

  test('only R2V sizes of the aspect ratio are accepted, and v1 routes refuse v2 batches', async () => {
    const h = harness(), {list, batch} = await h.ready({size: '768x1344', musicMode: 'native'});
    expect(batch.preset).toMatchObject({width: 768, height: 1344});
    expect(batch.clips.every(c => Object.values(c.prompts).every(p => p.text.includes('A low synth drone.')))).toBe(true);
    expect((await h.call(`/api/shot-lists/${list.id}/render-batches`, {size: '1344x768'})).status).toBe(400);
    expect((await h.call(`/api/render-batches/${batch.id}/package`)).status).toBe(409);
    expect((await h.call(`/api/render-batches/${batch.id}/push`, {url: 'https://w.example.com', key: 'k'.repeat(10)})).status).toBe(409);
  });
});

describe('media store', () => {
  test('uploads are checked by signature, size and quota, and served with ranges to the owner', async () => {
    const h = harness(), {p, portrait} = await h.ready();
    expect(portrait).toMatchObject({kind: 'reference_image', contentType: 'image/png', bytes: PNG.length, origin: 'owner'});
    expect((await h.upload(p.project.id, 'reference_image', JPEG.slice(0, 2))).status).toBe(415);
    expect((await h.upload(p.project.id, 'take_video', mp4(1))).status).toBe(400);
    expect((await h.upload(p.project.id, 'voice_sample', new Uint8Array(11 * 1024 * 1024))).status).toBe(413);
    const again = await h.upload(p.project.id, 'reference_image', PNG);
    expect(again.body.asset.id).toBe(portrait.id);
    const full = await h.app(new Request(`http://127.0.0.1:4317/api/media/${portrait.id}`));
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(PNG);
    const part = await h.app(new Request(`http://127.0.0.1:4317/api/media/${portrait.id}`, {headers: {range: 'bytes=0-3'}}));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-3/${PNG.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG.slice(0, 4));
    expect((await h.call(`/api/media/${portrait.id}/delete`, {})).status).toBe(409);
    const quota = await h.upload(p.project.id, 'music', new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...new Uint8Array(1024 * 1024)]));
    expect(quota.status).toBe(507);
  });
});

describe('render sessions', () => {
  test('a session code works only for its batches, and the worker gets the document, its program and the references', async () => {
    const h = harness(), {p, batch, portrait} = await h.ready(), {session, code} = await h.session(p.project.id, batch.id);
    expect(code).toMatch(/^http:\/\/127\.0\.0\.1:4317#sciepo_ss_[A-Za-z0-9_-]{43}$/u);
    expect(session.status).toBe('waiting');
    expect(JSON.stringify(h.store.get('render_sessions', session.id))).not.toContain(code.split('#')[1]!);
    expect(session.settings.budgetMinutes).toBeGreaterThanOrEqual(15);
    const doc = await h.worker(code, 'session');
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({format: 'sciepo-session', session: {id: session.id, heartbeatSeconds: 30}, references: [{sha256: portrait.sha256, kind: 'image'}]});
    expect(doc.body.modes).toContain('r2v');
    expect(doc.body.stacks[0]).toMatchObject({id: 'h3-lite', comfyui: {commit: expect.stringMatching(/^[0-9a-f]{40}$/u)}, workflowGraphs: {r2v: expect.any(Object)}});
    expect(h.store.get('render_sessions', session.id)!.status).toBe('connected');
    const program = await h.worker(code, 'session/worker.py');
    expect(program.status).toBe(200);
    expect(String(program.body)).toContain('def main(');
    const reference = await h.worker(code, `references/${portrait.sha256}`);
    expect(reference.status).toBe(200);
    expect((await h.worker(code, `references/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await h.worker('x#sciepo_ss_' + 'a'.repeat(43), 'session')).status).toBe(401);
    expect((await h.call('/api/worker/v1/session')).status).toBe(401);
  });

  test('takes are claimed in order, uploads land in the media store, and the end revokes the code', async () => {
    const h = harness(), {p, batch, jobs} = await h.ready(), {session, code} = await h.session(p.project.id, batch.id);
    await h.worker(code, 'session/events', {stage: 'gpu', data: {gpu: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', vramGb: 96}});
    const claim = await h.worker(code, 'session/claim', {});
    expect(claim.status).toBe(200);
    const take = claim.body.take, first = jobs[0]!;
    expect(take).toMatchObject({jobId: first.id, n: 1, seed: first.takes[0]!.seed, mode: 'r2v', width: 480, height: 864, steps: 20, output: first.outputName});
    expect(take.shots[0]).toMatchObject({start: 0});
    expect(Array.isArray(take.expectedLines)).toBe(true);
    const second = await h.worker(code, 'session/claim', {});
    expect(second.body.take.jobId).toBe(jobs[1]!.id);
    const beat = await h.worker(code, `takes/${first.id}/1/heartbeat`, {});
    expect(beat.body).toMatchObject({stop: null, current: true});
    const video = await h.worker(code, `takes/${first.id}/1/files/video`, undefined, {method: 'PUT', raw: mp4(7)});
    expect(video.status).toBe(200);
    const sheet = await h.worker(code, `takes/${first.id}/1/files/contact-sheet`, undefined, {method: 'PUT', raw: JPEG});
    const wrong = await h.worker(code, `takes/${first.id}/1/files/video`, undefined, {method: 'PUT', raw: JPEG});
    expect(wrong.status).toBe(415);
    const qa = {checks: [{id: 'duration', status: 'pass', message: 'sciepo_ss_' + 'z'.repeat(43) + ' ok'}], loudness: {integrated: -16.2, truePeak: -1.5}, speech: {lines: [{sceneId: 's1', position: 2, language: 'en', expected: 'Hi.', heard: 'Hi', score: 0.9}]}};
    const result = await h.worker(code, `takes/${first.id}/1/result`, {status: 'rendered', files: {video: video.body.assetId, contactSheet: sheet.body.assetId}, qa, seconds: 12.25, timing: {renderSeconds: 180}});
    expect(result.status).toBe(200);
    const done = h.store.get('render_jobs_v2', first.id)!.takes[0]!;
    expect(done).toMatchObject({status: 'rendered', video: {assetId: video.body.assetId, seconds: 12.25}, qa: {contactSheet: sheet.body.assetId, loudness: {integrated: -16.2}}});
    expect(done.qa!.checks[0]!.message).toBe('[token] ok');
    expect(h.store.all('render_rates')).toHaveLength(1);
    expect(h.store.all('render_rates')[0]!.id).toContain('RTX PRO 6000 Blackwell');
    const ended = await h.worker(code, 'session/end', {reason: 'stopped', summary: {message: 'test'}});
    expect(ended.status).toBe(200);
    const after = h.store.get('render_sessions', session.id)!;
    expect(after).toMatchObject({status: 'ended', end: 'stopped', tokenHash: null, summary: {takesRendered: 1, undelivered: 1}});
    expect(h.store.get('render_jobs_v2', jobs[1]!.id)!.takes[0]!.status).toBe('queued');
    expect((await h.worker(code, 'session')).status).toBe(401);
  });

  test('stop, budget, lost sessions and a changed production version end the queue', async () => {
    const h = harness(), {p, batch, r, list} = await h.ready(), {session, code} = await h.session(p.project.id, batch.id, {budgetMinutes: 5});
    await h.worker(code, 'session/events', {stage: 'ready'});
    h.tick(3);
    expect((await h.worker(code, 'session/claim', {})).body).toEqual({end: 'budget'});
    const roomy = await h.session(p.project.id, batch.id, {budgetMinutes: 600});
    const claimed = await h.worker(roomy.code, 'session/claim', {});
    expect(claimed.body.take).toBeDefined();
    h.tick(4);
    expect((await h.call(`/api/render-sessions/${roomy.session.id}`)).body.status).toBe('lost');
    expect((await h.worker(roomy.code, `takes/${claimed.body.take.jobId}/1/heartbeat`, {})).status).toBe(200);
    expect(h.store.get('render_sessions', roomy.session.id)!.status).toBe('rendering');
    expect((await h.call(`/api/render-sessions/${roomy.session.id}/stop`, {when: 'after_take'})).body.stopRequest.when).toBe('after_take');
    expect((await h.worker(roomy.code, `takes/${claimed.body.take.jobId}/1/heartbeat`, {})).body.stop).toBe('after_take');
    expect((await h.worker(roomy.code, 'session/claim', {})).body).toEqual({end: 'stopped'});
    const third = await h.session(p.project.id, batch.id, {budgetMinutes: 600});
    const edited = (await h.call(`/api/shot-lists/${list.id}/edit`, {cast: list.cast, shots: list.shots.map((s, i) => i === 0 ? {...s, durationSeconds: 6} : s), adaptations: list.adaptations})).body as ShotList;
    expect((await h.call(`/api/episodes/${r.episodeId}/production-shot-list`, {shotListId: edited.id, expectedShotListId: list.id})).status).toBe(200);
    expect((await h.worker(third.code, 'session/claim', {})).body).toEqual({end: 'not_current'});
    expect((await h.call(`/api/projects/${p.project.id}/render-sessions`, {batchIds: [batch.id]})).status).toBe(409);
    expect(h.store.get('render_sessions', session.id)!.status).toBe('rendering');
  });

  test('the estimate is available before a session, and equal bytes from two sessions are two records', async () => {
    const h = harness(), {p, batch} = await h.ready();
    const estimate = await h.call(`/api/render-batches/${batch.id}/estimate`);
    expect(estimate.body.pull).toMatchObject({setupMinutes: 4, measured: false});
    expect(estimate.body.pull.takes).toBeGreaterThan(0);
    expect(estimate.body.rehearsal.setupMinutes).toBe(0.5);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const {code} = await h.session(p.project.id, batch.id);
      const take = (await h.worker(code, 'session/claim', {})).body.take;
      const video = await h.worker(code, `takes/${take.jobId}/${take.n}/files/video`, undefined, {method: 'PUT', raw: mp4(9)});
      ids.push(video.body.assetId);
      expect((await h.worker(code, `takes/${take.jobId}/${take.n}/result`, {status: 'rendered', files: {video: video.body.assetId}})).status).toBe(200);
      await h.worker(code, 'session/end', {reason: 'stopped'});
    }
    expect(new Set(ids).size).toBe(2);
    const lost = await h.session(p.project.id, batch.id);
    await h.worker(lost.code, 'session/claim', {});
    h.tick(5);
    expect((await h.call(`/api/projects/${p.project.id}`)).body.renderSessions.find((s: PublicRenderSession) => s.id === lost.session.id).status).toBe('lost');
    expect((await h.call(`/api/render-sessions/${lost.session.id}/stop`, {when: 'now'})).body).toMatchObject({status: 'ended', end: 'lost', summary: {undelivered: 1}});
  });

  test('a waiting session can reissue its code or stop at once, and it expires', async () => {
    const h = harness(), {p, batch} = await h.ready(), {session, code} = await h.session(p.project.id, batch.id, {expiresHours: 1});
    const reissued = await h.call(`/api/render-sessions/${session.id}/code`, {});
    expect(reissued.body.code).not.toBe(code);
    expect((await h.worker(code, 'session')).status).toBe(401);
    expect((await h.worker(reissued.body.code, 'session')).status).toBe(200);
    expect((await h.call(`/api/render-sessions/${session.id}/code`, {})).status).toBe(409);
    const other = await h.session(p.project.id, batch.id);
    expect((await h.call(`/api/render-sessions/${other.session.id}/stop`, {when: 'now'})).body).toMatchObject({status: 'ended', end: 'stopped'});
    h.tick(61);
    expect((await h.call(`/api/render-sessions/${session.id}`)).body).toMatchObject({status: 'expired'});
    expect((await h.worker(reissued.body.code, 'session')).status).toBe(401);
  });

  test('retakes queue the next seed in the same batch, and one take per job is approved', async () => {
    const h = harness(), {p, batch, jobs} = await h.ready(), {code} = await h.session(p.project.id, batch.id);
    const job = jobs[0]!;
    expect((await h.call(`/api/render-jobs-v2/${job.id}/retake`, {reasons: ['picture_broken']})).status).toBe(409);
    const take = (await h.worker(code, 'session/claim', {})).body.take;
    const video = await h.worker(code, `takes/${take.jobId}/1/files/video`, undefined, {method: 'PUT', raw: mp4(3)});
    await h.worker(code, `takes/${take.jobId}/1/result`, {status: 'rendered', files: {video: video.body.assetId}});
    expect((await h.call(`/api/render-jobs-v2/${job.id}/retake`, {reasons: []})).status).toBe(400);
    const retaken = await h.call(`/api/render-jobs-v2/${job.id}/retake`, {reasons: ['picture_broken'], note: 'shot 1 is rotated'});
    expect(retaken.status).toBe(200);
    const after = (retaken.body as ProjectBundle).renderJobsV2!.find(j => j.id === job.id)! as RenderJobV2;
    expect(after.takes.map(t => t.status)).toEqual(['rendered', 'queued']);
    expect(after.takes[0]!.verdict).toMatchObject({decision: 'retake', reasons: ['picture_broken'], note: 'shot 1 is rotated'});
    expect(after.takes[1]!.seed).not.toBe(after.takes[0]!.seed);
    const next = (await h.worker(code, 'session/claim', {})).body.take;
    expect(next).toMatchObject({jobId: job.id, n: 2, seed: after.takes[1]!.seed});
    expect((await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 2})).status).toBe(409);
    const approved = await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 1});
    expect((approved.body as ProjectBundle).renderJobsV2!.find(j => j.id === job.id)!).toMatchObject({approvedTake: 1});
    expect((await h.call(`/api/media/${video.body.assetId}/delete`, {})).status).toBe(409);
  });

  test('the worker-only listener answers the worker API and nothing else', async () => {
    const h = harness(), {p, batch} = await h.ready(), {code} = await h.session(p.project.id, batch.id);
    const token = code.split('#')[1]!;
    const viaTunnel = (path: string, headers: Record<string, string> = {}) => h.app.worker(new Request(`https://abc.trycloudflare.com${path}`, {headers: {authorization: `Bearer ${token}`, ...headers}}));
    expect((await viaTunnel('/api/worker/v1/session')).status).toBe(200);
    expect((await viaTunnel(`/api/projects/${p.project.id}`)).status).toBe(404);
    expect((await viaTunnel('/api/worker/v1/session', {origin: 'https://evil.example.com'})).status).toBe(404);
    expect((await h.app(new Request(`https://abc.trycloudflare.com/api/projects/${p.project.id}`))).status).toBe(403);
  });
});
