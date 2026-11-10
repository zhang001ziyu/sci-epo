/** Production tab: the series profile for MiniMax H3, render batches, and the three ways to reach a worker.
 * Every displayed value is escaped. A new worker token and the worker key stay in this page's memory only. */
import type { Episode, ProductionCharacter, ProductionProfile, ProjectBundle, RenderBatch, RenderJob, Revision, ShotList } from '../src/types';
import { DEFAULT_CLIP_LIMIT, EMPTY_PROFILE, MIN_CLIP_LIMIT, STYLE_PRESETS, framesToSeconds, outputName } from '../src/core/h3';
import { languageName, scriptLanguage } from '../src/core/languages';
import { normalizeSpeakerName } from '../src/core/scriptLines';
import { boundAdaptations, shotListStatus } from '../src/core/shotList';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
const STATUS: Record<RenderJob['status'], string> = {queued: '排队中', claimed: '渲染中', succeeded: '完成', failed: '失败'};
export const COLAB_NOTEBOOK = 'https://colab.research.google.com/github/zhang001ziyu/sci-epo/blob/main/worker/colab/sciepo_h3_worker.ipynb';
export const WORKER_DOCS = 'https://github.com/zhang001ziyu/sci-epo/blob/main/docs/production-bridge.md';

export interface PublicWorkerToken { id: string; label: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }
export interface ProductionHooks {
  run(label: string, action: () => Promise<void>): Promise<void>;
  api<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  setBundle(bundle: ProjectBundle): void;
  render(): void;
  notice(message: string): void;
  fail(message: string): void;
  origin(): string;
}
export interface ProductionContext { bundle: ProjectBundle; episode: Episode; revision: Revision; busy: boolean }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** The production shot list of the episode and whether it is current. */
export function productionList(bundle: ProjectBundle, episode: Episode): {list?: ShotList; current: boolean} {
  const list = (bundle.shotLists ?? []).find(l => l.id === episode.productionShotListId);
  return {...(list ? {list} : {}), current: !!list && shotListStatus(list, episode).current};
}

/** The saved profile plus an empty row for every cast member it does not describe yet. */
export function profileDraft(saved: ProductionProfile | undefined, list: ShotList | undefined): ProductionProfile {
  const profile = structuredClone(saved ?? EMPTY_PROFILE);
  for (const member of list?.cast ?? []) if (!profile.characters.some(c => normalizeSpeakerName(c.name) === normalizeSpeakerName(member.name))) profile.characters.push({name: member.name, appearance: '', voice: ''});
  return profile;
}

export function jobCounts(jobs: RenderJob[]) {
  return {succeeded: jobs.filter(j => j.status === 'succeeded').length, failed: jobs.filter(j => j.status === 'failed').length, claimed: jobs.filter(j => j.status === 'claimed').length, queued: jobs.filter(j => j.status === 'queued').length};
}

export class ProductionPanel {
  private draft: ProductionProfile | null = null;
  private draftFor = '';
  private tokens: PublicWorkerToken[] | null = null;
  private loadingTokens = false;
  private newToken: {label: string; token: string} | null = null;
  private tokenLabel = 'Colab';
  private workerUrl = '';
  private workerKey = '';
  private clipLimit = DEFAULT_CLIP_LIMIT;
  private languages: string[] | null = null;
  constructor(private hooks: ProductionHooks) {}

  reset(): void { this.draft = null; this.draftFor = ''; this.newToken = null; this.workerKey = ''; this.languages = null; this.tokens = null; }
  get changed(): boolean { return !!this.draft && this.draftFor !== '' && this.dirtyProfile; }
  private dirtyProfile = false;

  private syncDraft(ctx: ProductionContext, list: ShotList | undefined): ProductionProfile {
    const key = `${ctx.bundle.project.id}:${list?.id ?? ''}`;
    if (!this.draft || this.draftFor !== key) { this.draft = profileDraft(ctx.bundle.project.production, list); this.draftFor = key; this.dirtyProfile = false; }
    return this.draft;
  }
  private loadTokens(): void {
    if (this.tokens || this.loadingTokens) return;
    this.loadingTokens = true;
    void this.hooks.api<PublicWorkerToken[]>('/api/worker-tokens').then(tokens => { this.tokens = tokens; }).catch(() => { this.tokens = []; }).finally(() => { this.loadingTokens = false; this.hooks.render(); });
  }

