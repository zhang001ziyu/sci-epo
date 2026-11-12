/** Shot lists: validation, warnings, editing operations and CSV export, shared by the server and the browser.
 * Shots reference script lines by position; text is always read from the bound revision and adaptations.
 * The storyboard prompt lives in storyboardPrompt.ts so the browser bundle carries no model instructions. */
import { CAMERA_MOVES, SHOT_SIZES, type CastMember, type Episode, type Localization, type Revision, type Scene, type Shot, type ShotList, type ShotListContent } from '../types';
import { MAX_SHOT_SECONDS } from './formats';
import { languageName, scriptLanguage } from './languages';
import { READING_SPEEDS, dialoguePositions, isLineAligned, minimumSpeechSeconds, normalizeSpeakerName, quotedParts, readingCharacters, readingSeconds, screenTextOf, scriptLines, type ReadingSpeeds } from './scriptLines';

export class ShotListError extends Error { override name = 'ShotListError'; }
const reject = (message: string): never => { throw new ShotListError(message); };
const record = (value: unknown, label: string): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject(`${label}格式无效。`);
const CAST_ID = /^C\d{1,3}$/u, SHOT_ID = /^[A-Za-z0-9_-]{1,40}$/u;
const round = (value: number) => Math.round(value * 10) / 10;

function note(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 500) return reject(`${label}需为 500 字以内的文字。`);
  return value.trim() || undefined;
}

function parseShot(item: unknown, index: number, counts: Map<string, number>, castIds: Set<string>): Shot {
  const shot = record(item, `第 ${index + 1} 个镜头`), id = shot.id;
  if (typeof id !== 'string' || !SHOT_ID.test(id)) return reject(`第 ${index + 1} 个镜头的编号无效。`);
  const sceneId = shot.sceneId;
  if (typeof sceneId !== 'string' || !counts.has(sceneId)) return reject(`镜头 ${id} 的场景 ${String(sceneId)} 不存在。`);
  const count = counts.get(sceneId)!, {firstLine, lastLine} = shot;
  if (typeof firstLine !== 'number' || typeof lastLine !== 'number' || !Number.isSafeInteger(firstLine) || !Number.isSafeInteger(lastLine) || firstLine < 1 || lastLine < firstLine || lastLine > count) {
    return reject(`镜头 ${id} 的行号范围无效：场景 ${sceneId} 共 ${count} 行。`);
  }
  if (!SHOT_SIZES.includes(shot.size as Shot['size'])) return reject(`镜头 ${id} 的景别无效。`);
  if (!CAMERA_MOVES.includes(shot.camera as Shot['camera'])) return reject(`镜头 ${id} 的运镜无效。`);
  const characters = shot.characters ?? [];
  if (!Array.isArray(characters) || characters.length > 10 || characters.some(c => typeof c !== 'string' || !castIds.has(c)) || new Set(characters).size !== characters.length) {
    return reject(`镜头 ${id} 的入镜人物必须是角色表中不重复的编号。`);
  }
  const spokenInput = shot.spoken ?? [];
  if (!Array.isArray(spokenInput) || spokenInput.length > 40) return reject(`镜头 ${id} 的台词标注无效。`);
  const seen = new Set<number>();
  const spoken = spokenInput.map(entry => {
    const s = record(entry, `镜头 ${id} 的台词标注`), line = s.line, castId = s.castId;
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < firstLine || line > lastLine) return reject(`镜头 ${id} 标注的台词行 ${String(line)} 不在本镜第 ${firstLine}–${lastLine} 行之内。`);
    if (seen.has(line)) return reject(`镜头 ${id} 的第 ${line} 行重复标注了说话人。`);
    if (typeof castId !== 'string' || !castIds.has(castId)) return reject(`镜头 ${id} 第 ${line} 行的说话人 ${String(castId)} 不在角色表中。`);
    seen.add(line);
    return {line, castId};
  }).sort((a, b) => a.line - b.line);
  const duration = shot.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration > 600 || round(duration) <= 0) return reject(`镜头 ${id} 的预计时长需在 0.1–600 秒之间。`);
  const composition = note(shot.composition, `镜头 ${id} 的构图说明`), sound = note(shot.sound, `镜头 ${id} 的声音说明`);
  const screenText = screenTextMarks(shot.screenText, id, firstLine, lastLine);
  return {id, sceneId, firstLine, lastLine, size: shot.size as Shot['size'], camera: shot.camera as Shot['camera'], characters: [...characters] as string[], spoken,
    durationSeconds: round(duration), ...(composition ? {composition} : {}), ...(sound ? {sound} : {}), ...(screenText ? {screenText} : {})};
}

