/** Production bridge: the series profile, render batches, job packages, results, worker tokens,
 * the bearer-token worker API, and push/sync to a worker URL. Video files never pass through Sci-epo. */
import { createHash, randomBytes } from 'node:crypto';
import type { BatchReference, Episode, MediaAsset, ProductionCharacter, Project, RenderBatch, RenderJob, RenderJobV2, Revision, RetakeReason, ShotList, Take, WorkerToken } from '../types';
import { EMPTY_PROFILE, RENDER_RESULTS_FORMAT, RenderPlanError, parseProductionProfile, parseRenderResults, planRenderBatch, renderPackage, type RenderResult } from '../core/h3';
import { normalizeSpeakerName } from '../core/scriptLines';
import { planJobsV2, takeSeed } from '../core/renderPlan';
import { boundAdaptations, shotListStatus } from '../core/shotList';
import type { MediaStore } from './media';
import { DEFAULT_STACK_ID, RENDER_SIZES, type Stacks } from './stacks';
import type { Store } from './store';

type Fail = (status: number, message: string) => never;
export interface ProductionOptions { clock?: () => Date; transport?: typeof fetch; leaseMinutes?: number; media?: MediaStore; stacks?: Stacks }
const RETAKE_REASONS: readonly RetakeReason[] = ['picture_broken', 'character_drift', 'line_wrong', 'lip_sync', 'garbled_text', 'other'];
/** A reference file name the worker can use: ASCII slug of the character, a short hash and the file's extension. */
const referenceName = (character: string, sha256: string, extension: string) =>
  `${normalizeSpeakerName(character).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'cast'}-${sha256.slice(0, 8)}.${extension}`;
export type PublicWorkerToken = Omit<WorkerToken, 'hash'>;

const TOKEN_PATTERN = /^sciepo_wk_[A-Za-z0-9_-]{43}$/u;
const MAX_ACTIVE_TOKENS = 20;
const WORKER_BODY_LIMIT = 64_000;
const WORKER_RESPONSE_LIMIT = 2_000_000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const publicToken = ({hash: _hash, ...token}: WorkerToken): PublicWorkerToken => token;

export class Production {
  private readonly clock: () => Date;
  private readonly transport: typeof fetch;
  private readonly leaseMs: number;
  private readonly media?: MediaStore;
  private readonly stacks?: Stacks;
  constructor(private store: Store, private fail: Fail, private id: () => string, options: ProductionOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.transport = options.transport ?? fetch;
    this.leaseMs = (options.leaseMinutes ?? 60) * 60_000;
    if (options.media) this.media = options.media;
    if (options.stacks) this.stacks = options.stacks;
  }
  private now() { return this.clock().toISOString(); }
  private batch(id: string) { return this.store.get('render_batches', id) ?? this.fail(404, '找不到渲染批次。'); }
  private jobsOf(batchId: string) { return this.store.all('render_jobs').filter(j => j.batchId === batchId); }
  private projectOf(batch: RenderBatch) {
    const episode = this.store.get('episodes', batch.episodeId) ?? this.fail(404, '找不到集数。');
    return {episode, project: this.store.get('projects', episode.projectId) ?? this.fail(404, '找不到系列。')};
  }
  /** A batch is current while its shot list is the adopted production version of an unchanged accepted script. */
  current(batch: RenderBatch): boolean {
    const episode = this.store.get('episodes', batch.episodeId), list = this.store.get('shot_lists', batch.shotListId);
    return !!episode && !!list && shotListStatus(list, episode).current;
  }

