/** Manuscript language: a browser preference that decides which existing text the workspace shows
 * and exports. It never changes stored scripts. Every displayed value is escaped. */
import type { Localization, ProjectBundle, Revision } from '../src/types';
import { WORKSPACE_LANGUAGES, languageName, scriptLanguage } from '../src/core/languages';
import { isShortDrama } from '../src/core/formats';
import { currentAdaptation, otherVersionAdaptations } from '../src/core/manuscripts';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});

/** Not under the `sci-epo-` prefix that sign-out clears: a language choice holds no private content. */
export const MANUSCRIPT_PREFERENCE_KEY = 'sciepo-pref:manuscript-language';
export type ManuscriptLanguage = typeof WORKSPACE_LANGUAGES[number]['code'];
export const isManuscriptLanguage = (value: unknown): value is ManuscriptLanguage => WORKSPACE_LANGUAGES.some(l => l.code === value);
const SWITCH_LABELS: Record<ManuscriptLanguage, string> = {'zh-CN': '中文', en: 'English'};
const MANUSCRIPT_NAMES: Record<ManuscriptLanguage, string> = {'zh-CN': '中文稿', en: '英文稿'};
export const manuscriptName = (language: string) => isManuscriptLanguage(language) ? MANUSCRIPT_NAMES[language] : `${languageName(language)}稿`;

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): PreferenceStorage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } }
export function readManuscriptPreference(storage: PreferenceStorage | undefined = browserStorage()): ManuscriptLanguage | null {
  try { const value = storage?.getItem(MANUSCRIPT_PREFERENCE_KEY); return isManuscriptLanguage(value) ? value : null; } catch { return null; }
}
export function saveManuscriptPreference(language: ManuscriptLanguage, storage: PreferenceStorage | undefined = browserStorage()): void {
  try { storage?.setItem(MANUSCRIPT_PREFERENCE_KEY, language); } catch { /* The choice still applies until the page reloads. */ }
}

/** Languages offered for one revision: Chinese and English, plus a stored script language outside them. */
const offered = (source: string): string[] => [...WORKSPACE_LANGUAGES.map(l => l.code as string), ...(isManuscriptLanguage(source) ? [] : [source])];

/** Without a choice, the script language is shown and marked as selected. */
export function manuscriptSwitch(selected: string | null, source: string): string {
  const active = selected ?? source;
  return `<div class="manuscript-switch" role="group" aria-label="稿件语言">${offered(source).map(code => `<button type="button" data-action="manuscript-language" data-id="${esc(code)}" class="${active === code ? 'active' : ''}" aria-pressed="${active === code}">${esc(isManuscriptLanguage(code) ? SWITCH_LABELS[code] : languageName(code))}</button>`).join('')}</div>`;
}

/** One export per language; a language without a manuscript of this exact revision is not a link. */
export function exportControl(revision: Revision, localizations: Localization[]): string {
  const source = scriptLanguage(revision);
  return `<div class="export-control"><span class="small muted">导出</span>${offered(source).map(code => {
    const name = manuscriptName(code);
    return code === source || currentAdaptation(revision, localizations, code)
      ? `<a class="button subtle small-button" href="/api/revisions/${encodeURIComponent(revision.id)}/export?language=${encodeURIComponent(code)}" download>${esc(name)} ↗</a>`
      : `<span class="button subtle small-button is-disabled" aria-disabled="true" title="${esc(`这一版还没有${name}`)}">${esc(name)}</span>`;
  }).join('')}</div>`;
}

export interface ManuscriptContext { bundle: ProjectBundle; revision: Revision; language: string; versionNumber: number; busy: boolean; live: boolean; dirty: boolean }

/** Read-only manuscript of an adaptation. Review, rewriting, locks and adoption stay with the source. */
export function adaptationView(ctx: ManuscriptContext, adaptation: Localization): string {
  const {bundle, revision, language, versionNumber, busy, dirty} = ctx, source = scriptLanguage(revision);
  const kind = adaptation.mode === 'demo' ? '预置双语演示' : adaptation.mode === 'manual' ? '作者修改的译稿' : '模型改编候选';
  return `<div class="script-toolbar"><div><span class="label">${esc(manuscriptName(language))}</span><strong>V${esc(versionNumber)} 的改编</strong><span class="small muted">${esc(kind)} · ${esc(date(adaptation.createdAt))}</span></div><button class="button small-button" data-action="edit-adaptation" data-id="${esc(adaptation.id)}" data-language="${esc(language)}" ${busy ? 'disabled' : ''}>在语言与发布页修改</button></div>
    ${dirty ? '<div class="inline-warning">原稿有未保存的编辑。这里显示的是已保存版本的改编。</div>' : ''}<p class="small muted manuscript-note">审读、改稿、锁定和采用都针对原稿（${esc(languageName(source))}）。改编稿保存后不表示作者已审定。</p>
    <article class="script-paper manuscript-paper" lang="${esc(language)}"><div class="paper-kicker">${esc(bundle.project.title)} / ${esc(language.toUpperCase())} SCRIPT</div><h2 class="manuscript-title">${esc(adaptation.title)}</h2><p class="manuscript-logline">${esc(adaptation.logline)}</p>
    ${adaptation.scenes.map((s, i) => `<section class="scene" id="manuscript-${esc(s.id)}"><div class="scene-top"><span class="scene-number">SCENE ${String(i + 1).padStart(2, '0')}</span><span class="small muted">${esc(s.id)}</span></div><h3 class="manuscript-heading">${esc(s.heading)}</h3><pre class="manuscript-text">${esc(s.content)}</pre></section>`).join('')}
    <div class="paper-end">— 本版结束 —</div></article>`;
}

/** No manuscript of this revision in that language. Other versions' adaptations are mentioned, never shown as this one. */
export function missingAdaptationView(ctx: ManuscriptContext): string {
  const {bundle, revision, language, busy, live, dirty} = ctx, name = manuscriptName(language);
  const others = otherVersionAdaptations(revision, bundle.revisions, bundle.localizations, language);
  const aligned = isShortDrama(revision.context.brief) ? '逐行对齐，同一份分镜表可以配两种语言' : '保留场景编号和顺序';
  return `<section class="empty-panel manuscript-missing"><span class="empty-mark">文</span><h3>这一版还没有${esc(name)}</h3><p>${esc(name)}由这一版原稿改编，${esc(aligned)}。生成后另存为语言版本，原稿不变。</p>
    <div class="language-toolbar manuscript-actions"><button class="button primary" data-action="localize" data-mode="live" data-origin="script" data-language="${esc(language)}" data-requires-saved data-requires-live="true" ${busy || !live || dirty ? 'disabled' : ''}>生成${esc(name)}</button>${revision.mode === 'demo' ? `<button class="text-button" data-action="localize" data-mode="demo" data-origin="script" data-language="${esc(language)}" ${busy || dirty ? 'disabled' : ''}>载入预置${esc(name)} →</button>` : ''}</div>
    ${!live ? '<p class="small muted">写作模型尚未配置，暂时只能载入预置示例。</p>' : ''}${dirty ? '<p class="small muted">原稿有未保存的编辑，请先保存为新版本。</p>' : ''}${others.length ? `<p class="small muted">本集其他版本有 ${others.length} 份${esc(name)}，它们对应别的原稿版本，不是这一版的稿件。可在语言与发布页查看。</p>` : ''}</section>`;
}