  view(ctx: ProductionContext): string {
    const {bundle, episode, busy} = ctx, {list, current} = productionList(bundle, episode), disabled = busy ? 'disabled' : '';
    const profile = this.syncDraft(ctx, list);
    this.loadTokens();
    const intro = `<div class="section-title"><div><div class="eyebrow">PRODUCTION · MINIMAX H3</div><h2>把分镜表交给 H3。</h2></div></div><p class="muted">每个片段按配音语言各生成一次，H3 同时生成画面和这一语言的对白。Sci-epo 不运行模型，只排任务、写提示词、记录结果；渲染在 Colab 或你自己的 GPU 机器上进行，视频文件留在那里。</p>`;
    const state = !list
      ? '<div class="inline-warning">本集还没有制作版本的分镜表。先在分镜页采用一份分镜表，再回到这里生成渲染任务。<button class="text-button" data-action="tab" data-id="shots">去分镜页 →</button></div>'
      : !current ? '<div class="inline-warning">制作版本的分镜表已不对应本集当前定稿，不能生成新的渲染任务。请在分镜页为当前定稿采用新的分镜表。</div>'
      : `<p class="small muted">制作版本：${esc(list.shots.length)} 个镜头 · 画幅 ${esc(list.aspectRatio)} · 配音语言 ${list.voiceLanguages.map(l => esc(languageName(l))).join('、')}</p>`;
    return `<section class="production-view">${intro}${state}${this.profileView(profile, disabled)}${list && current ? this.batchForm(ctx, list, disabled) : ''}${this.batchesView(ctx, disabled)}${this.workersView(disabled)}</section>`;
  }

  private profileView(profile: ProductionProfile, disabled: string): string {
    const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'character';
    const row = (c: ProductionCharacter, i: number) => `<tr><th scope="row">${esc(c.name)}</th>
      <td><label class="sr-only" for="prod-appearance-${i}">${esc(c.name)} 的外貌</label><input id="prod-appearance-${i}" data-production-character="${i}" data-field="appearance" value="${esc(c.appearance)}" maxlength="600" placeholder="a woman in her twenties in a wet yellow delivery jacket" ${disabled}/></td>
      <td><label class="sr-only" for="prod-voice-${i}">${esc(c.name)} 的声音</label><input id="prod-voice-${i}" data-production-character="${i}" data-field="voice" value="${esc(c.voice)}" maxlength="300" placeholder="a dry, low female voice" ${disabled}/></td>
      <td><label class="sr-only" for="prod-image-${i}">${esc(c.name)} 的参考图</label><input id="prod-image-${i}" data-production-character="${i}" data-field="image" value="${esc(c.image ?? '')}" maxlength="124" placeholder="${esc(slug(c.name))}.png" ${disabled}/></td>
      <td><label class="sr-only" for="prod-sample-${i}">${esc(c.name)} 的声音样本</label><input id="prod-sample-${i}" data-production-character="${i}" data-field="voiceSample" value="${esc(c.voiceSample ?? '')}" maxlength="124" placeholder="${esc(slug(c.name))}.wav" ${disabled}/></td></tr>`;
    return `<section class="publication-panel production-profile"><div class="eyebrow">SERIES LOOK AND VOICES</div><h2>制作设定（整部系列共用）</h2>
      <p class="muted small">H3 的提示词正文用英文，所以这里也用英文写。外貌和声音写得越稳定，不同片段里的人物越像同一个人。填了参考图的角色会用 H3 的参考模式（R2V）；文件名只能用英文字母、数字、点、横线和下划线，文件放进工作机的参考文件夹。</p>
      <div class="publication-grid"><div><label class="field-label" for="prod-style">画面风格</label><input id="prod-style" list="prod-style-presets" data-production-field="style" value="${esc(profile.style)}" maxlength="300" placeholder="${esc(STYLE_PRESETS[0])}" ${disabled}/><datalist id="prod-style-presets">${STYLE_PRESETS.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist></div>
      <div><label class="field-label" for="prod-music">背景音乐（观众听得到、角色听不到）</label><input id="prod-music" data-production-field="music" value="${esc(profile.music)}" maxlength="300" placeholder="N/A" ${disabled}/></div></div>
      ${profile.characters.length ? `<div class="table-scroll"><table class="production-table"><thead><tr><th>角色</th><th>外貌</th><th>声音</th><th>参考图</th><th>声音样本</th></tr></thead><tbody>${profile.characters.map(row).join('')}</tbody></table></div>` : '<p class="small muted">采用分镜表后，这里会列出它的角色。</p>'}
      <div class="language-toolbar"><button class="button" data-action="production-save-profile" ${disabled}>保存制作设定</button>${this.dirtyProfile ? '<span class="small muted is-dirty">有未保存的修改</span>' : ''}</div></section>`;
  }

