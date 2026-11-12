/** Cuts on the Sci-epo host: plans, the queue and its ffmpeg runner, automatic drafts, sign-off, the delivery report,
 * and the delivered cut of each language for the publication manifest. ffmpeg always gets an argument array, never a
 * shell, and caption text reaches it only through text files in the cut's work folder. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { Caption, Cut, CutSettings, CutSize, Episode, MediaAsset, Project, RenderBatch, RenderJobV2, Revision, ShotList } from '../types';
import { CAPTION_MAX_TEXT, CUT_SETTING_RANGES, CUT_SIZES, DEFAULT_CUT_SETTINGS, aspectOf, audioProbeArguments, captionFiles, cutArguments, cutCurrent, cutDimensions, cutPlan, durationProbeArguments, fontFilterValue, loudnessArguments, parseEbur128, parseLoudnorm, sameTakes, type CutNumberSetting, type CutPlan } from '../core/cut';
import { cutReport } from '../core/cutReport';
import { languageName, scriptLanguage } from '../core/languages';
import { shotListStatus } from '../core/shotList';
import type { MediaStore } from './media';
import type { Store } from './store';

type Fail = (status: number, message: string) => never;
type Body = Record<string, unknown>;
export interface SpawnResult { code: number; stdout: string; stderr: string }
/** Runs one program with an argument array in a working folder. Tests replace it. */
export type Spawner = (cmd: string[], options: {cwd: string; timeoutMs: number}) => Promise<SpawnResult>;
export interface CutTools { ffmpeg: string; ffprobe: string }
export interface CutsOptions {
  clock?: () => Date; spawn?: Spawner;
  /** ffmpeg and ffprobe, or null when they are missing. Defaults to SCIEPO_FFMPEG/SCIEPO_FFPROBE, then PATH. */
  tools?: () => CutTools | null;
  /** The caption font file, or null. Defaults to SCIEPO_CAPTION_FONT, then common locations. */
  font?: () => string | null;
  /** Parent folder of the temporary work folders. */
  workRoot?: string;
}

export const FFMPEG_HINT = '这台电脑上找不到 ffmpeg，Sci-epo 不能剪辑成片。请在运行 Sci-epo 的电脑上安装 ffmpeg（Windows：winget install Gyan.FFmpeg；macOS：brew install ffmpeg；Debian 或 Ubuntu：sudo apt install ffmpeg），然后重启 Sci-epo；也可以用环境变量 SCIEPO_FFMPEG 和 SCIEPO_FFPROBE 写明两个程序的路径。';
const NO_FONT = '找不到能显示中文的字体，这一版没有画面文字字幕。请安装 Noto Sans CJK，或用环境变量 SCIEPO_CAPTION_FONT 写明字体文件的路径。';
const TOKEN_TEXT = /sciepo_(?:ss|wk)_[A-Za-z0-9_-]{20,}/gu;
const SETTING_LABELS: Record<CutNumberSetting, string> = {musicLevelDb: '配乐音量', dialogueLufs: '有对白片段的目标响度', ambienceLufs: '无对白片段的目标响度', maxGainDb: '片段增益上限', targetLufs: '整片目标响度', truePeakDb: '真峰值上限', fadeMs: '片段淡入淡出'};
const FONT_CANDIDATES: Record<string, string[]> = {
  win32: ['msyh.ttc', 'msyh.ttf', 'simhei.ttf', 'Deng.ttf', 'simsun.ttc'],
  darwin: ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/Library/Fonts/Arial Unicode.ttf'],
  linux: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'],
};
class CutError extends Error {}

