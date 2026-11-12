/** Shot-list tab: read view, edit mode with validated local drafts, adoption and export.
 * Every displayed value is escaped; checks reuse the same core functions as the server. */
import type { Episode, Localization, ProjectBundle, Revision, Shot, ShotList, ShotListContent } from '../src/types';
import { CAMERA_MOVES, SHOT_SIZES } from '../src/types';
import { aspectRatioOf } from '../src/core/formats';
import { languageName, scriptLanguage } from '../src/core/languages';
import { isLineAligned } from '../src/core/scriptLines';
import { boundAdaptations, mergeWithNext, newestAlignedAdaptations, parseShotList, sceneDifferences, shotListStatus, shotListWarnings, shotNeeds, shotTexts, splitShot, totalDuration, type ShotView, type ShotWarning } from '../src/core/shotList';
import { confirmedBible } from '../src/core/bible';
import { BiblePanel } from './bible';
import { fixButtons, reviewView } from './shotReview';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
export const SIZE_LABELS: Record<Shot['size'], string> = {extreme_close_up: '大特写', close_up: '特写', medium_close_up: '近景', medium: '中景', medium_wide: '中全景', wide: '全景', insert: '插入镜头'};
export const CAMERA_LABELS: Record<Shot['camera'], string> = {static: '固定', push_in: '推近', pull_out: '拉远', pan: '横摇', tilt: '俯仰', track: '跟拍', handheld: '手持'};
const MODE_LABELS: Record<string, string> = {live: '模型生成', demo: '预置演示', manual: '手动修改'};

interface Draft extends ShotListContent { adaptations: Record<string, string> }
export interface ShotListHooks {
  run(label: string, action: () => Promise<void>): Promise<void>;
  post<T>(path: string, body: unknown): Promise<T>;
  reload(revisionId: string): Promise<void>;
  render(): void;
  notice(message: string): void;
  fail(message: string): void;
  confirm(message: string): boolean;
}
export interface ShotListContext { bundle: ProjectBundle; revision: Revision; episode: Episode; busy: boolean; live: boolean; dirty: boolean; preferredLanguage?: string }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const draftKey = (id: string) => `sci-epo-shotlist:${id}`;
function storage(): Storage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } }

export class ShotListPanel {
  private selectedId = '';
  private draft: Draft | null = null;
  private draftFor = '';
  private page: 'list' | 'review' = 'list';
  readonly bible: BiblePanel;
  constructor(private hooks: ShotListHooks) { this.bible = new BiblePanel(hooks); }

  get editing(): boolean { return !!this.draft; }
  reset(): void { this.selectedId = ''; this.draft = null; this.draftFor = ''; this.page = 'list'; this.bible.reset(); }

  private lists(ctx: ShotListContext): ShotList[] { return (ctx.bundle.shotLists ?? []).filter(l => l.sourceRevisionId === ctx.revision.id); }
  private selected(ctx: ShotListContext): ShotList | undefined { const lists = this.lists(ctx); return lists.find(l => l.id === this.selectedId) ?? lists.at(-1); }

  /** Keep the in-memory draft tied to the selected version; resume a validated saved draft after reloads. */
  private syncDraft(ctx: ShotListContext, list: ShotList | undefined): void {
    if (!list) { this.draft = null; this.draftFor = ''; return; }
    if (this.draft && this.draftFor === list.id) return;
    this.draft = null; this.draftFor = '';
    const saved = storage()?.getItem(draftKey(list.id));
    if (!saved) return;
    try {
      const value = JSON.parse(saved) as Draft;
      const content = parseShotList(value, ctx.revision);
      const adaptations = value.adaptations && typeof value.adaptations === 'object' ? Object.fromEntries(Object.entries(value.adaptations).filter(([, id]) => typeof id === 'string')) as Record<string, string> : {};
      this.draft = {...content, adaptations}; this.draftFor = list.id;
    } catch { storage()?.removeItem(draftKey(list.id)); }
  }
  private persist(): void { if (this.draft && this.draftFor) try { storage()?.setItem(draftKey(this.draftFor), JSON.stringify(this.draft)); } catch { /* The server version remains authoritative. */ } }
  private discard(): void { if (this.draftFor) storage()?.removeItem(draftKey(this.draftFor)); this.draft = null; this.draftFor = ''; }