  private batchForm(ctx: ProductionContext, list: ShotList, disabled: string): string {
    const source = scriptLanguage(ctx.revision), bound = boundAdaptations(list, ctx.bundle.localizations);
    const available = list.voiceLanguages.filter(l => l === source || bound[l]);
    const chosen = (this.languages ?? available).filter(l => available.includes(l));
    const missing = list.voiceLanguages.filter(l => !available.includes(l));
    return `<section class="publication-panel"><div class="eyebrow">NEW RENDER BATCH</div><h2>生成渲染任务</h2>
      <p class="muted small">同一场里相邻的镜头合成一个片段，不超过片段上限；每个片段每种语言一个任务。生成任务不调用模型，提示词可以在下面逐条查看。</p>
      <div class="language-toolbar"><label for="prod-clip-limit">片段上限（秒）</label><input id="prod-clip-limit" class="small-input" type="number" min="${MIN_CLIP_LIMIT}" max="${DEFAULT_CLIP_LIMIT}" step="1" value="${esc(this.clipLimit)}" ${disabled}/>
      ${available.map(l => `<label class="check-label"><input type="checkbox" data-production-language="${esc(l)}" ${chosen.includes(l) ? 'checked' : ''} ${disabled}/><span>${esc(languageName(l))}</span></label>`).join('')}
      <button class="button primary" data-action="production-create-batch" data-id="${esc(list.id)}" ${disabled || (chosen.length ? '' : 'disabled')}>生成渲染任务</button></div>
      ${missing.length ? `<p class="small muted">${missing.map(l => esc(languageName(l))).join('、')} 没有绑定逐行对齐的改编，暂时不能出这一语言的视频。</p>` : ''}</section>`;
  }

  private batchesView(ctx: ProductionContext, disabled: string): string {
    const batches = (ctx.bundle.renderBatches ?? []).filter(b => b.episodeId === ctx.episode.id).slice().reverse();
    if (!batches.length) return '';
    return `<section class="production-batches"><h2>渲染批次</h2>${batches.map(b => this.batchView(ctx, b, disabled)).join('')}</section>`;
  }