/** Line positions inside the shot that carry on-screen text: unique, at most 20, sorted. Absent stays absent. */
function screenTextMarks(value: unknown, id: string, firstLine: number, lastLine: number): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20) return reject(`镜头 ${id} 的画面文字标注需为不超过 20 个行号的列表。`);
  const seen = new Set<number>();
  for (const line of value) {
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < firstLine || line > lastLine) return reject(`镜头 ${id} 标注的画面文字行 ${String(line)} 不在本镜第 ${firstLine}–${lastLine} 行之内。`);
    if (seen.has(line)) return reject(`镜头 ${id} 的第 ${line} 行重复标注了画面文字。`);
    seen.add(line);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Positions of a shot's lines that carry on-screen text: the marked ones, or, for a shot without the field,
 * its non-dialogue lines with quoted text. sceneLines are the scene's lines in the script language. */
export function screenTextLines(shot: Pick<Shot, 'firstLine' | 'lastLine' | 'spoken' | 'screenText'>, sceneLines: string[]): number[] {
  if (shot.screenText) return shot.screenText.filter(p => p >= shot.firstLine && p <= shot.lastLine).sort((a, b) => a - b);
  const spoken = new Set(shot.spoken.map(s => s.line)), positions: number[] = [];
  for (let position = shot.firstLine; position <= shot.lastLine; position++) if (!spoken.has(position) && quotedParts(sceneLines[position - 1] ?? '').length) positions.push(position);
  return positions;
}

function requireCoverage(shots: Shot[], scenes: Pick<Scene, 'id'>[], counts: Map<string, number>): void {
  let index = 0, expected = 1;
  const count = (i: number) => counts.get(scenes[i]!.id)!;
  const advance = () => { while (index < scenes.length && expected > count(index)) { index++; expected = 1; } };
  for (const shot of shots) {
    advance();
    const scene = scenes[index];
    if (!scene) return reject(`镜头 ${shot.id} 排在最后一场之后。`);
    if (shot.sceneId !== scene.id) {
      return reject(scenes.findIndex(s => s.id === shot.sceneId) < index
        ? `镜头 ${shot.id} 回到了已经拆完的场景 ${shot.sceneId}；镜头必须按场景顺序排列。`
        : `场景 ${scene.id} 第 ${expected}–${count(index)} 行没有镜头覆盖。`);
    }
    if (shot.firstLine !== expected) {
      return reject(shot.firstLine < expected ? `镜头 ${shot.id} 与前一个镜头在场景 ${scene.id} 第 ${shot.firstLine} 行重叠。` : `场景 ${scene.id} 第 ${expected}–${shot.firstLine - 1} 行没有镜头覆盖。`);
    }
    expected = shot.lastLine + 1;
  }
  advance();
  if (index < scenes.length) reject(`场景 ${scenes[index]!.id} 第 ${expected}–${count(index)} 行没有镜头覆盖。`);
}

/** One validator for model output and manual edits. Unknown keys are dropped, so shots never carry script text. */
export function parseShotList(value: unknown, revision: Pick<Revision, 'scenes'>): ShotListContent {
  const row = record(value, '分镜表');
  if (!Array.isArray(row.cast) || row.cast.length < 1 || row.cast.length > 20) reject('分镜表需要 1–20 个角色。');
  const cast: CastMember[] = (row.cast as unknown[]).map((item, index) => {
    const member = record(item, `第 ${index + 1} 个角色`);
    if (typeof member.id !== 'string' || !CAST_ID.test(member.id)) return reject(`第 ${index + 1} 个角色的编号无效，应为 C1、C2 这样的编号。`);
    if (typeof member.name !== 'string' || !member.name.trim() || member.name.length > 60) return reject(`角色 ${member.id} 的名字需为 1–60 个字符。`);
    return {id: member.id, name: member.name.trim()};
  });
  if (new Set(cast.map(c => c.id)).size !== cast.length) reject('角色编号重复。');
  if (new Set(cast.map(c => c.name.toLocaleUpperCase())).size !== cast.length) reject('角色名字重复。');
  if (!Array.isArray(row.shots) || row.shots.length < 1 || row.shots.length > 400) reject('分镜表需要 1–400 个镜头。');
  const counts = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content).length]));
  const shots = (row.shots as unknown[]).map((item, index) => parseShot(item, index, counts, new Set(cast.map(c => c.id))));
  if (new Set(shots.map(s => s.id)).size !== shots.length) reject('镜头编号重复。');
  requireCoverage(shots, revision.scenes, counts);
  return {cast, shots};
}

