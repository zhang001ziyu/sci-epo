import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { Localization, ProjectBundle, PublicRenderSession, Revision, ShotList } from '../src/types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const brief = {title: 'Last Order', premise: 'Midnight deliveries pull a rider into strangers\' secrets.', characters: 'MAYA: a rider.\nLEO: seventy.', worldRules: 'An ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en', format: 'vertical_short_drama'};
const profile = {style: 'Live-action, cinematic', music: '', characters: [
  {name: 'MAYA', appearance: 'a woman in her twenties in a wet yellow delivery jacket', voice: 'a dry, low female voice'},
  {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'},
]};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...Array.from({length: 64}, () => 7)]);
const LOUDNORM = '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-16.51",\n\t"input_tp" : "-2.10",\n\t"input_lra" : "9.00",\n\t"input_thresh" : "-27.00",\n\t"target_offset" : "0.20"\n}\n';
const SUMMARY = 'Summary:\n\n  Integrated loudness:\n    I:         -14.0 LUFS\n\n  True peak:\n    Peak:       -1.4 dBFS\n';
const sha = (n: number) => n.toString(16).padStart(64, '0');

function harness() {
  const store = new Store(), dir = mkdtempSync(join(tmpdir(), 'sciepo-drive-'));
  cleanups.push(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  // No ffmpeg on this host: with Drive storage nothing here needs it.
  const app = createApp(store, {demo: demoProvider}, process.cwd(), {media: {dir}, videoStorage: 'drive', cuts: {tools: () => null, font: () => null, workRoot: dir}});
  const request = (path: string, init: RequestInit = {}) => app(new Request('http://127.0.0.1:4317' + path, init));
  const call = async (path: string, body?: unknown, method?: string) => {
    const r = await request(path, {method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* Markdown */ }
    return {status: r.status, body: parsed};
  };
  const worker = async (code: string, path: string, body?: unknown, options: {method?: string; raw?: Uint8Array<ArrayBuffer>} = {}) => {
    const r = await request(`/api/worker/v1/${path}`, {method: options.method ?? (options.raw ? 'PUT' : body === undefined ? 'GET' : 'POST'),
      headers: {authorization: `Bearer ${code.split('#')[1]}`, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
      ...(options.raw ? {body: options.raw} : body !== undefined ? {body: JSON.stringify(body)} : {})});
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* files */ }
    return {status: r.status, body: parsed};
  };
  async function ready() {
    const p = (await call('/api/projects', brief)).body as ProjectBundle, e = p.episodes[0]!;
    const r = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
    (await call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'})).body as Localization;
    const list = (await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).body as ShotList;
    await call(`/api/projects/${p.project.id}/production`, profile, 'PUT');
    const portrait = (await request(`/api/projects/${p.project.id}/media?kind=reference_image`, {method: 'PUT', body: PNG}).then(x => x.json())) as any;
    await call(`/api/projects/${p.project.id}/cast`, {name: 'MAYA', portraitAssetId: portrait.asset.id});
    const episode = store.get('episodes', e.id)!;
    expect((await call(`/api/episodes/${e.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true})).status).toBe(200);
    expect((await call(`/api/episodes/${e.id}/production-shot-list`, {shotListId: list.id, expectedShotListId: null})).status).toBe(200);
    const items = (await call(`/api/episodes/${e.id}/readiness`)).body.items as {id: string; status: string}[];
    const bundle = (await call(`/api/shot-lists/${list.id}/render-batches`, {confirmedReadiness: items.filter(i => i.status !== 'passed').map(i => i.id)})).body as ProjectBundle;
    return {p, batch: bundle.renderBatches!.at(-1)!};
  }
  return {store, call, worker, ready};
}

test('with Drive storage takes and cuts stay in Google Drive and the worker makes the cuts', async () => {
  const h = harness(), {p, batch} = await h.ready();
  expect((await h.call('/api/status')).body.videoStorage).toBe('drive');
  const {code} = (await h.call(`/api/projects/${p.project.id}/render-sessions`, {batchIds: [batch.id], mode: 'pull'})).body as {session: PublicRenderSession; code: string};
  const doc = (await h.worker(code, 'session')).body;
  expect(doc.storage).toEqual({video: 'drive'});
  expect(doc.work.takes).toBeGreaterThan(0);

  let n = 0;
  for (;;) {
    const claim = (await h.worker(code, 'session/claim', {})).body;
    if (!claim.take) { expect(claim.cut).toBeDefined(); break; }
    const t = claim.take;
    expect(t.drive).toEqual({folder: ['Sci-epo', 'Last Order', expect.stringContaining('第 1 集'), expect.stringContaining(batch.id.slice(0, 8))], share: 'link'});
    // The server takes no video: an upload is refused, and a result must name the Drive file.
    expect((await h.worker(code, `takes/${t.jobId}/${t.n}/files/video`, undefined, {raw: mp4})).status).toBe(409);
    expect((await h.worker(code, `takes/${t.jobId}/${t.n}/result`, {status: 'rendered', files: {}, seconds: t.seconds})).status).toBe(400);
    expect((await h.worker(code, `takes/${t.jobId}/${t.n}/result`, {status: 'rendered', video: {drive: {id: 'bad id', name: 'x.mp4'}, sha256: sha(1), bytes: 10}, files: {}, seconds: t.seconds})).status).toBe(400);
    n++;
    const done = await h.worker(code, `takes/${t.jobId}/${t.n}/result`, {status: 'rendered', video: {drive: {id: `drive_take_${String(n).padStart(4, '0')}`, name: `${t.output}`}, sha256: sha(n), bytes: 1000 + n},
      files: {}, seconds: t.seconds, qa: {checks: [], loudness: {integrated: -16, truePeak: -1}}});
    expect(done.status).toBe(200);
  }
  expect(h.store.all('media_assets').some(a => a.kind === 'take_video' || a.kind === 'cut_video')).toBe(false);
  const job = h.store.all('render_jobs_v2').find(j => j.batchId === batch.id)!;
  expect(job.takes[0]!.video).toMatchObject({drive: {id: expect.stringMatching(/^drive_take_/u)}, sha256: expect.any(String)});
  expect(job.takes[0]!.video!.assetId).toBeUndefined();

  // The drafts were queued, not cut here; the claim that ended the take loop handed one to the worker.
  const cuts = h.store.all('cuts').filter(c => c.batchId === batch.id);
  expect(cuts.map(c => c.kind)).toEqual(['draft', 'draft']);
  const running = cuts.find(c => c.status === 'running')!;
  expect(running.sessionId).toBeDefined();
  expect(cuts.filter(c => c.status === 'queued')).toHaveLength(1);

  // A session that ends gives its running cut back, and a new session can start for the cuts alone.
  await h.worker(code, 'session/end', {reason: 'stopped'});
  expect(h.store.get('cuts', running.id)!.status).toBe('queued');
  const second = (await h.call(`/api/projects/${p.project.id}/render-sessions`, {batchIds: [batch.id], mode: 'pull'})).body as {code: string};
  expect((await h.worker(second.code, 'session')).body.work).toEqual({takes: 0, cuts: 2});
  const task = (await h.worker(second.code, 'session/claim', {})).body.cut;
  expect(task.inputs.length).toBe(batch.clips.length);
  expect(task.inputs[0]).toMatchObject({name: 'clip-01.mp4', drive: {id: expect.stringMatching(/^drive_take_/u)}});
  expect(task.output.drive.share).toBe('link');
  expect(task.music).toBeNull();

  expect((await h.worker(second.code, `cuts/${task.id}/heartbeat`, {})).body).toEqual({stop: null});
  const audio = Object.fromEntries(task.inputs.map((i: {name: string}) => [i.name, true]));
  expect((await h.worker(second.code, `cuts/${task.id}/args`, {audio: {}, font: false})).status).toBe(400);
  const pass1 = (await h.worker(second.code, `cuts/${task.id}/args`, {audio, font: false})).body.args as string[];
  expect(pass1.slice(-3)).toEqual(['-f', 'null', '-']);
  expect(pass1).toContain('clip-01.mp4');
  const pass2 = (await h.worker(second.code, `cuts/${task.id}/args`, {audio, font: false, measured: LOUDNORM})).body;
  expect(pass2.args.at(-1)).toBe('cut.mp4');
  expect(pass2.args.join(' ')).toContain('measured_I=-16.51');
  expect(pass2.fallback).toBeNull();

  expect((await h.worker(second.code, `cuts/${task.id}/result`, {status: 'done', drive: {id: 'drive_cut_000001', name: task.output.name}, sha256: 'z', bytes: 5, seconds: 10})).status).toBe(400);
  const result = await h.worker(second.code, `cuts/${task.id}/result`, {status: 'done', drive: {id: 'drive_cut_000001', name: task.output.name}, sha256: sha(99), bytes: 5_000_000, seconds: 12.5, loudness: SUMMARY, warnings: ['a note from the worker']});
  expect(result.status).toBe(200);
  const cut = h.store.get('cuts', task.id)!;
  expect(cut).toMatchObject({status: 'done', output: {drive: {id: 'drive_cut_000001'}, sha256: sha(99), bytes: 5_000_000, seconds: 12.5, loudness: -14, truePeak: -1.4}});
  expect(cut.sessionId).toBeUndefined();
  expect(cut.warnings).toContain('a note from the worker');
  const report = (await h.call(`/api/cuts/${cut.id}/report`)).body as string;
  expect(report).toContain('https://drive.google.com/file/d/drive_cut_000001/view');
  expect(report).toContain('https://drive.google.com/file/d/drive_take_0001/view');
  // A cut that is not this session's cannot be reported again.
  expect((await h.worker(second.code, `cuts/${task.id}/result`, {status: 'failed', error: 'late'})).status).toBe(409);
  // The other draft fails cleanly when the worker says so, without a token in the error.
  const other = (await h.worker(second.code, 'session/claim', {})).body.cut;
  await h.worker(second.code, `cuts/${other.id}/result`, {status: 'failed', error: 'ffmpeg failed: sciepo_ss_' + 'q'.repeat(43)});
  expect(h.store.get('cuts', other.id)).toMatchObject({status: 'failed', error: expect.not.stringContaining('sciepo_ss_')});
  expect((await h.worker(second.code, 'session/claim', {})).body).toEqual({end: 'queue_empty'});
});

test('with media storage the worker cut routes are not offered', async () => {
  const store = new Store(), dir = mkdtempSync(join(tmpdir(), 'sciepo-drive-'));
  cleanups.push(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const app = createApp(store, {demo: demoProvider}, process.cwd(), {media: {dir}});
  const status = await (await app(new Request('http://127.0.0.1:4317/api/status'))).json();
  expect(status.videoStorage).toBeUndefined();
});