  private batchView(ctx: ProductionContext, batch: RenderBatch, disabled: string): string {
    const jobs = (ctx.bundle.renderJobs ?? []).filter(j => j.batchId === batch.id), counts = jobCounts(jobs);
    const list = (ctx.bundle.shotLists ?? []).find(l => l.id === batch.shotListId), current = !!list && list.id === ctx.episode.productionShotListId && shotListStatus(list, ctx.episode).current;
    const warnings = [...batch.warnings, ...batch.clips.flatMap(c => c.warnings.map(w => `${c.id}：${w}`))];
    const cell = (clipId: string, language: string) => {
      const job = jobs.find(j => j.clipId === clipId && j.language === language);
      if (!job) return '<td>—</td>';
      const detail = job.status === 'succeeded' ? `<span class="small">${esc(job.output?.file)}${job.output?.seconds !== undefined ? ` · ${esc(job.output.seconds)} 秒` : ''}</span>`
        : job.status === 'failed' ? `<span class="small error-text">${esc(job.error)}</span><button class="text-button" data-action="production-requeue" data-id="${esc(job.id)}" ${disabled}>重新排队</button>`
        : job.status === 'claimed' ? `<span class="small muted">${esc(job.workerLabel)} · 租约到 ${esc(job.leaseExpiresAt ? date(job.leaseExpiresAt) : '')}</span>` : '';
      return `<td><span class="pill ${job.status === 'succeeded' ? 'accepted' : job.status === 'failed' ? 'changed' : ''}">${esc(STATUS[job.status])}</span>${detail}</td>`;
    };
    const rows = batch.clips.map(clip => `<tr><th scope="row">${esc(clip.id)}<span class="small muted">${esc(clip.shotIds.join('、'))} · 约 ${esc(clip.plannedSeconds)} 秒 → ${esc(clip.frames)} 帧（${esc(framesToSeconds(clip.frames))} 秒）· ${esc(Object.values(clip.prompts)[0]?.mode === 'r2v' ? '参考模式 R2V' : '文生 T2VA')}</span></th>${batch.languages.map(l => cell(clip.id, l)).join('')}</tr>
      <tr class="prompt-row"><td colspan="${batch.languages.length + 1}">${batch.languages.map(l => { const p = clip.prompts[l]; return p ? `<details><summary>${esc(languageName(l))} 提示词 · ${esc(outputName(ctx.episode.ordinal, clip.id, l))}${p.images.length ? ` · 参考图 ${esc(p.images.join('、'))}` : ''}${p.audio.length ? ` · 声音样本 ${esc(p.audio.join('、'))}` : ''}</summary><pre class="prompt-text">${esc(p.text)}</pre></details>` : ''; }).join('')}</td></tr>`).join('');
    return `<article class="render-batch"><div class="render-batch-head"><div><strong>${esc(date(batch.createdAt))} · ${esc(batch.clips.length)} 个片段 · ${batch.languages.map(l => esc(languageName(l))).join('、')}</strong><span class="small muted">${esc(batch.width)}×${esc(batch.height)} · ${esc(batch.fps)} fps · 片段上限 ${esc(batch.clipLimitSeconds)} 秒</span></div>
      <span class="pill ${current ? 'accepted' : 'changed'}">${current ? '当前制作版本' : '不是当前制作版本 · 工作机不会再领取'}</span>
      <span class="small">完成 ${counts.succeeded} · 失败 ${counts.failed} · 渲染中 ${counts.claimed} · 排队 ${counts.queued}</span></div>
      ${warnings.length ? `<div class="inline-warning"><strong>需要留意</strong><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="language-toolbar"><a class="button subtle small-button" href="/api/render-batches/${encodeURIComponent(batch.id)}/package" download>下载任务包 ↗</a>
      <label class="button subtle small-button file-button">上传结果 results.json<input type="file" accept=".json,application/json" data-production-results="${esc(batch.id)}" ${disabled}/></label></div>
      <div class="language-toolbar push-row"><label class="sr-only" for="push-url-${esc(batch.id)}">工作机地址</label><input id="push-url-${esc(batch.id)}" data-production-worker="url" value="${esc(this.workerUrl)}" placeholder="https://xxxx.trycloudflare.com" ${disabled}/>
      <label class="sr-only" for="push-key-${esc(batch.id)}">工作机密钥</label><input id="push-key-${esc(batch.id)}" type="password" autocomplete="off" data-production-worker="key" value="${esc(this.workerKey)}" placeholder="工作机密钥（不保存）" ${disabled}/>
      <button class="button small-button" data-action="production-push" data-id="${esc(batch.id)}" ${disabled || !current ? 'disabled' : ''}>发送到工作机</button><button class="button subtle small-button" data-action="production-sync" data-id="${esc(batch.id)}" ${disabled}>同步结果</button></div>
      <div class="table-scroll"><table class="production-table jobs-table"><thead><tr><th>片段</th>${batch.languages.map(l => `<th>${esc(languageName(l))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }

  private workersView(disabled: string): string {
    const origin = this.hooks.origin();
    const tokens = this.tokens === null ? '<p class="small muted">正在读取工作机令牌…</p>' : this.tokens.length
      ? `<ul class="token-list">${this.tokens.map(t => `<li><strong>${esc(t.label)}</strong><span class="small muted">创建 ${esc(date(t.createdAt))}${t.lastUsedAt ? ` · 最近使用 ${esc(date(t.lastUsedAt))}` : ' · 尚未使用'}</span>${t.revokedAt ? '<span class="pill">已撤销</span>' : `<button class="text-button" data-action="production-revoke-token" data-id="${esc(t.id)}" ${disabled}>撤销</button>`}</li>`).join('')}</ul>`
      : '<p class="small muted">还没有工作机令牌。</p>';
    const fresh = this.newToken ? `<div class="inline-warning token-once" role="status"><strong>${esc(this.newToken.label)} 的令牌只显示这一次</strong><input readonly value="${esc(this.newToken.token)}" aria-label="新的工作机令牌"/><span class="small">在 Colab 里放进“密钥”（Secrets）的 SCIEPO_WORKER_TOKEN，或在自己的机器上设为环境变量。离开这一页后无法再看到它；丢了就撤销后重建。</span><button class="text-button" data-action="production-hide-token">我已保存，隐藏</button></div>` : '';
    return `<section class="publication-panel workers-panel"><div class="eyebrow">WORKERS</div><h2>连接工作机</h2>
      <p class="muted small">三种方式用同一个工作机程序 <code>worker/sciepo_worker.py</code> 和同一份任务格式。Colab 和自己的 GPU 机器都可以用；推荐先打开 <a href="${esc(COLAB_NOTEBOOK)}" target="_blank" rel="noreferrer">Colab 笔记本</a>，详细说明见 <a href="${esc(WORKER_DOCS)}" target="_blank" rel="noreferrer">制作桥接文档</a>。</p>
      <ol class="worker-modes"><li><strong>任务包（离线也能用）</strong>：下载任务包 → 在工作机运行 <code>python sciepo_worker.py package --package 任务包.json --out 输出文件夹 --workflow h3_t2v_api.json</code> → 把输出文件夹里的 results.json 上传回来。</li>
      <li><strong>工作机自己领任务</strong>（Sci-epo 在网上时）：建一个令牌，在工作机运行 <code>python sciepo_worker.py pull --server ${esc(origin)} --out 输出文件夹 --workflow h3_t2v_api.json --wait</code>，令牌放在环境变量 SCIEPO_WORKER_TOKEN。</li>
      <li><strong>Sci-epo 推送给工作机</strong>（Sci-epo 在你电脑上时）：工作机运行 <code>serve</code> 并开隧道，把隧道地址和密钥填进上面的批次，点“发送到工作机”，渲染后点“同步结果”。</li></ol>
      ${fresh}${tokens}<div class="language-toolbar"><label class="sr-only" for="token-label">工作机名字</label><input id="token-label" data-production-token-label value="${esc(this.tokenLabel)}" maxlength="60" ${disabled}/><button class="button small-button" data-action="production-create-token" ${disabled}>新建工作机令牌</button></div></section>`;
  }

  input(el: Field): boolean {
    if (el.dataset.productionField && this.draft) { this.draft[el.dataset.productionField as 'style' | 'music'] = el.value; this.dirtyProfile = true; return true; }
    if (el.dataset.productionCharacter !== undefined && this.draft) {
      const character = this.draft.characters[Number(el.dataset.productionCharacter)], field = el.dataset.field as keyof ProductionCharacter;
      if (character && ['appearance', 'voice', 'image', 'voiceSample'].includes(field)) { (character as unknown as Record<string, string>)[field] = el.value; this.dirtyProfile = true; }
      return true;
    }
    if (el.dataset.productionWorker) { if (el.dataset.productionWorker === 'url') this.workerUrl = el.value.trim(); else this.workerKey = el.value; return true; }
    if (el.dataset.productionTokenLabel !== undefined) { this.tokenLabel = el.value; return true; }
    if (el.id === 'prod-clip-limit') { this.clipLimit = Number(el.value); return true; }
    return false;
  }

  change(el: Field, ctx?: ProductionContext): boolean {
    if (el.dataset.productionLanguage && ctx) {
      const {list} = productionList(ctx.bundle, ctx.episode), source = scriptLanguage(ctx.revision);
      const bound = list ? boundAdaptations(list, ctx.bundle.localizations) : {}, available = list ? list.voiceLanguages.filter(l => l === source || bound[l]) : [];
      const chosen = new Set(this.languages ?? available);
      if ((el as HTMLInputElement).checked) chosen.add(el.dataset.productionLanguage); else chosen.delete(el.dataset.productionLanguage);
      this.languages = available.filter(l => chosen.has(l));
      this.hooks.render();
      return true;
    }
    if (el.dataset.productionResults) {
      const file = (el as HTMLInputElement).files?.[0], batchId = el.dataset.productionResults;
      if (!file) return true;
      void this.hooks.run('正在读取结果文件…', async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(await file.text()); } catch { throw new Error('结果文件不是有效的 JSON。'); }
        const answer = await this.hooks.post<{applied: number; unchanged: number; ignored: number; bundle: ProjectBundle}>(`/api/render-batches/${encodeURIComponent(batchId)}/results`, parsed);
        this.hooks.setBundle(answer.bundle);
        this.hooks.notice(`已读取结果：更新 ${answer.applied} 个任务，${answer.unchanged} 个没有变化，${answer.ignored} 条跳过。`);
      });
      return true;
    }
    return this.input(el);
  }

  click(action: string, el: {dataset: DOMStringMap}, ctx: ProductionContext): boolean {
    const id = el.dataset.id ?? '';
    if (action === 'production-save-profile' && this.draft) {
      const profile = structuredClone(this.draft);
      void this.hooks.run('正在保存制作设定…', async () => {
        const bundle = await this.hooks.api<ProjectBundle>(`/api/projects/${encodeURIComponent(ctx.bundle.project.id)}/production`, {method: 'PUT', body: JSON.stringify(profile)});
        this.hooks.setBundle(bundle); this.draft = null; this.dirtyProfile = false;
        this.hooks.notice('制作设定已保存。它不属于剧本设定，不会让任何一集需要复核。');
      });
      return true;
    }
    if (action === 'production-create-batch') {
      if (this.dirtyProfile) { this.hooks.fail('制作设定有未保存的修改。先保存，再生成渲染任务。'); return true; }
      const body = {clipLimitSeconds: this.clipLimit, ...(this.languages ? {languages: this.languages} : {})};
      void this.hooks.run('正在生成渲染任务…', async () => {
        this.hooks.setBundle(await this.hooks.post<ProjectBundle>(`/api/shot-lists/${encodeURIComponent(id)}/render-batches`, body));
        this.hooks.notice('渲染任务已生成。可以下载任务包，或让工作机来领取。');
      });
      return true;
    }
    if (action === 'production-requeue') {
      void this.hooks.run('正在重新排队…', async () => { this.hooks.setBundle(await this.hooks.post<ProjectBundle>(`/api/render-jobs/${encodeURIComponent(id)}/requeue`, {})); this.hooks.notice('任务已重新排队。'); });
      return true;
    }
    if (action === 'production-push' || action === 'production-sync') {
      const target = {url: this.workerUrl, key: this.workerKey};
      if (!target.url || !target.key) { this.hooks.fail('先填写工作机地址和密钥。'); return true; }
      void this.hooks.run(action === 'production-push' ? '正在发送到工作机…' : '正在向工作机同步结果…', async () => {
        if (action === 'production-push') {
          const answer = await this.hooks.post<{sent: boolean; accepted?: number}>(`/api/render-batches/${encodeURIComponent(id)}/push`, target);
          this.hooks.notice(answer.accepted !== undefined ? `已发送，工作机排上了 ${answer.accepted} 个任务。渲染完成后点“同步结果”。` : '已发送到工作机。');
        } else {
          const answer = await this.hooks.post<{applied: number; unchanged: number; ignored: number; bundle: ProjectBundle}>(`/api/render-batches/${encodeURIComponent(id)}/sync`, target);
          this.hooks.setBundle(answer.bundle);
          this.hooks.notice(`已同步：更新 ${answer.applied} 个任务，${answer.unchanged} 个没有变化，${answer.ignored} 条跳过。`);
        }
      });
      return true;
    }
    if (action === 'production-create-token') {
      const label = this.tokenLabel.trim();
      void this.hooks.run('正在创建工作机令牌…', async () => {
        const answer = await this.hooks.post<{token: string; tokens: PublicWorkerToken[]}>('/api/worker-tokens', {label});
        this.tokens = answer.tokens; this.newToken = {label, token: answer.token};
      });
      return true;
    }
    if (action === 'production-revoke-token') {
      void this.hooks.run('正在撤销令牌…', async () => { this.tokens = await this.hooks.post<PublicWorkerToken[]>(`/api/worker-tokens/${encodeURIComponent(id)}/revoke`, {}); this.hooks.notice('令牌已撤销，用它的工作机不能再领取任务。'); });
      return true;
    }
    if (action === 'production-hide-token') { this.newToken = null; this.hooks.render(); return true; }
    return false;
  }
}
