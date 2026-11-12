import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { findTools, type Spawner } from '../src/server/cuts';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { Cut, Localization, MediaAsset, ProjectBundle, PublicRenderSession, Revision, ShotList } from '../src/types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const brief = {title: 'Last Order', premise: 'Midnight deliveries pull a rider into strangers\' secrets.', characters: 'MAYA: a rider.\nLEO: seventy.', worldRules: 'An ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en', format: 'vertical_short_drama'};
const profile = {style: 'Live-action, cinematic', music: '', characters: [
  {name: 'MAYA', appearance: 'a woman in her twenties in a wet yellow delivery jacket', voice: 'a dry, low female voice'},
  {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'},
]};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const mp4 = (fill: number) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...Array.from({length: 64}, () => fill)]);
const FLAC = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0x22, 1, 2, 3, 4]);
const LOUDNORM = '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-16.51",\n\t"input_tp" : "-2.10",\n\t"input_lra" : "9.00",\n\t"input_thresh" : "-27.00",\n\t"target_offset" : "0.20"\n}\n';
const SUMMARY = 'Summary:\n\n  Integrated loudness:\n    I:         -14.0 LUFS\n\n  True peak:\n    Peak:       -1.4 dBFS\n';

/** ffmpeg and ffprobe stand-ins: they answer like the real programs and write the cut file. */
function fakeTools(calls: string[][], options: {failRender?: boolean} = {}): Spawner {
  return async (cmd, {cwd}) => {
    calls.push(cmd);
    if (cmd[0] === 'ffprobe') return {code: 0, stdout: cmd.includes('stream=index') ? '1\n' : '12.5\n', stderr: ''};
    if (cmd.some(a => a.startsWith('ebur128'))) return {code: 0, stdout: '', stderr: SUMMARY};
    if (cmd.at(-1) === '-') return {code: 0, stdout: '', stderr: LOUDNORM};
    if (options.failRender) return {code: 1, stdout: '', stderr: 'Error while filtering: sciepo_ss_' + 'q'.repeat(43)};
    writeFileSync(join(cwd, cmd.at(-1)!), mp4(cmd.length % 200));
    return {code: 0, stdout: '', stderr: ''};
  };
}