export function parseShotListOutput(raw: string, revision: Pick<Revision, 'scenes'>): ShotListContent {
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); }
  catch { return reject('模型输出不是完整的 JSON。'); }
  return parseShotList(value, revision);
}

/** Adaptations bound to a new shot list: the newest line-aligned one per extra voice language. */
export function newestAlignedAdaptations(revision: Revision, localizations: Localization[], voiceLanguages: string[]): Record<string, Localization> {
  const source = scriptLanguage(revision), result: Record<string, Localization> = {};
  for (const language of voiceLanguages) {
    if (language === source) continue;
    const newest = localizations.filter(l => l.sourceRevisionId === revision.id && l.language === language && isLineAligned(revision, l)).at(-1);
    if (newest) result[language] = newest;
  }
  return result;
}

export function parseAdaptationBinding(value: unknown, revision: Revision, localizations: Localization[], voiceLanguages: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  const row = record(value, '改编绑定'), source = scriptLanguage(revision), result: Record<string, string> = {};
  for (const [language, id] of Object.entries(row)) {
    if (language === source || !voiceLanguages.includes(language)) reject(`${language} 不是需要改编的配音语言。`);
    const adaptation = typeof id === 'string' ? localizations.find(l => l.id === id) : undefined;
    if (!adaptation || adaptation.sourceRevisionId !== revision.id || adaptation.language !== language) return reject(`${languageName(language)} 的改编不属于这一版剧本。`);
    if (!isLineAligned(revision, adaptation)) reject(`${languageName(language)} 的改编没有逐行对齐，不能绑定到分镜表。`);
    result[language] = adaptation.id;
  }
  return result;
}

export function boundAdaptations(list: Pick<ShotList, 'adaptations'>, localizations: Localization[]): Record<string, Localization> {
  return Object.fromEntries(Object.entries(list.adaptations).flatMap(([language, id]) => {
    const adaptation = localizations.find(l => l.id === id);
    return adaptation ? [[language, adaptation]] : [];
  }));
}

export interface ShotLine { position: number; texts: Record<string, string>; speakerId?: string }
export interface ShotView { shot: Shot; order: number; lines: ShotLine[] }

/** Covered lines of every shot in the script language and each bound adaptation. */
export function shotTexts(list: Pick<ShotList, 'shots'>, revision: Pick<Revision, 'scenes' | 'language' | 'context'>, adaptations: Record<string, Pick<Localization, 'scenes'>>): ShotView[] {
  const source = scriptLanguage(revision as Revision);
  const sceneLines = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content)]));
  const adapted = Object.entries(adaptations).map(([language, l]) => [language, new Map(l.scenes.map(s => [s.id, scriptLines(s.content)]))] as const);
  return list.shots.map((shot, index) => ({shot, order: index + 1, lines: Array.from({length: shot.lastLine - shot.firstLine + 1}, (_, offset) => {
    const position = shot.firstLine + offset, speakerId = shot.spoken.find(s => s.line === position)?.castId;
    const texts: Record<string, string> = {[source]: sceneLines.get(shot.sceneId)?.[position - 1] ?? ''};
    for (const [language, scenes] of adapted) texts[language] = scenes.get(shot.sceneId)?.[position - 1] ?? '';
    return {position, texts, ...(speakerId ? {speakerId} : {})};
  })}));
}

export const totalDuration = (list: Pick<ShotList, 'shots'>): number => round(list.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0));

