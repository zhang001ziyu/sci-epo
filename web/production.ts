/** Production tab: the series profile and cast references, render batches with their review and render sessions,
 * and the older ways to reach a worker for version 1 batches.
 * Every displayed value is escaped. Session codes, a new worker token and the worker key stay in this page's memory only. */
import type { Caption, Cut, CutSettings, CutSize, Episode, MediaAsset, ProductionCharacter, ProductionProfile, ProjectBundle, PublicRenderSession, ReadinessItem, RenderBatch, RenderJob, RenderJobV2, RenderSession, RetakeReason, Revision, ShotList } from '../src/types';
import { CUT_SETTING_RANGES, cutCurrent, cutSelection } from '../src/core/cut';
import { readinessItems } from '../src/core/readiness';
import { DEFAULT_CLIP_LIMIT, EMPTY_PROFILE, MIN_CLIP_LIMIT, STYLE_PRESETS, framesToSeconds, outputName } from '../src/core/h3';
import { languageName, scriptLanguage } from '../src/core/languages';
import { MEDIA_KINDS, formatBytes } from '../src/core/mediaKinds';
import { normalizeSpeakerName } from '../src/core/scriptLines';
import { boundAdaptations, shotListStatus } from '../src/core/shotList';
import { RETAKE_REASONS, codeOnce, countsView, cutForm, cutSignOff, cutView, isLiveSession, jobCell, mediaUrl, musicUpload, referenceChanges, reviewPanel, sessionLive, sessionStart, sessionSummary, type CutFormDraft } from './productionV2';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
const STATUS: Record<RenderJob['status'], string> = {queued: '排队中', claimed: '渲染中', succeeded: '完成', failed: '失败'};
export const COLAB_NOTEBOOK = 'https://colab.research.google.com/github/zhang001ziyu/sci-epo/blob/main/worker/colab/sciepo_h3_worker.ipynb';
export const WORKER_DOCS = 'https://github.com/zhang001ziyu/sci-epo/blob/main/docs/production-bridge.md';
export { SESSION_NOTEBOOK, takeCounts } from './productionV2';
/** Render sizes of v2 batches: the cheaper one first, as the server's default, then H3's native size. */
export const RENDER_SIZES: Record<ShotList['aspectRatio'], {value: string; label: string}[]> = {
  '9:16': [{value: '480x864', label: '480×864 · 省算力'}, {value: '768x1344', label: '768×1344 · H3 原生尺寸'}],
  '16:9': [{value: '864x480', label: '864×480 · 省算力'}, {value: '1344x768', label: '1344×768 · H3 原生尺寸'}],
};
export const POLL_MS = 5000;
const READINESS_STATUS: Record<ReadinessItem['status'], string> = {passed: '通过', warning: '提醒', failed: '未通过'};
const TAB_LABELS: Record<ReadinessItem['link']['tab'], string> = {script: '剧本', review: '审稿', languages: '语言与发布', shots: '分镜', production: '制作设定'};

export interface PublicWorkerToken { id: string; label: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }
/** GET /api/render-batches/:id/cut-plan */
export interface CutPlanAnswer { captions: Caption[]; missing: string[]; seconds: number; pictureLanguage: string; settings: CutSettings; sizes: CutSize[]; musicRequired: boolean; ffmpeg: {found: boolean; hint?: string} }
export interface PanelTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface ProductionHooks {
  run(label: string, action: () => Promise<void>): Promise<void>;
  api<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** PUT a raw file with the CSRF header; a JSON {error} answer becomes the thrown message, as in api(). */
  upload<T>(path: string, file: Blob): Promise<T>;
  setBundle(bundle: ProjectBundle): void;
  render(): void;
  /** Re-render only the regions marked data-live, so polling keeps focus, typed text and a playing video. Falls back to render(). */
  patch?(): void;
  notice(message: string): void;
  fail(message: string): void;
  origin(): string;
  copy?(text: string): Promise<void>;
  confirm?(message: string): boolean;
  /** Timers and clock for polling and elapsed time; tests replace them. */
  timers?: PanelTimers;
  now?(): number;
}
/** videoStorage: 'drive' when take and cut videos live in Google Drive and cuts are made by a session's worker. */
export interface ProductionContext { bundle: ProjectBundle; episode: Episode; revision: Revision; busy: boolean; videoStorage?: 'media' | 'drive' }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const defaultTimers: PanelTimers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)};

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