  view(ctx: ShotListContext): string {
    const {bundle, revision, episode, busy, live, dirty} = ctx, lists = this.lists(ctx), list = this.selected(ctx);
    this.syncDraft(ctx, list);
    const disabled = (condition = false) => busy || condition ? 'disabled' : '';
    const ratio = list?.aspectRatio ?? aspectRatioOf(revision.context.brief);
    const generate = `<button class="button primary" data-action="shots-generate" data-mode="live" ${disabled(!live || dirty || this.editing)}>${lists.length ? '重新生成分镜表' : '生成分镜表'}</button>${revision.mode === 'demo' ? `<button class="text-button" data-action="shots-generate" data-mode="demo" ${disabled(dirty || this.editing)}>载入预置分镜表 →</button>` : ''}`;
    const bibleView = this.bible.view({bundle, revision, episode, busy, live});
    const intro = `<div class="section-title"><div><div class="eyebrow">SHOT LIST · ${esc(ratio)}</div><h2>一镜一镜，先配音再出画。</h2></div><div class="header-actions">${generate}</div></div><p class="muted">分镜表引用剧本的行，不改写台词。时长是估计值，配音后以实测为准。</p>${dirty ? '<div class="inline-warning">剧本有未保存的编辑。先保存为新版本，再为它生成分镜表。</div>' : ''}${!live ? '<p class="small muted">写作模型尚未配置，暂时只能载入预置示例。</p>' : ''}`;
    if (!list) return `<section class="shots-view">${bibleView}${intro}${this.previousNotice(ctx)}<div class="empty-panel"><span class="empty-mark">▯</span><h3>这一版还没有分镜表</h3><p>生成后，每个镜头都会绑定剧本的具体几行，并按配音语言对照台词。</p></div></section>`;
    const status = shotListStatus(list, episode), content: ShotListContent = this.draft ?? list;
    const adaptationIds = this.draft ? this.draft.adaptations : list.adaptations;
    const adaptations = boundAdaptations({adaptations: adaptationIds}, bundle.localizations);
    const newest = Object.fromEntries(Object.entries(newestAlignedAdaptations(revision, bundle.localizations, list.voiceLanguages)).map(([language, l]) => [language, l.id]));
    const warnings = shotListWarnings({...content, voiceLanguages: list.voiceLanguages}, {revision, adaptations, newest});
    const views = shotTexts(content, revision, adaptations);
    const pill = status.current ? '<span class="pill accepted">当前制作版本</span>' : status.adopted ? '<span class="pill">已采用 · 不是当前定稿</span>' : '<span class="pill">未采用</span>';
    const hint = status.adopted || status.adoptable ? '' : episode.needsReview ? '<span class="small muted">前文已变化，先复核本集定稿，才能采用分镜表。</span>' : '<span class="small muted">先在剧本页采用这一版，才能把它的分镜表设为制作版本。</span>';
    const versions = lists.length > 1 ? `<label class="sr-only" for="shot-list-version">分镜表版本</label><select id="shot-list-version" ${disabled(this.editing)}>${lists.map((l, i) => `<option value="${esc(l.id)}" ${l.id === list.id ? 'selected' : ''}>V${i + 1} · ${esc(MODE_LABELS[l.mode] ?? l.mode)} · ${esc(date(l.createdAt))}</option>`).join('')}</select>` : `<span class="small muted">V1 · ${esc(MODE_LABELS[list.mode] ?? list.mode)} · ${esc(date(list.createdAt))}</span>`;
    const actions = this.editing
      ? `<button class="button primary" data-action="shots-save" ${disabled()}>保存为新版本</button><button class="button subtle" data-action="shots-cancel" ${disabled()}>放弃修改</button>`
      : `<button class="button" data-action="shots-adopt" ${disabled(!status.adoptable)}>采用为制作版本</button>${hint}<button class="button subtle" data-action="shots-edit" ${disabled()}>修改分镜表</button><a class="button subtle" href="/api/shot-lists/${encodeURIComponent(list.id)}/export" download>导出 CSV ↗</a>`;
    const page = this.editing ? 'list' : this.page;
    const pages = `<div class="page-switch" role="group" aria-label="分镜页视图"><button class="button small-button ${page === 'list' ? 'primary' : 'subtle'}" data-action="shots-page" data-id="list" ${disabled(this.editing)}>分镜表</button><button class="button small-button ${page === 'review' ? 'primary' : 'subtle'}" data-action="shots-page" data-id="review" ${disabled(this.editing)}>逐镜确认（开 GPU 前）</button></div>`;
    const toolbar = `<div class="shots-toolbar">${versions}${pill}${actions}</div>${pages}`;
    const target = revision.context.brief.durationTarget, total = totalDuration(content);
    const summary = `<div class="shots-summary"><span>预计总时长 <strong>${esc(total)} 秒</strong>${target ? ` · 目标 ${esc(target.min)}–${esc(target.max)} 秒` : ''}（估计）</span><span>${esc(content.shots.length)} 个镜头 · 画幅 ${esc(list.aspectRatio)}</span><span class="voice-coverage">${this.coverage(ctx, list, adaptations)}</span></div>`;
    if (page === 'review') {
      const bible = confirmedBible(episode, {id: list.sourceRevisionId}), review = bundle.shotReviews?.find(r => r.id === list.id);
      const blocked = !status.current ? '逐镜确认只对当前的制作版本做。先点“采用为制作版本”。' : !bible ? '先确认上面的“本集设定”。镜头要对照地点和道具来看。' : undefined;
      const languages = [scriptLanguage(revision), ...Object.keys(adaptations)];
      const review_ = reviewView({views, cast: content.cast, revision, languages, needs: shotNeeds(content, {revision, adaptations}), warnings,
        ...(bible ? {bible} : {}), ...(review ? {review} : {}), canConfirm: !blocked, ...(blocked ? {blocked} : {}), disabled: disabled()});
      return `<section class="shots-view">${bibleView}${intro}${toolbar}${review_}</section>`;
    }
    const warningBlock = warnings.length ? `<div class="inline-warning" role="status"><strong>需要留意</strong><ul>${warnings.map(w => `<li>${esc(w.message)}${fixButtons(w, disabled())}</li>`).join('')}</ul><span class="small">这些提示不会阻止保存或采用，但开拍清单会逐条列出来。带按钮的可以一键改：改动先进入草稿，点“保存为新版本”才生效。</span></div>` : '';
    const castEditor = this.editing ? this.castEditor(content) : '';
    const scenes = revision.scenes.map(scene => {
      const cards = views.filter(v => v.shot.sceneId === scene.id).map(v => this.card(v, content, list.aspectRatio, revision, Object.keys(adaptations), warnings.filter(w => w.shotId === v.shot.id), disabled(), ctx.preferredLanguage));
      return `<section class="shot-scene"><h3><span>${esc(scene.id)}</span>${esc(scene.heading)}</h3><div class="shot-grid">${cards.join('')}</div></section>`;
    }).join('');
    return `<section class="shots-view">${bibleView}${intro}${toolbar}${summary}${warningBlock}${castEditor}${scenes}</section>`;
  }

