/** Render sessions: one worker's work on v2 batches, with a token that works only for them, a time budget,
 * a timeline and an end. Owner routes create, watch and stop sessions. Worker routes (Bearer sciepo_ss_…) serve the
 * session document and the worker program, hand out takes, store uploads in the media store and end the session. */
import { createHash, randomBytes } from 'node:crypto';
import type { BatchReference, MediaAsset, MediaKind, PublicRenderSession, QaCheck, RenderBatch, RenderJobV2, RenderSession, SessionEnd, SessionEstimate, SessionEvent, SpeechLine, Take, TakeQa } from '../types';
import { framesToSeconds } from '../core/h3';
import { defaultRate, median, rateKey, shotTimes, spokenLines } from '../core/renderPlan';
import type { MediaStore } from './media';
import type { Production } from './production';
import type { StackProfile, Stacks } from './stacks';
import type { Store } from './store';

type Fail = (status: number, message: string) => never;
type Body = Record<string, unknown>;
export const SESSION_TOKEN = /^sciepo_ss_[A-Za-z0-9_-]{43}$/u;
const LEASE_MS = 15 * 60_000, LOST_MS = 3 * 60_000, HEARTBEAT_SECONDS = 30, TAKE_OVERHEAD_SECONDS = 15, BODY_LIMIT = 512 * 1024;
const LIVE = new Set<RenderSession['status']>(['waiting', 'connected', 'setting_up', 'rendering', 'finishing', 'lost']);
const ENDS: readonly SessionEnd[] = ['queue_empty', 'budget', 'stopped', 'not_current', 'failures', 'error', 'lost', 'expired'];
const STAGE_STATUS: Record<string, RenderSession['status']> = {connected: 'connected', gpu: 'setting_up', installing: 'setting_up', downloading: 'setting_up', starting_comfyui: 'setting_up',
  ready: 'rendering', rendering: 'rendering', checking: 'rendering', uploading: 'rendering', finishing: 'finishing'};