export type ShotWarningKind = 'too_long' | 'too_short_for_speech' | 'multiple_speakers' | 'label_mismatch' | 'unassigned_dialogue' | 'dialogue_misaligned' | 'total_duration' | 'missing_language' | 'adaptation_not_newest' | 'screen_text_unreadable';
export interface ShotWarning { kind: ShotWarningKind; message: string; shotId?: string; language?: string }
/** readingSpeed overrides READING_SPEEDS, in characters per second. */
export interface ShotListContext { revision: Revision; adaptations: Record<string, Pick<Localization, 'id' | 'scenes'>>; newest?: Record<string, string>; readingSpeed?: ReadingSpeeds }

/** Advisory checks only: they never block saving, adoption or export. */
export function shotListWarnings(list: Pick<ShotList, 'cast' | 'shots' | 'voiceLanguages'>, context: ShotListContext): ShotWarning[] {
  const {revision, adaptations} = context, source = scriptLanguage(revision), warnings: ShotWarning[] = [];
  const names = new Map(list.cast.map(c => [c.id, c.name])), languages = [source, ...Object.keys(adaptations)];
  const sceneLines = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content)])), speeds = context.readingSpeed ?? READING_SPEEDS;
  for (const {shot, lines} of shotTexts(list, revision, adaptations)) {
    if (shot.durationSeconds > MAX_SHOT_SECONDS) warnings.push({kind: 'too_long', shotId: shot.id, message: `镜头 ${shot.id} 预计 ${shot.durationSeconds} 秒，超过单次视频生成的 ${MAX_SHOT_SECONDS} 秒。`});
    const spoken = new Set(shot.spoken.map(s => s.line));
    for (const language of languages) {
      const texts = lines.filter(l => spoken.has(l.position)).map(l => l.texts[language] ?? '').filter(Boolean);
      const minimum = minimumSpeechSeconds(texts, language);
      if (texts.length && shot.durationSeconds < minimum) warnings.push({kind: 'too_short_for_speech', shotId: shot.id, language, message: `镜头 ${shot.id} 预计 ${shot.durationSeconds} 秒，${languageName(language)} 台词至少约需 ${minimum} 秒。`});
    }
    const screen = screenTextLines(shot, sceneLines.get(shot.sceneId) ?? []);
    if (screen.length) for (const language of languages) {
      const texts = screen.map(position => screenTextOf(lines.find(l => l.position === position)?.texts[language] ?? '')).filter(Boolean);
      const seconds = readingSeconds(texts, language, speeds), characters = texts.reduce((sum, text) => sum + readingCharacters(text), 0);
      if (seconds > shot.durationSeconds) warnings.push({kind: 'screen_text_unreadable', shotId: shot.id, language, message: `镜头 ${shot.id} 的画面文字（${languageName(language)}）有 ${characters} 个字符，约需 ${Math.ceil(seconds * 10) / 10} 秒读完，镜头只有 ${shot.durationSeconds} 秒。可以缩短文字，或延长这个镜头。`});
    }
    const speakers = new Set(shot.spoken.map(s => s.castId));
    if (speakers.size > 1) warnings.push({kind: 'multiple_speakers', shotId: shot.id, message: `镜头 ${shot.id} 有 ${speakers.size} 人说话，视频模型可能把台词安到别人嘴上；可考虑拆成正反打。`});
  }
  for (const scene of revision.scenes) {
    const dialogue = dialoguePositions(scene.content), shots = list.shots.filter(s => s.sceneId === scene.id);
    for (const [position, label] of dialogue) {
      const shot = shots.find(s => s.firstLine <= position && position <= s.lastLine), castId = shot?.spoken.find(s => s.line === position)?.castId;
      if (!castId) warnings.push({kind: 'unassigned_dialogue', ...(shot ? {shotId: shot.id} : {}), message: `场景 ${scene.id} 第 ${position} 行是 ${label} 的台词，但没有标注说话人。`});
      else if (normalizeSpeakerName(label) !== normalizeSpeakerName(names.get(castId) ?? '')) warnings.push({kind: 'label_mismatch', shotId: shot!.id, message: `场景 ${scene.id} 第 ${position} 行剧本写的说话人是 ${label}，镜头标注的是 ${names.get(castId) ?? castId}。`});
    }
    for (const [language, adaptation] of Object.entries(adaptations)) {
      const target = adaptation.scenes.find(s => s.id === scene.id);
      if (!target) continue;
      const adapted = dialoguePositions(target.content);
      for (const position of [...new Set([...dialogue.keys(), ...adapted.keys()])].sort((a, b) => a - b)) {
        if (dialogue.has(position) !== adapted.has(position)) warnings.push({kind: 'dialogue_misaligned', language, message: `场景 ${scene.id} 第 ${position} 行在原稿中${dialogue.has(position) ? '是' : '不是'}台词，在${languageName(language)}改编中${adapted.has(position) ? '是' : '不是'}台词；改编可能在这一行错位。`});
      }
    }
  }
  for (const language of list.voiceLanguages) if (language !== source && !adaptations[language]) warnings.push({kind: 'missing_language', language, message: `配音语言 ${languageName(language)} 还没有绑定逐行对齐的改编。`});
  for (const [language, adaptation] of Object.entries(adaptations)) {
    const newest = context.newest?.[language];
    if (newest && newest !== adaptation.id) warnings.push({kind: 'adaptation_not_newest', language, message: `绑定的 ${languageName(language)} 改编不是最新的逐行对齐版本。`});
  }
  const total = totalDuration(list), target = revision.context.brief.durationTarget;
  if (target && (total < target.min || total > target.max)) warnings.push({kind: 'total_duration', message: `全部镜头预计共 ${total} 秒，目标为 ${target.min}–${target.max} 秒。`});
  return warnings;
}