  /** When this revision has no shot list, point to the nearest one and the scenes that changed. */
  private previousNotice(ctx: ShotListContext): string {
    const others = (ctx.bundle.shotLists ?? []).filter(l => l.episodeId === ctx.episode.id && l.sourceRevisionId !== ctx.revision.id);
    const reference = others.find(l => l.id === ctx.episode.productionShotListId) ?? others.at(-1);
    if (!reference) return '';
    const revisions = ctx.bundle.revisions.filter(r => r.episodeId === ctx.episode.id), source = revisions.find(r => r.id === reference.sourceRevisionId);
    if (!source) return '';
    const changed = sceneDifferences(source, ctx.revision);
    return `<div class="inline-warning" role="status">最近的分镜表基于 V${revisions.indexOf(source) + 1}${reference.id === ctx.episode.productionShotListId ? '（已采用为制作版本）' : ''}。${changed.length ? `与这一版相比，这些场景不同：${changed.map(esc).join('、')}。` : '两版的场景内容相同。'}为这一版生成新的分镜表后才会对应本版台词。</div>`;
  }

  private coverage(ctx: ShotListContext, list: ShotList, adaptations: Record<string, Localization>): string {
    const source = scriptLanguage(ctx.revision);
    return list.voiceLanguages.map(language => {
      if (language === source) return `<span class="pill">${esc(languageName(language))} · 原稿</span>`;
      if (this.editing) {
        const options = ctx.bundle.localizations.filter(l => l.sourceRevisionId === ctx.revision.id && l.language === language && isLineAligned(ctx.revision, l));
        return `<label class="small">${esc(languageName(language))} <select data-adaptation-language="${esc(language)}"><option value="">不绑定</option>${options.map(l => `<option value="${esc(l.id)}" ${this.draft?.adaptations[language] === l.id ? 'selected' : ''}>${esc(date(l.createdAt))} · ${esc(l.title)}</option>`).join('')}</select></label>`;
      }
      const bound = adaptations[language];
      return bound ? `<span class="pill">${esc(languageName(language))} · 改编 ${esc(date(bound.createdAt))}</span>` : `<span class="pill changed">${esc(languageName(language))} · 缺少逐行对齐的改编</span><button class="text-button" data-action="tab" data-id="languages">去语言页生成 →</button>`;
    }).join('');
  }