  /** Owner GET routes; undefined when the path is not a production route. */
  get(a: string | undefined, target: string | undefined, action: string | undefined): Response | unknown | undefined {
    if (a === 'render-batches' && target && action === 'package') {
      const body = JSON.stringify(this.package(this.v1(this.batch(target))), null, 2);
      return new Response(body, {headers: {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="sciepo-render-${target}.json"`}});
    }
    if (a === 'worker-tokens' && !target) return this.tokens();
    return undefined;
  }

  /** Owner POST and PUT routes; undefined when the path is not a production route. */
  async post(method: string, a: string | undefined, target: string | undefined, action: string | undefined, body: Record<string, unknown>): Promise<unknown | undefined> {
    if (a === 'projects' && target && action === 'production' && method === 'PUT') return this.saveProfile(target, body);
    if (a === 'projects' && target && action === 'production-settings' && method === 'PUT') return this.saveSettings(target, body);
    if (method !== 'POST') return undefined;
    if (a === 'projects' && target && action === 'cast') return this.linkCast(target, body);
    if (a === 'shot-lists' && target && action === 'render-batches') return this.createBatch(target, body);
    if (a === 'render-jobs-v2' && target && action === 'retake') return this.retake(target, body);
    if (a === 'render-jobs-v2' && target && action === 'approve') return this.approve(target, body);
    if (a === 'render-batches' && target && action === 'results') return this.applyResults(this.v1(this.batch(target)), body, '结果文件');
    if (a === 'render-batches' && target && action === 'push') return this.push(this.v1(this.batch(target)), body);
    if (a === 'render-batches' && target && action === 'sync') return this.sync(this.v1(this.batch(target)), body);
    if (a === 'render-jobs' && target && action === 'requeue') return this.requeue(target);
    if (a === 'worker-tokens' && !target) return this.createToken(body);
    if (a === 'worker-tokens' && target && action === 'revoke') return this.revokeToken(target);
    return undefined;
  }

  private saveProfile(projectId: string, body: Record<string, unknown>) {
    const project = this.store.get('projects', projectId) ?? this.fail(404, '找不到系列。');
    let production;
    try { production = parseProductionProfile(body); } catch (error) { return this.fail(400, error instanceof Error ? error.message : '制作设定无效。'); }
    // Uploaded references are linked on the cast route; a saved profile keeps them for characters it still describes.
    const previous = project.production?.characters ?? [];
    production.characters = production.characters.map(c => {
      const old = previous.find(p => normalizeSpeakerName(p.name) === normalizeSpeakerName(c.name));
      return {...c, ...(old?.portrait ? {portrait: old.portrait} : {}), ...(old?.voiceSampleAsset ? {voiceSampleAsset: old.voiceSampleAsset} : {}), ...(c.usePortrait === undefined && old?.usePortrait !== undefined ? {usePortrait: old.usePortrait} : {})};
    });
    // Outside the frozen brief and the context token: saving it never marks episodes for recheck.
    this.store.update('projects', {...project, production, updatedAt: this.now()});
    return this.store.bundle(project.id);
  }

  private saveSettings(projectId: string, body: Record<string, unknown>) {
    const project = this.store.get('projects', projectId) ?? this.fail(404, '找不到系列。');
    const rate = body.computeUnitsPerHour;
    if (rate !== undefined && rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1000)) this.fail(400, '计算单元单价需为 0–1000 的数字。');
    const settings = {...project.productionSettings};
    if (rate === null) delete settings.computeUnitsPerHour; else if (typeof rate === 'number') settings.computeUnitsPerHour = rate;
    this.store.update('projects', {...project, productionSettings: settings, updatedAt: this.now()});
    return this.store.bundle(project.id);
  }

  /** Link an uploaded portrait or voice sample to a character, or unlink it with null. */
  private linkCast(projectId: string, body: Record<string, unknown>) {
    const project = this.store.get('projects', projectId) ?? this.fail(404, '找不到系列。');
    const name = typeof body.name === 'string' && body.name.trim() && body.name.length <= 60 ? body.name.trim() : this.fail(400, '请写明角色名。');
    const asset = (value: unknown, kind: MediaAsset['kind']) => {
      if (value === null) return null;
      if (value === undefined) return undefined;
      const found = typeof value === 'string' ? this.store.get('media_assets', value) : undefined;
      if (!found || found.projectId !== project.id || found.kind !== kind) return this.fail(400, kind === 'reference_image' ? '参考图不在这个系列的媒体库里。' : '声音样本不在这个系列的媒体库里。');
      return found;
    };
    const portrait = asset(body.portraitAssetId, 'reference_image'), voice = asset(body.voiceSampleAssetId, 'voice_sample');
    if (body.usePortrait !== undefined && typeof body.usePortrait !== 'boolean') this.fail(400, '“使用参考图”需为是或否。');
    const profile = structuredClone(project.production ?? EMPTY_PROFILE);
    let character = profile.characters.find(c => normalizeSpeakerName(c.name) === normalizeSpeakerName(name));
    if (!character) { if (profile.characters.length >= 20) this.fail(409, '角色设定最多 20 个。'); character = {name, appearance: '', voice: ''}; profile.characters.push(character); }
    if (portrait === null) delete character.portrait; else if (portrait) character.portrait = {assetId: portrait.id, sha256: portrait.sha256, approvedAt: this.now()};
    if (voice === null) delete character.voiceSampleAsset; else if (voice) character.voiceSampleAsset = {assetId: voice.id, sha256: voice.sha256};
    if (typeof body.usePortrait === 'boolean') character.usePortrait = body.usePortrait;
    this.store.update('projects', {...project, production: profile, updatedAt: this.now()});
    return this.store.bundle(project.id);
  }

  /** Version 1 batches only: v2 batches render through sessions into the media store. */
  private v1(batch: RenderBatch): RenderBatch {
    if (batch.version === 2) this.fail(409, '这一批通过渲染会话交给工作机，不用任务包、推送或结果文件。');
    return batch;
  }

  private createBatch(listId: string, body: Record<string, unknown>) {
    const list = this.store.get('shot_lists', listId) ?? this.fail(404, '找不到分镜表。');
    const episode = this.store.get('episodes', list.episodeId) ?? this.fail(404, '找不到集数。');
    if (!shotListStatus(list, episode).current) this.fail(409, '只有当前制作版本的分镜表才能生成渲染任务。请先在分镜页采用它，并确认本集定稿没有变化。');
    const revision = this.store.get('revisions', list.sourceRevisionId) ?? this.fail(404, '找不到剧本版本。');
    const project = this.store.get('projects', episode.projectId) ?? this.fail(404, '找不到系列。');
    const languages = body.languages === undefined ? undefined : Array.isArray(body.languages) && body.languages.length <= 6 && body.languages.every(l => typeof l === 'string') ? body.languages as string[] : this.fail(400, '配音语言格式无效。');
    const clipLimitSeconds = body.clipLimitSeconds === undefined ? undefined : typeof body.clipLimitSeconds === 'number' ? body.clipLimitSeconds : this.fail(400, '片段上限需为数字。');
    if (body.version !== 1) return this.createBatchV2({list, episode, revision, project, body, ...(languages ? {languages} : {}), ...(clipLimitSeconds !== undefined ? {clipLimitSeconds} : {})});
    const createdAt = this.now();
    let plan;
    try {
      plan = planRenderBatch({batchId: this.id(), createdAt, episodeId: episode.id, list, revision, adaptations: boundAdaptations(list, this.store.all('localizations')), profile: project.production ?? EMPTY_PROFILE, ...(languages ? {languages} : {}), ...(clipLimitSeconds !== undefined ? {clipLimitSeconds} : {})});
    } catch (error) { if (error instanceof RenderPlanError) return this.fail(400, error.message); throw error; }
    const {batch, jobs} = plan;
    this.store.db.transaction(() => {
      this.store.insert('render_batches', batch);
      for (const job of jobs) this.store.insert('render_jobs', {id: this.id(), batchId: batch.id, clipId: job.clipId, language: job.language, order: job.order, status: 'queued', attempts: 0, updatedAt: createdAt});
    })();
    return this.store.bundle(project.id);
  }

  package(batch: RenderBatch) {
    const {episode, project} = this.projectOf(batch);
    return renderPackage(batch, this.jobsOf(batch.id), {series: project.title, episodeOrdinal: episode.ordinal, episodeTitle: episode.title});
  }

  /** Version 2: a render preset, references from the media store, one job per distinct render, and take 1 queued. */
  private createBatchV2(input: {list: ShotList; episode: Episode; revision: Revision; project: Project; body: Record<string, unknown>; languages?: string[]; clipLimitSeconds?: number}) {
    const {list, episode, revision, project, body} = input;
    const stacks = this.stacks ?? this.fail(503, '服务器上没有工作机栈配置（worker/stacks）。');
    const stack = stacks.get(typeof body.stack === 'string' ? body.stack : DEFAULT_STACK_ID) ?? this.fail(400, '找不到这个工作机栈。');
    const sizes = RENDER_SIZES[list.aspectRatio];
    const size = body.size === undefined ? sizes[0]! : sizes.find(s => `${s.width}x${s.height}` === body.size) ?? this.fail(400, `渲染尺寸只能是 ${sizes.map(s => `${s.width}x${s.height}`).join(' 或 ')}。`);
    const steps = body.steps === undefined ? 20 : typeof body.steps === 'number' && Number.isInteger(body.steps) && body.steps >= 1 && body.steps <= 60 ? body.steps : this.fail(400, '采样步数需为 1–60 的整数。');
    if (body.turbo !== undefined && typeof body.turbo !== 'boolean') this.fail(400, '加速开关需为是或否。');
    const musicMode = body.musicMode === undefined || body.musicMode === 'bed' ? 'bed' as const : body.musicMode === 'native' ? 'native' as const : this.fail(400, '配乐方式只能是整集配乐（bed）或片段自带（native）。');
    const preset = {width: size.width, height: size.height, steps, turbo: body.turbo === true, stack: {id: stack.id, version: stack.version}};
    // References come from the media store; a bare file name from a v1 profile cannot reach a session's worker.
    const profile = project.production ?? EMPTY_PROFILE, references: BatchReference[] = [], warnings: string[] = [];
    const reference = (character: string, ref: {assetId: string; sha256: string}, kind: 'image' | 'audio') => {
      const asset = this.store.get('media_assets', ref.assetId);
      if (!asset || asset.sha256 !== ref.sha256) { warnings.push(`${character} 的${kind === 'image' ? '参考图' : '声音样本'}已不在媒体库里，这一批不使用它。`); return undefined; }
      const name = referenceName(character, asset.sha256, this.media?.extension(asset) ?? (kind === 'image' ? 'png' : 'wav'));
      if (!references.some(r => r.name === name)) references.push({name, kind, character, assetId: asset.id, sha256: asset.sha256});
      return name;
    };
    const planning = {...profile, characters: profile.characters.map((c): ProductionCharacter => {
      const {image: legacyImage, voiceSample: legacyVoice, ...rest} = c, out: ProductionCharacter = {...rest};
      if (c.portrait && c.usePortrait !== false) { const name = reference(c.name, c.portrait, 'image'); if (name) out.image = name; }
      else if (legacyImage && !c.portrait) warnings.push(`${c.name} 的参考图只写了文件名 ${legacyImage}，没有上传到媒体库，这一批不使用它。`);
      if (c.voiceSampleAsset) { const name = reference(c.name, c.voiceSampleAsset, 'audio'); if (name) out.voiceSample = name; }
      else if (legacyVoice) warnings.push(`${c.name} 的声音样本只写了文件名 ${legacyVoice}，没有上传到媒体库，这一批不使用它。`);
      return out;
    })};
    const createdAt = this.now();
    let plan;
    try {
      plan = planRenderBatch({batchId: this.id(), createdAt, episodeId: episode.id, list, revision, adaptations: boundAdaptations(list, this.store.all('localizations')), profile: planning, size, musicMode,
        ...(input.languages ? {languages: input.languages} : {}), ...(input.clipLimitSeconds !== undefined ? {clipLimitSeconds: input.clipLimitSeconds} : {})});
    } catch (error) { if (error instanceof RenderPlanError) return this.fail(400, error.message); throw error; }
    const {clips, jobs} = planJobsV2(plan.batch, preset, references, episode.ordinal);
    for (const clip of clips) if (Object.values(clip.prompts).some(p => p.mode === 't2va') && !stack.workflows.t2va) warnings.push(`片段 ${clip.id} 没有入镜角色的参考图，要用文生模式（T2VA）；${stack.label} 还没有可用的 T2VA 工作流，这一段会失败。请给入镜角色上传并选定参考图。`);
    const batch: RenderBatch = {...plan.batch, version: 2, preset, musicMode, references, clips, warnings: [...new Set([...plan.batch.warnings, ...warnings])]};
    this.store.db.transaction(() => {
      this.store.insert('render_batches', batch);
      for (const job of jobs) {
        const clip = clips.find(c => c.id === job.clipId)!;
        this.store.insert('render_jobs_v2', {id: this.id(), batchId: batch.id, ...job, takes: [{n: 1, seed: takeSeed(clip.pictureKey!, 1), status: 'queued'}], updatedAt: createdAt});
      }
    })();
    return this.store.bundle(project.id);
  }

  private jobV2(id: string): RenderJobV2 { return this.store.get('render_jobs_v2', id) ?? this.fail(404, '找不到渲染任务。'); }

  /** Queue the next take with the next seed; the latest rendered take keeps the reasons. */
  private retake(jobId: string, body: Record<string, unknown>) {
    const job = this.jobV2(jobId), batch = this.batch(job.batchId), last = job.takes.at(-1)!;
    if (!this.current(batch)) this.fail(409, '这个批次已不是当前制作版本，不能再重拍。');
    if (last.status === 'queued' || last.status === 'claimed') this.fail(409, '这个片段已经在排队或正在渲染。');
    const reasons = Array.isArray(body.reasons) && body.reasons.every(r => RETAKE_REASONS.includes(r as RetakeReason)) ? [...new Set(body.reasons as RetakeReason[])] : this.fail(400, '重拍原因无效。');
    if (!reasons.length) this.fail(400, '请至少选一个重拍原因。');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const clip = batch.clips.find(c => c.id === job.clipId), at = this.now(), n = last.n + 1;
    const takes: Take[] = job.takes.map(t => t.n === last.n && t.status === 'rendered' ? {...t, verdict: {decision: 'retake', reasons, ...(note ? {note} : {}), at}} : t);
    const {approvedTake, ...rest} = job;
    this.store.update('render_jobs_v2', {...rest, ...(approvedTake !== undefined && approvedTake !== last.n ? {approvedTake} : {}), takes: [...takes, {n, seed: takeSeed(clip?.pictureKey ?? `${batch.id}:${job.clipId}`, n), status: 'queued'}], updatedAt: at});
    return this.store.bundle(this.projectOf(batch).project.id);
  }

  /** One approved take per job. */
  private approve(jobId: string, body: Record<string, unknown>) {
    const job = this.jobV2(jobId), batch = this.batch(job.batchId);
    const n = typeof body.take === 'number' ? body.take : this.fail(400, '请指明通过哪一条 take。');
    const take = job.takes.find(t => t.n === n) ?? this.fail(404, '找不到这条 take。');
    if (take.status !== 'rendered') this.fail(409, '只有渲染完成的 take 才能通过。');
    const at = this.now();
    const takes = job.takes.map((t): Take => {
      if (t.n === n) return {...t, verdict: {decision: 'approved', reasons: [], at}};
      if (t.verdict?.decision !== 'approved') return t;
      const {verdict: _verdict, ...rest} = t;
      return rest;
    });
    this.store.update('render_jobs_v2', {...job, takes, approvedTake: n, updatedAt: at});
    return this.store.bundle(this.projectOf(batch).project.id);
  }

  /** Why a media file must stay, or undefined when it can be deleted. */
  mediaInUse(asset: MediaAsset): string | undefined {
    for (const project of this.store.all('projects')) for (const c of project.production?.characters ?? []) if (c.portrait?.assetId === asset.id || c.voiceSampleAsset?.assetId === asset.id) return `${c.name} 正在用它作为参考。`;
    for (const batch of this.store.all('render_batches')) if (batch.references?.some(r => r.assetId === asset.id) && this.current(batch)) return '当前制作版本的渲染批次用它作为参考。';
    for (const job of this.store.all('render_jobs_v2')) for (const t of job.takes) {
      if (t.verdict?.decision !== 'approved') continue;
      if ([t.video?.assetId, t.qa?.contactSheet, t.qa?.dataAssetId, ...(t.qa?.keyframes ?? []).map(k => k.assetId)].includes(asset.id)) return '它属于一条已通过的 take。';
    }
    return undefined;
  }

  /** Apply worker results. Idempotent; a success is never replaced by a later failure report. */
  private applyResults(batch: RenderBatch, body: unknown, source: string) {
    let parsed;
    try { parsed = parseRenderResults(body, batch.id); } catch (error) { return this.fail(400, error instanceof Error ? error.message : '结果文件无效。'); }
    const jobs = new Map(this.jobsOf(batch.id).map(j => [j.id, j]));
    const counts = {applied: 0, unchanged: 0, ignored: parsed.skipped};
    this.store.db.transaction(() => {
      for (const result of parsed.results) {
        const job = jobs.get(result.jobId);
        if (!job || (job.status === 'succeeded' && result.status === 'failed')) { counts.ignored++; continue; }
        const next = this.finished(job, result, source);
        if (job.status === next.status && JSON.stringify(job.output ?? null) === JSON.stringify(next.output ?? null) && (job.error ?? null) === (next.error ?? null)) { counts.unchanged++; continue; }
        this.store.update('render_jobs', next);
        counts.applied++;
      }
    })();
    return {...counts, bundle: this.store.bundle(this.projectOf(batch).project.id)};
  }

  private finished(job: RenderJob, result: RenderResult, source: string): RenderJob {
    const {leaseExpiresAt: _lease, error: _error, output: _output, ...rest} = job;
    return {...rest, status: result.status, workerLabel: rest.workerLabel ?? source, updatedAt: this.now(),
      ...(result.status === 'succeeded' ? {output: {file: result.file!, ...(result.seconds !== undefined ? {seconds: result.seconds} : {}), ...(result.bytes !== undefined ? {bytes: result.bytes} : {}), ...(result.sha256 ? {sha256: result.sha256} : {})}} : {error: result.error ?? '工作机报告失败。'})};
  }

  private requeue(jobId: string) {
    const job = this.store.get('render_jobs', jobId) ?? this.fail(404, '找不到渲染任务。');
    const expired = job.status === 'claimed' && !!job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= this.clock().getTime();
    if (job.status !== 'failed' && !expired) this.fail(409, '只有失败或超时的任务可以重新排队。');
    const {leaseExpiresAt: _lease, error: _error, workerTokenId: _token, workerLabel: _label, output: _output, ...rest} = job;
    this.store.update('render_jobs', {...rest, status: 'queued', updatedAt: this.now()});
    return this.store.bundle(this.projectOf(this.batch(job.batchId)).project.id);
  }

  private tokens(): PublicWorkerToken[] { return this.store.all('worker_tokens').map(publicToken).reverse(); }

  private createToken(body: Record<string, unknown>) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > 60) this.fail(400, '请给工作机起一个 60 字以内的名字，例如 Colab A100。');
    if (this.store.all('worker_tokens').filter(t => !t.revokedAt).length >= MAX_ACTIVE_TOKENS) this.fail(409, `最多保留 ${MAX_ACTIVE_TOKENS} 个有效的工作机令牌，请先撤销不用的。`);
    const token = `sciepo_wk_${randomBytes(32).toString('base64url')}`;
    const row = this.store.insert('worker_tokens', {id: this.id(), label, hash: sha256(token), createdAt: this.now()});
    return {token, worker: publicToken(row), tokens: this.tokens()};
  }

  private revokeToken(id: string) {
    const token = this.store.get('worker_tokens', id) ?? this.fail(404, '找不到工作机令牌。');
    if (!token.revokedAt) this.store.update('worker_tokens', {...token, revokedAt: this.now()});
    return this.tokens();
  }

  /** `/api/worker/v1/*`: bearer token only. No session cookie and no CSRF token are read or required. */
  async worker(req: Request, url: URL): Promise<Response> {
    const presented = /^Bearer (\S+)$/u.exec(req.headers.get('authorization') ?? '')?.[1];
    const hash = presented && TOKEN_PATTERN.test(presented) ? sha256(presented) : undefined;
    const token = hash ? this.store.all('worker_tokens').find(t => t.hash === hash) : undefined;
    if (!token || token.revokedAt) return Response.json({error: '工作机令牌无效或已撤销。'}, {status: 401});
    const nowMs = this.clock().getTime();
    if (!token.lastUsedAt || nowMs - Date.parse(token.lastUsedAt) > 60_000) this.store.update('worker_tokens', {...token, lastUsedAt: this.now()});
    // /api/worker/v1/<resource>/<job>/<action>
    const [, , , resource, jobId, action, extra] = url.pathname.split('/').filter(Boolean);
    if (extra !== undefined) return Response.json({error: '未找到接口。'}, {status: 404});
    if (req.method === 'GET' && resource === 'hello' && !jobId) return Response.json({service: 'sci-epo', worker: token.label});
    if (req.method !== 'POST') return Response.json({error: '未找到接口。'}, {status: 404});
    const text = await req.text();
    if (text.length > WORKER_BODY_LIMIT) return Response.json({error: '请求内容过长。'}, {status: 413});
    let body: Record<string, unknown> = {};
    if (text.trim()) {
      try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); body = parsed; }
      catch { return Response.json({error: '请求不是有效的 JSON 对象。'}, {status: 400}); }
    }
    if (resource === 'claim' && !jobId) return this.claim(token, nowMs);
    if (resource === 'jobs' && jobId && action === 'heartbeat') return this.heartbeat(token, jobId, nowMs);
    if (resource === 'jobs' && jobId && action === 'result') return this.report(token, jobId, body);
    return Response.json({error: '未找到接口。'}, {status: 404});
  }

  /** The oldest queued job of a current batch, or one whose lease expired. One transaction, so no double claims. */
  private claim(token: WorkerToken, nowMs: number): Response {
    return this.store.db.transaction((): Response => {
      const batches = this.store.all('render_batches').filter(b => this.current(b)), rank = new Map(batches.map((b, i) => [b.id, i]));
      const job = this.store.all('render_jobs')
        .filter(j => rank.has(j.batchId) && (j.status === 'queued' || (j.status === 'claimed' && !!j.leaseExpiresAt && Date.parse(j.leaseExpiresAt) <= nowMs)))
        .sort((a, b) => rank.get(a.batchId)! - rank.get(b.batchId)! || a.order - b.order)[0];
      if (!job) return new Response(null, {status: 204});
      const leaseExpiresAt = new Date(nowMs + this.leaseMs).toISOString();
      const {error: _error, output: _output, ...rest} = job;
      const claimed: RenderJob = {...rest, status: 'claimed', attempts: job.attempts + 1, workerTokenId: token.id, workerLabel: token.label, leaseExpiresAt, updatedAt: this.now()};
      this.store.update('render_jobs', claimed);
      const batch = batches[rank.get(job.batchId)!]!, {episode, project} = this.projectOf(batch);
      const pkg = renderPackage(batch, [claimed], {series: project.title, episodeOrdinal: episode.ordinal, episodeTitle: episode.title});
      return Response.json({batch: pkg.batch, model: pkg.model, job: {...pkg.jobs[0], leaseExpiresAt}});
    })();
  }

  private owned(token: WorkerToken, jobId: string): RenderJob | Response {
    const job = this.store.get('render_jobs', jobId);
    if (!job || job.status !== 'claimed' || job.workerTokenId !== token.id) return Response.json({error: '这个任务不属于这台工作机，或已经不在进行中。'}, {status: 409});
    return job;
  }

  private heartbeat(token: WorkerToken, jobId: string, nowMs: number): Response {
    const job = this.owned(token, jobId);
    if (job instanceof Response) return job;
    if (!this.current(this.batch(job.batchId))) return Response.json({error: '这个批次已不是当前制作版本，请停止渲染。'}, {status: 410});
    const leaseExpiresAt = new Date(nowMs + this.leaseMs).toISOString();
    this.store.update('render_jobs', {...job, leaseExpiresAt, updatedAt: this.now()});
    return Response.json({leaseExpiresAt});
  }

  private report(token: WorkerToken, jobId: string, body: Record<string, unknown>): Response {
    const job = this.owned(token, jobId);
    if (job instanceof Response) return job;
    let result: RenderResult | undefined;
    try { result = parseRenderResults({format: RENDER_RESULTS_FORMAT, version: 1, batchId: job.batchId, results: [{...body, jobId}]}, job.batchId).results[0]; }
    catch (error) { return Response.json({error: error instanceof Error ? error.message : '结果无效。'}, {status: 400}); }
    if (!result) return Response.json({error: '结果状态只能是 succeeded 或 failed。'}, {status: 400});
    this.store.update('render_jobs', this.finished(job, result, token.label));
    return Response.json({ok: true});
  }

  /** Worker URLs: https anywhere, plain http only on this computer. */
  private workerUrl(value: unknown): string {
    let url: URL;
    try { url = new URL(String(value ?? '')); } catch { return this.fail(400, '工作机地址无效。'); }
    if (url.username || url.password || url.search || url.hash) this.fail(400, '工作机地址不能带账号、查询参数或锚点。');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) this.fail(400, '工作机地址需为 https，或本机的 http://127.0.0.1。');
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  }
  private workerKey(value: unknown): string {
    return typeof value === 'string' && /^[\x21-\x7e]{8,200}$/u.test(value) ? value : this.fail(400, '工作机密钥需为 8–200 个可见字符。');
  }

  /** One request to a worker: no redirects, a timeout, a size limit, and errors that never echo the key or the body. */
  private async request(url: string, key: string, init: {method: 'GET' | 'POST'; body?: string}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, {method: init.method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {authorization: `Bearer ${key}`, accept: 'application/json', ...(init.body ? {'content-type': 'application/json'} : {})}, ...(init.body ? {body: init.body} : {})});
    } catch { return this.fail(502, '连接不上工作机。请检查地址、隧道和工作机是否在运行。'); }
    if (Number(response.headers.get('content-length') ?? 0) > WORKER_RESPONSE_LIMIT) return this.fail(502, '工作机返回的内容过大。');
    const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (bytes.length > WORKER_RESPONSE_LIMIT) return this.fail(502, '工作机返回的内容过大。');
    if (!response.ok) return this.fail(502, `工作机返回 HTTP ${response.status}。${response.status === 401 ? '请检查工作机密钥。' : ''}`);
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return this.fail(502, '工作机没有返回有效的 JSON。'); }
  }

  private async push(batch: RenderBatch, body: Record<string, unknown>) {
    const url = this.workerUrl(body.url), key = this.workerKey(body.key);
    if (!this.current(batch)) this.fail(409, '这个批次已不是当前制作版本，不能再发送。');
    const answer = await this.request(`${url}/v1/batches`, key, {method: 'POST', body: JSON.stringify(this.package(batch))});
    const accepted = answer && typeof answer === 'object' && typeof (answer as Record<string, unknown>).jobs === 'number' ? (answer as Record<string, number>).jobs : undefined;
    return {sent: true, ...(accepted !== undefined ? {accepted} : {})};
  }

  private async sync(batch: RenderBatch, body: Record<string, unknown>) {
    const url = this.workerUrl(body.url), key = this.workerKey(body.key);
    return this.applyResults(batch, await this.request(`${url}/v1/batches/${encodeURIComponent(batch.id)}/results`, key, {method: 'GET'}), '推送的工作机');
  }
}