export function shotListStatus(list: Pick<ShotList, 'id' | 'sourceRevisionId'>, episode: Pick<Episode, 'acceptedRevisionId' | 'needsReview' | 'productionShotListId'>) {
  const adopted = episode.productionShotListId === list.id;
  const sourceAccepted = list.sourceRevisionId === episode.acceptedRevisionId && !episode.needsReview;
  return {adopted, current: adopted && sourceAccepted, adoptable: sourceAccepted && !adopted};
}

/** Scenes whose heading or content differ, including scenes present in only one revision. */
export function sceneDifferences(from: Pick<Revision, 'scenes'>, to: Pick<Revision, 'scenes'>): string[] {
  const ids = [...new Set([...from.scenes.map(s => s.id), ...to.scenes.map(s => s.id)])];
  return ids.filter(id => {
    const a = from.scenes.find(s => s.id === id), b = to.scenes.find(s => s.id === id);
    return !a || !b || a.heading !== b.heading || a.content !== b.content;
  });
}

export function nextShotId(shots: Pick<Shot, 'id'>[]): string {
  const used = new Set(shots.map(s => s.id));
  let n = shots.reduce((max, s) => Math.max(max, Number(/^sh(\d+)$/u.exec(s.id)?.[1] ?? 0)), 0) + 1;
  while (used.has(`sh${n}`)) n++;
  return `sh${n}`;
}

/** Split before atLine. The second part gets a new ID; every other shot keeps its ID. */
export function splitShot(content: ShotListContent, shotId: string, atLine: number): ShotListContent {
  const index = content.shots.findIndex(s => s.id === shotId), shot = content.shots[index];
  if (!shot || !Number.isSafeInteger(atLine) || atLine <= shot.firstLine || atLine > shot.lastLine) return reject(`镜头 ${shotId} 不能从第 ${atLine} 行拆开。`);
  const share = (atLine - shot.firstLine) / (shot.lastLine - shot.firstLine + 1);
  const firstDuration = Math.max(0.5, round(shot.durationSeconds * share)), secondDuration = Math.max(0.5, round(shot.durationSeconds - firstDuration));
  // On-screen text marks follow their lines; a shot without marks stays without them.
  const first: Shot = {...structuredClone(shot), lastLine: atLine - 1, spoken: shot.spoken.filter(s => s.line < atLine).map(s => ({...s})), durationSeconds: firstDuration,
    ...(shot.screenText ? {screenText: shot.screenText.filter(line => line < atLine)} : {})};
  const second: Shot = {...structuredClone(shot), id: nextShotId(content.shots), firstLine: atLine, spoken: shot.spoken.filter(s => s.line >= atLine).map(s => ({...s})), durationSeconds: secondDuration,
    ...(shot.screenText ? {screenText: shot.screenText.filter(line => line >= atLine)} : {})};
  return {cast: structuredClone(content.cast), shots: [...content.shots.slice(0, index), first, second, ...content.shots.slice(index + 1)].map(s => structuredClone(s))};
}

