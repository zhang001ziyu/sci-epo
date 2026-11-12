/** The shot-by-shot check before rendering: what each shot shows, where, who, how long, and the exact lines,
 * in plain words, with one confirmation per shot. Pure rendering; ShotListPanel owns the state and the clicks. */
import type { CastMember, EpisodeBible, Revision, Shot, ShotReview } from '../src/types';
import { sceneSetting } from '../src/core/bible';
import { languageName } from '../src/core/languages';
import { dialoguePositions, labelOnly, scriptLines } from '../src/core/scriptLines';
import { isTooShort, screenTextLines, type ShotNeed, type ShotView, type ShotWarning } from '../src/core/shotList';
import { bibleStamp } from '../src/core/shotReview';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

export const SIZE_PLAIN: Record<Shot['size'], string> = {extreme_close_up: '大特写（只拍很小的局部）', close_up: '特写（拍一张脸或一样东西）', medium_close_up: '近景（胸口以上）', medium: '中景（腰部以上）', medium_wide: '中全景（膝盖以上）', wide: '全景（整个人和周围环境）', insert: '插入镜头（拍一样东西的细节）'};
export const CAMERA_PLAIN: Record<Shot['camera'], string> = {static: '镜头不动', push_in: '镜头慢慢推近', pull_out: '镜头慢慢拉远', pan: '镜头左右摇', tilt: '镜头上下摇', track: '镜头跟着人移动', handheld: '手持，轻微晃动'};

export interface ReviewInput {
  views: ShotView[];
  cast: CastMember[];
  revision: Revision;
  /** The script language first, then each bound adaptation language. */
  languages: string[];
  needs: Map<string, ShotNeed>;
  warnings: ShotWarning[];
  /** The confirmed bible of the list's revision, when there is one. */
  bible?: EpisodeBible;
  review?: ShotReview;
  /** False when the list is not the current production list or the bible is not confirmed. */
  canConfirm: boolean;
  blocked?: string;
  disabled: string;
}

type LineKind = 'dialogue' | 'action' | 'screen' | 'label';
const KIND_LABELS: Record<LineKind, string> = {dialogue: '台词', action: '动作', screen: '画面文字', label: '说话人'};

/** One-click fixes of a warning, as buttons: the duration the content needs, and the split point. */
export function fixButtons(w: ShotWarning, disabled: string): string {
  if (!w.shotId) return '';
  const out: string[] = [];
  if (w.suggestedSeconds) out.push(`<button class="text-button" data-action="shots-fix-duration" data-id="${esc(w.shotId)}" data-seconds="${esc(w.suggestedSeconds)}" ${disabled}>改成 ${esc(w.suggestedSeconds)} 秒</button>`);
  if (w.splitAt) out.push(`<button class="text-button" data-action="shots-fix-split" data-id="${esc(w.shotId)}" data-line="${esc(w.splitAt)}" ${disabled}>从第 ${esc(w.splitAt)} 行拆成两个镜头</button>`);
  return out.length ? ` <span class="fix-buttons">${out.join(' ')}</span>` : '';
}