function harness(options: {spawn?: Spawner; tools?: boolean; store?: Store; dir?: string} = {}) {
  const store = options.store ?? new Store(), dir = options.dir ?? mkdtempSync(join(tmpdir(), 'sciepo-cuts-'));
  if (!options.store) cleanups.push(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const calls: string[][] = [];
  const app = createApp(store, {demo: demoProvider}, process.cwd(), {media: {dir}, cuts: {spawn: options.spawn ?? fakeTools(calls), tools: () => options.tools === false ? null : {ffmpeg: 'ffmpeg', ffprobe: 'ffprobe'}, font: () => null, workRoot: dir}});
  const request = (path: string, init: RequestInit = {}) => app(new Request('http://127.0.0.1:4317' + path, init));
  const call = async (path: string, body?: unknown, method?: string) => {
    const r = await request(path, {method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* reports are Markdown */ }
    return {status: r.status, body: parsed};
  };
  const upload = async (projectId: string, kind: string, bytes: Uint8Array<ArrayBuffer>, query = '') => (await request(`/api/projects/${projectId}/media?kind=${kind}${query}`, {method: 'PUT', body: bytes})).json() as Promise<any>;
  const worker = async (code: string, path: string, body?: unknown, raw?: Uint8Array<ArrayBuffer>) => {
    const r = await request(`/api/worker/v1/${path}`, {method: raw ? 'PUT' : 'POST', headers: {authorization: `Bearer ${code.split('#')[1]}`, ...(body !== undefined ? {'content-type': 'application/json'} : {})}, ...(raw ? {body: raw} : body !== undefined ? {body: JSON.stringify(body)} : {})});
    return r.json() as Promise<any>;
  };
  async function ready() {
    const p = (await call('/api/projects', brief)).body as ProjectBundle, e = p.episodes[0]!;
    const r = (await call(`/api/episodes/${e.id}/generate`, {mode: 'demo'})).body as Revision;
    (await call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'})).body as Localization;
    const list = (await call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'})).body as ShotList;
    await call(`/api/projects/${p.project.id}/production`, profile, 'PUT');
    const portrait = await upload(p.project.id, 'reference_image', PNG);
    await call(`/api/projects/${p.project.id}/cast`, {name: 'MAYA', portraitAssetId: portrait.asset.id});
    const episode = store.get('episodes', e.id)!;
    expect((await call(`/api/episodes/${e.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true})).status).toBe(200);
    expect((await call(`/api/episodes/${e.id}/production-shot-list`, {shotListId: list.id, expectedShotListId: null})).status).toBe(200);
    const items = (await call(`/api/episodes/${e.id}/readiness`)).body.items as {id: string; status: string}[];
    const bundle = (await call(`/api/shot-lists/${list.id}/render-batches`, {confirmedReadiness: items.filter(i => i.status !== 'passed').map(i => i.id)})).body as ProjectBundle, batch = bundle.renderBatches!.at(-1)!;
    return {p, e, r, list, batch};
  }
  /** Render every take of a batch through one session; each video is the given bytes, or a distinct stub. */
  async function renderAll(projectId: string, batchId: string, video?: (n: number) => Uint8Array<ArrayBuffer>, mode: 'pull' | 'rehearsal' = 'pull') {
    const {code} = (await call(`/api/projects/${projectId}/render-sessions`, {batchIds: [batchId], mode})).body as {session: PublicRenderSession; code: string};
    for (let i = 0; ; i++) {
      const claim = await worker(code, 'session/claim', {});
      if (!claim.take) break;
      const t = claim.take, uploaded = await worker(code, `takes/${t.jobId}/${t.n}/files/video`, undefined, video ? video(i) : mp4(i + 1));
      await worker(code, `takes/${t.jobId}/${t.n}/result`, {status: 'rendered', files: {video: uploaded.assetId}, seconds: t.seconds, qa: {checks: [], loudness: {integrated: t.expectedLines.length ? -10.5 : -28.3, truePeak: -1}}});
    }
    await worker(code, 'session/end', {reason: 'queue_empty'});
  }
  return {store, app, call, upload, worker, ready, renderAll, calls, dir};
}

const cutsOf = (h: ReturnType<typeof harness>, batchId: string) => h.store.all('cuts').filter(c => c.batchId === batchId);

describe('cuts', () => {
  test('the last rendered take of a language queues a draft, which is cut and stored', async () => {
    const h = harness(), {p, batch} = await h.ready();
    await h.renderAll(p.project.id, batch.id);
    await h.app.cuts.idle();
    const drafts = cutsOf(h, batch.id);
    expect(drafts.map(c => [c.language, c.kind, c.status]).sort()).toEqual([['en', 'draft', 'done'], ['zh-CN', 'draft', 'done']]);
    const zh = drafts.find(c => c.language === 'zh-CN')!;
    expect(zh.clips).toHaveLength(batch.clips.length);
    expect(zh.output).toMatchObject({seconds: 12.5, loudness: -14, truePeak: -1.4});
    expect(h.store.get('media_assets', zh.output!.assetId!)).toMatchObject({kind: 'cut_video', origin: 'sciepo'});
    expect(zh.warnings ?? []).toEqual(zh.captions.some(c => c.enabled) ? [expect.stringContaining('字体')] : []);
    // Two ffmpeg passes per cut, then the measurement; ffmpeg never gets a shell or the caption text.
    const renders = h.calls.filter(c => c[0] === 'ffmpeg' && c.at(-1) === 'cut.mp4');
    expect(renders).toHaveLength(2);
    expect(renders[0]!.join(' ')).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-16.51');
    // A second identical draft is not queued again.
    h.app.cuts.takeRendered(h.store.all('render_jobs_v2').find(j => j.batchId === batch.id)!.id);
    await h.app.cuts.idle();
    expect(cutsOf(h, batch.id)).toHaveLength(2);
    const bundle = (await h.call(`/api/projects/${p.project.id}`)).body as ProjectBundle;
    expect(bundle.cuts).toHaveLength(2);
  });

  test('final cuts need approved takes, a music choice in bed mode and valid captions', async () => {
    const h = harness(), {p, batch} = await h.ready();
    await h.renderAll(p.project.id, batch.id);
    await h.app.cuts.idle();
    const path = `/api/render-batches/${batch.id}/cuts`;
    expect((await h.call(path, {language: 'ja', kind: 'final'})).status).toBe(400);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {noMusic: true}})).status).toBe(409);
    for (const job of h.store.all('render_jobs_v2').filter(j => j.batchId === batch.id)) expect((await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 1})).status).toBe(200);
    const plan = (await h.call(`/api/render-batches/${batch.id}/cut-plan?language=zh-CN&kind=final`)).body;
    expect(plan).toMatchObject({missing: [], musicRequired: true, ffmpeg: {found: true}, sizes: ['native', '720x1280', '1080x1920']});
    expect((await h.call(path, {language: 'zh-CN', kind: 'final'})).status).toBe(400);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {noMusic: true, size: '1920x1080'}})).status).toBe(400);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {noMusic: true, targetLufs: -5}})).status).toBe(400);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {noMusic: true}, captions: [{shotId: 'nope', start: 0, end: 1, text: 'x', enabled: true}]})).status).toBe(400);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {noMusic: true}, captions: [{shotId: batch.clips[0]!.shotIds[0], start: 2, end: 1, text: 'x', enabled: true}]})).status).toBe(400);
    const otherProject = (await h.call('/api/projects', {...brief, title: 'Other'})).body as ProjectBundle;
    const foreign = await h.upload(otherProject.project.id, 'music', FLAC);
    expect((await h.call(path, {language: 'zh-CN', kind: 'final', settings: {musicAssetId: foreign.asset.id}})).status).toBe(400);
    const music = await h.upload(p.project.id, 'music', FLAC, '&label=bed&license=CC%20BY%204.0');
    const shot = batch.clips[0]!.shotIds[0]!;
    const created = await h.call(path, {language: 'zh-CN', kind: 'final', settings: {musicAssetId: music.asset.id, musicLevelDb: -18, size: '720x1280'}, captions: [{shotId: shot, start: 0.5, end: 2, text: "第一行\u0007 'x'", enabled: true}]});
    expect(created.status).toBe(200);
    expect((created.body.cut as Cut).captions).toEqual([{shotId: shot, start: 0.5, end: 2, text: "第一行 'x'", enabled: true}]);
    await h.app.cuts.idle();
    const final = h.store.get('cuts', created.body.cut.id)!;
    expect(final).toMatchObject({kind: 'final', status: 'done', settings: {musicAssetId: music.asset.id, musicLevelDb: -18, size: '720x1280'}});
    const render = h.calls.filter(c => c[0] === 'ffmpeg' && c.at(-1) === 'cut.mp4').at(-1)!;
    expect(render).toEqual(expect.arrayContaining(['-stream_loop', '-1']));
    expect(render.join(' ')).toContain('scale=720:1280');
    expect((await h.call(`/api/media/${music.asset.id}/delete`, {})).status).toBe(200);
  });

  test('sign-off: only finished final cuts, a reason to reject, a stored report, and the manifest marks the language delivered', async () => {
    const h = harness(), {p, r, batch} = await h.ready();
    await h.renderAll(p.project.id, batch.id);
    await h.app.cuts.idle();
    const draft = cutsOf(h, batch.id).find(c => c.language === 'en')!;
    expect((await h.call(`/api/cuts/${draft.id}/sign-off`, {decision: 'signed_off'})).status).toBe(409);
    for (const job of h.store.all('render_jobs_v2').filter(j => j.batchId === batch.id)) await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 1});
    const id = (await h.call(`/api/render-batches/${batch.id}/cuts`, {language: 'en', kind: 'final', settings: {noMusic: true}})).body.cut.id as string;
    await h.app.cuts.idle();
    expect((await h.call(`/api/cuts/${id}/sign-off`, {decision: 'rejected'})).status).toBe(400);
    const rejected = await h.call(`/api/cuts/${id}/sign-off`, {decision: 'rejected', note: 'The note caption is too fast.'});
    expect(rejected.body.cut.signOff).toMatchObject({decision: 'rejected', note: 'The note caption is too fast.'});
    const signed = await h.call(`/api/cuts/${id}/sign-off`, {decision: 'signed_off'});
    expect(signed.status).toBe(200);
    const report = h.store.get('media_assets', signed.body.cut.signOff.reportAssetId)!;
    expect(report).toMatchObject({kind: 'report', origin: 'sciepo'});
    const text = (await h.call(`/api/cuts/${id}/report`)).body as string;
    for (const part of [r.id, batch.id, batch.shotListId, 'SHA-256']) expect(text).toContain(part);
    expect(text).not.toMatch(/sciepo_(ss|wk)_/u);
    const manifest = (await h.call(`/api/revisions/${r.id}/publication`)).body;
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.productionStatus).toBe('partly_delivered');
    expect(manifest.versions.find((v: any) => v.language === 'en')).toMatchObject({productionStatus: 'delivered', cut: {id, sha256: h.store.get('cuts', id)!.output!.sha256}});
    expect(manifest.versions.find((v: any) => v.language === 'zh-CN')).toMatchObject({productionStatus: 'planning_only', cut: null});
    // A retake that becomes the approved take makes the delivered cut stale.
    const job = h.store.all('render_jobs_v2').find(j => j.batchId === batch.id)!;
    await h.call(`/api/render-jobs-v2/${job.id}/retake`, {reasons: ['picture_broken']});
    await h.renderAll(p.project.id, batch.id, n => mp4(200 + n));
    await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 2});
    expect((await h.call(`/api/cuts/${id}`)).body.current).toBe(false);
    expect((await h.call(`/api/revisions/${r.id}/publication`)).body.productionStatus).toBe('planning_only');
    expect((await h.call(`/api/media/${report.id}/delete`, {})).status).toBe(409);
  });

  test('rehearsal cuts cannot be signed off, a missing ffmpeg answers 503, and failures keep the error without tokens', async () => {
    const h = harness(), {p, batch} = await h.ready();
    await h.renderAll(p.project.id, batch.id, undefined, 'rehearsal');
    await h.app.cuts.idle();
    for (const job of h.store.all('render_jobs_v2').filter(j => j.batchId === batch.id)) await h.call(`/api/render-jobs-v2/${job.id}/approve`, {take: 1});
    const id = (await h.call(`/api/render-batches/${batch.id}/cuts`, {language: 'en', kind: 'final', settings: {noMusic: true}})).body.cut.id as string;
    await h.app.cuts.idle();
    expect(h.store.get('cuts', id)!.rehearsal).toBe(true);
    expect((await h.call(`/api/cuts/${id}/sign-off`, {decision: 'signed_off'})).status).toBe(409);
    const none = harness({tools: false}), second = await none.ready();
    expect((await none.call(`/api/render-batches/${second.batch.id}/cut-plan?language=en&kind=draft`)).body.ffmpeg).toMatchObject({found: false, hint: expect.stringContaining('ffmpeg')});
    await none.renderAll(second.p.project.id, second.batch.id);
    expect((await none.call(`/api/render-batches/${second.batch.id}/cuts`, {language: 'en', kind: 'draft'})).status).toBe(503);
    const broken = harness({spawn: fakeTools([], {failRender: true})}), third = await broken.ready();
    await broken.renderAll(third.p.project.id, third.batch.id);
    await broken.app.cuts.idle();
    const failed = cutsOf(broken, third.batch.id)[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('[token]');
    expect(failed.error).not.toMatch(/sciepo_ss_/u);
  });

  test('a cut that was running when the server stopped is cut again after a restart', async () => {
    const h = harness(), {p, batch} = await h.ready();
    await h.renderAll(p.project.id, batch.id);
    await h.app.cuts.idle();
    const cut = cutsOf(h, batch.id)[0]!;
    h.store.update('cuts', {...cut, status: 'running', output: undefined} as Cut);
    const again = harness({store: h.store, dir: h.dir});
    await again.app.cuts.idle();
    expect(h.store.get('cuts', cut.id)).toMatchObject({status: 'done'});
  });
});

const tools = findTools();
describe.skipIf(!tools)('a real cut with ffmpeg', () => {
  test('two synthetic clips and a music bed become one normalized episode with captions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sciepo-realcut-'));
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const make = (name: string, args: string[]) => {
      const done = Bun.spawnSync([tools!.ffmpeg, '-v', 'error', '-y', ...args, join(dir, name)]);
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
      return new Uint8Array(readFileSync(join(dir, name)));
    };
    const clip = (i: number) => make(`clip${i}.mp4`, ['-f', 'lavfi', '-i', 'testsrc2=size=480x864:rate=24', '-f', 'lavfi', '-i', `sine=frequency=${300 + 100 * i}:sample_rate=32000`, '-t', '2', '-af', `volume=${i % 2 ? -20 : -6}dB`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=clip ${i}`]);
    const music = make('music.flac', ['-f', 'lavfi', '-i', 'sine=frequency=110:sample_rate=48000', '-t', '5']);
    // A real runner: the default spawner and tools, the default font search.
    const store = new Store(), media = mkdtempSync(join(tmpdir(), 'sciepo-realcut-media-'));
    cleanups.push(() => { store.close(); rmSync(media, {recursive: true, force: true}); });
    const app = createApp(store, {demo: demoProvider}, process.cwd(), {media: {dir: media}, cuts: {workRoot: media}});
    const request = (path: string, init: RequestInit = {}) => app(new Request('http://127.0.0.1:4317' + path, init));
    const json = async (path: string, body?: unknown, method?: string) => (await request(path, {method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body !== undefined ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})})).json() as Promise<any>;
    const p = await json('/api/projects', brief), e = p.episodes[0];
    const r = await json(`/api/episodes/${e.id}/generate`, {mode: 'demo'});
    await json(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'});
    const list = await json(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'});
    await json(`/api/projects/${p.project.id}/production`, profile, 'PUT');
    const portrait = await (await request(`/api/projects/${p.project.id}/media?kind=reference_image`, {method: 'PUT', body: PNG})).json() as {asset: MediaAsset};
    await json(`/api/projects/${p.project.id}/cast`, {name: 'MAYA', portraitAssetId: portrait.asset.id});
    const episode = store.get('episodes', e.id)!;
    await json(`/api/episodes/${e.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: store.contextToken(episode), acknowledgeReview: true, acknowledgeLengthException: true});
    await json(`/api/episodes/${e.id}/production-shot-list`, {shotListId: list.id, expectedShotListId: null});
    const items = (await json(`/api/episodes/${e.id}/readiness`)).items as {id: string; status: string}[];
    const batch = (await json(`/api/shot-lists/${list.id}/render-batches`, {confirmedReadiness: items.filter(i => i.status !== 'passed').map(i => i.id)})).renderBatches.at(-1);
    const {code} = await json(`/api/projects/${p.project.id}/render-sessions`, {batchIds: [batch.id]});
    const auth = {authorization: `Bearer ${code.split('#')[1]}`};
    const clips = [clip(0), clip(1)];
    for (let i = 0; ; i++) {
      const claim = await (await request('/api/worker/v1/session/claim', {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: '{}'})).json() as any;
      if (!claim.take) break;
      const t = claim.take, up = await (await request(`/api/worker/v1/takes/${t.jobId}/${t.n}/files/video`, {method: 'PUT', headers: auth, body: clips[i % 2]!})).json() as any;
      await request(`/api/worker/v1/takes/${t.jobId}/${t.n}/result`, {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: JSON.stringify({status: 'rendered', files: {video: up.assetId}, seconds: 2, qa: {checks: [], loudness: {integrated: i % 2 ? -32 : -18, truePeak: -3}}})});
    }
    for (const job of store.all('render_jobs_v2')) await json(`/api/render-jobs-v2/${job.id}/approve`, {take: 1});
    const bed = await (await request(`/api/projects/${p.project.id}/media?kind=music&label=bed`, {method: 'PUT', body: music})).json() as {asset: MediaAsset};
    const plan = await json(`/api/render-batches/${batch.id}/cut-plan?language=zh-CN&kind=final`);
    const captions = plan.captions.map((c: any, i: number) => i === 0 ? {...c, start: 0.2, end: 1.8, text: "订单备注：'50% off' [x] C:\\temp %{n}", enabled: true} : c);
    const created = await json(`/api/render-batches/${batch.id}/cuts`, {language: 'zh-CN', kind: 'final', settings: {musicAssetId: bed.asset.id}, captions});
    expect(created.cut).toBeDefined();
    await app.cuts.idle();
    const cut = store.get('cuts', created.cut.id)!;
    expect(cut.error).toBeUndefined();
    expect(cut.status).toBe('done');
    expect(cut.output!.seconds).toBeCloseTo(2 * batch.clips.length, 0);
    expect(cut.output!.loudness!).toBeGreaterThan(-15.5);
    expect(cut.output!.loudness!).toBeLessThan(-12.5);
    expect(cut.output!.truePeak!).toBeLessThanOrEqual(-0.5);
    const file = join(media, cut.output!.sha256.slice(0, 2), cut.output!.sha256);
    const probe = Bun.spawnSync([tools!.ffprobe, '-v', 'error', '-show_entries', 'stream=codec_name,width,height,sample_rate', '-of', 'csv=p=0', file]).stdout.toString();
    expect(probe).toContain('h264,480,864');
    expect(probe).toContain('aac,48000');
  }, 180_000);
});
