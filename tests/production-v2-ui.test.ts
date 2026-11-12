import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { planRenderBatch } from '../src/core/h3';
import { planJobsV2 } from '../src/core/renderPlan';
import { SHORT_DRAMA_DEMO, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { BatchReference, Episode, Localization, MediaAsset, ProductionProfile, ProjectBundle, PublicRenderSession, RenderBatch, RenderJobV2, Revision, ShotList, Take, TakeQa } from '../src/types';
import { POLL_MS, ProductionPanel, SESSION_NOTEBOOK, mediaUsage, takeCounts, type ProductionContext } from '../web/production';
import { codeOnce } from '../web/productionV2';

const attack = '<img src=x onerror="alert(1)">';
const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
const time = '2026-11-12T08:00:00.000Z';
const NOW = Date.parse('2026-11-12T08:12:30.000Z');
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const CODE = 'https://studio.example.com#sciepo_ss_' + 'Q'.repeat(43);
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA, LEO', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const count = (text: string, part: string) => text.split(part).length - 1;

function liveSession(overrides: Partial<PublicRenderSession> = {}): PublicRenderSession {
  return {id: 's-live', projectId: 'p1', batchIds: ['b2'], mode: 'pull', status: 'rendering', settings: {budgetMinutes: 52, allowUntestedGpu: false, waitForRetakesMinutes: 0},
    estimate: {setupMinutes: 4, renderMinutes: 30.5, takes: 9, frames: 2500, measured: false}, createdAt: '2026-11-12T07:59:00.000Z', expiresAt: '2026-11-12T14:00:00.000Z',
    startedAt: time, lastSeenAt: '2026-11-12T08:12:00.000Z', worker: {gpu: `RTX PRO 6000 ${attack}`, vramGb: 96},
    events: [
      {at: '2026-11-12T08:00:05.000Z', stage: 'gpu', data: {gpu: 'RTX PRO 6000'}},
      {at: '2026-11-12T08:01:00.000Z', stage: 'downloading', data: {bytesDone: 1e9, bytesTotal: 4e9}},
      {at: '2026-11-12T08:01:15.000Z', stage: 'downloading', data: {bytesDone: 2e9, bytesTotal: 4e9}},
      {at: '2026-11-12T08:06:00.000Z', stage: 'rendering', message: `ep01-c01-en.mp4 · take 1 ${attack}`, data: {index: 2, count: 9}},
    ], ...overrides};
}
const endedSession: PublicRenderSession = {id: 's-old', projectId: 'p1', batchIds: ['b2'], mode: 'pull', status: 'ended', end: 'budget', settings: {budgetMinutes: 45, allowUntestedGpu: false, waitForRetakesMinutes: 0},
  estimate: {setupMinutes: 4, renderMinutes: 30, takes: 10, frames: 3000, measured: true}, createdAt: '2026-11-11T08:00:00.000Z', expiresAt: '2026-11-11T14:00:00.000Z', startedAt: '2026-11-11T08:01:00.000Z',
  endedAt: '2026-11-11T08:45:00.000Z', events: [], summary: {minutes: 41.2, takesRendered: 6, takesFailed: 1, undelivered: 1, message: `bye ${attack}`}, readings: {before: 120.5}};

function fixture(options: {live?: boolean} = {}) {
  const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(SHORT_DRAMA_DEMO.en), language: 'en', kind: 'generated', instruction: '', mode: 'demo', createdAt: time, context: snapshotContext(brief, [])};
  const zh: Localization = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', parentId: null, mode: 'demo', glossary: '', createdAt: time, ...structuredClone(SHORT_DRAMA_DEMO.zh)};
  const list: ShotList = {...shortDramaDemoShotList('en'), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'demo', createdAt: time};
  const episode: Episode = {id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: 'r1', needsReview: false, createdAt: time, productionShotListId: 'v1'};
  const production: ProductionProfile = {style: 'Live-action, cinematic', music: 'A low synth drone.', characters: [
    {name: 'MAYA', appearance: 'a rider in a hooded yellow jacket', voice: 'a dry, low female voice', portrait: {assetId: 'img-maya', sha256: SHA_A, approvedAt: time}, usePortrait: true},
    {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'}]};
  // As the server plans a v2 batch: the portrait becomes a reference name the prompt uses.
  const references: BatchReference[] = [{name: 'maya-aaaaaaaa.png', kind: 'image', character: 'MAYA', assetId: 'img-maya', sha256: SHA_A}];
  const planning = {...production, characters: production.characters.map(c => c.portrait ? {...c, image: 'maya-aaaaaaaa.png'} : c)};
  const plan = planRenderBatch({batchId: 'b2', createdAt: time, episodeId: 'e1', list, revision, adaptations: {'zh-CN': zh}, profile: planning, size: {width: 480, height: 864}, musicMode: 'bed'});
  const preset = {width: 480, height: 864, steps: 20, turbo: false, stack: {id: 'h3-lite', version: '2026.11.1'}};
  const {clips, jobs: planned} = planJobsV2(plan.batch, preset, references, 1);
  clips[0]!.prompts.en!.text += ` ${attack}`;
  const batch: RenderBatch = {...plan.batch, version: 2, preset, musicMode: 'bed', references, clips};
  const qa: TakeQa = {checks: [{id: 'duration', status: 'pass', message: 'within one frame'}, {id: 'loudness', status: 'failure', message: `too quiet ${attack}`, value: -31.5}], loudness: {integrated: -31.5, truePeak: -9.2},
    contactSheet: 'sheet-c01', keyframes: [{shotId: 'sh1', assetId: 'kf-sh1'}, {shotId: 'sh2', assetId: 'kf-sh2'}],
    speech: {language: 'en', lines: [{sceneId: 's1', position: 3, language: 'en', expected: 'Singing costs extra.', heard: `Singing costs ${attack}`, score: 0.42}]}};
  const video = (assetId: string) => ({assetId, sha256: SHA_B, bytes: 1_200_000, seconds: 12.25});
  const jobs: RenderJobV2[] = planned.map(p => {
    const id = `j-${p.clipId}-${p.languages.join('+')}`, seed = clips.find(c => c.id === p.clipId)!.seed;
    let takes: Take[] = [{n: 1, seed, status: 'queued'}], approvedTake: number | undefined;
    if (id === 'j-c01-en') takes = [{n: 1, seed, status: 'rendered', sessionId: 's-live', video: video('vid-c01-en-1'), qa, renderSeconds: 180}];
    if (id === 'j-c01-zh-CN') takes = [{n: 1, seed, status: 'claimed', sessionId: 's-live', leaseExpiresAt: '2026-11-12T08:20:00.000Z'}];
    if (id === 'j-c02-en') takes = [{n: 1, seed, status: 'failed', error: `CUDA ${attack}`}];
    if (id === 'j-c02-zh-CN') takes = [{n: 1, seed, status: 'rendered', video: video('vid-c02-zh-1'), verdict: {decision: 'retake', reasons: ['picture_broken', 'lip_sync'], note: `rotated ${attack}`, at: time}}, {n: 2, seed: seed + 1, status: 'queued'}];
    if (p.languages.length > 1) { takes = [{n: 1, seed, status: 'rendered', rehearsal: true, video: video('vid-c04-1'), qa: {checks: [{id: 'duration', status: 'pass', message: 'ok'}], keyframes: []}, verdict: {decision: 'approved', reasons: [], at: time}}]; approvedTake = 1; }
    return {id, batchId: 'b2', ...p, takes, ...(approvedTake !== undefined ? {approvedTake} : {}), updatedAt: time};
  });
  const media: MediaAsset[] = [
    {id: 'img-maya', projectId: 'p1', kind: 'reference_image', contentType: 'image/png', bytes: 2048, sha256: SHA_A, origin: 'owner', label: `MAYA · ${attack}`, createdAt: time},
    {id: 'vid-c01-en-1', projectId: 'p1', kind: 'take_video', contentType: 'video/mp4', bytes: 1_200_000, sha256: SHA_B, origin: 'worker', sessionId: 's-live', createdAt: time},
  ];
  const bundle: ProjectBundle = {project: {...brief, id: 'p1', createdAt: time, updatedAt: time, voiceLanguages: ['en', 'zh-CN'], production, productionSettings: {computeUnitsPerHour: 10.05}}, episodes: [episode], revisions: [revision], reviews: [], runs: [], localizations: [zh], shotLists: [list],
    renderBatches: [batch], renderJobs: [], renderJobsV2: jobs, renderSessions: [endedSession, ...(options.live === false ? [] : [liveSession()])], media};
  const ctx: ProductionContext = {bundle, episode, revision, busy: false};
  return {ctx, jobs, batch};
}

type Route = (path: string, body: unknown) => unknown;
interface FakeTimer { fn: () => void; ms: number }
function harness(ctx: ProductionContext, route: Route = () => undefined, options: {app?: boolean; copy?: (text: string) => Promise<void>} = {}) {
  const calls = {posts: [] as [string, unknown][], apis: [] as [string, RequestInit | undefined][], uploads: [] as [string, Blob][], notices: [] as string[], failures: [] as string[], bundles: 0, renders: 0};
  const timers: FakeTimer[] = [];
  const answer = (path: string, body: unknown) => route(path, body) ?? ctx.bundle;
  // With app: true, render and patch draw the view again, as the workspace does.
  const draw = () => { calls.renders++; if (options.app) p.view(ctx); };
  const p: ProductionPanel = new ProductionPanel({
    run: async (_label, action) => { try { await action(); } catch (error) { calls.failures.push(error instanceof Error ? error.message : String(error)); } },
    api: async <T>(path: string, init?: RequestInit) => { calls.apis.push([path, init]); return (path === '/api/worker-tokens' ? [] : answer(path, init?.body)) as T; },
    post: async <T>(path: string, body: unknown) => { calls.posts.push([path, body]); return answer(path, body) as T; },
    upload: async <T>(path: string, file: Blob) => { calls.uploads.push([path, file]); return ({asset: {id: 'new-asset'}, bundle: ctx.bundle}) as T; },
    setBundle: b => { calls.bundles++; ctx.bundle = b; }, render: draw, patch: draw,
    notice: m => { calls.notices.push(m); }, fail: m => { calls.failures.push(m); }, origin: () => 'https://studio.example.com',
    timers: {set: (fn, ms) => { const t = {fn, ms}; timers.push(t); return t; }, clear: handle => { const i = timers.indexOf(handle as FakeTimer); if (i >= 0) timers.splice(i, 1); }},
    now: () => NOW, ...(options.copy ? {copy: options.copy} : {}),
  });
  const fire = async () => { const t = timers.shift(); if (!t) throw new Error('no timer is waiting'); t.fn(); await flush(); };
  return {p, calls, timers, fire};
}
const field = (dataset: Record<string, string>, value = '', checked = false) => ({dataset, value, checked, id: ''}) as unknown as HTMLInputElement;

describe('v2 render batches in the production tab', () => {
  test('the grid shows shared and per-language jobs, technical counts apart from verdicts, and escapes worker text', () => {
    const {ctx, jobs} = fixture(), html = harness(ctx).p.view(ctx);
    expect(html).not.toContain(attack);
    expect(html).not.toContain('onerror="');
    expect(html).toContain('已渲染 3 条 · 质检失败 1 条 · 渲染失败 1 条 · 排队 7 · 渲染中 1');
    expect(html).toContain('已通过 1/11 · 要求重拍 1 次');
    expect(takeCounts(jobs)).toEqual({jobs: 11, rendered: 3, qaFailed: 1, failed: 1, queued: 7, rendering: 1, approved: 1, retakes: 1});
    const shared = jobs.find(j => j.languages.length > 1)!;
    expect(shared.clipId).toBe('c04');
    expect(html).toContain(`colspan="2" data-live="job-${shared.id}"`);
    expect(html).toContain('English、简体中文 共用一次渲染');
    expect(html).toContain('data-live="job-j-c01-en"><button class="take-cell" data-action="production-review" data-id="j-c01-en" aria-pressed="false"');
    expect(html).toContain('<img class="take-thumb" src="/api/media/sheet-c01"');
    expect(html).toContain('质检失败：响度');
    expect(html).toContain(`CUDA ${escaped}`);
    expect(html).toContain('<span class="pill accepted">已通过</span>');
    expect(html).toContain('<span class="pill changed">要求重拍</span>');
    expect(html).toContain('take 1 · 演练');
    expect(html).toContain('480×864 · 20 步 · 整集配乐');
    expect(html).toContain('参考：MAYA 的参考图');
    expect(html).not.toContain('系列的参考已经变了');
    expect(html).not.toContain('/package');
  });

  test('cast references show the portrait next to the appearance, and media usage counts each file once', () => {
    const {ctx} = fixture(), {p} = harness(ctx);
    let html = p.view(ctx);
    expect(html).toContain('<img src="/api/media/img-maya" alt="MAYA 的参考图"');
    expect(html).toContain('a rider in a hooded yellow jacket');
    expect(html).toContain('兜帽');
    expect(html).toContain('data-production-use-portrait="MAYA" checked');
    expect(html).toContain('data-action="production-unlink" data-id="MAYA" data-kind="portrait"');
    expect(html).toContain('data-production-upload="voice" data-character="LEO"');
    expect(html).toContain('媒体库：本系列 2 个文件，共 1.1 MB。');
    expect(mediaUsage([...ctx.bundle.media!, {...ctx.bundle.media![0]!, id: 'again', kind: 'reference_image'}])).toBe(2048 + 1_200_000);
    p.click('production-toggle-media', {dataset: {}}, ctx);
    html = p.view(ctx);
    expect(html).toContain(`MAYA · ${escaped}`);
    expect(html).toContain('data-action="production-delete-media" data-id="img-maya"');
    expect(html).not.toContain('data-id="vid-c01-en-1"');
  });

  test('a batch says when the series uses another reference now', () => {
    const {ctx} = fixture();
    ctx.bundle.project.production!.characters[0]!.portrait!.sha256 = 'c'.repeat(64);
    ctx.bundle.project.production!.characters[1]!.voiceSampleAsset = {assetId: 'wav-leo', sha256: 'd'.repeat(64)};
    const html = harness(ctx).p.view(ctx);
    expect(html).toContain('MAYA 的参考图已经换了，这一批仍用原来的。');
    expect(html).toContain('LEO 现在有声音样本，这一批没有用它。');
  });

  test('a live session shows status, time, the default estimate, compute units, recent stages and stop buttons', () => {
    const {ctx} = fixture(), html = harness(ctx).p.view(ctx);
    expect(html).toContain('data-live="session-s-live-live"');
    expect(html).toContain('正在渲染');
    expect(html).toContain('已运行 12 分钟 · 预计还要约 22 分钟 · 预计共 34.5 分钟（准备 4 + 渲染 30.5，9 条 take） · 默认估算 · 时间预算 52 分钟');
    expect(html).toContain('按每小时 10.05 个计算单元：已用约 2.1 个，整场预计约 5.8 个。');
    expect(html).toContain(`GPU：RTX PRO 6000 ${escaped}（96 GB）`);
    expect(html).toContain(`ep01-c01-en.mp4 · take 1 ${escaped}`);
    expect(html).toContain('第 2/9 条');
    expect(html).toContain('<progress max="100" value="50">50%</progress><span class="small muted">1.9 GB / 3.7 GB（50%）</span>');
    expect(html).not.toContain('（25%）');
    expect(html).toContain('data-action="production-stop" data-id="s-live" data-when="after_take"');
    expect(html).toContain('data-action="production-stop" data-id="s-live" data-when="now"');
    expect(html).not.toContain('data-action="production-start-session"');
    // The last ended session keeps its summary and the readings.
    expect(html).toContain('到了时间预算');
    expect(html).toContain('用时 41.2 分钟 · 约 6.9 个计算单元（按现在的单价估算） · 渲染完成 6 条 · 失败 1 条 · 未送达 1 条（已重新排队）');
    expect(html).toContain(`bye ${escaped}`);
    expect(html).toContain('id="reading-before-s-old" class="small-input" type="number" min="0" step="0.01" value="120.5"');
    expect(html).toContain('代码执行程序 → 查看资源');
  });

  test('the review panel shows the latest take with its video, sheet, keyframes, checks and lines, and approves it', async () => {
    const {ctx} = fixture(), {p, calls} = harness(ctx);
    p.click('production-review', {dataset: {id: 'j-c01-en'}}, ctx);
    const html = p.view(ctx);
    expect(html).not.toContain(attack);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('<video class="review-video" controls playsinline preload="metadata" src="/api/media/vid-c01-en-1"');
    expect(html).toContain('<img src="/api/media/sheet-c01" alt="take 1 的联系表"');
    expect(html).toContain('<img src="/api/media/kf-sh2" alt="镜头 sh2 的关键帧"');
    expect(html).toContain(`<strong>响度</strong><span>too quiet ${escaped}</span><span class="small muted">数值 -31.5</span>`);
    expect(html.indexOf('too quiet')).toBeLessThan(html.indexOf('within one frame'));
    expect(html).toContain('响度 -31.5 LUFS · 真峰值 -9.2 dBTP');
    expect(html).toContain(`<td>Singing costs extra.</td><td>Singing costs ${escaped}</td><td class="qa-warning">42%</td>`);
    expect(html).toContain('&lt;Subject 1&gt;');
    expect(html).toContain(`non_diegetic_music:\nN/A ${escaped}</pre>`);
    expect(html).toContain('data-production-retake-reason="character_drift"');
    for (const label of ['画面旋转或损坏', '人物不一致', '台词缺失或错误', '口型不对', '文字乱码', '其他']) expect(html).toContain(`<span>${label}</span>`);
    p.click('production-approve', {dataset: {id: 'j-c01-en', take: '1'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-jobs-v2/j-c01-en/approve', {take: 1}]);
  });

  test('a retake needs a reason and sends the reasons and the note', async () => {
    const {ctx} = fixture(), {p, calls} = harness(ctx);
    p.click('production-review', {dataset: {id: 'j-c01-en'}}, ctx);
    p.click('production-retake', {dataset: {id: 'j-c01-en'}}, ctx);
    expect(calls.failures).toEqual(['请至少选一个重拍原因。']);
    p.input(field({productionRetakeReason: 'lip_sync'}, 'on', true));
    p.input(field({productionRetakeReason: 'picture_broken'}, 'on', true));
    p.input(field({productionRetakeReason: 'other'}, 'on', true));
    p.input(field({productionRetakeReason: 'other'}, 'on', false));
    p.input(field({productionRetakeReason: 'made_up'}, 'on', true));
    p.input(field({productionRetakeNote: ''}, ' shot 1 is rotated '));
    expect(p.view(ctx)).toContain('data-production-retake-reason="lip_sync" checked');
    p.click('production-retake', {dataset: {id: 'j-c01-en'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-jobs-v2/j-c01-en/retake', {reasons: ['picture_broken', 'lip_sync'], note: 'shot 1 is rotated'}]);
    expect(p.view(ctx)).not.toContain('data-production-retake-reason="lip_sync" checked');
  });

  test('earlier takes keep their verdicts and stay approvable; rehearsal takes are labelled', () => {
    const {ctx} = fixture(), {p} = harness(ctx);
    p.click('production-review', {dataset: {id: 'j-c02-zh-CN'}}, ctx);
    let html = p.view(ctx);
    expect(html).toContain('这一条还在排队或渲染，完成后再决定。');
    expect(html).toContain('<h4>其他 take</h4>');
    expect(html).toContain(`<span class="pill changed">要求重拍</span><span class="small">画面旋转或损坏、口型不对 · rotated ${escaped}</span>`);
    expect(html).toContain('data-action="production-review-take" data-id="j-c02-zh-CN" data-take="1"');
    expect(html).toContain('data-action="production-approve" data-id="j-c02-zh-CN" data-take="1"');
    p.click('production-review-take', {dataset: {id: 'j-c02-zh-CN', take: '1'}}, ctx);
    html = p.view(ctx);
    expect(html).toContain('src="/api/media/vid-c02-zh-1"');
    expect(html).toContain('重拍只针对最新的一条 take。');
    const shared = ctx.bundle.renderJobsV2!.find(j => j.languages.length > 1)!;
    p.click('production-review', {dataset: {id: shared.id}}, ctx);
    html = p.view(ctx);
    expect(html).toContain('<span class="pill demo">演练</span>');
    expect(html).toContain('这一条已通过');
    p.click('production-review-close', {dataset: {}}, ctx);
    expect(p.view(ctx)).not.toContain('class="review-panel"');
  });

  test('a batch of an older shot list offers no session and no retake', () => {
    const {ctx} = fixture({live: false}), {p} = harness(ctx);
    ctx.episode.productionShotListId = 'v9';
    p.click('production-review', {dataset: {id: 'j-c01-en'}}, ctx);
    const html = p.view(ctx);
    expect(html).toContain('不是当前制作版本 · 不能再渲染或重拍');
    expect(html).toContain('这一批已不是当前制作版本，不能再开始渲染会话。');
    expect(html).toContain('这一批已不是当前制作版本，不能再重拍。');
    expect(html).not.toContain('data-action="production-start-session"');
    expect(html).not.toContain('data-action="production-create-batch"');
  });
});

describe('render sessions', () => {
  test('a new session shows its code once with the notebook steps; a new code replaces it and reset hides it', async () => {
    const {ctx} = fixture({live: false});
    const waiting = liveSession({status: 'waiting', events: [], startedAt: undefined, worker: undefined});
    delete waiting.startedAt; delete waiting.worker;
    const second = CODE.replace('QQQQ', 'RRRR');
    const {p, calls} = harness(ctx, path => {
      if (path === '/api/projects/p1/render-sessions') return {session: waiting, code: CODE, bundle: {...ctx.bundle, renderSessions: [...ctx.bundle.renderSessions!, waiting]}};
      if (path === '/api/render-sessions/s-live/code') return {session: waiting, code: second};
      return undefined;
    });
    let html = p.view(ctx);
    expect(html).toContain('待渲染 7 条 take');
    p.input(field({productionSessionMode: 'b2'}, 'rehearsal', true));
    p.input(field({productionSessionMode: 'b2'}, 'pull', true));
    p.input(field({productionSessionBudget: 'b2'}, '3'));
    p.click('production-start-session', {dataset: {id: 'b2'}}, ctx);
    expect(calls.failures.at(-1)).toContain('5–720');
    p.input(field({productionSessionBudget: 'b2'}, '40'));
    p.click('production-start-session', {dataset: {id: 'b2'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/render-sessions', {batchIds: ['b2'], mode: 'pull', budgetMinutes: 40}]);
    html = p.view(ctx);
    expect(count(html, CODE)).toBe(1);
    expect(html).toContain(`href="${SESSION_NOTEBOOK}"`);
    expect(html).toContain('选 G4');
    expect(html).toContain('运行笔记本里唯一的代码单元');
    expect(html).toContain('粘贴会话码');
    expect(html).toContain('data-action="production-copy-code"');
    expect(html).toContain('data-live="session-s-live-waiting"');
    expect(html).toContain('data-action="production-reissue-code" data-id="s-live"');
    expect(html).not.toContain('data-action="production-start-session"');
    p.click('production-reissue-code', {dataset: {id: 's-live'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-sessions/s-live/code', {}]);
    html = p.view(ctx);
    expect(count(html, second)).toBe(1);
    expect(html).not.toContain(CODE);
    p.reset();
    expect(p.view(ctx)).not.toContain('sciepo_ss_');
  });

  test('the code is copied through the hook and hidden once the worker connects', async () => {
    const {ctx} = fixture({live: false});
    const waiting = liveSession({status: 'waiting', events: []});
    delete waiting.startedAt;
    const copied: string[] = [];
    const {p, fire} = harness(ctx, path => {
      if (path === '/api/projects/p1/render-sessions') return {session: waiting, code: CODE, bundle: {...ctx.bundle, renderSessions: [...ctx.bundle.renderSessions!, waiting]}};
      if (path === '/api/render-sessions/s-live') return liveSession({status: 'connected', events: []});
      return undefined;
    }, {app: true, copy: async text => { copied.push(text); }});
    p.view(ctx);
    p.click('production-start-session', {dataset: {id: 'b2'}}, ctx);
    await flush();
    p.click('production-copy-code', {dataset: {}}, ctx);
    await flush();
    expect(copied).toEqual([CODE]);
    expect(p.view(ctx)).toContain('已复制 ✓');
    await fire();
    expect(p.view(ctx)).not.toContain(CODE);
  });

  test('a lost session still shows and can be stopped, but a new session can start beside it', () => {
    const {ctx} = fixture();
    ctx.bundle.renderSessions = [endedSession, liveSession({status: 'lost'})];
    const html = harness(ctx).p.view(ctx);
    expect(html).toContain('失去联系');
    expect(html).toContain('data-live="session-s-live-lost"');
    expect(html).toContain('data-action="production-stop" data-id="s-live" data-when="now"');
    expect(html).toContain('data-action="production-start-session" data-id="b2"');
  });

  test('a code that points at this computer says Colab cannot reach it', () => {
    expect(codeOnce('http://127.0.0.1:4317#sciepo_ss_x', 'pull', false)).toContain('Colab 连不上');
    expect(codeOnce(CODE, 'pull', false)).not.toContain('Colab 连不上');
    expect(codeOnce(CODE, 'rehearsal', false)).toContain('选 CPU');
  });

  test('stop, readings and the compute-unit rate call their routes with the right bodies', async () => {
    const {ctx} = fixture();
    const {p, calls} = harness(ctx, (path, body) => {
      if (path === '/api/render-sessions/s-live/stop') return liveSession({stopRequest: {when: (body as {when: 'now' | 'after_take'}).when, at: time}});
      if (path === '/api/render-sessions/s-old/readings') return {...endedSession, readings: body};
      return undefined;
    });
    p.view(ctx);
    p.click('production-stop', {dataset: {id: 's-live', when: 'after_take'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-sessions/s-live/stop', {when: 'after_take'}]);
    let html = p.view(ctx);
    expect(html).toContain('已请求这一条渲染完就停');
    expect(html).toMatch(/data-when="after_take" disabled/u);
    p.click('production-stop', {dataset: {id: 's-live', when: 'now'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-sessions/s-live/stop', {when: 'now'}]);
    p.input(field({productionReading: 'after', id: 's-old'}, '113.2'));
    p.click('production-save-readings', {dataset: {id: 's-old'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-sessions/s-old/readings', {before: 120.5, after: 113.2}]);
    html = p.view(ctx);
    expect(html).toContain('按 Colab 的读数，这次用掉 7.3 个计算单元。');
    p.input(field({productionReading: 'before', id: 's-old'}, '-1'));
    p.click('production-save-readings', {dataset: {id: 's-old'}}, ctx);
    expect(calls.failures.at(-1)).toContain('非负数');
    p.input(field({productionRate: ''}, '9.5'));
    p.click('production-save-rate', {dataset: {}}, ctx);
    await flush();
    expect(calls.apis.at(-1)).toEqual(['/api/projects/p1/production-settings', {method: 'PUT', body: JSON.stringify({computeUnitsPerHour: 9.5})}]);
    p.input(field({productionRate: ''}, ''));
    p.click('production-save-rate', {dataset: {}}, ctx);
    await flush();
    expect(calls.apis.at(-1)).toEqual(['/api/projects/p1/production-settings', {method: 'PUT', body: JSON.stringify({computeUnitsPerHour: null})}]);
  });

  test('polling reads the session and the bundle every five seconds without stacking, and stops when the session ends', async () => {
    const {ctx} = fixture();
    const answers = [liveSession({events: [...liveSession().events, {at: '2026-11-12T08:12:20.000Z', stage: 'take_done', message: 'ep01-c01-zh-CN.mp4 · take 1 · 完成'}]}),
      {...liveSession(), status: 'ended' as const, end: 'queue_empty' as const, endedAt: '2026-11-12T08:13:00.000Z', summary: {minutes: 13, computeUnits: 2.18, takesRendered: 3, takesFailed: 0, undelivered: 0}}];
    const {p, calls, timers, fire} = harness(ctx, path => path === '/api/render-sessions/s-live' ? answers.shift() : undefined, {app: true});
    p.view(ctx);
    p.view(ctx);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(0);
    await fire();
    const polled = () => calls.apis.filter(([path]) => path !== '/api/worker-tokens').map(([path]) => path);
    expect(polled()).toEqual(['/api/render-sessions/s-live', '/api/projects/p1']);
    expect(calls.bundles).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(POLL_MS);
    p.view(ctx);
    expect(timers).toHaveLength(1);
    expect(p.view(ctx)).toContain('ep01-c01-zh-CN.mp4 · take 1 · 完成');
    await fire();
    expect(polled()).toHaveLength(4);
    expect(timers).toHaveLength(0);
    expect(p.pollingScheduled).toBe(false);
    const html = p.view(ctx);
    expect(timers).toHaveLength(0);
    expect(html).toContain('待渲染的 take 都处理完了');
    expect(html).toContain('约 2.18 个计算单元');
    expect(html).not.toContain('data-live="session-s-live');
    expect(html).toContain('data-action="production-start-session"');
    expect(polled()).toHaveLength(4);
  });

  test('reset clears a waiting timer and drops an answer that arrives after it', async () => {
    const {ctx} = fixture();
    let release: (value: unknown) => void = () => {};
    const {p, calls, timers, fire} = harness(ctx, path => path === '/api/render-sessions/s-live' ? new Promise(resolve => { release = resolve; }) : undefined, {app: true});
    p.view(ctx);
    expect(timers).toHaveLength(1);
    p.reset();
    expect(timers).toHaveLength(0);
    p.view(ctx);
    await fire();
    p.reset();
    release({...liveSession(), status: 'ended'});
    await flush();
    expect(calls.bundles).toBe(0);
    expect(timers).toHaveLength(0);
  });
});

describe('cast, uploads and the batch form', () => {
  test('uploads go to the media store and link the new asset; the switch and remove use the cast route', async () => {
    const {ctx} = fixture(), {p, calls} = harness(ctx);
    p.view(ctx);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'leo.png', {type: 'image/png'});
    p.change({dataset: {productionUpload: 'portrait', character: 'LEO'}, files: [file], value: '', id: ''} as unknown as HTMLInputElement, ctx);
    await flush();
    expect(calls.uploads).toEqual([['/api/projects/p1/media?kind=reference_image&label=LEO%20%C2%B7%20leo.png', file]]);
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/cast', {name: 'LEO', portraitAssetId: 'new-asset'}]);
    const sample = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'maya.wav', {type: 'audio/wav'});
    p.change({dataset: {productionUpload: 'voice', character: 'MAYA'}, files: [sample], value: '', id: ''} as unknown as HTMLInputElement, ctx);
    await flush();
    expect(calls.uploads.at(-1)![0]).toBe('/api/projects/p1/media?kind=voice_sample&label=MAYA%20%C2%B7%20maya.wav');
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/cast', {name: 'MAYA', voiceSampleAssetId: 'new-asset'}]);
    const huge = {name: 'big.png', size: 9 * 1024 * 1024, type: 'image/png'} as File;
    p.change({dataset: {productionUpload: 'portrait', character: 'MAYA'}, files: [huge], value: '', id: ''} as unknown as HTMLInputElement, ctx);
    expect(calls.failures.at(-1)).toBe('参考图不能超过 8.0 MB。');
    expect(calls.uploads).toHaveLength(2);
    p.change(field({productionUsePortrait: 'MAYA'}, 'on', false), ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/cast', {name: 'MAYA', usePortrait: false}]);
    p.click('production-unlink', {dataset: {id: 'MAYA', kind: 'portrait'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/cast', {name: 'MAYA', portraitAssetId: null}]);
    p.click('production-unlink', {dataset: {id: 'MAYA', kind: 'voice'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/projects/p1/cast', {name: 'MAYA', voiceSampleAssetId: null}]);
  });

  test('saving the profile leaves the references to the cast route', async () => {
    const {ctx} = fixture(), {p, calls} = harness(ctx);
    p.view(ctx);
    p.input(field({productionCharacter: '0', field: 'appearance'}, 'a rider in a yellow jacket, no hood'));
    p.click('production-save-profile', {dataset: {}}, ctx);
    await flush();
    const [path, init] = calls.apis.at(-1)!;
    expect(path).toBe('/api/projects/p1/production');
    const saved = JSON.parse(String(init!.body)) as ProductionProfile;
    expect(saved.characters[0]).toEqual({name: 'MAYA', appearance: 'a rider in a yellow jacket, no hood', voice: 'a dry, low female voice'});
  });

  test('the batch form sends the size, steps, turbo switch, music mode, clip limit and languages', async () => {
    const {ctx} = fixture(), {p, calls} = harness(ctx);
    let html = p.view(ctx);
    expect(html).toContain('<option value="480x864" selected>480×864 · 省算力</option><option value="768x1344" >768×1344 · H3 原生尺寸</option>');
    expect(html).toContain('<option value="bed" selected>整集配乐（bed）</option>');
    expect(html).toContain('剪辑时铺一条连续的配乐');
    expect(html).toContain('id="prod-steps" class="small-input" type="number" min="1" max="60" step="1" value="20"');
    p.click('production-create-batch', {dataset: {id: 'v1'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/shot-lists/v1/render-batches', {size: '480x864', steps: 20, turbo: false, musicMode: 'bed', clipLimitSeconds: 15}]);
    p.input(field({productionBatch: 'size'}, '768x1344'));
    p.input(field({productionBatch: 'musicMode'}, 'native'));
    p.input(field({productionBatch: 'steps'}, '24'));
    p.input(field({productionBatch: 'turbo'}, 'on', true));
    p.change(field({productionLanguage: 'zh-CN'}, 'on', false), ctx);
    html = p.view(ctx);
    expect(html).toContain('<option value="768x1344" selected>');
    p.click('production-create-batch', {dataset: {id: 'v1'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/shot-lists/v1/render-batches', {size: '768x1344', steps: 24, turbo: true, musicMode: 'native', clipLimitSeconds: 15, languages: ['en']}]);
    p.input(field({productionBatch: 'steps'}, '0'));
    p.click('production-create-batch', {dataset: {id: 'v1'}}, ctx);
    expect(calls.failures.at(-1)).toBe('采样步数需为 1–60 的整数。');
  });

  test('a 16:9 shot list offers the 16:9 sizes', () => {
    const {ctx} = fixture();
    ctx.bundle.shotLists![0]!.aspectRatio = '16:9';
    const html = harness(ctx).p.view(ctx);
    expect(html).toContain('<option value="864x480" selected>864×480 · 省算力</option><option value="1344x768" >1344×768 · H3 原生尺寸</option>');
  });
});

describe('cuts in the production tab', () => {
  const cut = (overrides: Partial<import('../src/types').Cut> = {}): import('../src/types').Cut => ({id: 'cut-zh', batchId: 'b2', projectId: 'p1', language: 'zh-CN', kind: 'draft', clips: [], captions: [{shotId: 'sh1', start: 1, end: 3, text: `备注 ${attack}`, enabled: true}],
    settings: {musicAssetId: null, musicLevelDb: -20, dialogueLufs: -16, ambienceLufs: -22, maxGainDb: 9, targetLufs: -14, truePeakDb: -1, fadeMs: 20, size: 'native'},
    status: 'done', output: {assetId: 'cutvid', sha256: SHA_A, bytes: 16_000_000, seconds: 79.2, loudness: -14, truePeak: -1.3}, warnings: [`没有字体 ${attack}`], createdAt: time, updatedAt: time, ...overrides});

  test('a done draft plays from the media store, warnings are escaped, and a final form waits for approved takes', () => {
    const {ctx} = fixture({live: false});
    ctx.bundle.cuts = [cut()];
    const html = harness(ctx).p.view(ctx);
    expect(html).toContain('<section class="cut-area"><h3>成片</h3>');
    expect(html).toContain('<video controls playsinline preload="metadata" src="/api/media/cutvid"');
    expect(html).toContain('79.2 秒 · 响度 -14 LUFS · 真峰值 -1.3 dBTP');
    expect(html).toContain(`没有字体 ${escaped}`);
    expect(html).not.toContain(attack);
    expect(html).toContain('每个片段都通过一条 take 后，才能剪正式成片');
    expect(html).toContain('href="/api/cuts/cut-zh/report"');
    expect(html).toContain('data-production-music-upload');
  });

  test('the final-cut form reads the plan, keeps edits, and sends music, size and captions', async () => {
    const {ctx, jobs} = fixture({live: false});
    for (const job of jobs) { job.takes = [{n: 1, seed: 1, status: 'rendered', video: {assetId: `v-${job.id}`, sha256: SHA_B, bytes: 10, seconds: 12}}]; job.approvedTake = 1; }
    ctx.bundle.media!.push({id: 'bed', projectId: 'p1', kind: 'music', contentType: 'audio/flac', bytes: 5000, sha256: SHA_B, origin: 'owner', label: `Night bed ${attack}`, license: 'CC BY 4.0', createdAt: time});
    const plan = {captions: [{shotId: 'sh1', start: 1, end: 3, text: '订单备注', enabled: true}], missing: [], seconds: 72, pictureLanguage: 'en', musicRequired: true,
      settings: {musicAssetId: null, musicLevelDb: -20, dialogueLufs: -16, ambienceLufs: -22, maxGainDb: 9, targetLufs: -14, truePeakDb: -1, fadeMs: 20, size: 'native'}, sizes: ['native', '720x1280', '1080x1920'], ffmpeg: {found: true}};
    const {p, calls} = harness(ctx, path => path.includes('/cut-plan') ? plan : path.endsWith('/cuts') ? {cut: cut({kind: 'final', status: 'queued'}), bundle: ctx.bundle} : undefined);
    expect(p.view(ctx)).toContain('data-action="production-cut-open" data-id="b2" data-language="zh-CN"');
    p.click('production-cut-open', {dataset: {id: 'b2', language: 'zh-CN'}}, ctx);
    await flush();
    expect(calls.apis.at(-1)![0]).toBe('/api/render-batches/b2/cut-plan?language=zh-CN&kind=final');
    let html = p.view(ctx);
    expect(html).toContain('<legend>正式成片 · 简体中文</legend>');
    expect(html).toContain('请选择配乐…');
    expect(html).toContain(`Night bed ${escaped} · CC BY 4.0`);
    p.click('production-cut-create', {dataset: {id: 'b2', language: 'zh-CN'}}, ctx);
    expect(calls.failures.at(-1)).toContain('请选一条配乐');
    const key = {cutKey: 'b2:zh-CN'};
    p.input(field({productionCutField: 'music', ...key}, 'bed'));
    p.input(field({productionCutField: 'musicLevel', ...key}, '-18'));
    p.input(field({productionCutField: 'size', ...key}, '720x1280'));
    p.input(field({productionCaption: 'text', ...key, index: '0'}, '订单备注：敲门三次'));
    p.input(field({productionCaption: 'end', ...key, index: '0'}, '4.5'));
    html = p.view(ctx);
    expect(html).toContain('<option value="bed" selected>');
    expect(html).toContain('订单备注：敲门三次');
    p.click('production-cut-create', {dataset: {id: 'b2', language: 'zh-CN'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-batches/b2/cuts', {language: 'zh-CN', kind: 'final', settings: {size: '720x1280', musicAssetId: 'bed', musicLevelDb: -18}, captions: [{shotId: 'sh1', start: 1, end: 4.5, text: '订单备注：敲门三次', enabled: true}]}]);
    expect(p.view(ctx)).not.toContain('<legend>正式成片');
  });

  test('sign-off needs a note to reject, rehearsal cuts cannot be signed, and a queued cut keeps polling', async () => {
    const {ctx} = fixture({live: false});
    ctx.bundle.cuts = [cut({id: 'final-zh', kind: 'final'})];
    const {p, calls, timers} = harness(ctx, path => path.includes('/sign-off') ? {cut: cut({id: 'final-zh', kind: 'final'}), bundle: ctx.bundle} : undefined);
    let html = p.view(ctx);
    expect(html).toContain('data-action="production-cut-signoff" data-id="final-zh" data-decision="signed_off"');
    p.click('production-cut-signoff', {dataset: {id: 'final-zh', decision: 'rejected'}}, ctx);
    expect(calls.failures.at(-1)).toBe('驳回时请写明原因。');
    p.input(field({productionCutNote: 'final-zh'}, '字幕太快'));
    p.click('production-cut-signoff', {dataset: {id: 'final-zh', decision: 'rejected'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/cuts/final-zh/sign-off', {decision: 'rejected', note: '字幕太快'}]);
    ctx.bundle.cuts = [cut({id: 'final-zh', kind: 'final', rehearsal: true})];
    html = p.view(ctx);
    expect(html).toContain('演练成片用的是占位画面，不能签收或交付。');
    expect(html).not.toContain('data-decision="signed_off"');
    expect(timers).toHaveLength(0);
    ctx.bundle.cuts = [cut({status: 'running', output: undefined})];
    p.view(ctx);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBeLessThanOrEqual(POLL_MS);
  });

  test('music uploads carry the license note in the query', async () => {
    const {ctx} = fixture({live: false});
    ctx.bundle.cuts = [cut()];
    const {p, calls} = harness(ctx);
    p.input(field({productionMusicLicense: ''}, 'CC BY 4.0, Jane'));
    const file = new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43])], 'bed.flac');
    p.change({dataset: {productionMusicUpload: ''}, files: [file], value: ''} as unknown as HTMLInputElement, ctx);
    await flush();
    expect(calls.uploads.at(-1)![0]).toBe('/api/projects/p1/media?kind=music&label=bed.flac&license=CC%20BY%204.0%2C%20Jane');
  });
});