export function reviewView(o: ReviewInput): string {
  const stamp = bibleStamp(o.bible), names = new Map(o.cast.map(c => [c.id, c.name]));
  const state = (id: string) => { const e = o.review?.shots[id]; return !e ? 'open' : e.bible === stamp ? 'confirmed' : 'outdated'; };
  const done = o.views.filter(v => state(v.shot.id) === 'confirmed').length;
  const intro = `<div class="review-intro"><p><strong>开 GPU 之前，一个镜头一个镜头地看。</strong>每张卡片写着这一镜拍什么、在哪里、谁在画面里、多长，以及这一镜要念的台词。没问题就点“这一镜没问题”。全部确认后，开拍清单里的“逐镜确认”才算通过。</p><p class="small muted">发现问题就点卡片里的修改按钮，或切回“分镜表”去改。改完会存成新的分镜表版本，没改动的镜头会保留确认；新版本需要重新采用。</p><div class="review-progress"><span>已确认 <strong>${esc(done)}</strong> / ${esc(o.views.length)} 个镜头</span><progress max="${esc(o.views.length)}" value="${esc(done)}"></progress></div>${o.blocked ? `<div class="inline-warning">${esc(o.blocked)}</div>` : ''}</div>`;
  const sceneLines = new Map(o.revision.scenes.map(s => [s.id, scriptLines(s.content)])), dialogue = new Map(o.revision.scenes.map(s => [s.id, dialoguePositions(s.content)]));
  const cards = o.views.map(({shot, order, lines}) => {
    const need = o.needs.get(shot.id), setting = o.bible ? sceneSetting(o.bible, shot.sceneId) : undefined, s = state(shot.id);
    const screen = new Set(screenTextLines(shot, sceneLines.get(shot.sceneId) ?? [])), spoken = new Map(shot.spoken.map(x => [x.line, x.castId]));
    const kindOf = (position: number): LineKind => {
      if (spoken.has(position) || dialogue.get(shot.sceneId)?.has(position)) return 'dialogue';
      if (screen.has(position)) return 'screen';
      const text = sceneLines.get(shot.sceneId)?.[position - 1] ?? '';
      return labelOnly(text) && dialogue.get(shot.sceneId)?.has(position + 1) ? 'label' : 'action';
    };
    const kinds = lines.map(l => kindOf(l.position));
    const people = shot.characters.map(id => names.get(id) ?? id), speakers = [...new Set(shot.spoken.map(x => names.get(x.castId) ?? x.castId))];
    const counts = [kinds.filter(k => k === 'action').length ? `${kinds.filter(k => k === 'action').length} 个动作` : '', kinds.filter(k => k === 'dialogue').length ? `${kinds.filter(k => k === 'dialogue').length} 句台词${speakers.length ? `（${speakers.map(esc).join('、')} 说）` : ''}` : '', kinds.filter(k => k === 'screen').length ? `${kinds.filter(k => k === 'screen').length} 处画面文字` : ''].filter(Boolean).join('，') || '没有动作和台词';
    const where = setting?.location ? `在<strong>${esc(setting.location.name)}</strong>` : '<span class="muted">地点：本集设定还没确认</span>';
    const summary = `<p class="review-summary">${esc(SIZE_PLAIN[shot.size])}，${esc(CAMERA_PLAIN[shot.camera])}。${where}。画面里：${people.length ? people.map(esc).join('、') : '没有人物'}。内容：${counts}。</p>`;
    const short = !!need && isTooShort(need, shot);
    const timing = `<p class="review-timing ${short ? 'short' : ''}">时长：现在 <strong>${esc(shot.durationSeconds)} 秒</strong>${need ? `；按内容大约要 ${esc(need.seconds)} 秒${short ? '，<strong>偏短</strong>' : need.seconds > shot.durationSeconds ? '，差一点，问题不大' : '，够用'}` : ''}</p>`;
    const props = setting && setting.props.length ? `<p class="small">这一场的道具：${setting.props.map(p => esc(p.name)).join('、')}</p>` : '';
    const lineRows = lines.map((line, i) => {
      const kind = kinds[i]!, who = kind === 'dialogue' ? names.get(spoken.get(line.position) ?? '') ?? '没标说话人' : '';
      return `<div class="review-line ${kind}"><span class="line-kind">${esc(line.position)} · ${esc(KIND_LABELS[kind])}${who ? ` · ${esc(who)}` : ''}</span><div>${o.languages.map((language, j) => `<p lang="${esc(language)}"${j ? ' class="secondary-language"' : ''}>${esc(line.texts[language] || '—')}${o.languages.length > 1 ? ` <span class="small muted">${esc(languageName(language))}</span>` : ''}</p>`).join('')}</div></div>`;
    }).join('');
    const notes = [shot.composition ? `<p class="shot-note"><span class="label">构图</span>${esc(shot.composition)}</p>` : '', shot.sound ? `<p class="shot-note"><span class="label">声音</span>${esc(shot.sound)}</p>` : ''].join('');
    const warnings = o.warnings.filter(w => w.shotId === shot.id);
    const warningList = warnings.length ? `<ul class="shot-warnings">${warnings.map(w => `<li>${esc(w.message)}${fixButtons(w, o.disabled)}</li>`).join('')}</ul>` : '';
    const pill = s === 'confirmed' ? '<span class="pill accepted">已确认</span>' : s === 'outdated' ? '<span class="pill changed">设定改过，要重看</span>' : '<span class="pill">未确认</span>';
    const button = s === 'confirmed'
      ? `<button class="button subtle small-button" data-action="shots-review-undo" data-id="${esc(shot.id)}" ${o.disabled}>撤销确认</button>`
      : `<button class="button primary small-button" data-action="shots-review-confirm" data-id="${esc(shot.id)}" ${o.canConfirm ? o.disabled : 'disabled'}>这一镜没问题</button>`;
    return `<article class="review-card ${esc(s)}" data-shot="${esc(shot.id)}"><div class="review-card-head"><strong>第 ${esc(order)} 镜</strong><span class="small muted">${esc(shot.id)} · 场景 ${esc(shot.sceneId)} · 第 ${esc(shot.firstLine)}–${esc(shot.lastLine)} 行</span>${pill}</div>${summary}${timing}${props}<div class="review-lines">${lineRows}</div>${notes}${warningList}<div class="review-actions">${button}</div></article>`;
  }).join('');
  return `<section class="review-view">${intro}<div class="review-list">${cards}</div></section>`;
}