const FILE_KINDS: Record<string, MediaKind> = {video: 'take_video', 'contact-sheet': 'qa_image', keyframe: 'qa_image', qa: 'qa_data'};
const TOKEN_TEXT = /sciepo_(?:ss|wk)_[A-Za-z0-9_-]{20,}/gu;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const scrub = (text: string, max = 500) => text.replace(TOKEN_TEXT, '[token]').slice(0, max);
const obj = (value: unknown): Body => value && typeof value === 'object' && !Array.isArray(value) ? value as Body : {};
const num = (value: unknown, min: number, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
export const publicSession = ({tokenHash: _hash, ...session}: RenderSession): PublicRenderSession => session;

export interface SessionOptions { clock: () => Date; publicUrl?: string }

export class Sessions {
  constructor(private store: Store, private media: MediaStore, private stacks: Stacks, private production: Production, private fail: Fail, private id: () => string, private options: SessionOptions) {}
  private now() { return this.options.clock().toISOString(); }
  private nowMs() { return this.options.clock().getTime(); }
  private session(id: string) { return this.store.get('render_sessions', id) ?? this.fail(404, '找不到渲染会话。'); }
  private batches(session: RenderSession): RenderBatch[] { return session.batchIds.map(id => this.store.get('render_batches', id)).filter((b): b is RenderBatch => !!b); }
  private jobs(batchIds: string[]): RenderJobV2[] { const ids = new Set(batchIds); return this.store.all('render_jobs_v2').filter(j => ids.has(j.batchId)).sort((a, b) => batchIds.indexOf(a.batchId) - batchIds.indexOf(b.batchId) || a.order - b.order); }
  private projectId(batch: RenderBatch) { return this.store.get('episodes', batch.episodeId)?.projectId ?? this.fail(404, '找不到集数。'); }
  private code(token: string, origin: string) { return `${(this.options.publicUrl ?? origin).replace(/\/+$/u, '')}#${token}`; }
  private newToken() { const token = `sciepo_ss_${randomBytes(32).toString('base64url')}`; return {token, tokenHash: sha256(token)}; }

  /** The take a worker should render next for this job: a queued one, or one whose lease ran out. */
  private pending(job: RenderJobV2, nowMs: number): Take | undefined {
    const last = job.takes.at(-1);
    return last && (last.status === 'queued' || (last.status === 'claimed' && !!last.leaseExpiresAt && Date.parse(last.leaseExpiresAt) <= nowMs)) ? last : undefined;
  }

  // ------------------------------------------------------------------ estimates

  private rate(stack: StackProfile | undefined, batch: RenderBatch, mode: string, gpu?: string): {secondsPerFrame: number; measured: boolean} {
    const preset = batch.preset!, steps = preset.turbo ? stack?.turboSteps[mode] ?? 4 : preset.steps;
    const label = this.gpuLabel(stack, gpu);
    const row = this.store.get('render_rates', rateKey(preset.stack, preset.width, preset.height, steps, label));
    if (row?.samples.length) return {secondsPerFrame: median(row.samples), measured: true};
    return {secondsPerFrame: defaultRate(stack?.defaultSecondsPerFrame ?? {}, preset.width, preset.height, steps), measured: false};
  }
  private gpuLabel(stack: StackProfile | undefined, reported?: string) {
    if (!reported) return stack?.testedGpus[0]?.name ?? 'GPU';
    return stack?.testedGpus.find(g => reported.includes(g.name))?.name ?? reported;
  }
  private expectedSeconds(session: Pick<RenderSession, 'mode' | 'worker'>, batch: RenderBatch, job: RenderJobV2): number {
    const clip = batch.clips.find(c => c.id === job.clipId)!;
    if (session.mode === 'rehearsal') return clip.frames * 0.02 + 3;
    const mode = clip.prompts[job.languages[0]!]?.mode ?? 'r2v';
    return clip.frames * this.rate(this.stacks.get(batch.preset!.stack.id), batch, mode, session.worker?.gpu).secondsPerFrame + TAKE_OVERHEAD_SECONDS;
  }

  estimate(batches: RenderBatch[], mode: RenderSession['mode']): SessionEstimate {
    let takes = 0, frames = 0, seconds = 0, measured = true, setup = mode === 'rehearsal' ? 0.5 : 0;
    const nowMs = this.nowMs();
    for (const batch of batches) {
      const stack = this.stacks.get(batch.preset!.stack.id);
      if (mode === 'pull') setup = Math.max(setup, stack?.setupMinutes ?? 5);
      for (const job of this.jobs([batch.id])) {
        if (!this.pending(job, nowMs)) continue;
        const clip = batch.clips.find(c => c.id === job.clipId)!;
        takes++; frames += clip.frames;
        seconds += this.expectedSeconds({mode}, batch, job);
        if (mode === 'pull' && !this.rate(stack, batch, clip.prompts[job.languages[0]!]?.mode ?? 'r2v').measured) measured = false;
      }
    }
    return {setupMinutes: setup, renderMinutes: round1(seconds / 60), takes, frames, measured};
  }

  // ------------------------------------------------------------------ owner routes

  get(a: string | undefined, target: string | undefined, action: string | undefined): unknown | undefined {
    if (a === 'render-sessions' && target && !action) return publicSession(this.refresh(this.session(target)));
    return undefined;
  }

  post(method: string, a: string | undefined, target: string | undefined, action: string | undefined, body: Body, origin: string): unknown | undefined {
    if (method !== 'POST') return undefined;
    if (a === 'projects' && target && action === 'render-sessions') return this.create(target, body, origin);
    if (a === 'render-sessions' && target && action === 'code') return this.reissue(target, origin);
    if (a === 'render-sessions' && target && action === 'stop') return this.stop(target, body);
    if (a === 'render-sessions' && target && action === 'readings') return this.readings(target, body);
    return undefined;
  }

  private create(projectId: string, body: Body, origin: string) {
    const project = this.store.get('projects', projectId) ?? this.fail(404, '找不到系列。');
    const ids = Array.isArray(body.batchIds) && body.batchIds.length >= 1 && body.batchIds.length <= 10 && body.batchIds.every(id => typeof id === 'string') ? [...new Set(body.batchIds as string[])] : this.fail(400, '请选择要渲染的批次。');
    const batches = ids.map(id => {
      const batch = this.store.get('render_batches', id) ?? this.fail(404, '找不到渲染批次。');
      if (this.store.get('episodes', batch.episodeId)?.projectId !== project.id) this.fail(400, '这个批次不属于这个系列。');
      if (batch.version !== 2) this.fail(409, '旧版批次请用任务包或工作机令牌渲染。');
      if (!this.production.current(batch)) this.fail(409, '只有当前制作版本的批次才能渲染。');
      return batch;
    });
    const mode = body.mode === 'rehearsal' ? 'rehearsal' as const : body.mode === undefined || body.mode === 'pull' ? 'pull' as const : this.fail(400, '会话方式只能是 pull 或 rehearsal。');
    const estimate = this.estimate(batches, mode);
    if (!estimate.takes) this.fail(409, '这些批次没有待渲染的 take。');
    const budgetMinutes = body.budgetMinutes === undefined ? Math.max(15, Math.ceil(1.5 * (estimate.setupMinutes + estimate.renderMinutes))) : num(body.budgetMinutes, 5, 720) ?? this.fail(400, '时间预算需为 5–720 分钟。');
    const waitForRetakesMinutes = body.waitForRetakesMinutes === undefined ? 0 : num(body.waitForRetakesMinutes, 0, 60) ?? this.fail(400, '等待重拍的时间需为 0–60 分钟。');
    const hours = body.expiresHours === undefined ? 6 : num(body.expiresHours, 1, 24) ?? this.fail(400, '会话码有效期需为 1–24 小时。');
    if (body.allowUntestedGpu !== undefined && typeof body.allowUntestedGpu !== 'boolean') this.fail(400, '是否允许未测试的 GPU 需为是或否。');
    const {token, tokenHash} = this.newToken(), createdAt = this.now();
    const session: RenderSession = {id: this.id(), projectId: project.id, batchIds: ids, mode, tokenHash, status: 'waiting',
      settings: {budgetMinutes, allowUntestedGpu: body.allowUntestedGpu === true, waitForRetakesMinutes}, estimate, createdAt,
      expiresAt: new Date(this.nowMs() + hours * 3_600_000).toISOString(), events: []};
    this.store.insert('render_sessions', session);
    return {session: publicSession(session), code: this.code(token, origin), bundle: this.store.bundle(project.id)};
  }

  private reissue(id: string, origin: string) {
    const session = this.refresh(this.session(id));
    if (session.status !== 'waiting') this.fail(409, '工作机已经连上或会话已结束，不能再换会话码。');
    const {token, tokenHash} = this.newToken();
    this.store.update('render_sessions', {...session, tokenHash});
    return {session: publicSession({...session, tokenHash}), code: this.code(token, origin)};
  }

  private stop(id: string, body: Body) {
    const session = this.refresh(this.session(id)), when = body.when === 'now' ? 'now' as const : 'after_take' as const;
    if (!LIVE.has(session.status)) this.fail(409, '这个会话已经结束。');
    if (session.status === 'waiting') {
      const ended: RenderSession = {...session, status: 'ended', end: 'stopped', endedAt: this.now(), tokenHash: null, summary: {minutes: 0, takesRendered: 0, takesFailed: 0, undelivered: 0}};
      this.store.update('render_sessions', ended);
      return publicSession(ended);
    }
    const next: RenderSession = {...session, stopRequest: {when, at: this.now()}};
    this.store.update('render_sessions', next);
    return publicSession(next);
  }

  private readings(id: string, body: Body) {
    const session = this.session(id), readings = {...session.readings};
    for (const key of ['before', 'after'] as const) {
      if (body[key] === null) delete readings[key];
      else if (body[key] !== undefined) readings[key] = num(body[key], 0, 1_000_000) ?? this.fail(400, '计算单元读数需为非负数。');
    }
    const next = {...session, readings};
    this.store.update('render_sessions', next);
    return publicSession(next);
  }

  /** Expiry and loss are noticed when a session is read. A lost worker that comes back resumes the session. */
  refresh(session: RenderSession): RenderSession {
    if (!LIVE.has(session.status)) return session;
    const nowMs = this.nowMs();
    if (nowMs > Date.parse(session.expiresAt)) {
      const expired: RenderSession = {...session, status: 'expired', end: 'expired', endedAt: this.now(), tokenHash: null};
      this.store.db.transaction(() => { this.releaseTakes(session.id); this.store.update('render_sessions', expired); })();
      return expired;
    }
    if (session.status !== 'waiting' && session.status !== 'lost' && session.lastSeenAt && nowMs - Date.parse(session.lastSeenAt) > LOST_MS) {
      const lost: RenderSession = {...session, status: 'lost'};
      this.store.update('render_sessions', lost);
      return lost;
    }
    return session;
  }

  /** Takes this session still holds go back to the queue with the same take number and seed. */
  private releaseTakes(sessionId: string): number {
    let released = 0;
    for (const job of this.store.all('render_jobs_v2')) {
      if (!job.takes.some(t => t.status === 'claimed' && t.sessionId === sessionId)) continue;
      const takes = job.takes.map((t): Take => {
        if (t.status !== 'claimed' || t.sessionId !== sessionId) return t;
        released++;
        const {sessionId: _s, leaseExpiresAt: _l, startedAt: _st, ...rest} = t;
        return {...rest, status: 'queued'};
      });
      this.store.update('render_jobs_v2', {...job, takes, updatedAt: this.now()});
    }
    return released;
  }

  // ------------------------------------------------------------------ worker routes

  /** True when the request carries a session token, so it belongs here rather than to the v1 worker API. */
  static handles(req: Request): boolean { return /^Bearer sciepo_ss_/u.test(req.headers.get('authorization') ?? ''); }

  async worker(req: Request, url: URL): Promise<Response> {
    const presented = /^Bearer (\S+)$/u.exec(req.headers.get('authorization') ?? '')?.[1];
    const hash = presented && SESSION_TOKEN.test(presented) ? sha256(presented) : undefined;
    const found = hash ? this.store.all('render_sessions').find(s => s.tokenHash === hash) : undefined;
    const session = found ? this.refresh(found) : undefined;
    if (!session || !session.tokenHash || !LIVE.has(session.status)) return Response.json({error: '会话码无效、已过期，或这个会话已经结束。'}, {status: 401});
    const live = this.touch(session);
    const [a, b, c, d, e, extra] = url.pathname.split('/').filter(Boolean).slice(3);
    if (extra !== undefined) return Response.json({error: '未找到接口。'}, {status: 404});
    if (req.method === 'GET' && a === 'session' && !b) return Response.json(this.document(live));
    if (req.method === 'GET' && a === 'session' && b === 'worker.py' && !c) return this.program();
    if (req.method === 'GET' && a === 'references' && b && !c) return this.reference(live, req, b);
    if (req.method === 'PUT' && a === 'takes' && b && c && d === 'files' && e) return Response.json(await this.upload(live, req, url, b, c, e));
    if (req.method !== 'POST') return Response.json({error: '未找到接口。'}, {status: 404});
    const body = await this.body(req);
    if (a === 'session' && b === 'events' && !c) return Response.json(this.events(live, body));
    if (a === 'session' && b === 'claim' && !c) return Response.json(this.claim(live));
    if (a === 'session' && b === 'end' && !c) return Response.json(this.end(live, body));
    if (a === 'takes' && b && c && d === 'heartbeat' && !e) return Response.json(this.heartbeat(live, b, c));
    if (a === 'takes' && b && c && d === 'result' && !e) return Response.json(this.result(live, b, c, body));
    return Response.json({error: '未找到接口。'}, {status: 404});
  }

  private async body(req: Request): Promise<Body> {
    if (Number(req.headers.get('content-length') ?? 0) > BODY_LIMIT) this.fail(413, '请求内容过长。');
    const text = await req.text();
    if (text.length > BODY_LIMIT) this.fail(413, '请求内容过长。');
    if (!text.trim()) return {};
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Body; } catch { /* below */ }
    return this.fail(400, '请求不是有效的 JSON 对象。');
  }

  /** Every request is a sign of life; the first one starts the session's clock and budget. */
  private touch(session: RenderSession): RenderSession {
    const now = this.now();
    const next: RenderSession = {...session, lastSeenAt: now,
      ...(session.status === 'waiting' ? {status: 'connected' as const, startedAt: now} : {}),
      ...(session.status === 'lost' ? {status: 'rendering' as const} : {})};
    this.store.update('render_sessions', next);
    return next;
  }

  private budgetEnd(session: RenderSession): number { return Date.parse(session.startedAt ?? session.createdAt) + session.settings.budgetMinutes * 60_000; }

  private references(session: RenderSession): BatchReference[] {
    const seen = new Map<string, BatchReference>();
    for (const batch of this.batches(session)) for (const ref of batch.references ?? []) if (!seen.has(ref.name)) seen.set(ref.name, ref);
    return [...seen.values()];
  }

  private document(session: RenderSession) {
    const program = this.stacks.workerProgram() ?? this.fail(503, '服务器上没有工作机程序 worker/sciepo_worker.py。');
    const batches = this.batches(session), nowMs = this.nowMs(), modes = new Set<string>();
    for (const job of this.jobs(session.batchIds)) {
      if (!this.pending(job, nowMs)) continue;
      const batch = batches.find(b => b.id === job.batchId)!, clip = batch.clips.find(c => c.id === job.clipId)!;
      modes.add(clip.prompts[job.languages[0]!]?.mode ?? 'r2v');
    }
    const stackIds = [...new Set(batches.map(b => b.preset!.stack.id))];
    return {
      format: 'sciepo-session', version: 1,
      session: {id: session.id, mode: session.mode, expiresAt: session.expiresAt, startedAt: session.startedAt, budgetMinutes: session.settings.budgetMinutes,
        budgetEndsAt: new Date(this.budgetEnd(session)).toISOString(), allowUntestedGpu: session.settings.allowUntestedGpu, waitForRetakesMinutes: session.settings.waitForRetakesMinutes, heartbeatSeconds: HEARTBEAT_SECONDS},
      worker: {sha256: program.sha256, bytes: program.bytes.length},
      stacks: session.mode === 'rehearsal' ? [] : stackIds.map(id => this.stacks.document(id)).filter(Boolean),
      modes: [...modes],
      references: this.references(session).map(r => ({name: r.name, sha256: r.sha256, kind: r.kind, bytes: this.store.get('media_assets', r.assetId)?.bytes ?? 0})),
      estimate: session.estimate,
    };
  }

  private program(): Response {
    const program = this.stacks.workerProgram() ?? this.fail(503, '服务器上没有工作机程序 worker/sciepo_worker.py。');
    return new Response(program.bytes, {headers: {'content-type': 'text/x-python; charset=utf-8', 'content-disposition': 'attachment; filename="sciepo_worker.py"'}});
  }

  private reference(session: RenderSession, req: Request, sha: string): Response {
    if (!/^[0-9a-f]{64}$/u.test(sha)) this.fail(404, '找不到这个参考文件。');
    const ref = this.references(session).find(r => r.sha256 === sha) ?? this.fail(404, '这个参考文件不属于这个会话。');
    const asset = this.store.get('media_assets', ref.assetId) ?? this.fail(404, '参考文件已不在媒体库里。');
    return this.media.serve(req, asset);
  }

  private events(session: RenderSession, body: Body) {
    const stage = typeof body.stage === 'string' && /^[a-z_]{1,40}$/u.test(body.stage) ? body.stage : this.fail(400, '阶段名称无效。');
    const data: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(obj(body.data)).slice(0, 20)) {
      if (!/^[A-Za-z0-9_]{1,40}$/u.test(key)) continue;
      if (typeof value === 'string') data[key] = scrub(value, 200);
      else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') data[key] = value;
    }
    const event: SessionEvent = {at: this.now(), stage, ...(typeof body.message === 'string' && body.message ? {message: scrub(body.message)} : {}), ...(Object.keys(data).length ? {data} : {})};
    const worker = {...session.worker};
    if (stage === 'gpu' && typeof data.gpu === 'string') { worker.gpu = data.gpu; if (typeof data.vramGb === 'number') worker.vramGb = data.vramGb; }
    if (stage === 'connected' && typeof data.workerSha256 === 'string') worker.workerSha256 = data.workerSha256.slice(0, 64);
    if (stage === 'ready' && typeof data.comfyCommit === 'string') worker.comfyCommit = data.comfyCommit.slice(0, 40);
    const status = STAGE_STATUS[stage] ?? session.status;
    this.store.update('render_sessions', {...session, status: session.status === 'finishing' && status !== 'finishing' ? 'finishing' : status, worker, events: [...session.events, event].slice(-300)});
    return {ok: true, stop: session.stopRequest?.when ?? null};
  }

  /** The next take in batch and job order, or why there is none. One transaction, so two workers never get the same take. */
  private claim(session: RenderSession) {
    return this.store.db.transaction(() => {
      if (session.stopRequest) return {end: 'stopped' as SessionEnd};
      const batches = this.batches(session);
      if (batches.some(b => !this.production.current(b))) return {end: 'not_current' as SessionEnd};
      const nowMs = this.nowMs();
      const job = this.jobs(session.batchIds).find(j => this.pending(j, nowMs));
      if (!job) {
        const waitMs = session.settings.waitForRetakesMinutes * 60_000, since = Date.parse(session.lastResultAt ?? session.startedAt ?? session.createdAt);
        if (waitMs && nowMs - since < waitMs && nowMs + 30_000 < this.budgetEnd(session)) return {wait: 30};
        return {end: 'queue_empty' as SessionEnd};
      }
      const batch = batches.find(b => b.id === job.batchId)!, clip = batch.clips.find(c => c.id === job.clipId)!;
      if (nowMs + this.expectedSeconds(session, batch, job) * 1000 > this.budgetEnd(session)) return {end: 'budget' as SessionEnd};
      const take = this.pending(job, nowMs)!, leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString(), startedAt = this.now();
      const {error: _error, ...rest} = take;
      const claimed: Take = {...rest, status: 'claimed', sessionId: session.id, leaseExpiresAt, startedAt};
      this.store.update('render_jobs_v2', {...job, takes: job.takes.map(t => t.n === take.n ? claimed : t), updatedAt: startedAt});
      const list = this.store.get('shot_lists', batch.shotListId)!, preset = batch.preset!, prompt = clip.prompts[job.languages[0]!]!;
      const stack = this.stacks.get(preset.stack.id);
      return {take: {
        jobId: job.id, n: take.n, seed: take.seed, leaseExpiresAt, batchId: batch.id, clipId: clip.id, languages: job.languages,
        mode: prompt.mode, prompt: prompt.text, frames: clip.frames, seconds: framesToSeconds(clip.frames), width: batch.width, height: batch.height, fps: batch.fps,
        steps: preset.turbo ? stack?.turboSteps[prompt.mode] ?? 4 : preset.steps, turbo: preset.turbo, stack: preset.stack,
        images: prompt.images, audio: prompt.audio, output: job.outputName, shots: shotTimes(clip, list),
        expectedLines: job.languages.flatMap(language => spokenLines(clip, list, language)), rehearsal: session.mode === 'rehearsal',
      }};
    })();
  }

  private owned(session: RenderSession, jobId: string, n: string): {job: RenderJobV2; take: Take} {
    const job = this.store.get('render_jobs_v2', jobId);
    const take = job && session.batchIds.includes(job.batchId) ? job.takes.find(t => t.n === Number(n)) : undefined;
    if (!job || !take || take.status !== 'claimed' || take.sessionId !== session.id) return this.fail(409, '这条 take 不属于这个会话，或已经不在进行中。');
    return {job, take};
  }

  private heartbeat(session: RenderSession, jobId: string, n: string) {
    const {job, take} = this.owned(session, jobId, n), leaseExpiresAt = new Date(this.nowMs() + LEASE_MS).toISOString();
    this.store.update('render_jobs_v2', {...job, takes: job.takes.map(t => t.n === take.n ? {...t, leaseExpiresAt} : t), updatedAt: this.now()});
    return {leaseExpiresAt, stop: session.stopRequest?.when ?? null, current: this.batches(session).every(b => this.production.current(b)), budgetEndsAt: new Date(this.budgetEnd(session)).toISOString()};
  }

  private async upload(session: RenderSession, req: Request, url: URL, jobId: string, n: string, fileKind: string) {
    const {job, take} = this.owned(session, jobId, n);
    const kind = FILE_KINDS[fileKind] ?? this.fail(404, '不支持这种文件。');
    const shot = url.searchParams.get('shot');
    if (fileKind === 'keyframe' && !(shot && /^[A-Za-z0-9_-]{1,40}$/u.test(shot))) this.fail(400, '关键帧需要镜头编号。');
    const declared = Number(req.headers.get('content-length') ?? Number.NaN);
    const batch = this.store.get('render_batches', job.batchId) ?? this.fail(404, '找不到渲染批次。');
    const asset = await this.media.ingest(this.projectId(batch), kind, req.body, {origin: 'worker', sessionId: session.id,
      label: `${job.outputName} · take ${take.n} · ${fileKind}${shot ? ` ${shot}` : ''}`, ...(Number.isFinite(declared) ? {declaredLength: declared} : {})});
    return {assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes};
  }

  private result(session: RenderSession, jobId: string, n: string, body: Body) {
    const {job, take} = this.owned(session, jobId, n);
    const status = body.status === 'rendered' ? 'rendered' as const : body.status === 'failed' ? 'failed' as const : this.fail(400, '结果只能是 rendered 或 failed。');
    const files = obj(body.files);
    const own = (value: unknown, kind: MediaKind): MediaAsset | undefined => {
      if (value === undefined || value === null) return undefined;
      const asset = typeof value === 'string' ? this.store.get('media_assets', value) : undefined;
      if (!asset || asset.sessionId !== session.id || asset.kind !== kind) return this.fail(400, '上报的文件不是这个会话上传的。');
      return asset;
    };
    const batch = this.store.get('render_batches', job.batchId)!, clip = batch.clips.find(c => c.id === job.clipId)!;
    let video: Take['video'];
    if (status === 'rendered') {
      const asset = own(files.video, 'take_video') ?? this.fail(400, '渲染成功前要先上传视频。');
      video = {assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, seconds: round2(num(body.seconds, 0, 600) ?? framesToSeconds(clip.frames))};
    }
    const qa = this.qa(body.qa, files, own), renderSeconds = num(obj(body.timing).renderSeconds, 0, 86_400), finishedAt = this.now();
    const {leaseExpiresAt: _lease, error: _error, ...rest} = take;
    const finished: Take = {...rest, status, finishedAt, ...(renderSeconds !== undefined ? {renderSeconds: round1(renderSeconds)} : {}), ...(video ? {video} : {}), ...(qa ? {qa} : {}),
      ...(session.mode === 'rehearsal' ? {rehearsal: true} : {}), ...(status === 'failed' ? {error: scrub(typeof body.error === 'string' && body.error ? body.error : '工作机报告失败，没有说明原因。')} : {})};
    this.store.db.transaction(() => {
      this.store.update('render_jobs_v2', {...job, takes: job.takes.map(t => t.n === take.n ? finished : t), updatedAt: finishedAt});
      if (status === 'rendered' && renderSeconds && session.mode === 'pull') this.recordRate(session, batch, clip.prompts[job.languages[0]!]?.mode ?? 'r2v', renderSeconds / clip.frames);
      const fresh = this.store.get('render_sessions', session.id)!;
      const event: SessionEvent = {at: finishedAt, stage: 'take_done', message: `${job.outputName} · take ${take.n} · ${status === 'rendered' ? '完成' : '失败'}`};
      this.store.update('render_sessions', {...fresh, lastResultAt: finishedAt, events: [...fresh.events, event].slice(-300)});
    })();
    return {ok: true};
  }

  private qa(value: unknown, files: Body, own: (value: unknown, kind: MediaKind) => MediaAsset | undefined): TakeQa | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const q = value as Body;
    const checks: QaCheck[] = (Array.isArray(q.checks) ? q.checks : []).slice(0, 60).flatMap(item => {
      const c = obj(item), id = typeof c.id === 'string' && /^[a-z_]{1,40}$/u.test(c.id) ? c.id : undefined;
      const status = c.status === 'pass' || c.status === 'warning' || c.status === 'failure' ? c.status : undefined;
      if (!id || !status) return [];
      const value = num(c.value, -1e9, 1e9);
      return [{id, status, message: scrub(typeof c.message === 'string' ? c.message : '', 300), ...(value !== undefined ? {value} : {})}];
    });
    const l = obj(q.loudness), integrated = num(l.integrated, -150, 30), truePeak = num(l.truePeak, -150, 30), range = num(l.range, 0, 200);
    const keyframes = (Array.isArray(files.keyframes) ? files.keyframes : []).slice(0, 40).flatMap(k => {
      const r = obj(k), shotId = typeof r.shotId === 'string' && /^[A-Za-z0-9_-]{1,40}$/u.test(r.shotId) ? r.shotId : undefined, asset = own(r.assetId, 'qa_image');
      return shotId && asset ? [{shotId, assetId: asset.id}] : [];
    });
    const contactSheet = own(files.contactSheet, 'qa_image'), data = own(files.qa, 'qa_data'), s = obj(q.speech);
    const lines: SpeechLine[] = (Array.isArray(s.lines) ? s.lines : []).slice(0, 120).flatMap(item => {
      const line = obj(item), score = num(line.score, 0, 1), position = num(line.position, 0, 100_000);
      if (score === undefined || position === undefined) return [];
      return [{sceneId: typeof line.sceneId === 'string' ? line.sceneId.slice(0, 40) : '', position: Math.round(position), language: typeof line.language === 'string' ? line.language.slice(0, 20) : '',
        expected: typeof line.expected === 'string' ? line.expected.slice(0, 500) : '', heard: typeof line.heard === 'string' ? scrub(line.heard, 1000) : '', score: round2(score)}];
    });
    return {checks, keyframes, ...(integrated !== undefined && truePeak !== undefined ? {loudness: {integrated, truePeak, ...(range !== undefined ? {range} : {})}} : {}),
      ...(contactSheet ? {contactSheet: contactSheet.id} : {}), ...(data ? {dataAssetId: data.id} : {}),
      ...(lines.length || typeof s.language === 'string' ? {speech: {...(typeof s.language === 'string' ? {language: s.language.slice(0, 20)} : {}), lines}} : {})};
  }

  private recordRate(session: RenderSession, batch: RenderBatch, mode: string, secondsPerFrame: number) {
    const preset = batch.preset!, stack = this.stacks.get(preset.stack.id), steps = preset.turbo ? stack?.turboSteps[mode] ?? 4 : preset.steps;
    const id = rateKey(preset.stack, preset.width, preset.height, steps, this.gpuLabel(stack, session.worker?.gpu ?? 'unknown GPU'));
    const row = this.store.get('render_rates', id);
    this.store.put('render_rates', {id, samples: [...(row?.samples ?? []), Math.round(secondsPerFrame * 1000) / 1000].slice(-20), updatedAt: this.now()});
  }

  /** The worker's last call: takes it still holds go back to the queue, the summary is kept and the token stops working. */
  private end(session: RenderSession, body: Body) {
    const reason = ENDS.includes(body.reason as SessionEnd) ? body.reason as SessionEnd : 'error';
    const endedAt = this.now(), project = this.store.get('projects', session.projectId);
    this.store.db.transaction(() => {
      const undelivered = this.releaseTakes(session.id);
      const takes = this.jobs(session.batchIds).flatMap(j => j.takes).filter(t => t.sessionId === session.id);
      const minutes = round1((this.nowMs() - Date.parse(session.startedAt ?? session.createdAt)) / 60_000), rate = project?.productionSettings?.computeUnitsPerHour;
      const message = typeof obj(body.summary).message === 'string' ? scrub(obj(body.summary).message as string) : undefined;
      const fresh = this.store.get('render_sessions', session.id)!;
      this.store.update('render_sessions', {...fresh, status: 'ended', end: reason, endedAt, tokenHash: null,
        summary: {minutes, ...(rate !== undefined && session.mode === 'pull' ? {computeUnits: round2(minutes / 60 * rate)} : {}), takesRendered: takes.filter(t => t.status === 'rendered').length,
          takesFailed: takes.filter(t => t.status === 'failed').length, undelivered, ...(message ? {message} : {})}});
    })();
    return {ok: true};
  }
}