  private castEditor(content: ShotListContent): string {
    return `<div class="cast-editor"><span class="field-label">角色表</span>${content.cast.map(c => `<label>${esc(c.id)}<input data-cast-id="${esc(c.id)}" value="${esc(c.name)}" maxlength="60"/></label><button class="text-button" data-action="shots-remove-cast" data-id="${esc(c.id)}">移除</button>`).join('')}<button class="text-button" data-action="shots-add-cast">添加角色 ＋</button></div>`;
  }

  private card(view: ShotView, content: ShotListContent, ratio: ShotList['aspectRatio'], revision: Revision, adaptationLanguages: string[], warnings: ShotWarning[], disabled: string, preferred?: string): string {
    const {shot, order, lines} = view, names = new Map(content.cast.map(c => [c.id, c.name]));
    const bound = [scriptLanguage(revision), ...adaptationLanguages], ordered = !!preferred && bound.includes(preferred);
    // The manuscript language reads first; the other voice languages follow as secondary lines.
    const languages = ordered ? [preferred!, ...bound.filter(l => l !== preferred)] : bound;
    const frame = `<div class="shot-frame ratio-${ratio === '9:16' ? '9-16' : '16-9'}"><span class="shot-frame-label">${esc(SIZE_LABELS[shot.size])} · ${esc(CAMERA_LABELS[shot.camera])}</span><span class="shot-frame-id">${esc(shot.id)}</span></div>`;
    const lineView = lines.map(line => {
      const texts = languages.map((language, i) => `<p lang="${esc(language)}"${ordered && i ? ' class="secondary-language"' : ''}>${esc(line.texts[language] || '—')}</p>`).join('');
      const speaker = this.editing
        ? `<select data-shot-speaker data-shot-id="${esc(shot.id)}" data-line="${esc(line.position)}" aria-label="第 ${esc(line.position)} 行的说话人" ${disabled}><option value="">动作 · 不说话</option>${content.cast.map(c => `<option value="${esc(c.id)}" ${line.speakerId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${line.position > shot.firstLine ? `<button class="text-button" data-action="shots-split" data-id="${esc(shot.id)}" data-line="${esc(line.position)}" ${disabled}>从这一行拆开</button>` : ''}`
        : '';
      return `<div class="shot-line ${line.speakerId ? 'spoken' : ''}"><span class="line-ref">${esc(shot.sceneId)}·${esc(line.position)}</span><div>${texts}${speaker}</div></div>`;
    }).join('');
    const people = shot.characters.map(id => names.get(id) ?? id), speakers = [...new Set(shot.spoken.map(s => names.get(s.castId) ?? s.castId))];
    const next = content.shots[content.shots.findIndex(s => s.id === shot.id) + 1];
    const body = this.editing
      ? `<div class="shot-edit-grid"><label class="small">景别<select data-shot-field="size" data-shot-id="${esc(shot.id)}" ${disabled}>${SHOT_SIZES.map(v => `<option value="${v}" ${shot.size === v ? 'selected' : ''}>${esc(SIZE_LABELS[v])}</option>`).join('')}</select></label><label class="small">运镜<select data-shot-field="camera" data-shot-id="${esc(shot.id)}" ${disabled}>${CAMERA_MOVES.map(v => `<option value="${v}" ${shot.camera === v ? 'selected' : ''}>${esc(CAMERA_LABELS[v])}</option>`).join('')}</select></label><label class="small">预计秒数<input type="number" min="0.1" max="600" step="0.1" data-shot-field="durationSeconds" data-shot-id="${esc(shot.id)}" value="${esc(shot.durationSeconds)}" ${disabled}/></label></div>${lineView}<div class="small">入镜：${content.cast.map(c => `<label class="check-label"><input type="checkbox" data-shot-character="${esc(c.id)}" data-shot-id="${esc(shot.id)}" ${shot.characters.includes(c.id) ? 'checked' : ''} ${disabled}/><span>${esc(c.name)}</span></label>`).join('')}</div><label class="small">构图<input data-shot-field="composition" data-shot-id="${esc(shot.id)}" value="${esc(shot.composition ?? '')}" maxlength="500" ${disabled}/></label><label class="small">声音<input data-shot-field="sound" data-shot-id="${esc(shot.id)}" value="${esc(shot.sound ?? '')}" maxlength="500" ${disabled}/></label>${next && next.sceneId === shot.sceneId ? `<button class="text-button" data-action="shots-merge" data-id="${esc(shot.id)}" ${disabled}>与下一镜合并</button>` : ''}`
      : `${lineView}<p class="small muted">入镜：${people.length ? people.map(esc).join('、') : '无人物'} · 说话：${speakers.length ? speakers.map(esc).join('、') : '无台词'}</p>${shot.composition ? `<p class="shot-note"><span class="label">构图</span>${esc(shot.composition)}</p>` : ''}${shot.sound ? `<p class="shot-note"><span class="label">声音</span>${esc(shot.sound)}</p>` : ''}`;
    const notes = warnings.length ? `<ul class="shot-warnings">${warnings.map(w => `<li>${esc(w.message)}${fixButtons(w, disabled)}</li>`).join('')}</ul>` : '';
    return `<article class="shot-card ${ratio === '16:9' ? 'horizontal' : ''}" data-shot="${esc(shot.id)}">${frame}<div class="shot-body"><div class="shot-meta"><strong>镜头 ${esc(order)}</strong><span>约 ${esc(shot.durationSeconds)} 秒</span></div>${body}${notes}</div></article>`;
  }

  private shot(id: string | undefined): Shot | undefined { return this.draft?.shots.find(s => s.id === id); }

  /** Text and number fields update the draft without re-rendering, so focus stays put. */
  input(el: Field): boolean {
    if (this.bible.input(el)) return true;
    if (!this.draft) return false;
    if (el.dataset.castId) { const member = this.draft.cast.find(c => c.id === el.dataset.castId); if (member) member.name = el.value; this.persist(); return true; }
    const field = el.dataset.shotField, shot = this.shot(el.dataset.shotId);
    if (!shot || !field || !['durationSeconds', 'composition', 'sound'].includes(field)) return false;
    if (field === 'durationSeconds') shot.durationSeconds = Number(el.value);
    else if (el.value.trim()) shot[field as 'composition' | 'sound'] = el.value; else delete shot[field as 'composition' | 'sound'];
    this.persist(); return true;
  }

  /** Selects, checkboxes and the version picker change structure or warnings, so they re-render. */
  change(el: Field): boolean {
    if (this.bible.change(el)) return true;
    if (el.id === 'shot-list-version') { this.selectedId = el.value; this.draft = null; this.draftFor = ''; this.hooks.render(); return true; }
    if (!this.draft) return false;
    const shot = this.shot(el.dataset.shotId);
    if (el.dataset.adaptationLanguage) {
      if (el.value) this.draft.adaptations[el.dataset.adaptationLanguage] = el.value; else delete this.draft.adaptations[el.dataset.adaptationLanguage];
    } else if (shot && (el.dataset.shotField === 'size' || el.dataset.shotField === 'camera')) {
      if (el.dataset.shotField === 'size' && SHOT_SIZES.includes(el.value as Shot['size'])) shot.size = el.value as Shot['size'];
      if (el.dataset.shotField === 'camera' && CAMERA_MOVES.includes(el.value as Shot['camera'])) shot.camera = el.value as Shot['camera'];
    } else if (shot && el.dataset.shotSpeaker !== undefined) {
      const line = Number(el.dataset.line);
      shot.spoken = shot.spoken.filter(s => s.line !== line);
      if (el.value) shot.spoken = [...shot.spoken, {line, castId: el.value}].sort((a, b) => a.line - b.line);
    } else if (shot && el.dataset.shotCharacter) {
      const id = el.dataset.shotCharacter, checked = (el as HTMLInputElement).checked;
      shot.characters = checked ? [...new Set([...shot.characters, id])] : shot.characters.filter(c => c !== id);
    } else return false;
    this.persist(); this.hooks.render(); return true;
  }

  click(action: string, el: {dataset: DOMStringMap}, ctx: ShotListContext): boolean {
    if (!action.startsWith('shots-')) return false;
    if (this.bible.click(action, el, ctx)) return true;
    const list = this.selected(ctx), id = el.dataset.id ?? '';
    if (action === 'shots-generate') {
      const mode = el.dataset.mode === 'demo' ? 'demo' : 'live', revisionId = ctx.revision.id;
      void this.hooks.run(mode === 'demo' ? '正在载入预置分镜表…' : '正在生成分镜表…', async () => {
        const created = await this.hooks.post<ShotList>(`/api/revisions/${encodeURIComponent(revisionId)}/shot-lists`, {mode});
        await this.hooks.reload(revisionId);
        this.selectedId = created.id; this.draft = null; this.draftFor = '';
        this.hooks.notice(mode === 'demo' ? '已载入预置分镜表，不是针对当前剧本生成的。' : '分镜表已保存。请逐镜核对说话人和时长。');
      });
      return true;
    }
    if (!list) return true;
    if (action === 'shots-page') { this.page = el.dataset.id === 'review' ? 'review' : 'list'; this.hooks.render(); return true; }
    if (action === 'shots-review-confirm' || action === 'shots-review-undo') {
      const shotListId = list.id, revisionId = ctx.revision.id, confirmed = action === 'shots-review-confirm';
      void this.hooks.run(confirmed ? '正在确认这一镜…' : '正在撤销确认…', async () => {
        await this.hooks.post(`/api/shot-lists/${encodeURIComponent(shotListId)}/review`, {shotId: id, confirmed});
        await this.hooks.reload(revisionId);
      });
      return true;
    }
    if (action === 'shots-fix-duration' || action === 'shots-fix-split') {
      // A fix starts a draft of the selected version; nothing is saved until the author saves a new version.
      if (!this.draft) { this.draft = {...structuredClone({cast: list.cast, shots: list.shots}), adaptations: {...list.adaptations}}; this.draftFor = list.id; }
      try {
        if (action === 'shots-fix-duration') {
          const shot = this.shot(id), seconds = Number(el.dataset.seconds);
          if (!shot || !Number.isFinite(seconds) || seconds <= 0 || seconds > 600) { this.hooks.fail('这个时长无效。'); return true; }
          shot.durationSeconds = seconds;
        } else this.draft = {...splitShot(this.draft, id, Number(el.dataset.line)), adaptations: this.draft.adaptations};
      } catch (error) { this.hooks.fail(error instanceof Error ? error.message : '无法修改这个镜头。'); return true; }
      this.page = 'list'; this.persist();
      this.hooks.notice(action === 'shots-fix-split' ? `镜头 ${id} 已在草稿里拆成两个。看一下两段的时长和入镜人物，再点“保存为新版本”。` : `镜头 ${id} 已在草稿里改成 ${el.dataset.seconds} 秒。改完其他镜头后点“保存为新版本”。`);
      this.hooks.render(); return true;
    }
    if (action === 'shots-edit') { this.draft = {...structuredClone({cast: list.cast, shots: list.shots}), adaptations: {...list.adaptations}}; this.draftFor = list.id; this.persist(); this.hooks.render(); return true; }
    if (action === 'shots-adopt') {
      const shotListId = list.id, expectedShotListId = ctx.episode.productionShotListId ?? null, revisionId = ctx.revision.id;
      void this.hooks.run('正在采用分镜表…', async () => {
        await this.hooks.post(`/api/episodes/${encodeURIComponent(ctx.episode.id)}/production-shot-list`, {shotListId, expectedShotListId});
        await this.hooks.reload(revisionId);
        this.hooks.notice('分镜表已采用为本集的制作版本。剧本定稿变化后，它会标为不是当前版本。');
      });
      return true;
    }
    if (!this.draft) return true;
    if (action === 'shots-cancel') { if (!this.hooks.confirm('放弃对这份分镜表的修改吗？')) return true; this.discard(); this.hooks.render(); return true; }
    if (action === 'shots-save') {
      let content: ShotListContent;
      try { content = parseShotList(this.draft, ctx.revision); } catch (error) { this.hooks.fail(error instanceof Error ? error.message : '分镜表格式无效。'); return true; }
      const body = {...content, adaptations: {...this.draft.adaptations}}, sourceId = list.id, revisionId = ctx.revision.id;
      void this.hooks.run('正在保存分镜表…', async () => {
        const saved = await this.hooks.post<ShotList>(`/api/shot-lists/${encodeURIComponent(sourceId)}/edit`, body);
        storage()?.removeItem(draftKey(sourceId));
        this.draft = null; this.draftFor = ''; this.selectedId = saved.id;
        await this.hooks.reload(revisionId);
        this.hooks.notice('分镜表已另存为新版本，原版本保留。');
      });
      return true;
    }
    try {
      const adaptations = this.draft.adaptations;
      if (action === 'shots-split') this.draft = {...splitShot(this.draft, id, Number(el.dataset.line)), adaptations};
      else if (action === 'shots-merge') this.draft = {...mergeWithNext(this.draft, id), adaptations};
      else if (action === 'shots-add-cast') {
        const n = this.draft.cast.reduce((max, c) => Math.max(max, Number(c.id.slice(1))), 0) + 1;
        this.draft.cast.push({id: `C${n}`, name: `角色 ${n}`});
      } else if (action === 'shots-remove-cast') {
        if (this.draft.shots.some(s => s.characters.includes(id) || s.spoken.some(x => x.castId === id))) { this.hooks.fail('这个角色仍在镜头中出现或说话，先改掉这些标注再移除。'); return true; }
        if (this.draft.cast.length <= 1) { this.hooks.fail('分镜表至少保留一个角色。'); return true; }
        this.draft.cast = this.draft.cast.filter(c => c.id !== id);
      } else return true;
    } catch (error) { this.hooks.fail(error instanceof Error ? error.message : '无法修改这个镜头。'); return true; }
    this.persist(); this.hooks.render(); return true;
  }
}
