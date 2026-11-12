/** The readiness checklist of an episode before a render batch: what has passed, what warns and what fails, with the
 * tab where the author fixes it. A batch needs every item to pass, or the author's confirmation of the rest.
 * Browser-safe, so the production tab shows the same items the server checks. */
import type { Episode, Localization, LogicCheck, ProductionProfile, ReadinessItem, Review, Revision, ShotList, ShotReview } from '../types';
import { bibleNotes, bibleState, confirmedBible } from './bible';
import { logicGate } from './logic';
import { languageName, scriptLanguage } from './languages';
import { reviewProgress } from './shotReview';
import { normalizeSpeakerName } from './scriptLines';
import { boundAdaptations, newestAlignedAdaptations, shotListStatus, shotListWarnings } from './shotList';

const DIMENSION_LABELS: Record<string, string> = {story: '故事与因果', character: '人物与选择', dialogue: '对白与表达', continuity: '设定与连续性', filmability: '场面与可表演性'};
const clip = (text: string, max = 140) => { const t = text.replace(/\s+/gu, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

export interface ReadinessInput {
  episode: Pick<Episode, 'acceptedRevisionId' | 'needsReview' | 'productionShotListId' | 'bible'>;
  /** The accepted revision, when there is one. */
  revision?: Revision;
  /** The production shot list, when there is one. */
  list?: ShotList;
  /** Script logic checks of the episode. */
  logicChecks?: LogicCheck[];
  /** The author's shot-by-shot check of the production shot list. */
  shotReview?: ShotReview;
  reviews: Review[];
  localizations: Localization[];
  profile?: ProductionProfile;
  /** Voice languages of the batch; every voice language of the shot list with text when absent. */
  languages?: string[];
}

/** Open issues of a review: assessments that report an issue, and causal checks and pressures with a gap. */
export function openIssues(review: Review): {id: string; message: string}[] {
  const issues: {id: string; message: string}[] = [];
  for (const a of review.assessments) if (a.status === 'issue') issues.push({id: `issue:assessment:${a.dimension}`, message: `审稿（${DIMENSION_LABELS[a.dimension] ?? a.dimension}）：${clip(a.explanation)}`});
  (review.causality?.checks ?? []).forEach((c, i) => { if (c.verdict === 'gap') issues.push({id: `issue:causal:${c.sceneId}:${i}`, message: `因果（${c.sceneId}）：${clip(c.explanation)}`}); });
  (review.causality?.pressures ?? []).forEach((c, i) => { if (c.verdict === 'gap') issues.push({id: `issue:pressure:${c.sceneId}:${i}`, message: `压力（${c.sceneId}）：${clip(c.explanation)}`}); });
  return issues;
}

export function readinessItems(input: ReadinessInput): ReadinessItem[] {
  const {episode, revision, list} = input, items: ReadinessItem[] = [];
  const accepted = !!revision && episode.acceptedRevisionId === revision.id && !episode.needsReview;
  items.push(accepted
    ? {id: 'accepted', status: 'passed', message: '本集已采用定稿，前面没有需要复核的改动。', link: {tab: 'script'}}
    : {id: 'accepted', status: 'failed', message: episode.needsReview ? '本集因上游修改需要复核，请重新审读并采用定稿。' : '本集还没有采用定稿。', link: {tab: 'script'}});
  if (!revision) return items;
  const gate = logicGate(episode, input.logicChecks);
  items.push(gate.passed
    ? {id: 'logic', status: 'passed', message: `剧本逻辑检查已处理完：${gate.check.findings.length ? `${gate.check.findings.length} 个问题都写明了保留理由`: '没有发现断开的地方'}。`, link: {tab: 'review'}}
    : {id: 'logic', status: 'failed', message: gate.message, link: {tab: 'review'}});

  // The newest review of the accepted revision; a newer accepted revision needs its own.
  const review = input.reviews.filter(r => r.revisionId === revision.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!review) items.push({id: 'review', status: 'failed', message: '这一版定稿还没有审稿。开 GPU 之前，请先跑一次审稿，看看逻辑和因果有没有断开。', link: {tab: 'review'}});
  else if (review.mode !== 'live') items.push({id: 'review', status: 'failed', message: '这一版只有示例演练的审稿，没有真实模型审稿。', link: {tab: 'review'}});
  else if (review.errors.length || review.status !== 'completed') items.push({id: 'review', status: 'failed', message: '这一版的审稿没有完整完成或没有通过核实，请重新审稿或核实。', link: {tab: 'review'}});
  else items.push({id: 'review', status: 'passed', message: '这一版定稿有完整的真实模型审稿。', link: {tab: 'review'}});
  if (review) for (const issue of openIssues(review)) items.push({id: issue.id, status: 'warning', message: issue.message, link: {tab: 'review'}});

  const state = bibleState(episode.bible, revision);
  if (state === 'confirmed') {
    items.push({id: 'bible', status: 'passed', message: '本集设定（地点和道具）已确认，每段视频都会按它来画。', link: {tab: 'shots'}});
    for (const n of bibleNotes(episode.bible!)) items.push({id: `bible_note:${n.id}`, status: 'warning', message: `本集设定：${n.message}`, link: {tab: 'shots'}});
  } else items.push({id: 'bible', status: 'failed', link: {tab: 'shots'}, message: state === 'missing'
    ? '还没有本集设定。没有它，每段视频会各自想象房间和道具，前后对不上。请在分镜页整理并确认地点和道具。'
    : state === 'draft' ? '本集设定还是草稿，没有确认。请在分镜页看一遍地点和道具，再点确认。'
    : '剧本定稿换了版本，本集设定是按旧版确认的。请在分镜页看一遍还对不对，再重新确认。'});

  if (!list) { items.push({id: 'shot_list', status: 'failed', message: '还没有采用制作用分镜表。', link: {tab: 'shots'}}); return items; }
  const current = shotListStatus(list, episode).current;
  items.push(current
    ? {id: 'shot_list', status: 'passed', message: '制作用分镜表基于本集当前定稿。', link: {tab: 'shots'}}
    : {id: 'shot_list', status: 'failed', message: '制作用分镜表不是基于本集当前定稿的版本，请在分镜页采用新的分镜表。', link: {tab: 'shots'}});

  const progress = reviewProgress(list, input.shotReview, confirmedBible(episode, revision));
  const listed = (ids: string[]) => ids.length > 6 ? `${ids.slice(0, 6).join('、')} 等 ${ids.length} 个` : ids.join('、');
  items.push(progress.open.length
    ? {id: 'shot_review', status: 'failed', link: {tab: 'shots', target: progress.open[0]}, message: `还有 ${progress.open.length} 个镜头没有逐个确认：${listed(progress.open)}。${progress.outdated.length ? `其中 ${listed(progress.outdated)} 是本集设定改过之后要重新确认的。` : ''}请在分镜页的“逐镜确认”里一个个看过。`}
    : {id: 'shot_review', status: 'passed', message: `全部 ${list.shots.length} 个镜头都已逐个确认。`, link: {tab: 'shots'}});

  const source = scriptLanguage(revision), bound = boundAdaptations(list, input.localizations);
  const languages = input.languages ?? list.voiceLanguages.filter(l => l === source || bound[l]);
  for (const language of input.languages ?? list.voiceLanguages) {
    if (language === source) continue;
    items.push(bound[language]
      ? {id: `adaptation:${language}`, status: languages.includes(language) ? 'passed' : 'warning', message: languages.includes(language) ? `${languageName(language)}逐行对齐稿已绑定到分镜表。` : `${languageName(language)}这次不渲染。`, link: {tab: 'languages'}}
      : {id: `adaptation:${language}`, status: 'failed', message: `${languageName(language)}还没有绑定到分镜表的逐行对齐稿。`, link: {tab: 'languages'}});
  }

  const newest = Object.fromEntries(Object.entries(newestAlignedAdaptations(revision, input.localizations, list.voiceLanguages)).map(([language, l]) => [language, l.id]));
  shotListWarnings(list, {revision, adaptations: bound, newest}).forEach((w, i) => {
    items.push({id: `shot_warning:${w.kind}:${w.shotId ?? w.language ?? i}`, status: 'warning', message: `分镜：${w.message}`, link: {tab: 'shots', ...(w.shotId ? {target: w.shotId} : {})}});
  });

  const characterOf = (name: string) => input.profile?.characters.find(c => normalizeSpeakerName(c.name) === normalizeSpeakerName(name));
  const inFrame = new Set(list.shots.flatMap(s => s.characters)), speakers = new Set(list.shots.flatMap(s => s.spoken.map(x => x.castId)));
  for (const member of list.cast) {
    const c = characterOf(member.name);
    if (inFrame.has(member.id)) {
      if (!c?.appearance) items.push({id: `appearance:${member.name}`, status: 'warning', message: `${member.name} 没有外貌描述，不同片段里可能长得不一样。`, link: {tab: 'production'}});
      if (c?.portrait && c.usePortrait !== false) items.push({id: `portrait:${member.name}`, status: 'passed', message: `${member.name} 有选定的参考图。`, link: {tab: 'production'}});
      else if (c?.usePortrait === false) items.push({id: `portrait:${member.name}`, status: 'warning', message: `${member.name} 选择不用参考图：不同片段里可能长得不一样，只有这个角色入镜的片段要用文生模式。`, link: {tab: 'production'}});
      else items.push({id: `portrait:${member.name}`, status: 'failed', message: `${member.name} 还没有选定参考图。请上传一张和外貌描述一致的参考图（例如描述里没有兜帽，图里就不要戴兜帽）。`, link: {tab: 'production'}});
    }
    if (speakers.has(member.id) && !c?.voice && !c?.voiceSampleAsset) items.push({id: `voice:${member.name}`, status: 'warning', message: `${member.name} 没有声音描述，不同片段里的声音可能不一样。`, link: {tab: 'production'}});
  }
  return items;
}

/** Items that need the author's confirmation: everything that did not pass. */
export const unconfirmedItems = (items: ReadinessItem[], confirmed: readonly string[]): ReadinessItem[] =>
  items.filter(item => item.status !== 'passed' && !confirmed.includes(item.id));