const scrub = (text: string, max = 600) => text.replace(TOKEN_TEXT, '[token]').slice(-max).trim();
/** The last lines of a program's error output, which say what went wrong. */
const tail = (stderr: string, max = 600) => scrub(stderr.trim().split(/\r?\n/u).filter(line => line.trim()).slice(-6).join(' | '), max) || '没有错误输出。';
const obj = (value: unknown): Body => value && typeof value === 'object' && !Array.isArray(value) ? value as Body : {};
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** The program by an explicit setting (a path or a name on PATH), or by its name on PATH. */
function program(setting: string | undefined, name: string, sibling?: string): string | null {
  if (setting) return /[\\/]/u.test(setting) ? existsSync(setting) ? setting : null : Bun.which(setting);
  if (sibling) {
    const next = join(dirname(sibling), basename(sibling).replace(/ffmpeg/iu, name));
    if (next !== sibling && existsSync(next)) return next;
  }
  return Bun.which(name);
}
export function findTools(env: Record<string, string | undefined> = process.env): CutTools | null {
  const ffmpeg = program(env.SCIEPO_FFMPEG, 'ffmpeg');
  const ffprobe = ffmpeg ? program(env.SCIEPO_FFPROBE, 'ffprobe', ffmpeg) : null;
  return ffmpeg && ffprobe ? {ffmpeg, ffprobe} : null;
}
export function findCaptionFont(env: Record<string, string | undefined> = process.env, platform = process.platform): string | null {
  if (env.SCIEPO_CAPTION_FONT && existsSync(env.SCIEPO_CAPTION_FONT)) return env.SCIEPO_CAPTION_FONT;
  const candidates = platform === 'win32' ? FONT_CANDIDATES.win32!.map(name => join(env.WINDIR ?? 'C:\\Windows', 'Fonts', name)) : FONT_CANDIDATES[platform] ?? FONT_CANDIDATES.linux!;
  return candidates.find(path => existsSync(path)) ?? null;
}
export const spawnProcess: Spawner = async (cmd, {cwd, timeoutMs}) => {
  const proc = Bun.spawn(cmd, {cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return {code, stdout, stderr};
  } finally { clearTimeout(timer); }
};
async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256'), reader = Bun.file(path).stream().getReader();
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return hash.digest('hex');
    hash.update(value);
  }
}

/** `current`: the batch's shot list is the adopted production version of the episode's unchanged accepted script. */
interface BatchContext { batch: RenderBatch; episode: Episode; project: Project; list: ShotList; revision: Revision; jobs: RenderJobV2[]; current: boolean }

export class Cuts {
  private loop: Promise<void> | null = null;
  private wanted = false;
  private readonly clock: () => Date;
  private readonly spawn: Spawner;
  constructor(private store: Store, private media: MediaStore, private fail: Fail, private id: () => string, private options: CutsOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.spawn = options.spawn ?? spawnProcess;
    this.recover();
  }
  private now() { return this.clock().toISOString(); }
  tools(): CutTools | null { return (this.options.tools ?? findTools)(); }
  private font(): string | null { return (this.options.font ?? findCaptionFont)(); }

  // ------------------------------------------------------------------ owner routes