/** Merge with the following shot of the same scene, keeping the first shot's ID. */
export function mergeWithNext(content: ShotListContent, shotId: string): ShotListContent {
  const index = content.shots.findIndex(s => s.id === shotId), shot = content.shots[index], next = content.shots[index + 1];
  if (!shot || !next || next.sceneId !== shot.sceneId) return reject(`镜头 ${shotId} 后面没有同一场的镜头可以合并。`);
  const join = (a?: string, b?: string) => [...new Set([a, b].filter((v): v is string => !!v))].join(' / ').slice(0, 500) || undefined;
  const composition = join(shot.composition, next.composition), sound = join(shot.sound, next.sound);
  // Marks of either shot carry over; when neither has marks, the merged shot keeps the quoted-text fallback.
  const screenText = shot.screenText || next.screenText ? [...new Set([...shot.screenText ?? [], ...next.screenText ?? []])].sort((a, b) => a - b).slice(0, 20) : undefined;
  const {composition: _c, sound: _s, screenText: _t, ...rest} = structuredClone(shot);
  const merged: Shot = {...rest, lastLine: next.lastLine, characters: [...new Set([...shot.characters, ...next.characters])].slice(0, 10),
    spoken: [...shot.spoken, ...next.spoken].map(s => ({...s})), durationSeconds: Math.min(600, round(shot.durationSeconds + next.durationSeconds)),
    ...(composition ? {composition} : {}), ...(sound ? {sound} : {}), ...(screenText ? {screenText} : {})};
  return {cast: structuredClone(content.cast), shots: [...content.shots.slice(0, index), merged, ...content.shots.slice(index + 2)].map(s => structuredClone(s))};
}

const FORMULA_START = /^[=+\-@\t\r]/u;
/** RFC 4180 cell; values a spreadsheet would run as formulas get a leading apostrophe. */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportShotListCsv(input: {list: ShotList; revision: Revision; adaptations: Record<string, Pick<Localization, 'scenes'>>; episodeTitle: string; status: {adopted: boolean; current: boolean}}): string {
  const {list, revision, adaptations, episodeTitle, status} = input;
  const languages = [scriptLanguage(revision), ...Object.keys(adaptations)], names = new Map(list.cast.map(c => [c.id, c.name]));
  const production = status.current ? 'current' : status.adopted ? 'adopted_not_current' : 'not_adopted';
  const bound = Object.entries(list.adaptations).map(([language, id]) => `${language}:${id}`).join('; ');
  const header = ['episode', 'shot_list_version', 'source_revision', 'adaptations', 'production_status', 'aspect_ratio', 'order', 'shot_id', 'scene_id', 'lines', 'size', 'camera', 'characters', 'speakers', ...languages.map(l => `text_${l}`), 'est_seconds', 'duration_basis', 'composition', 'sound', 'screen_text'];
  const sceneLines = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content)]));
  const rows = shotTexts(list, revision, adaptations).map(({shot, order, lines}) => [
    episodeTitle, list.id, list.sourceRevisionId, bound, production, list.aspectRatio, order, shot.id, shot.sceneId, `${shot.firstLine}-${shot.lastLine}`, shot.size, shot.camera,
    shot.characters.map(id => names.get(id) ?? id).join('; '), [...new Set(shot.spoken.map(s => names.get(s.castId) ?? s.castId))].join('; '),
    ...languages.map(language => lines.map(line => line.texts[language] ?? '').join('\n')), shot.durationSeconds, 'estimate', shot.composition ?? '', shot.sound ?? '',
    // Line positions with on-screen text: the marks, or the quoted-text fallback that captions and warnings also use.
    screenTextLines(shot, sceneLines.get(shot.sceneId) ?? []).join('; '),
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
