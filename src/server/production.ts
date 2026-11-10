/** Production bridge: the series profile, render batches, job packages, results, worker tokens,
 * the bearer-token worker API, and push/sync to a worker URL. Video files never pass through Sci-epo. */
import { createHash, randomBytes } from 'node:crypto';
import type { RenderBatch, RenderJob, WorkerToken } from '../types';
import { EMPTY_PROFILE, RENDER_RESULTS_FORMAT, RenderPlanError, parseProductionProfile, parseRenderResults, planRenderBatch, renderPackage, type RenderResult } from '../core/h3';
import { boundAdaptations, shotListStatus } from '../core/shotList';
import type { Store } from './store';

type Fail = (status: number, message: string) => never;
export interface ProductionOptions { clock?: () => Date; transport?: typeof fetch; leaseMinutes?: number }
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
  constructor(private store: Store, private fail: Fail, private id: () => string, options: ProductionOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.transport = options.transport ?? fetch;
    this.leaseMs = (options.leaseMinutes ?? 60) * 60_000;
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
      const body = JSON.stringify(this.package(this.batch(target)), null, 2);
      return new Response(body, {headers: {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="sciepo-render-${target}.json"`}});
    }
    if (a === 'worker-tokens' && !target) return this.tokens();
    return undefined;
  }

  /** Owner POST and PUT routes; undefined when the path is not a production route. */
  async post(method: string, a: string | undefined, target: string | undefined, action: string | undefined, body: Record<string, unknown>): Promise<unknown | undefined> {
    if (a === 'projects' && target && action === 'production' && method === 'PUT') return this.saveProfile(target, body);
    if (method !== 'POST') return undefined;
    if (a === 'shot-lists' && target && action === 'render-batches') return this.createBatch(target, body);
    if (a === 'render-batches' && target && action === 'results') return this.applyResults(this.batch(target), body, '结果文件');
    if (a === 'render-batches' && target && action === 'push') return this.push(this.batch(target), body);
    if (a === 'render-batches' && target && action === 'sync') return this.sync(this.batch(target), body);
    if (a === 'render-jobs' && target && action === 'requeue') return this.requeue(target);
    if (a === 'worker-tokens' && !target) return this.createToken(body);
    if (a === 'worker-tokens' && target && action === 'revoke') return this.revokeToken(target);
    return undefined;
  }

  private saveProfile(projectId: string, body: Record<string, unknown>) {
    const project = this.store.get('projects', projectId) ?? this.fail(404, '找不到系列。');
    let production;
    try { production = parseProductionProfile(body); } catch (error) { return this.fail(400, error instanceof Error ? error.message : '制作设定无效。'); }
    // Outside the frozen brief and the context token: saving it never marks episodes for recheck.
    this.store.update('projects', {...project, production, updatedAt: this.now()});
    return this.store.bundle(project.id);
  }

  private createBatch(listId: string, body: Record<string, unknown>) {
    const list = this.store.get('shot_lists', listId) ?? this.fail(404, '找不到分镜表。');
    const episode = this.store.get('episodes', list.episodeId) ?? this.fail(404, '找不到集数。');
    if (!shotListStatus(list, episode).current) this.fail(409, '只有当前制作版本的分镜表才能生成渲染任务。请先在分镜页采用它，并确认本集定稿没有变化。');
    const revision = this.store.get('revisions', list.sourceRevisionId) ?? this.fail(404, '找不到剧本版本。');
    const project = this.store.get('projects', episode.projectId) ?? this.fail(404, '找不到系列。');
    const languages = body.languages === undefined ? undefined : Array.isArray(body.languages) && body.languages.length <= 6 && body.languages.every(l => typeof l === 'string') ? body.languages as string[] : this.fail(400, '配音语言格式无效。');
    const clipLimitSeconds = body.clipLimitSeconds === undefined ? undefined : typeof body.clipLimitSeconds === 'number' ? body.clipLimitSeconds : this.fail(400, '片段上限需为数字。');
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