/** Media bytes of a project, counting each stored file once. */
export function mediaUsage(media: MediaAsset[]): number {
  return [...new Map(media.map(m => [m.sha256, m.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** The open readiness items' IDs in checklist order: a changed checklist needs a new confirmation. */
const readinessSignature = (items: ReadinessItem[]) => items.filter(i => i.status !== 'passed').map(i => i.id).join('\n');

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
  private size = '';
  private steps = 20;
  private turbo = false;
  private musicMode: 'bed' | 'native' = 'bed';
  private review: {jobId: string; take?: number} | null = null;
  private reasons = new Set<RetakeReason>();
  private note = '';
  /** The newest copy of each session this page has read; GET /api/render-sessions notices lost and expired sessions. */
  private sessions = new Map<string, PublicRenderSession>();
  private code: {sessionId: string; code: string} | null = null;
  private copied = false;
  private sessionDrafts = new Map<string, {mode: RenderSession['mode']; budget: string}>();
  private readings = new Map<string, {before?: string; after?: string}>();
  private rate: string | null = null;
  private showMedia = false;
  /** Open final-cut forms by "batch:language", the sign-off notes by cut and the license note of the next music upload. */
  private cutForms = new Map<string, CutFormDraft>();
  private cutNotes = new Map<string, string>();
  private musicLicense = '';
  /** The IDs of the open readiness items the author confirmed, joined; a changed checklist needs a new confirmation. */
  private readinessConfirmed = '';
  private timer: unknown = undefined;
  private polling = false;
  private generation = 0;
  private lastPoll = 0;
  private pollError = '';
  private bundleEpoch = 0;
  private readonly timers: PanelTimers;
  constructor(private hooks: ProductionHooks) { this.timers = hooks.timers ?? defaultTimers; }

  reset(): void {
    this.draft = null; this.draftFor = ''; this.newToken = null; this.workerKey = ''; this.languages = null; this.tokens = null;
    this.stopTimer(); this.generation++; this.polling = false; this.lastPoll = 0; this.pollError = '';
    this.sessions.clear(); this.code = null; this.copied = false; this.review = null; this.reasons.clear(); this.note = '';
    this.sessionDrafts.clear(); this.readings.clear(); this.rate = null; this.showMedia = false;
    this.cutForms.clear(); this.cutNotes.clear(); this.musicLicense = ''; this.readinessConfirmed = '';
  }
  get changed(): boolean { return !!this.draft && this.draftFor !== '' && this.dirtyProfile; }
  /** True while a polling timer is waiting to fire. */
  get pollingScheduled(): boolean { return this.timer !== undefined; }
  private dirtyProfile = false;
  private now(): number { return this.hooks.now?.() ?? Date.now(); }
  private setBundle(bundle: ProjectBundle): void { this.bundleEpoch++; this.hooks.setBundle(bundle); }

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
    const intro = `<div class="section-title"><div><div class="eyebrow">PRODUCTION · MINIMAX H3</div><h2>把分镜表交给 H3。</h2></div></div><p class="muted">每个片段按配音语言出提示词，H3 同时生成画面和这一语言的对白；没有台词差别的片段，所有语言共用一次渲染。Sci-epo 不运行模型：它排任务、写提示词，在渲染会话里把任务交给 Colab，收回视频和质检结果供你审片。</p>`;
    const state = !list
      ? '<div class="inline-warning">本集还没有制作版本的分镜表。先在分镜页采用一份分镜表，再回到这里生成渲染任务。<button class="text-button" data-action="tab" data-id="shots">去分镜页 →</button></div>'
      : !current ? '<div class="inline-warning">制作版本的分镜表已不对应本集当前定稿，不能生成新的渲染任务。请在分镜页为当前定稿采用新的分镜表。</div>'
      : `<p class="small muted">制作版本：${esc(list.shots.length)} 个镜头 · 画幅 ${esc(list.aspectRatio)} · 配音语言 ${list.voiceLanguages.map(l => esc(languageName(l))).join('、')}</p>`;
    const html = `<section class="production-view">${intro}${state}${this.profileView(ctx, profile, disabled)}${list && current ? this.batchForm(ctx, list, disabled) : ''}${this.batchesView(ctx, disabled)}${this.workersView(disabled)}</section>`;
    this.schedule(ctx);
    return html;
  }

  private profileView(ctx: ProductionContext, profile: ProductionProfile, disabled: string): string {
    const row = (c: ProductionCharacter, i: number) => `<tr><th scope="row">${esc(c.name)}</th>
      <td><label class="sr-only" for="prod-appearance-${i}">${esc(c.name)} 的外貌</label><input id="prod-appearance-${i}" data-production-character="${i}" data-field="appearance" value="${esc(c.appearance)}" maxlength="600" placeholder="a woman in her twenties in a wet yellow delivery jacket" ${disabled}/></td>
      <td><label class="sr-only" for="prod-voice-${i}">${esc(c.name)} 的声音</label><input id="prod-voice-${i}" data-production-character="${i}" data-field="voice" value="${esc(c.voice)}" maxlength="300" placeholder="a dry, low female voice" ${disabled}/></td></tr>`;
    return `<section class="publication-panel production-profile"><div class="eyebrow">SERIES LOOK AND VOICES</div><h2>制作设定（整部系列共用）</h2>
      <p class="muted small">H3 的提示词正文用英文，所以这里也用英文写。外貌和声音写得越稳定，不同片段里的人物越像同一个人。有参考图的角色用 H3 的参考模式（R2V）。</p>
      <div class="publication-grid"><div><label class="field-label" for="prod-style">画面风格</label><input id="prod-style" list="prod-style-presets" data-production-field="style" value="${esc(profile.style)}" maxlength="300" placeholder="${esc(STYLE_PRESETS[0])}" ${disabled}/><datalist id="prod-style-presets">${STYLE_PRESETS.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist></div>
      <div><label class="field-label" for="prod-music">背景音乐（观众听得到、角色听不到）</label><input id="prod-music" data-production-field="music" value="${esc(profile.music)}" maxlength="300" placeholder="N/A" ${disabled}/></div></div>
      ${profile.characters.length ? `<div class="table-scroll"><table class="production-table"><thead><tr><th>角色</th><th>外貌</th><th>声音</th></tr></thead><tbody>${profile.characters.map(row).join('')}</tbody></table></div>` : '<p class="small muted">采用分镜表后，这里会列出它的角色。</p>'}
      <div class="language-toolbar"><button class="button" data-action="production-save-profile" ${disabled}>保存制作设定</button>${this.dirtyProfile ? '<span class="small muted is-dirty">有未保存的修改</span>' : ''}</div>${this.castView(ctx, profile, disabled)}</section>`;
  }

  /** Cast and references: the approved portrait next to the appearance text, uploads and the switch. References take effect at once. */
  private castView(ctx: ProductionContext, profile: ProductionProfile, disabled: string): string {
    if (!profile.characters.length) return '';
    const saved = ctx.bundle.project.production?.characters ?? [];
    const card = (c: ProductionCharacter) => {
      const stored = saved.find(s => normalizeSpeakerName(s.name) === normalizeSpeakerName(c.name)), portrait = stored?.portrait, voice = stored?.voiceSampleAsset, name = esc(c.name);
      const legacy = [c.image, c.voiceSample].filter((v): v is string => !!v);
      const picture = portrait ? `<img src="${esc(mediaUrl(portrait.assetId))}" alt="${name} 的参考图" loading="lazy"/>` : '<span>还没有参考图</span>';
      const portraitActions = `<label class="button subtle small-button file-button">${portrait ? '换一张参考图' : '上传参考图'}<input type="file" accept="image/png,image/jpeg,image/webp" data-production-upload="portrait" data-character="${name}" aria-label="${name} 的参考图" ${disabled}/></label>`
        + (portrait ? `<label class="check-label"><input type="checkbox" data-production-use-portrait="${name}" ${stored?.usePortrait !== false ? 'checked' : ''} ${disabled}/><span>使用参考图</span></label><button class="text-button" data-action="production-unlink" data-id="${name}" data-kind="portrait" ${disabled}>移除参考图</button>` : '');
      const voiceActions = (voice ? `<audio controls preload="none" src="${esc(mediaUrl(voice.assetId))}" aria-label="${name} 的声音样本"></audio><button class="text-button" data-action="production-unlink" data-id="${name}" data-kind="voice" ${disabled}>移除声音样本</button>` : '')
        + `<label class="button subtle small-button file-button">${voice ? '换一个声音样本' : '上传声音样本（可选）'}<input type="file" accept="audio/wav,audio/x-wav,audio/mpeg,audio/flac,.wav,.mp3,.flac" data-production-upload="voice" data-character="${name}" aria-label="${name} 的声音样本" ${disabled}/></label>`;
      return `<article class="cast-card"><div class="cast-portrait">${picture}</div><div class="cast-body"><strong>${name}</strong><p class="small cast-appearance">${c.appearance ? esc(c.appearance) : '<span class="muted">还没有外貌描述</span>'}</p>`
        + `<div class="cast-actions">${portraitActions}</div><div class="cast-actions">${voiceActions}</div>`
        + `${legacy.length ? `<p class="small muted">旧版文件名 ${legacy.map(esc).join('、')} 只用于旧版批次。<button class="text-button" data-action="production-clear-legacy" data-id="${name}" ${disabled}>清除</button></p>` : ''}</div></article>`;
    };
    return `<div class="cast-panel"><div class="eyebrow">CAST AND REFERENCES</div><h3>演员与参考</h3><p class="small muted">参考图要和外貌描述一致：图里有而文字没写的东西（比如兜帽）也会出现在片段里。上传和开关立即生效，不用再保存制作设定；已经生成的批次继续用当时的参考。</p>`
      + `<div class="cast-grid">${profile.characters.map(card).join('')}</div>${this.mediaView(ctx, disabled)}</div>`;
  }

  private mediaView(ctx: ProductionContext, disabled: string): string {
    const media = ctx.bundle.media ?? [];
    if (!media.length) return '';
    const owned = media.filter(m => m.origin === 'owner');
    const list = !this.showMedia ? '' : owned.length
      ? `<ul class="media-list">${owned.map(m => `<li>${m.kind === 'reference_image' ? `<img class="media-thumb" src="${esc(mediaUrl(m.id))}" alt="" loading="lazy"/>` : ''}<span><strong>${esc(MEDIA_KINDS[m.kind].label)}</strong> ${esc(m.label ?? '')} · ${esc(formatBytes(m.bytes))} · ${esc(date(m.createdAt))}${m.license ? ` · ${esc(m.license)}` : ''}</span><button class="text-button" data-action="production-delete-media" data-id="${esc(m.id)}" ${disabled}>删除</button></li>`).join('')}</ul><p class="small muted">正在用作参考、属于已通过 take 的文件不能删除。</p>`
      : '<p class="small muted">还没有你上传的文件。</p>';
    return `<div class="media-usage"><span class="small muted">媒体库：本系列 ${esc(media.length)} 个文件，共 ${esc(formatBytes(mediaUsage(media)))}。</span><button class="text-button" data-action="production-toggle-media" ${disabled}>${this.showMedia ? '收起' : '管理我上传的文件'}</button></div>${list}`;
  }

  /** The checklist for a batch in the chosen languages, computed the way the server checks it. */
  private readiness(ctx: ProductionContext): ReadinessItem[] {
    const {episode, bundle} = ctx, revision = bundle.revisions.find(r => r.id === episode.acceptedRevisionId), list = productionList(bundle, episode).list;
    const shotReview = list ? bundle.shotReviews?.find(r => r.id === list.id) : undefined;
    return readinessItems({episode, logicChecks: bundle.logicChecks ?? [], ...(revision ? {revision} : {}), ...(list ? {list} : {}), ...(shotReview ? {shotReview} : {}), reviews: bundle.reviews, localizations: bundle.localizations,
      ...(bundle.project.production ? {profile: bundle.project.production} : {}), ...(this.languages ? {languages: this.languages} : {})});
  }

  private readinessView(items: ReadinessItem[], disabled: string): string {
    const counts = {passed: 0, warning: 0, failed: 0};
    for (const item of items) counts[item.status]++;
    const open = items.filter(i => i.status !== 'passed').sort((a, b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1));
    const confirmed = !!open.length && this.readinessConfirmed === readinessSignature(items);
    const row = (i: ReadinessItem) => `<li class="readiness-${esc(i.status)}"><span class="pill ${i.status === 'passed' ? 'accepted' : i.status === 'failed' ? 'changed' : ''}">${esc(READINESS_STATUS[i.status])}</span><span>${esc(i.message)}</span>`
      + `${i.status === 'passed' ? '' : `<button class="text-button" data-action="tab" data-id="${esc(i.link.tab)}">去${esc(TAB_LABELS[i.link.tab])} →</button>`}</li>`;
    return `<div class="readiness"><h3>开拍清单</h3><p class="small">${counts.failed ? `<strong>${esc(counts.failed)} 项未通过</strong> · ` : ''}${esc(counts.warning)} 项提醒 · ${esc(counts.passed)} 项通过</p>`
      + `${open.length ? `<ul class="readiness-list">${open.map(row).join('')}</ul>` : '<p class="small">都通过了，可以开拍。</p>'}`
      + `${items.some(i => i.status === 'passed') ? `<details><summary class="small">已通过的 ${esc(counts.passed)} 项</summary><ul class="readiness-list">${items.filter(i => i.status === 'passed').map(row).join('')}</ul></details>` : ''}`
      + `${open.length ? `<label class="check-label readiness-confirm"><input type="checkbox" data-production-readiness-confirm ${confirmed ? 'checked' : ''} ${disabled}/><span>我已逐项看过上面 ${esc(open.length)} 项，确认带着这些问题开拍。确认会记在这一批里，并写进交付报告。</span></label>` : ''}</div>`;
  }

  private batchForm(ctx: ProductionContext, list: ShotList, disabled: string): string {
    const source = scriptLanguage(ctx.revision), bound = boundAdaptations(list, ctx.bundle.localizations);
    const available = list.voiceLanguages.filter(l => l === source || bound[l]);
    const chosen = (this.languages ?? available).filter(l => available.includes(l));
    const items = this.readiness(ctx), open = items.filter(i => i.status !== 'passed'), ready = !open.length || this.readinessConfirmed === readinessSignature(items);
    const missing = list.voiceLanguages.filter(l => !available.includes(l));
    const sizes = RENDER_SIZES[list.aspectRatio], size = sizes.some(s => s.value === this.size) ? this.size : sizes[0]!.value;
    return `<section class="publication-panel"><div class="eyebrow">NEW RENDER BATCH</div><h2>生成渲染任务</h2>${this.readinessView(items, disabled)}
      <p class="muted small">同一场里相邻的镜头合成一个片段，不超过片段上限。生成任务不调用模型，提示词可以在审片时逐条查看。</p>
      <div class="language-toolbar"><label for="prod-size">渲染尺寸</label><select id="prod-size" data-production-batch="size" ${disabled}>${sizes.map(s => `<option value="${esc(s.value)}" ${s.value === size ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      <label for="prod-steps">采样步数</label><input id="prod-steps" class="small-input" type="number" min="1" max="60" step="1" value="${esc(this.steps)}" data-production-batch="steps" ${disabled}/>
      <label class="check-label"><input type="checkbox" data-production-batch="turbo" ${this.turbo ? 'checked' : ''} ${disabled}/><span>加速（turbo LoRA：步数由工作机栈决定，细节可能少一些）</span></label></div>
      <div class="language-toolbar"><label for="prod-music-mode">配乐</label><select id="prod-music-mode" data-production-batch="musicMode" ${disabled}><option value="bed" ${this.musicMode === 'bed' ? 'selected' : ''}>整集配乐（bed）</option><option value="native" ${this.musicMode === 'native' ? 'selected' : ''}>片段自带配乐（native）</option></select>
      <span class="small muted">整集配乐：片段里不生成背景音乐，剪辑时铺一条连续的配乐；片段自带的配乐每段各不相同，接起来会断开。</span></div>
      <div class="language-toolbar"><label for="prod-clip-limit">片段上限（秒）</label><input id="prod-clip-limit" class="small-input" type="number" min="${MIN_CLIP_LIMIT}" max="${DEFAULT_CLIP_LIMIT}" step="1" value="${esc(this.clipLimit)}" ${disabled}/>
      ${available.map(l => `<label class="check-label"><input type="checkbox" data-production-language="${esc(l)}" ${chosen.includes(l) ? 'checked' : ''} ${disabled}/><span>${esc(languageName(l))}</span></label>`).join('')}
      <button class="button primary" data-action="production-create-batch" data-id="${esc(list.id)}" ${disabled || (chosen.length && ready ? '' : 'disabled')}>生成渲染任务</button></div>
      ${missing.length ? `<p class="small muted">${missing.map(l => esc(languageName(l))).join('、')} 没有绑定逐行对齐的改编，暂时不能出这一语言的视频。</p>` : ''}</section>`;
  }

  private batchesView(ctx: ProductionContext, disabled: string): string {
    const batches = (ctx.bundle.renderBatches ?? []).filter(b => b.episodeId === ctx.episode.id).slice().reverse();
    if (!batches.length) return '';
    const rate = batches.some(b => b.version === 2) ? this.rateView(ctx, disabled) : '';
    return `<section class="production-batches"><h2>渲染批次</h2>${rate}${batches.map(b => b.version === 2 ? this.batchViewV2(ctx, b, disabled) : this.batchView(ctx, b, disabled)).join('')}</section>`;
  }

  private rateView(ctx: ProductionContext, disabled: string): string {
    const saved = ctx.bundle.project.productionSettings?.computeUnitsPerHour;
    return `<div class="language-toolbar compute-rate"><label for="prod-cu-rate">计算单元单价（每小时）</label><input id="prod-cu-rate" class="small-input" type="number" min="0" max="1000" step="0.01" value="${esc(this.rate ?? saved ?? '')}" data-production-rate ${disabled}/><button class="button subtle small-button" data-action="production-save-rate" ${disabled}>保存单价</button>`
      + '<span class="small muted">Colab 在“代码执行程序 → 查看资源”里显示当前运行时每小时用多少计算单元。填上后会估算每个会话的花费；留空就不估算。</span></div>';
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

  /** A v2 batch: preset, separate counts, the clip × language grid, the review panel and the render session. */
  private batchViewV2(ctx: ProductionContext, batch: RenderBatch, disabled: string): string {
    const jobs = (ctx.bundle.renderJobsV2 ?? []).filter(j => j.batchId === batch.id).sort((a, b) => a.order - b.order);
    const list = (ctx.bundle.shotLists ?? []).find(l => l.id === batch.shotListId), current = !!list && list.id === ctx.episode.productionShotListId && shotListStatus(list, ctx.episode).current;
    const warnings = [...batch.warnings, ...batch.clips.flatMap(c => c.warnings.map(w => `${c.id}：${w}`))], changes = referenceChanges(batch, ctx.bundle.project.production);
    const preset = batch.preset, references = batch.references ?? [], selected = this.review?.jobId;
    const rows = batch.clips.map(clip => {
      const jobFor = (language: string) => jobs.find(j => j.clipId === clip.id && j.languages.includes(language));
      const cells: string[] = [];
      for (let i = 0; i < batch.languages.length;) {
        const job = jobFor(batch.languages[i]!);
        let span = 1;
        while (job && i + span < batch.languages.length && jobFor(batch.languages[i + span]!) === job) span++;
        cells.push(jobCell(job, {span, selected: !!job && job.id === selected, disabled}));
        i += span;
      }
      const mode = Object.values(clip.prompts)[0]?.mode === 'r2v' ? '参考模式 R2V' : '文生 T2VA';
      return `<tr><th scope="row">${esc(clip.id)}<span class="small muted">${esc(clip.shotIds.join('、'))} · 约 ${esc(clip.plannedSeconds)} 秒 → ${esc(clip.frames)} 帧（${esc(framesToSeconds(clip.frames))} 秒）· ${mode}</span></th>${cells.join('')}</tr>`;
    }).join('');
    const settings = [preset ? `${preset.width}×${preset.height}` : `${batch.width}×${batch.height}`, ...(preset ? [`${preset.steps} 步${preset.turbo ? ' · 加速' : ''}`] : []), batch.musicMode === 'native' ? '片段自带配乐' : '整集配乐', `片段上限 ${batch.clipLimitSeconds} 秒`, ...(preset ? [`工作机栈 ${preset.stack.id} ${preset.stack.version}`] : [])];
    const used = references.length ? `参考：${references.map(r => `${r.character} 的${r.kind === 'image' ? '参考图' : '声音样本'}`).join('、')}` : '没有用参考图或声音样本';
    const head = `<div class="render-batch-head"><div><strong>${esc(date(batch.createdAt))} · ${esc(batch.clips.length)} 个片段 · ${esc(jobs.length)} 个渲染任务 · ${batch.languages.map(l => esc(languageName(l))).join('、')}</strong><span class="small muted">${settings.map(esc).join(' · ')}</span><span class="small muted">${esc(used)}</span></div>`
      + `<span class="pill ${current ? 'accepted' : 'changed'}">${current ? '当前制作版本' : '不是当前制作版本 · 不能再渲染或重拍'}</span></div>`;
    const reviewJob = selected ? jobs.find(j => j.id === selected) : undefined;
    return `<article class="render-batch render-batch-v2">${head}${countsView(batch.id, jobs)}`
      + `${warnings.length ? `<div class="inline-warning"><strong>需要留意</strong><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}`
      + `${changes.length ? `<div class="inline-warning"><strong>系列的参考已经变了</strong><ul>${changes.map(w => `<li>${esc(w)}</li>`).join('')}</ul><span class="small">要用现在的参考，请生成新的渲染批次。</span></div>` : ''}`
      + `<div class="table-scroll"><table class="production-table jobs-table"><thead><tr><th>片段</th>${batch.languages.map(l => `<th>${esc(languageName(l))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
      + `${reviewJob ? reviewPanel({batch, job: reviewJob, ...(this.review?.take !== undefined ? {take: this.review.take} : {}), current, disabled, reasons: this.reasons, note: this.note}) : ''}${this.sessionArea(ctx, batch, jobs, current, disabled)}${this.cutArea(ctx, batch, jobs, current, disabled)}</article>`;
  }

  private cutsOf(ctx: ProductionContext, batchId: string): Cut[] {
    return (ctx.bundle.cuts ?? []).filter(c => c.batchId === batchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Per language: the final cuts with their sign-off, the newest draft, and the form of a new final cut. */
  private cutArea(ctx: ProductionContext, batch: RenderBatch, jobs: RenderJobV2[], current: boolean, disabled: string): string {
    const cuts = this.cutsOf(ctx, batch.id), music = (ctx.bundle.media ?? []).filter(m => m.kind === 'music'), worker = ctx.videoStorage === 'drive';
    if (!cuts.length && !jobs.some(j => j.takes.some(t => t.status === 'rendered'))) return '';
    const sections = batch.languages.map(language => {
      const mine = cuts.filter(c => c.language === language), draft = mine.find(c => c.kind === 'draft'), finals = mine.filter(c => c.kind === 'final');
      const rendered = cutSelection(batch, jobs, language, 'draft'), approved = cutSelection(batch, jobs, language, 'final');
      const key = `${batch.id}:${language}`, form = this.cutForms.get(key), data = `data-id="${esc(batch.id)}" data-language="${esc(language)}"`;
      const items = [...finals, ...(draft ? [draft] : [])].map(cut => {
        const fresh = cutCurrent(cut, jobs);
        return cutView(cut, {current: fresh, batch, worker}) + cutSignOff(cut, {current: fresh && current, note: this.cutNotes.get(cut.id) ?? '', disabled});
      }).join('');
      const waiting = rendered.missing.length ? `<p class="small muted">还有片段没有渲染好的 take：${rendered.missing.map(esc).join('、')}。全部渲染好后，Sci-epo 会自动剪一版草稿。</p>` : '';
      const redo = !rendered.missing.length && (!draft || draft.status === 'failed' || (draft.status === 'done' && !cutCurrent(draft, jobs)))
        ? `<button class="button subtle small-button" data-action="production-cut-draft" ${data} ${disabled}>${draft ? '重新剪草稿' : '剪一版草稿'}</button>` : '';
      const final = !current ? '<span class="small muted">这一批不是当前制作版本，不能剪正式成片。</span>'
        : approved.missing.length ? `<span class="small muted">每个片段都通过一条 take 后，才能剪正式成片（还差 ${approved.missing.map(esc).join('、')}）。</span>`
        : form ? '' : `<button class="button small-button" data-action="production-cut-open" ${data} ${disabled}>剪辑正式成片…</button>`;
      return `<section class="cut-language"><h4>${esc(languageName(language))}</h4>${waiting}${items}<div class="language-toolbar">${redo}${final}</div>${form ? cutForm(batch, language, form, {music, disabled}) : ''}</section>`;
    }).join('');
    return `<section class="cut-area"><h3>成片</h3><p class="small muted">草稿用每个片段最新渲染好的 take，供你连着看；正式成片只用你通过的 take，签收后才算交付。${worker ? '视频不存在这台服务器上：take 和成片都存进 Colab 账号的 Google Drive，按链接分享。剪辑也在 Colab 上做，排队的成片由下一个渲染会话来剪；只剩剪辑时，Colab 选 CPU 运行时就够了。' : '剪辑在运行 Sci-epo 的电脑上用 ffmpeg 完成，不花 GPU。'}</p>`
      + `${sections}${musicUpload(batch.id, music, this.musicLicense, disabled)}</section>`;
  }

  /** Sessions of this episode's v2 batches, preferring the copy this page read last. */
  private sessionsOf(ctx: ProductionContext): PublicRenderSession[] {
    const batches = new Set((ctx.bundle.renderBatches ?? []).filter(b => b.episodeId === ctx.episode.id && b.version === 2).map(b => b.id));
    const all = new Map((ctx.bundle.renderSessions ?? []).map(s => [s.id, s]));
    for (const s of this.sessions.values()) if (s.projectId === ctx.bundle.project.id) all.set(s.id, s);
    return [...all.values()].filter(s => s.batchIds.some(id => batches.has(id))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private sessionDraft(batchId: string): {mode: RenderSession['mode']; budget: string} {
    let draft = this.sessionDrafts.get(batchId);
    if (!draft) { draft = {mode: 'pull', budget: ''}; this.sessionDrafts.set(batchId, draft); }
    return draft;
  }

  private sessionArea(ctx: ProductionContext, batch: RenderBatch, jobs: RenderJobV2[], current: boolean, disabled: string): string {
    const sessions = this.sessionsOf(ctx).filter(s => s.batchIds.includes(batch.id));
    if (!current && !sessions.length) return '';
    // A lost session stays live until it expires, but it must not block a new one: its takes return when their leases end.
    const live = sessions.filter(isLiveSession), active = live.filter(s => s.status !== 'lost'), last = sessions.filter(s => !isLiveSession(s)).at(-1);
    const rate = ctx.bundle.project.productionSettings?.computeUnitsPerHour, code = this.code;
    const waiting = code ? live.find(s => s.id === code.sessionId && s.status === 'waiting') : undefined;
    const draft = last ? this.readings.get(last.id) ?? {} : {};
    const saved = (value: number | undefined) => value === undefined ? '' : String(value);
    return `<div class="session-panel"><div class="eyebrow">RENDER SESSION</div><h3>渲染会话</h3>`
      + `${code && waiting ? codeOnce(code.code, waiting.mode, this.copied) : ''}${live.map(s => sessionLive(s, {now: this.now(), rate, disabled, pollError: this.pollError})).join('')}`
      + `${current && !active.length ? sessionStart(batch, jobs, this.sessionDraft(batch.id), disabled, (ctx.bundle.cuts ?? []).filter(c => c.batchId === batch.id && (c.status === 'queued' || c.status === 'running')).length) : ''}${!current && !live.length ? '<p class="small muted">这一批已不是当前制作版本，不能再开始渲染会话。</p>' : ''}`
      + `${last ? sessionSummary(last, {rate, readings: {before: draft.before ?? saved(last.readings?.before), after: draft.after ?? saved(last.readings?.after)}, disabled}) : ''}</div>`;
  }

  private workersView(disabled: string): string {
    const origin = this.hooks.origin();
    const tokens = this.tokens === null ? '<p class="small muted">正在读取工作机令牌…</p>' : this.tokens.length
      ? `<ul class="token-list">${this.tokens.map(t => `<li><strong>${esc(t.label)}</strong><span class="small muted">创建 ${esc(date(t.createdAt))}${t.lastUsedAt ? ` · 最近使用 ${esc(date(t.lastUsedAt))}` : ' · 尚未使用'}</span>${t.revokedAt ? '<span class="pill">已撤销</span>' : `<button class="text-button" data-action="production-revoke-token" data-id="${esc(t.id)}" ${disabled}>撤销</button>`}</li>`).join('')}</ul>`
      : '<p class="small muted">还没有工作机令牌。</p>';
    const fresh = this.newToken ? `<div class="inline-warning token-once" role="status"><strong>${esc(this.newToken.label)} 的令牌只显示这一次</strong><input readonly value="${esc(this.newToken.token)}" aria-label="新的工作机令牌"/><span class="small">在 Colab 里放进“密钥”（Secrets）的 SCIEPO_WORKER_TOKEN，或在自己的机器上设为环境变量。离开这一页后无法再看到它；丢了就撤销后重建。</span><button class="text-button" data-action="production-hide-token">我已保存，隐藏</button></div>` : '';
    return `<section class="publication-panel workers-panel"><div class="eyebrow">WORKERS</div><h2>连接工作机</h2>
      <p class="small muted">这一节只用于旧版（v1）批次。新的渲染批次用批次里的“渲染会话”，不需要工作机令牌。</p>
      <p class="muted small">三种方式用同一个工作机程序 <code>worker/sciepo_worker.py</code> 和同一份任务格式。Colab 和自己的 GPU 机器都可以用；推荐先打开 <a href="${esc(COLAB_NOTEBOOK)}" target="_blank" rel="noreferrer">Colab 笔记本</a>，详细说明见 <a href="${esc(WORKER_DOCS)}" target="_blank" rel="noreferrer">制作桥接文档</a>。</p>
      <ol class="worker-modes"><li><strong>任务包（离线也能用）</strong>：下载任务包 → 在工作机运行 <code>python sciepo_worker.py package --package 任务包.json --out 输出文件夹 --workflow h3_t2v_api.json</code> → 把输出文件夹里的 results.json 上传回来。</li>
      <li><strong>工作机自己领任务</strong>（Sci-epo 在网上时）：建一个令牌，在工作机运行 <code>python sciepo_worker.py pull --server ${esc(origin)} --out 输出文件夹 --workflow h3_t2v_api.json --wait</code>，令牌放在环境变量 SCIEPO_WORKER_TOKEN。</li>
      <li><strong>Sci-epo 推送给工作机</strong>（Sci-epo 在你电脑上时）：工作机运行 <code>serve</code> 并开隧道，把隧道地址和密钥填进上面的批次，点“发送到工作机”，渲染后点“同步结果”。</li></ol>
      ${fresh}${tokens}<div class="language-toolbar"><label class="sr-only" for="token-label">工作机名字</label><input id="token-label" data-production-token-label value="${esc(this.tokenLabel)}" maxlength="60" ${disabled}/><button class="button small-button" data-action="production-create-token" ${disabled}>新建工作机令牌</button></div></section>`;
  }

  // ------------------------------------------------------------------ polling

  /** One timer at a time while a session of this episode is live; the next one is set when the view renders again. */
  private schedule(ctx: ProductionContext): void {
    const ids = this.sessionsOf(ctx).filter(isLiveSession).map(s => s.id);
    // A cut that is queued or being cut also needs the page to refresh, even after every session has ended.
    const batches = new Set((ctx.bundle.renderBatches ?? []).filter(b => b.episodeId === ctx.episode.id).map(b => b.id));
    const cutting = (ctx.bundle.cuts ?? []).some(c => batches.has(c.batchId) && (c.status === 'queued' || c.status === 'running'));
    if (!ids.length && !cutting) { this.stopTimer(); return; }
    if (this.timer !== undefined || this.polling) return;
    const projectId = ctx.bundle.project.id, generation = this.generation, wait = Math.max(0, POLL_MS - (this.now() - this.lastPoll));
    this.timer = this.timers.set(() => { this.timer = undefined; void this.poll(projectId, ids, generation); }, wait);
  }
  private stopTimer(): void { if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = undefined; }

  private async poll(projectId: string, ids: string[], generation: number): Promise<void> {
    this.polling = true; this.lastPoll = this.now();
    const epoch = this.bundleEpoch;
    try {
      const [sessions, bundle] = await Promise.all([Promise.all(ids.map(id => this.hooks.api<PublicRenderSession>(`/api/render-sessions/${encodeURIComponent(id)}`))), this.hooks.api<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}`)]);
      if (generation !== this.generation) return;
      for (const session of sessions) this.remember(session);
      // A bundle this panel set while the request was out is newer than the polled one.
      if (epoch === this.bundleEpoch) this.hooks.setBundle(bundle);
      this.pollError = '';
    } catch {
      if (generation !== this.generation) return;
      this.pollError = '刷新失败，稍后会再试。';
    } finally {
      if (generation === this.generation) { this.polling = false; if (this.hooks.patch) this.hooks.patch(); else this.hooks.render(); }
    }
  }
  private remember(session: PublicRenderSession): void {
    this.sessions.set(session.id, session);
    if (this.code?.sessionId === session.id && session.status !== 'waiting') { this.code = null; this.copied = false; }
  }

  // ------------------------------------------------------------------ events

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
    if (el.dataset.productionBatch) {
      const field = el.dataset.productionBatch;
      if (field === 'size') this.size = el.value;
      else if (field === 'steps') this.steps = Number(el.value);
      else if (field === 'turbo') this.turbo = (el as HTMLInputElement).checked;
      else if (field === 'musicMode') this.musicMode = el.value === 'native' ? 'native' : 'bed';
      return true;
    }
    if (el.dataset.productionSessionMode) { if ((el as HTMLInputElement).checked) this.sessionDraft(el.dataset.productionSessionMode).mode = el.value === 'rehearsal' ? 'rehearsal' : 'pull'; return true; }
    if (el.dataset.productionSessionBudget) { this.sessionDraft(el.dataset.productionSessionBudget).budget = el.value; return true; }
    if (el.dataset.productionReading && el.dataset.id) {
      const draft = {...this.readings.get(el.dataset.id)};
      if (el.dataset.productionReading === 'after') draft.after = el.value; else draft.before = el.value;
      this.readings.set(el.dataset.id, draft);
      return true;
    }
    if (el.dataset.productionRate !== undefined) { this.rate = el.value; return true; }
    if (el.dataset.productionRetakeNote !== undefined) { this.note = el.value; return true; }
    if (el.dataset.productionCutField && el.dataset.cutKey) {
      const form = this.cutForms.get(el.dataset.cutKey);
      if (!form) return true;
      const field = el.dataset.productionCutField;
      if (field === 'music') form.music = el.value;
      else if (field === 'musicLevel') form.musicLevel = el.value;
      else if (field === 'size' && form.sizes.includes(el.value as CutSize)) form.settings = {...form.settings, size: el.value as CutSize};
      return true;
    }
    if (el.dataset.productionCaption && el.dataset.cutKey) {
      const caption = this.cutForms.get(el.dataset.cutKey)?.captions[Number(el.dataset.index)], field = el.dataset.productionCaption;
      if (!caption) return true;
      if (field === 'enabled') caption.enabled = (el as HTMLInputElement).checked;
      else if (field === 'text') caption.text = el.value;
      else if (field === 'start' || field === 'end') { const value = Number(el.value); if (el.value.trim() !== '' && Number.isFinite(value)) caption[field] = value; }
      return true;
    }
    if (el.dataset.productionCutNote) { this.cutNotes.set(el.dataset.productionCutNote, el.value); return true; }
    if (el.dataset.productionMusicLicense !== undefined) { this.musicLicense = el.value; return true; }
    if (el.dataset.productionRetakeReason) {
      const reason = el.dataset.productionRetakeReason as RetakeReason;
      if (RETAKE_REASONS.some(([value]) => value === reason)) { if ((el as HTMLInputElement).checked) this.reasons.add(reason); else this.reasons.delete(reason); }
      return true;
    }
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
        this.setBundle(answer.bundle);
        this.hooks.notice(`已读取结果：更新 ${answer.applied} 个任务，${answer.unchanged} 个没有变化，${answer.ignored} 条跳过。`);
      });
      return true;
    }
    if (el.dataset.productionUpload) {
      const file = (el as HTMLInputElement).files?.[0], name = el.dataset.character ?? '', voice = el.dataset.productionUpload === 'voice';
      if (!file || !name || !ctx) return true;
      const kind = voice ? 'voice_sample' : 'reference_image', rule = MEDIA_KINDS[kind], projectId = ctx.bundle.project.id;
      if (!file.size) { this.hooks.fail('文件是空的。'); return true; }
      if (file.size > rule.limitBytes) { this.hooks.fail(`${rule.label}不能超过 ${formatBytes(rule.limitBytes)}。`); return true; }
      const label = `${name} · ${file.name}`.slice(0, 200);
      void this.hooks.run(`正在上传${rule.label}…`, async () => {
        const {asset} = await this.hooks.upload<{asset: MediaAsset; bundle: ProjectBundle}>(`/api/projects/${encodeURIComponent(projectId)}/media?kind=${kind}&label=${encodeURIComponent(label)}`, file);
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}/cast`, voice ? {name, voiceSampleAssetId: asset.id} : {name, portraitAssetId: asset.id}));
        this.hooks.notice(voice ? `${name} 的声音样本已上传。之后生成的渲染批次会用它。` : `${name} 的参考图已上传。请对照外貌描述检查；之后生成的渲染批次会用它。`);
      });
      return true;
    }
    if (el.dataset.productionReadinessConfirm !== undefined && ctx) {
      this.readinessConfirmed = (el as HTMLInputElement).checked ? readinessSignature(this.readiness(ctx)) : '';
      this.hooks.render();
      return true;
    }
    if (el.dataset.productionMusicUpload !== undefined) {
      const file = (el as HTMLInputElement).files?.[0], rule = MEDIA_KINDS.music;
      if (!file || !ctx) return true;
      if (!file.size) { this.hooks.fail('文件是空的。'); return true; }
      if (file.size > rule.limitBytes) { this.hooks.fail(`${rule.label}不能超过 ${formatBytes(rule.limitBytes)}。`); return true; }
      const projectId = ctx.bundle.project.id, license = this.musicLicense.trim().slice(0, 300), label = file.name.slice(0, 200);
      void this.hooks.run('正在上传配乐…', async () => {
        const answer = await this.hooks.upload<{asset: MediaAsset; bundle: ProjectBundle}>(`/api/projects/${encodeURIComponent(projectId)}/media?kind=music&label=${encodeURIComponent(label)}${license ? `&license=${encodeURIComponent(license)}` : ''}`, file);
        this.setBundle(answer.bundle);
        this.musicLicense = '';
        for (const form of this.cutForms.values()) if (!form.music) form.music = answer.asset.id;
        this.hooks.notice(license ? '配乐已上传，授权说明会写进交付报告。' : '配乐已上传。它没有授权说明；交付前请确认你有权使用它。');
      });
      return true;
    }
    if (el.dataset.productionUsePortrait !== undefined) {
      const name = el.dataset.productionUsePortrait, usePortrait = (el as HTMLInputElement).checked;
      if (!name || !ctx) return true;
      const projectId = ctx.bundle.project.id;
      void this.hooks.run('正在更新参考图设置…', async () => {
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}/cast`, {name, usePortrait}));
        this.hooks.notice(usePortrait ? `${name} 的片段会用参考图。` : `${name} 的片段不再用参考图，只按外貌描述生成。`);
      });
      return true;
    }
    return this.input(el);
  }

  click(action: string, el: {dataset: DOMStringMap}, ctx: ProductionContext): boolean {
    const id = el.dataset.id ?? '', projectId = ctx.bundle.project.id;
    if (action === 'production-save-profile' && this.draft) {
      // References and their switch are set on the cast route; leaving them out keeps a stale draft from overwriting them.
      const profile = {...structuredClone(this.draft), characters: this.draft.characters.map(({portrait: _p, voiceSampleAsset: _v, usePortrait: _u, ...rest}) => structuredClone(rest))};
      void this.hooks.run('正在保存制作设定…', async () => {
        const bundle = await this.hooks.api<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}/production`, {method: 'PUT', body: JSON.stringify(profile)});
        this.setBundle(bundle); this.draft = null; this.dirtyProfile = false;
        this.hooks.notice('制作设定已保存。它不属于剧本设定，不会让任何一集需要复核。');
      });
      return true;
    }
    if (action === 'production-create-batch') {
      if (this.dirtyProfile) { this.hooks.fail('制作设定有未保存的修改。先保存，再生成渲染任务。'); return true; }
      if (!Number.isInteger(this.steps) || this.steps < 1 || this.steps > 60) { this.hooks.fail('采样步数需为 1–60 的整数。'); return true; }
      const sizes = RENDER_SIZES[productionList(ctx.bundle, ctx.episode).list?.aspectRatio ?? '9:16'], size = sizes.some(s => s.value === this.size) ? this.size : sizes[0]!.value;
      const open = this.readiness(ctx).filter(i => i.status !== 'passed'), signature = open.map(i => i.id).join('\n');
      if (open.length && this.readinessConfirmed !== signature) { this.hooks.fail(`开拍清单还有 ${open.length} 项没有通过。请逐项看过，勾选确认后再生成渲染任务。`); return true; }
      const body = {size, steps: this.steps, turbo: this.turbo, musicMode: this.musicMode, clipLimitSeconds: this.clipLimit, ...(this.languages ? {languages: this.languages} : {}), ...(open.length ? {confirmedReadiness: open.map(i => i.id)} : {})};
      void this.hooks.run('正在生成渲染任务…', async () => {
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/shot-lists/${encodeURIComponent(id)}/render-batches`, body));
        this.readinessConfirmed = '';
        this.hooks.notice('渲染任务已生成。在这一批下面开始渲染会话，就能交给 Colab 渲染。');
      });
      return true;
    }
    if (action === 'production-requeue') {
      void this.hooks.run('正在重新排队…', async () => { this.setBundle(await this.hooks.post<ProjectBundle>(`/api/render-jobs/${encodeURIComponent(id)}/requeue`, {})); this.hooks.notice('任务已重新排队。'); });
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
          this.setBundle(answer.bundle);
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
    return this.clickV2(action, el, ctx, id, projectId);
  }

  /** Final-cut forms, drafts and sign-off. */
  private clickCut(action: string, el: {dataset: DOMStringMap}, id: string): boolean {
    const language = el.dataset.language ?? '', key = `${id}:${language}`;
    if (action === 'production-cut-open') {
      void this.hooks.run('正在读取成片计划…', async () => {
        const plan = await this.hooks.api<CutPlanAnswer>(`/api/render-batches/${encodeURIComponent(id)}/cut-plan?language=${encodeURIComponent(language)}&kind=final`);
        this.cutForms.set(key, {settings: {...plan.settings}, captions: plan.captions.map(c => ({...c})), sizes: plan.sizes, seconds: plan.seconds, pictureLanguage: plan.pictureLanguage,
          musicRequired: plan.musicRequired, music: plan.musicRequired ? '' : 'none', musicLevel: String(plan.settings.musicLevelDb), ffmpeg: plan.ffmpeg});
      });
      return true;
    }
    if (action === 'production-cut-cancel') { this.cutForms.delete(key); this.hooks.render(); return true; }
    if (action === 'production-cut-draft') {
      void this.hooks.run('正在排上草稿…', async () => {
        this.setBundle((await this.hooks.post<{cut: Cut; bundle: ProjectBundle}>(`/api/render-batches/${encodeURIComponent(id)}/cuts`, {language, kind: 'draft'})).bundle);
        this.hooks.notice('草稿排上了，剪好后可以直接在这里播放。');
      });
      return true;
    }
    if (action === 'production-cut-create') {
      const form = this.cutForms.get(key);
      if (!form) return true;
      if (form.musicRequired && !form.music) { this.hooks.fail('请选一条配乐，或选择“不加配乐”。'); return true; }
      const level = Number(form.musicLevel), [low, high] = CUT_SETTING_RANGES.musicLevelDb;
      if (form.music && form.music !== 'none' && (form.musicLevel.trim() === '' || !Number.isFinite(level) || level < low || level > high)) { this.hooks.fail(`配乐音量需为 ${low} 到 ${high} dB。`); return true; }
      const bad = form.captions.find(c => c.enabled && (!c.text.trim() || !(c.end > c.start) || c.start < 0 || c.end > form.seconds + 0.5));
      if (bad) { this.hooks.fail(`镜头 ${bad.shotId} 的字幕需要文字，并且结束时间晚于开始、不超过 ${form.seconds} 秒；不想显示就把它关掉。`); return true; }
      const settings = {size: form.settings.size, ...(form.music === 'none' ? {noMusic: true} : form.music ? {musicAssetId: form.music, musicLevelDb: level} : {})};
      void this.hooks.run('正在排上正式成片…', async () => {
        const answer = await this.hooks.post<{cut: Cut; bundle: ProjectBundle}>(`/api/render-batches/${encodeURIComponent(id)}/cuts`, {language, kind: 'final', settings, captions: form.captions});
        this.setBundle(answer.bundle); this.cutForms.delete(key);
        this.hooks.notice('正式成片排上了。剪好后请看一遍，再决定签收或驳回。');
      });
      return true;
    }
    if (action === 'production-cut-signoff') {
      const decision = el.dataset.decision === 'rejected' ? 'rejected' : 'signed_off', note = (this.cutNotes.get(id) ?? '').trim();
      if (decision === 'rejected' && !note) { this.hooks.fail('驳回时请写明原因。'); return true; }
      void this.hooks.run(decision === 'signed_off' ? '正在签收…' : '正在记录驳回…', async () => {
        this.setBundle((await this.hooks.post<{cut: Cut; bundle: ProjectBundle}>(`/api/cuts/${encodeURIComponent(id)}/sign-off`, {decision, ...(note ? {note} : {})})).bundle);
        this.cutNotes.delete(id);
        this.hooks.notice(decision === 'signed_off' ? '已签收。交付报告存进了媒体库，发布清单会把这一语言标为已交付。' : '已驳回，原因记在成片上。可以重拍片段或改字幕后再剪一版。');
      });
      return true;
    }
    return false;
  }

  /** Cast references, media, review and render sessions. */
  private clickV2(action: string, el: {dataset: DOMStringMap}, ctx: ProductionContext, id: string, projectId: string): boolean {
    if (action.startsWith('production-cut-')) return this.clickCut(action, el, id);
    if (action === 'production-unlink') {
      const voice = el.dataset.kind === 'voice';
      if (!id) return true;
      void this.hooks.run(voice ? '正在移除声音样本…' : '正在移除参考图…', async () => {
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}/cast`, voice ? {name: id, voiceSampleAssetId: null} : {name: id, portraitAssetId: null}));
        this.hooks.notice(`已移除 ${id} 的${voice ? '声音样本' : '参考图'}。文件还在媒体库里，不再需要时可以删除。`);
      });
      return true;
    }
    if (action === 'production-clear-legacy') {
      const character = this.draft?.characters.find(c => c.name === id);
      if (character) { delete character.image; delete character.voiceSample; this.dirtyProfile = true; }
      this.hooks.render();
      return true;
    }
    if (action === 'production-toggle-media') { this.showMedia = !this.showMedia; this.hooks.render(); return true; }
    if (action === 'production-delete-media') {
      if (this.hooks.confirm && !this.hooks.confirm('从媒体库删除这个文件？删除后不能恢复。')) return true;
      void this.hooks.run('正在删除文件…', async () => { this.setBundle(await this.hooks.post<ProjectBundle>(`/api/media/${encodeURIComponent(id)}/delete`, {})); this.hooks.notice('文件已从媒体库删除。'); });
      return true;
    }
    if (action === 'production-save-rate') {
      const text = (this.rate ?? String(ctx.bundle.project.productionSettings?.computeUnitsPerHour ?? '')).trim(), value = text === '' ? null : Number(text);
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1000)) { this.hooks.fail('计算单元单价需为 0–1000 的数字，或留空。'); return true; }
      void this.hooks.run('正在保存计算单元单价…', async () => {
        this.setBundle(await this.hooks.api<ProjectBundle>(`/api/projects/${encodeURIComponent(projectId)}/production-settings`, {method: 'PUT', body: JSON.stringify({computeUnitsPerHour: value})}));
        this.rate = null;
        this.hooks.notice(value === null ? '已清除计算单元单价，不再估算计算单元。' : `计算单元单价已保存：每小时 ${value} 个。`);
      });
      return true;
    }
    if (action === 'production-review') {
      if (this.review?.jobId === id) this.review = null; else { this.review = {jobId: id}; this.reasons.clear(); this.note = ''; }
      this.hooks.render();
      return true;
    }
    if (action === 'production-review-take') { const take = Number(el.dataset.take); if (Number.isInteger(take)) this.review = {jobId: id, take}; this.hooks.render(); return true; }
    if (action === 'production-review-close') { this.review = null; this.hooks.render(); return true; }
    if (action === 'production-approve') {
      const take = Number(el.dataset.take);
      if (!Number.isInteger(take)) return true;
      void this.hooks.run('正在记录通过…', async () => {
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/render-jobs-v2/${encodeURIComponent(id)}/approve`, {take}));
        this.hooks.notice(`已通过 take ${take}。`);
      });
      return true;
    }
    if (action === 'production-retake') {
      const reasons = RETAKE_REASONS.map(([value]) => value).filter(r => this.reasons.has(r)), note = this.note.trim();
      if (!reasons.length) { this.hooks.fail('请至少选一个重拍原因。'); return true; }
      void this.hooks.run('正在排上重拍…', async () => {
        this.setBundle(await this.hooks.post<ProjectBundle>(`/api/render-jobs-v2/${encodeURIComponent(id)}/retake`, {reasons, ...(note ? {note} : {})}));
        this.reasons.clear(); this.note = '';
        if (this.review?.jobId === id) this.review = {jobId: id};
        this.hooks.notice('已排上新的 take，用下一个种子。正在运行的会话预算够的话会接着渲染它；否则再开始一个会话。');
      });
      return true;
    }
    if (action === 'production-start-session') {
      const draft = this.sessionDraft(id), text = draft.budget.trim(), budgetMinutes = text ? Number(text) : undefined;
      if (budgetMinutes !== undefined && (!Number.isFinite(budgetMinutes) || budgetMinutes < 5 || budgetMinutes > 720)) { this.hooks.fail('时间预算需为 5–720 分钟，或留空用默认值。'); return true; }
      const body = {batchIds: [id], mode: draft.mode, ...(budgetMinutes !== undefined ? {budgetMinutes} : {})};
      void this.hooks.run('正在开始渲染会话…', async () => {
        const answer = await this.hooks.post<{session: PublicRenderSession; code: string; bundle: ProjectBundle}>(`/api/projects/${encodeURIComponent(projectId)}/render-sessions`, body);
        this.setBundle(answer.bundle); this.remember(answer.session);
        this.code = {sessionId: answer.session.id, code: answer.code}; this.copied = false; this.sessionDrafts.delete(id);
        this.hooks.notice(answer.session.mode === 'rehearsal' ? '演练会话已开始。按下面的步骤把会话码交给 Colab（CPU 运行时就够）。' : '渲染会话已开始。按下面的步骤把会话码交给 Colab。');
      });
      return true;
    }
    if (action === 'production-copy-code') {
      const code = this.code?.code;
      if (!code) return true;
      if (!this.hooks.copy) { this.hooks.fail('这个页面不能自动复制。请选中会话码后手动复制。'); return true; }
      void this.hooks.copy(code).then(() => { this.copied = true; this.hooks.render(); }, () => { this.hooks.fail('浏览器没有允许复制。请选中会话码后手动复制。'); });
      return true;
    }
    if (action === 'production-hide-code') { this.code = null; this.copied = false; this.hooks.render(); return true; }
    if (action === 'production-reissue-code') {
      void this.hooks.run('正在换会话码…', async () => {
        const answer = await this.hooks.post<{session: PublicRenderSession; code: string}>(`/api/render-sessions/${encodeURIComponent(id)}/code`, {});
        this.remember(answer.session); this.code = {sessionId: answer.session.id, code: answer.code}; this.copied = false;
        this.hooks.notice('已换新的会话码，旧的不能再用了。');
      });
      return true;
    }
    if (action === 'production-stop') {
      const when = el.dataset.when === 'now' ? 'now' as const : 'after_take' as const;
      void this.hooks.run('正在请求停止…', async () => {
        const session = await this.hooks.post<PublicRenderSession>(`/api/render-sessions/${encodeURIComponent(id)}/stop`, {when});
        this.remember(session);
        this.hooks.notice(session.status === 'ended' ? '会话已结束，会话码已作废。' : when === 'now' ? '已请求立即停止。工作机最多 30 秒内收到，正在渲染的 take 会重新排队。' : '已请求在这一条 take 渲染完后停止。');
      });
      return true;
    }
    if (action === 'production-save-readings') {
      const session = this.sessionsOf(ctx).find(s => s.id === id), draft = this.readings.get(id) ?? {};
      const read = (text: string | undefined, saved: number | undefined): number | null | 'invalid' => {
        const value = (text ?? (saved === undefined ? '' : String(saved))).trim();
        if (!value) return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : 'invalid';
      };
      const before = read(draft.before, session?.readings?.before), after = read(draft.after, session?.readings?.after);
      if (before === 'invalid' || after === 'invalid') { this.hooks.fail('计算单元读数需为非负数，或留空。'); return true; }
      void this.hooks.run('正在保存读数…', async () => {
        this.remember(await this.hooks.post<PublicRenderSession>(`/api/render-sessions/${encodeURIComponent(id)}/readings`, {before, after}));
        this.readings.delete(id);
        this.hooks.notice('计算单元读数已保存。');
      });
      return true;
    }
    return false;
  }
}