  get(a: string | undefined, target: string | undefined, action: string | undefined, url: URL): unknown | undefined {
    if (a === 'render-batches' && target && action === 'cut-plan') return this.planView(target, url.searchParams);
    if (a === 'cuts' && target && action === 'report') {
      const cut = this.store.get('cuts', target) ?? this.fail(404, '找不到成片。');
      return new Response(this.report(cut), {headers: {'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="sci-epo-cut-${cut.id}.md"`}});
    }
    if (a === 'cuts' && target && !action) {
      const cut = this.store.get('cuts', target) ?? this.fail(404, '找不到成片。');
      return {...cut, current: cutCurrent(cut, this.jobs(cut.batchId))};
    }
    return undefined;
  }

  async post(method: string, a: string | undefined, target: string | undefined, action: string | undefined, body: Body): Promise<unknown | undefined> {
    if (method !== 'POST') return undefined;
    if (a === 'render-batches' && target && action === 'cuts') return this.create(target, body);
    if (a === 'cuts' && target && action === 'sign-off') return this.signOff(target, body);
    return undefined;
  }

  private jobs(batchId: string): RenderJobV2[] { return this.store.all('render_jobs_v2').filter(j => j.batchId === batchId); }
  private context(batchId: string): BatchContext {
    const batch = this.store.get('render_batches', batchId) ?? this.fail(404, '找不到渲染批次。');
    if (batch.version !== 2) this.fail(409, '旧版批次不能剪辑成片；请用渲染会话渲染的新批次。');
    const episode = this.store.get('episodes', batch.episodeId) ?? this.fail(404, '找不到集数。');
    const project = this.store.get('projects', episode.projectId) ?? this.fail(404, '找不到系列。');
    const list = this.store.get('shot_lists', batch.shotListId) ?? this.fail(404, '找不到分镜表。');
    const revision = this.store.get('revisions', batch.sourceRevisionId) ?? this.fail(404, '找不到剧本版本。');
    return {batch, episode, project, list, revision, jobs: this.jobs(batch.id), current: shotListStatus(list, episode).current};
  }
  private plan(ctx: BatchContext, language: string, kind: Cut['kind'], settings?: CutSettings): CutPlan {
    return cutPlan({batch: ctx.batch, jobs: ctx.jobs, list: ctx.list, revision: ctx.revision, localizations: this.store.all('localizations'), language, kind, ...(settings ? {settings} : {})});
  }
  private language(batch: RenderBatch, value: unknown): string {
    return typeof value === 'string' && batch.languages.includes(value) ? value : this.fail(400, `成片语言需为这一批的配音语言：${batch.languages.join('、')}。`);
  }
  private kind(value: unknown): Cut['kind'] {
    return value === 'final' ? 'final' : value === undefined || value === null || value === 'draft' ? 'draft' : this.fail(400, '成片类型只能是草稿（draft）或正式成片（final）。');
  }
  private sizes(batch: RenderBatch): CutSize[] { return ['native', ...CUT_SIZES[aspectOf(batch)]]; }

  /** What a cut of this language and kind would use, with default captions and settings, before it is made. */
  private planView(batchId: string, params: URLSearchParams) {
    const ctx = this.context(batchId), language = this.language(ctx.batch, params.get('language')), kind = this.kind(params.get('kind') ?? undefined);
    return {...this.plan(ctx, language, kind), settings: {...DEFAULT_CUT_SETTINGS}, sizes: this.sizes(ctx.batch),
      musicRequired: kind === 'final' && ctx.batch.musicMode !== 'native', ffmpeg: this.tools() ? {found: true} : {found: false, hint: FFMPEG_HINT}};
  }

  private create(batchId: string, body: Body) {
    const ctx = this.context(batchId), language = this.language(ctx.batch, body.language), kind = this.kind(body.kind);
    const settings = this.settings(ctx, body.settings, kind);
    const plan = this.plan(ctx, language, kind, settings);
    const captions = body.captions === undefined ? plan.captions : this.captions(ctx, body.captions, plan.seconds);
    if (kind === 'final' && !ctx.current) this.fail(409, '这一批已不是当前制作版本，不能剪正式成片。请用当前分镜表的批次。');
    if (!this.tools()) this.fail(503, FFMPEG_HINT);
    if (plan.missing.length) this.fail(409, kind === 'final'
      ? `还有片段没有通过的 take：${plan.missing.join('、')}。每个片段都通过一条 take 后才能剪正式成片。`
      : `还有片段没有渲染好的 take：${plan.missing.join('、')}。`);
    const cut = this.queue(ctx, language, kind, plan, settings, captions);
    return {cut, bundle: this.store.bundle(ctx.project.id)};
  }

  /** Defaults with the given values, each checked against its range; music from this series' media store. */
  private settings(ctx: BatchContext, value: unknown, kind: Cut['kind']): CutSettings {
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) this.fail(400, '成片设置格式无效。');
    const input = obj(value), settings: CutSettings = {...DEFAULT_CUT_SETTINGS};
    for (const key of Object.keys(CUT_SETTING_RANGES) as CutNumberSetting[]) {
      const v = input[key], [min, max] = CUT_SETTING_RANGES[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) this.fail(400, `${SETTING_LABELS[key]}需为 ${min} 到 ${max} 之间的数字。`);
      settings[key] = v as number;
    }
    if (input.size !== undefined) {
      const sizes = this.sizes(ctx.batch);
      if (!sizes.includes(input.size as CutSize)) this.fail(400, `输出尺寸只能是 ${sizes.join('、')}。`);
      settings.size = input.size as CutSize;
    }
    if (input.noMusic !== undefined && typeof input.noMusic !== 'boolean') this.fail(400, '“不加配乐”需为是或否。');
    if (input.musicAssetId !== undefined && input.musicAssetId !== null) {
      const asset = typeof input.musicAssetId === 'string' ? this.store.get('media_assets', input.musicAssetId) : undefined;
      if (!asset || asset.projectId !== ctx.project.id || asset.kind !== 'music') this.fail(400, '配乐不在这个系列的媒体库里。');
      if (input.noMusic === true) this.fail(400, '选了配乐，就不能同时选“不加配乐”。');
      settings.musicAssetId = asset!.id;
    }
    if (input.noMusic === true) settings.noMusic = true;
    if (kind === 'final' && ctx.batch.musicMode !== 'native' && !settings.musicAssetId && !settings.noMusic) this.fail(400, '这一批用整集配乐：正式成片要选一条配乐，或明确选择不加配乐。');
    return settings;
  }

  /** Captions only for shots of this batch, one per shot, inside the cut, with at most 300 characters each. */
  private captions(ctx: BatchContext, value: unknown, seconds: number): Caption[] {
    if (!Array.isArray(value) || value.length > 400) return this.fail(400, '字幕需为不超过 400 条的列表。');
    const shots = new Set(ctx.batch.clips.flatMap(c => c.shotIds)), seen = new Set<string>();
    return value.map((item, index): Caption => {
      const c = obj(item);
      const shotId = typeof c.shotId === 'string' && shots.has(c.shotId) ? c.shotId : this.fail(400, `第 ${index + 1} 条字幕的镜头不在这一批里。`);
      if (seen.has(shotId)) this.fail(400, `镜头 ${shotId} 有两条字幕。`);
      seen.add(shotId);
      const {start, end} = c;
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > seconds + 0.5) {
        this.fail(400, `镜头 ${shotId} 的字幕时间需在 0 到 ${seconds} 秒之间，并且结束晚于开始。`);
      }
      if (typeof c.text !== 'string' || [...c.text].length > CAPTION_MAX_TEXT) this.fail(400, `镜头 ${shotId} 的字幕需为 ${CAPTION_MAX_TEXT} 字以内的文字。`);
      if (typeof c.enabled !== 'boolean') this.fail(400, `镜头 ${shotId} 的字幕要写明是否显示。`);
      const text = (c.text as string).replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ').replace(CONTROL, '').trim();
      if (c.enabled && !text) this.fail(400, `镜头 ${shotId} 的字幕是空的；不想显示的话，请把它关掉。`);
      return {shotId, start: round3(start as number), end: round3(Math.min(end as number, seconds)), text, enabled: c.enabled as boolean};
    }).sort((a, b) => a.start - b.start);
  }

  /** Queue a cut. A newer draft replaces a draft of the same language that has not started. */
  private queue(ctx: BatchContext, language: string, kind: Cut['kind'], plan: CutPlan, settings: CutSettings, captions: Caption[]): Cut {
    const at = this.now(), fields = {clips: plan.clips, settings, captions, ...(plan.rehearsal ? {rehearsal: true} : {})};
    const waiting = kind === 'draft' ? this.store.all('cuts').find(c => c.batchId === ctx.batch.id && c.language === language && c.kind === 'draft' && c.status === 'queued') : undefined;
    let cut: Cut;
    if (waiting) {
      const {rehearsal: _r, warnings: _w, error: _e, ...rest} = waiting;
      cut = {...rest, ...fields, updatedAt: at};
      this.store.update('cuts', cut);
    } else {
      cut = {id: this.id(), batchId: ctx.batch.id, projectId: ctx.project.id, language, kind, ...fields, status: 'queued', createdAt: at, updatedAt: at};
      this.store.insert('cuts', cut);
    }
    this.kick();
    return cut;
  }

  /** After a take is rendered: a draft for every language of its job whose clips now all have a rendered take,
   * unless a draft with exactly these takes exists. */
  takeRendered(jobId: string): void {
    const job = this.store.get('render_jobs_v2', jobId), batch = job ? this.store.get('render_batches', job.batchId) : undefined;
    if (!job || batch?.version !== 2) return;
    const ctx = this.context(batch.id);
    for (const language of job.languages) {
      const plan = this.plan(ctx, language, 'draft');
      if (plan.missing.length) continue;
      if (this.store.all('cuts').some(c => c.batchId === batch.id && c.language === language && c.kind === 'draft' && sameTakes(c.clips, plan.clips))) continue;
      this.queue(ctx, language, 'draft', plan, {...DEFAULT_CUT_SETTINGS}, plan.captions);
    }
  }

  private async signOff(id: string, body: Body) {
    const cut = this.store.get('cuts', id) ?? this.fail(404, '找不到成片。');
    const decision = body.decision === 'signed_off' || body.decision === 'rejected' ? body.decision : this.fail(400, '结论只能是签收（signed_off）或驳回（rejected）。');
    if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 1000)) this.fail(400, '说明需为 1000 字以内的文字。');
    const note = typeof body.note === 'string' ? body.note.replace(CONTROL, '').trim() : '';
    if (cut.kind !== 'final') this.fail(409, '只有正式成片才能签收或驳回；草稿只用来预览。');
    if (cut.status !== 'done' || !cut.output) this.fail(409, '这个成片还没有剪好。');
    if (cut.rehearsal) this.fail(409, '演练成片用的是占位画面，不能签收或交付。');
    if (decision === 'rejected' && !note) this.fail(400, '驳回时请写明原因。');
    if (decision === 'signed_off' && !cutCurrent(cut, this.jobs(cut.batchId))) this.fail(409, '这个成片用的 take 已不是通过的那一条，它不是当前版本。请重新剪辑正式成片后再签收。');
    if (decision === 'signed_off' && !this.context(cut.batchId).current) this.fail(409, '这个成片所在的批次已不是当前制作版本，不能签收。');
    const at = this.now();
    let next: Cut = {...cut, signOff: {decision, ...(note ? {note} : {}), at}, updatedAt: at};
    if (decision === 'signed_off') {
      // The report is stored as it was at the sign-off, so the delivery keeps its record.
      const asset = await this.media.ingest(cut.projectId, 'report', new Blob([this.report(next)]).stream(), {origin: 'sciepo', label: `成片报告 · ${languageName(cut.language)} · ${cut.id}`});
      next = {...next, signOff: {...next.signOff!, reportAssetId: asset.id}};
    }
    this.store.update('cuts', next);
    return {cut: next, bundle: this.store.bundle(cut.projectId)};
  }

  private report(cut: Cut): string {
    const ctx = this.context(cut.batchId), adaptationId = ctx.batch.adaptations[cut.language];
    const adaptation = adaptationId ? this.store.get('localizations', adaptationId) : undefined;
    const sessions = this.store.all('render_sessions').filter(s => s.batchIds.includes(cut.batchId)).map(({tokenHash: _hash, ...s}) => s);
    const rate = ctx.project.productionSettings?.computeUnitsPerHour;
    return cutReport({cut, current: cutCurrent(cut, ctx.jobs), generatedAt: this.now(),
      project: {title: ctx.project.title, ...(rate !== undefined ? {computeUnitsPerHour: rate} : {})}, episode: ctx.episode,
      revision: {id: ctx.revision.id, title: ctx.revision.title, createdAt: ctx.revision.createdAt, accepted: ctx.episode.acceptedRevisionId === ctx.revision.id && !ctx.episode.needsReview, language: scriptLanguage(ctx.revision)},
      ...(adaptation ? {adaptation} : {}), list: ctx.list, batch: ctx.batch, jobs: ctx.jobs, sessions, media: this.store.all('media_assets').filter(m => m.projectId === cut.projectId)});
  }

  /** The newest signed-off final cut of a v2 batch made from this revision in this language, while its takes are still the approved ones. */
  delivered(revisionId: string, language: string): Cut | undefined {
    // Only a batch of the current production version delivers: a cut of an older shot list is history.
    const batches = new Set(this.store.all('render_batches').filter(b => b.version === 2 && b.sourceRevisionId === revisionId && this.context(b.id).current).map(b => b.id));
    return this.store.all('cuts')
      .filter(c => batches.has(c.batchId) && c.language === language && c.kind === 'final' && c.status === 'done' && !!c.output && !c.rehearsal && c.signOff?.decision === 'signed_off' && cutCurrent(c, this.jobs(c.batchId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** Why a media file must stay because of a cut, or undefined. */
  mediaInUse(asset: MediaAsset): string | undefined {
    for (const cut of this.store.all('cuts')) {
      if ((cut.status === 'queued' || cut.status === 'running') && (cut.settings.musicAssetId === asset.id || cut.clips.some(c => c.assetId === asset.id))) return '一个正在排队或剪辑的成片要用它。';
      if (cut.signOff?.decision === 'signed_off' && (cut.output?.assetId === asset.id || cut.settings.musicAssetId === asset.id)) return '它属于一个已签收的成片。';
      if (cut.signOff?.reportAssetId === asset.id) return '它是一个已签收成片的交付报告。';
    }
    return undefined;
  }

  // ------------------------------------------------------------------ runner

  /** Cuts that were running when the server stopped go back to the queue. */
  private recover(): void {
    for (const cut of this.store.all('cuts')) if (cut.status === 'running') this.store.update('cuts', {...cut, status: 'queued', updatedAt: this.now()});
    if (this.store.all('cuts').some(c => c.status === 'queued')) this.kick();
  }

  /** Start the runner unless it is running; it takes queued cuts one at a time, oldest first. */
  kick(): void {
    this.wanted = true;
    if (this.loop) return;
    this.loop = (async () => {
      while (this.wanted) {
        this.wanted = false;
        for (let cut = this.next(); cut; cut = this.next()) await this.process(cut);
      }
    })().catch(() => { this.wanted = false; }).finally(() => { this.loop = null; if (this.wanted) this.kick(); });
  }
  private next(): Cut | undefined { return this.store.all('cuts').find(c => c.status === 'queued'); }
  /** Resolves when no cut is running and none is waiting. */
  async idle(): Promise<void> { while (this.loop) await this.loop; }

  private async process(queued: Cut): Promise<void> {
    const startedAt = this.now(), {error: _error, warnings: _warnings, ...rest} = queued;
    const running: Cut = {...rest, status: 'running', startedAt, updatedAt: startedAt};
    this.store.update('cuts', running);
    let finished: Partial<Cut>;
    try {
      const {output, warnings} = await this.render(running);
      finished = {status: 'done', output, ...(warnings.length ? {warnings} : {})};
    } catch (error) {
      finished = {status: 'failed', error: scrub(error instanceof Error ? error.message : String(error))};
    }
    const fresh = this.store.get('cuts', running.id) ?? running, at = this.now();
    this.store.update('cuts', {...fresh, ...finished, finishedAt: at, updatedAt: at});
  }

  private async run(cmd: string[], cwd: string, timeoutMs: number, what: string): Promise<SpawnResult> {
    const result = await this.spawn(cmd, {cwd, timeoutMs});
    if (result.code !== 0) throw new CutError(`${what}失败：${tail(result.stderr)}`);
    return result;
  }

  private async render(cut: Cut): Promise<{output: NonNullable<Cut['output']>; warnings: string[]}> {
    const tools = this.tools() ?? (() => { throw new CutError(FFMPEG_HINT); })();
    const ctx = this.context(cut.batchId), warnings: string[] = [];
    const work = mkdtempSync(join(this.options.workRoot ?? tmpdir(), 'sciepo-cut-'));
    try {
      // Inputs come only from the media store, and each must still have the bytes the cut recorded.
      const inputs = [];
      for (const clip of cut.clips) {
        const path = this.media.path(clip.sha256);
        if (!existsSync(path)) throw new CutError(`片段 ${clip.clipId} 的视频已不在媒体库里。`);
        if (await fileSha256(path) !== clip.sha256) throw new CutError(`片段 ${clip.clipId} 的视频文件和记录的 SHA-256 不一致。`);
        const probe = await this.run([tools.ffprobe, ...audioProbeArguments(path)], work, 60_000, `读取片段 ${clip.clipId}`);
        const audio = probe.stdout.trim().length > 0;
        if (!audio) warnings.push(`片段 ${clip.clipId} 没有音轨，这一段用静音。`);
        inputs.push({file: path, seconds: clip.seconds, gainDb: clip.gainDb, audio});
      }
      let music: {file: string; levelDb: number} | null = null;
      if (cut.settings.musicAssetId) {
        const asset = this.store.get('media_assets', cut.settings.musicAssetId), path = asset ? this.media.path(asset.sha256) : '';
        if (!asset || !existsSync(path)) throw new CutError('选的配乐已不在媒体库里。');
        if (await fileSha256(path) !== asset.sha256) throw new CutError('配乐文件和记录的 SHA-256 不一致。');
        music = {file: path, levelDb: cut.settings.musicLevelDb};
      }
      let font: string | null = null, captions: {file: string; start: number; end: number}[] = [];
      const files = captionFiles(cut.captions, cut.language);
      if (files.length) {
        const path = this.font();
        if (!path) warnings.push(NO_FONT);
        else {
          // A font path that a filter cannot carry is copied next to the caption files under a plain name.
          if (fontFilterValue(path)) font = path;
          else { font = `caption-font${extname(path).toLowerCase().replace(/[^a-z0-9.]/gu, '') || '.ttf'}`; copyFileSync(path, join(work, font)); }
          for (const file of files) writeFileSync(join(work, file.name), file.text, 'utf8');
          captions = files.map(f => ({file: f.name, start: f.start, end: f.end}));
        }
      }
      const size = cutDimensions(cut.settings.size, ctx.batch), total = cut.clips.reduce((sum, c) => sum + c.seconds, 0), timeoutMs = Math.max(600_000, total * 30_000);
      const input = {inputs, music, captions, font, ...size, fps: ctx.batch.fps, settings: cut.settings, output: 'cut.mp4', comment: `Sci-epo cut ${cut.id}`};
      const measure = await this.run([tools.ffmpeg, ...cutArguments(input)], work, timeoutMs, 'ffmpeg 测量响度');
      const measured = parseLoudnorm(measure.stderr);
      if (!measured) warnings.push('没有测到可用的响度（声音可能整段静音），这一版没有做响度标准化。');
      let rendered = await this.spawn([tools.ffmpeg, ...cutArguments(input, measured)], {cwd: work, timeoutMs});
      if (rendered.code !== 0 && captions.length) {
        warnings.push(`画面文字字幕没能画上（${tail(rendered.stderr, 240)}），这一版没有字幕。`);
        rendered = await this.spawn([tools.ffmpeg, ...cutArguments({...input, captions: [], font: null}, measured)], {cwd: work, timeoutMs});
      }
      const out = join(work, 'cut.mp4');
      if (rendered.code !== 0 || !existsSync(out)) throw new CutError(`ffmpeg 剪辑失败：${tail(rendered.stderr)}`);
      const probed = Number((await this.run([tools.ffprobe, ...durationProbeArguments(out)], work, 60_000, '读取成片时长')).stdout.trim());
      const seconds = Number.isFinite(probed) && probed > 0 ? round3(probed) : round3(total);
      if (!(Number.isFinite(probed) && probed > 0)) warnings.push('读不出成片的时长，这里写的是计划时长。');
      const loudness = parseEbur128((await this.run([tools.ffmpeg, ...loudnessArguments(out)], work, timeoutMs, '测量成片响度')).stderr);
      if (loudness.integrated === null) warnings.push('没有测到成片的响度。');
      const asset = await this.media.ingestFile(cut.projectId, 'cut_video', out, {origin: 'sciepo', label: `第 ${ctx.episode.ordinal} 集 · ${languageName(cut.language)} · ${cut.kind === 'final' ? '正式成片' : '草稿'}`});
      return {output: {assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, seconds, loudness: loudness.integrated, truePeak: loudness.truePeak}, warnings};
    } finally {
      rmSync(work, {recursive: true, force: true});
    }
  }
}
