/** MiniMax H3 render planning: clips from a production shot list and one prompt per clip and voice language.
 * Deterministic and model-free, so every prompt is checked against the script before a worker sees it.
 * Formats follow MiniMax's official H3 prompt guides: base T2VA and full-reference R2V.
 * Browser-safe: no Node.js modules, so the workspace can reuse the constants and names. */
import type { BibleContent, Localization, ProductionCharacter, ProductionProfile, RenderBatch, RenderClip, RenderJob, RenderPrompt, Revision, Shot, ShotList } from '../types';
import { settingSentences } from './bible';
import { scriptLanguage } from './languages';
import { dialoguePositions, inlineLabel, labelOnly, normalizeSpeakerName, scriptLines } from './scriptLines';

export class RenderPlanError extends Error { override name = 'RenderPlanError'; }
const reject = (message: string): never => { throw new RenderPlanError(message); };
const record = (value: unknown, label: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject(`${label}格式无效。`);
const round2 = (value: number) => Math.round(value * 100) / 100;
const pad2 = (value: number) => String(value).padStart(2, '0');

export const H3_FPS = 24;
/** 17k+5 frames: 107 is the first grid point above H3's 4-second minimum, 362 the point at about 15 seconds. */
export const H3_MIN_FRAMES = 107;
export const H3_MAX_FRAMES = 362;
export const DEFAULT_CLIP_LIMIT = 15;
export const MIN_CLIP_LIMIT = 5;
export const MAX_REFERENCE_IMAGES = 9;
export const MAX_REFERENCE_AUDIO = 3;
export const STYLE_PRESETS = ['Live-action, cinematic', '2D-animated, flat colors with clean outlines', '3D CG animation with soft lighting'] as const;
const FALLBACK_STYLE = 'Live-action, cinematic';

/** Frames for an estimate in seconds: rounded up to H3's 17k+5 grid at 24 fps and clamped to its range. */
export function h3Frames(seconds: number): number {
  const needed = Math.ceil(seconds * H3_FPS - 1e-9), k = Math.max(0, Math.ceil((needed - 5) / 17));
  return Math.min(H3_MAX_FRAMES, Math.max(H3_MIN_FRAMES, 17 * k + 5));
}
export const framesToSeconds = (frames: number) => round2(frames / H3_FPS);
/** H3's native short side is 768 pixels; both sides are multiples of 32. */
export const h3Size = (ratio: ShotList['aspectRatio']) => ratio === '9:16' ? {width: 768, height: 1344} : {width: 1344, height: 768};
export const outputName = (episodeOrdinal: number, clipId: string, language: string) => `ep${pad2(episodeOrdinal)}-${clipId}-${language}.mp4`;

/** FNV-1a over "batch:clip", so every language of one clip shares a seed and the same inputs repeat it. */
export function clipSeed(batchId: string, clipId: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${batchId}:${clipId}`)) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}

const LANGUAGE_TAGS: Record<string, string> = {en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic'};
/** The canonical English language name inside <d>[…], as the H3 guide writes it. */
export const dialogueTag = (language: string): string => LANGUAGE_TAGS[language.split('-')[0]!] ?? reject(`H3 提示词暂不支持 ${language} 的台词。`);

// Characters that carry meaning in H3 prompts: <d>, <Subject N>, [Shot N].
const UNSAFE = /[<>]|\[\s*shot\b/iu;
const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:png|jpe?g|webp)$/iu;
const AUDIO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:wav|mp3|flac)$/iu;
export const OUTPUT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
export const EMPTY_PROFILE: ProductionProfile = {style: '', music: '', characters: []};

export function parseProductionProfile(value: unknown): ProductionProfile {
  const row = record(value, '制作设定');
  const text = (input: unknown, label: string, max: number): string => {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'string' || input.length > max) return reject(`${label}需为不超过 ${max} 个字符的文字。`);
    if (UNSAFE.test(input)) return reject(`${label}不能包含 <、> 或 [Shot，它们在 H3 提示词里有特殊含义。`);
    return input.trim().replace(/\s+/gu, ' ');
  };
  const list = row.characters === undefined ? [] : Array.isArray(row.characters) ? row.characters : reject('角色设定格式无效。');
  if (list.length > 20) reject('角色设定最多 20 个。');
  const seen = new Set<string>();
  const characters = list.map((item, index): ProductionCharacter => {
    const c = record(item, `第 ${index + 1} 个角色`), name = text(c.name, '角色名', 60);
    if (!name) reject(`第 ${index + 1} 个角色缺少名字。`);
    const key = normalizeSpeakerName(name);
    if (seen.has(key)) reject(`角色 ${name} 重复。`);
    seen.add(key);
    const image = text(c.image, `${name} 的参考图`, 124), voiceSample = text(c.voiceSample, `${name} 的声音样本`, 124);
    if (image && !IMAGE_FILE.test(image)) reject(`${name} 的参考图只能写文件名（英文字母、数字、点、横线、下划线），扩展名为 png、jpg、jpeg 或 webp。`);
    if (voiceSample && !AUDIO_FILE.test(voiceSample)) reject(`${name} 的声音样本只能写文件名（英文字母、数字、点、横线、下划线），扩展名为 wav、mp3 或 flac。`);
    return {name, appearance: text(c.appearance, `${name} 的外貌`, 600), voice: text(c.voice, `${name} 的声音`, 300), ...(image ? {image} : {}), ...(voiceSample ? {voiceSample} : {}), ...(typeof c.usePortrait === 'boolean' ? {usePortrait: c.usePortrait} : {})};
  });
  return {style: text(row.style, '画面风格', 300), music: text(row.music, '背景音乐', 300), characters};
}

export interface PlannedClip { id: string; sceneId: string; shots: Shot[]; plannedSeconds: number; frames: number; warnings: string[] }

/** Consecutive shots of one scene share a clip while the estimate stays within the limit. */
export function planClips(shots: Shot[], limit = DEFAULT_CLIP_LIMIT): PlannedClip[] {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < MIN_CLIP_LIMIT || limit > DEFAULT_CLIP_LIMIT) reject(`片段上限需为 ${MIN_CLIP_LIMIT}–${DEFAULT_CLIP_LIMIT} 秒。`);
  const clips: PlannedClip[] = [];
  let open: PlannedClip | undefined;
  const close = () => { if (!open) return; open.plannedSeconds = round2(open.plannedSeconds); open.frames = h3Frames(open.plannedSeconds); clips.push(open); open = undefined; };
  for (const shot of shots) {
    if (shot.durationSeconds > limit) {
      close();
      const longest = framesToSeconds(H3_MAX_FRAMES);
      open = {id: '', sceneId: shot.sceneId, shots: [shot], plannedSeconds: shot.durationSeconds, frames: 0, warnings: [shot.durationSeconds > longest
        ? `镜头 ${shot.id} 预计 ${shot.durationSeconds} 秒，超过 H3 单次生成的约 ${longest} 秒；这一段会在 ${longest} 秒处结束，后面的台词可能被截断。`
        : `镜头 ${shot.id} 预计 ${shot.durationSeconds} 秒，超过 ${limit} 秒的片段上限，单独成段。`]};
      close();
      continue;
    }
    if (open && open.sceneId === shot.sceneId && open.plannedSeconds + shot.durationSeconds <= limit + 1e-9) { open.shots.push(shot); open.plannedSeconds += shot.durationSeconds; continue; }
    close();
    open = {id: '', sceneId: shot.sceneId, shots: [shot], plannedSeconds: shot.durationSeconds, frames: 0, warnings: []};
  }
  close();
  clips.forEach((clip, index) => { clip.id = `c${pad2(index + 1)}`; });
  return clips;
}

/** MM:SS.mmm, the cut-time notation of the H3 guide. */
export function cutStamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${pad2(Math.floor(ms / 60000))}:${pad2(Math.floor((ms % 60000) / 1000))}.${String(ms % 1000).padStart(3, '0')}`;
}

const SIZE_PHRASES: Record<Shot['size'], string> = {extreme_close_up: 'an extreme close-up', close_up: 'a close-up', medium_close_up: 'a medium close-up', medium: 'a medium shot', medium_wide: 'a medium-wide shot', wide: 'a wide shot', insert: 'an insert shot'};
const CAMERA_PHRASES: Record<Exclude<Shot['camera'], 'pan' | 'tilt'>, string> = {
  static: 'The camera holds a static shot.',
  push_in: 'The camera pushes in with small amplitude at slow speed.',
  pull_out: 'The camera pulls out with small amplitude at slow speed.',
  track: 'The camera tracks alongside the subject as it moves.',
  handheld: 'The camera shakes slightly, like a handheld shot.',
};
const MOVE = 'with small amplitude at slow speed';
const only = (text: string, yes: RegExp, no: RegExp) => yes.test(text) && !no.test(text);
const [UP, DOWN, LEFT, RIGHT] = [/\b(up|upward|upwards)\b/iu, /\b(down|downward|downwards)\b/iu, /\bleft\b/iu, /\bright\b/iu];
/** Pan and tilt directions come from the shot's composition note, so the move never contradicts it.
 * A pan described as moving up or down is a tilt; without a direction the move stays neutral. */
export function cameraPhrase(shot: Pick<Shot, 'camera' | 'composition'>): string {
  const note = shot.composition ?? '';
  const vertical = only(note, UP, DOWN) ? 'up' : only(note, DOWN, UP) ? 'down' : '';
  if (shot.camera === 'tilt') return `The camera tilts${vertical ? ` ${vertical}` : ''} ${MOVE}.`;
  if (shot.camera === 'pan') {
    const side = only(note, LEFT, RIGHT) ? 'left' : only(note, RIGHT, LEFT) ? 'right' : '';
    if (side) return `The camera pans ${side} ${MOVE}.`;
    return vertical ? `The camera tilts ${vertical} ${MOVE}.` : `The camera pans ${MOVE}.`;
  }
  return CAMERA_PHRASES[shot.camera];
}
const sentence = (text: string) => { const t = text.trim(); return !t ? '' : /[.!?。！？…"”'’)]$/u.test(t) ? t : `${t}.`; };
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Statements end with punctuation before </d>; the words themselves are never changed. */
const spokenWords = (text: string, language: string) => { const t = text.trim(); return /[.!?。！？…]$/u.test(t) ? t : `${t}${/^(zh|ja)(-|$)/u.test(language) ? '。' : '.'}`; };

interface ScriptText { language: string; headings: Map<string, string>; lines: Map<string, string[]>; dialogue: Map<string, Map<number, string>> }
const scriptText = (language: string, scenes: {id: string; heading: string; content: string}[]): ScriptText => ({
  language,
  headings: new Map(scenes.map(s => [s.id, s.heading])),
  lines: new Map(scenes.map(s => [s.id, scriptLines(s.content)])),
  dialogue: new Map(scenes.map(s => [s.id, dialoguePositions(s.content)])),
});
/** The words and delivery of a spoken line: inline `NAME (note): words`, or a label on the line before. */
function spokenAt(text: ScriptText, sceneId: string, position: number): {words: string; note?: string; name?: string} {
  const lines = text.lines.get(sceneId) ?? [], line = lines[position - 1] ?? '', inline = inlineLabel(line);
  if (inline) return {words: inline.text, name: inline.name, ...(inline.note ? {note: inline.note} : {})};
  const before = position > 1 ? labelOnly(lines[position - 2] ?? '') : undefined;
  return {words: line.trim(), ...(before ? {name: before.name, ...(before.note ? {note: before.note} : {})} : {})};
}

export interface RenderPlanInput {
  batchId: string; createdAt: string; episodeId: string;
  list: ShotList; revision: Revision; adaptations: Record<string, Pick<Localization, 'id' | 'scenes'>>;
  profile: ProductionProfile; languages?: string[]; clipLimitSeconds?: number;
  /** Render size; H3's native size for the aspect ratio when absent. */
  size?: {width: number; height: number};
  /** `bed`: clips get no non-diegetic music, because the cut lays one track under the episode. */
  musicMode?: 'bed' | 'native';
  /** The confirmed episode bible: the first shot of every clip names its scene's setting and props. */
  bible?: BibleContent;
}
export interface PlannedJob { clipId: string; language: string; order: number }

/** Build every clip's prompts, check each against the script, and list the jobs. Throws RenderPlanError. */
export function planRenderBatch(input: RenderPlanInput): {batch: RenderBatch; jobs: PlannedJob[]} {
  const {list, revision, profile} = input, source = scriptLanguage(revision), warnings: string[] = [];
  const texts = new Map<string, ScriptText>([[source, scriptText(source, revision.scenes)]]);
  for (const [language, adaptation] of Object.entries(input.adaptations)) if (language !== source) texts.set(language, scriptText(language, adaptation.scenes));
  const available = list.voiceLanguages.filter(language => texts.has(language));
  const languages = input.languages ?? available;
  if (!languages.length || new Set(languages).size !== languages.length) reject('请选择至少一种配音语言，不能重复。');
  for (const language of languages) { if (!texts.has(language)) reject(`${language} 没有绑定到这份分镜表的逐行对齐稿，不能生成这一语言的任务。`); dialogueTag(language); }
  const english = texts.get('en');
  const picture = english ?? texts.get(source)!;
  if (!english) warnings.push('没有英文稿：画面描述使用原稿文字。H3 的提示词正文应为英文，建议先生成英文稿。');
  if (!/^en(-|$)/u.test(source) && list.shots.some(s => s.composition || s.sound)) warnings.push('分镜表的构图和声音说明是原稿语言；H3 的提示词正文应为英文。');
  const style = profile.style || FALLBACK_STYLE;
  if (!profile.style) warnings.push(`没有设置画面风格，暂用 “${FALLBACK_STYLE}”。`);

  // Every text that reaches a prompt must not contain prompt syntax.
  for (const shot of list.shots) for (let position = shot.firstLine; position <= shot.lastLine; position++) for (const text of [picture, ...languages.map(l => texts.get(l)!)]) {
    const line = text.lines.get(shot.sceneId)?.[position - 1] ?? '';
    if (UNSAFE.test(line)) reject(`场景 ${shot.sceneId} 第 ${position} 行（${text.language}）含有 <、> 或 [Shot，它们在 H3 提示词里有特殊含义。请先修改剧本。`);
  }
  for (const scene of revision.scenes) for (const line of input.bible ? settingSentences(input.bible, scene.id) : []) if (UNSAFE.test(line)) reject(`本集设定里场景 ${scene.id} 的描述含有 <、> 或 [Shot。请先修改本集设定。`);
  for (const shot of list.shots) for (const note of [shot.composition, shot.sound]) if (note && UNSAFE.test(note)) reject(`镜头 ${shot.id} 的构图或声音说明含有 <、> 或 [Shot。请先修改分镜表。`);
  for (const shot of list.shots) for (const [position, speaker] of picture.dialogue.get(shot.sceneId) ?? new Map<number, string>()) {
    if (position >= shot.firstLine && position <= shot.lastLine && !shot.spoken.some(s => s.line === position)) warnings.push(`场景 ${shot.sceneId} 第 ${position} 行像是 ${speaker} 的台词，但分镜表没有标说话人；H3 不会念这一行。`);
  }

  const cast = new Map(list.cast.map(c => [c.id, c.name]));
  // English names from the English labels of each speaker's lines, so a Chinese source still yields an English body.
  const displayName = new Map<string, string>();
  for (const shot of list.shots) for (const spoken of shot.spoken) if (!displayName.has(spoken.castId)) { const name = spokenAt(picture, shot.sceneId, spoken.line).name; if (name) displayName.set(spoken.castId, name); }
  const nameOf = (castId: string) => displayName.get(castId) ?? cast.get(castId) ?? castId;
  const characterOf = (castId: string): ProductionCharacter | undefined => {
    const keys = new Set([cast.get(castId), displayName.get(castId)].filter((v): v is string => !!v).map(normalizeSpeakerName));
    return profile.characters.find(c => keys.has(normalizeSpeakerName(c.name)));
  };
  for (const id of new Set(list.shots.flatMap(s => [...s.characters, ...s.spoken.map(x => x.castId)]))) {
    const character = characterOf(id);
    if (!character?.appearance) warnings.push(`角色 ${nameOf(id)} 没有外貌描述，不同片段里可能长得不一样。`);
    if (list.shots.some(s => s.spoken.some(x => x.castId === id)) && !character?.voice && !character?.voiceSample) warnings.push(`角色 ${nameOf(id)} 没有声音描述，不同片段里的声音可能不一样。`);
  }

  const {width, height} = input.size ?? h3Size(list.aspectRatio), orientation = list.aspectRatio === '9:16' ? 'vertical 9:16' : 'horizontal 16:9';
  const clips: RenderClip[] = planClips(list.shots, input.clipLimitSeconds ?? DEFAULT_CLIP_LIMIT).map(planned => {
    const clipWarnings = [...planned.warnings], seconds = framesToSeconds(planned.frames);
    const starts: number[] = []; planned.shots.reduce((t, shot) => { starts.push(t); return t + shot.durationSeconds; }, 0);
    const inFrame = [...new Set(planned.shots.flatMap(s => s.characters))];
    const speakers = [...new Set(planned.shots.flatMap(s => [...s.spoken].sort((a, b) => a.line - b.line).map(x => x.castId)))];
    const speakerId = new Map(speakers.map((id, index) => [id, index + 1]));
    const subjects = inFrame.filter(id => characterOf(id)?.image);
    const voices = speakers.filter(id => characterOf(id)?.voiceSample);
    if (subjects.length > MAX_REFERENCE_IMAGES) clipWarnings.push(`这一段有 ${subjects.length} 张参考图，H3 最多用 ${MAX_REFERENCE_IMAGES} 张，只用前 ${MAX_REFERENCE_IMAGES} 张。`);
    if (voices.length > MAX_REFERENCE_AUDIO) clipWarnings.push(`这一段有 ${voices.length} 个声音样本，H3 最多用 ${MAX_REFERENCE_AUDIO} 个，只用前 ${MAX_REFERENCE_AUDIO} 个。`);
    const usedSubjects = subjects.slice(0, MAX_REFERENCE_IMAGES), usedVoices = voices.slice(0, MAX_REFERENCE_AUDIO);
    const mode: RenderPrompt['mode'] = usedSubjects.length || usedVoices.length ? 'r2v' : 't2va';
    const subjectNo = new Map(usedSubjects.map((id, index) => [id, index + 1])), audioNo = new Map(usedVoices.map((id, index) => [id, index + 1]));
    const label = (id: string) => subjectNo.has(id) ? `<Subject ${subjectNo.get(id)}> ${nameOf(id)}` : nameOf(id);

    const prompts: Record<string, RenderPrompt> = {};
    for (const language of languages) {
      const voiceText = texts.get(language)!, tag = dialogueTag(language), expected: string[] = [];
      const introduced = new Set<string>(), voiced = new Set<string>();
      const shotParagraphs = planned.shots.map((shot, index) => {
        const head = index === 0
          ? (mode === 't2va' ? `[Shot 1] ${style}, ${SIZE_PHRASES[shot.size]} in a ${orientation} frame.` : `[Shot 1] ${capitalize(SIZE_PHRASES[shot.size])} in a ${orientation} frame.`)
          : `[Shot ${index + 1}] At ${cutStamp(starts[index]!)}, the camera cuts to ${SIZE_PHRASES[shot.size]}.`;
        const parts = [head];
        if (index === 0 && input.bible) parts.push(...settingSentences(input.bible, shot.sceneId));
        for (const id of shot.characters) if (!introduced.has(id)) {
          introduced.add(id);
          const appearance = characterOf(id)?.appearance;
          if (subjectNo.has(id) || appearance) parts.push(sentence(`${label(id)} appears${appearance ? `, ${appearance}` : ''}`));
        }
        if (shot.composition) parts.push(sentence(shot.composition));
        const spokenLines = new Map(shot.spoken.map(s => [s.line, s.castId]));
        const englishDialogue = picture.dialogue.get(shot.sceneId) ?? new Map<number, string>();
        for (let position = shot.firstLine; position <= shot.lastLine; position++) {
          const castId = spokenLines.get(position);
          if (castId) {
            // Words come from the voice language; the delivery note, like the rest of the body, from the English version.
            const {words} = spokenAt(voiceText, shot.sceneId, position), {note} = spokenAt(picture, shot.sceneId, position), character = characterOf(castId), first = !voiced.has(castId);
            voiced.add(castId);
            const voice = audioNo.has(castId) ? `, using the voice timbre referenced from <Audio ${audioNo.get(castId)}>,` : first && character?.voice ? `, with ${character.voice},` : '';
            const delivery = note ? ` says, ${note}:` : ' says:';
            const spoken = spokenWords(words, language);
            expected.push(spoken);
            parts.push(`${label(castId)} (S${speakerId.get(castId)})${voice}${delivery} <d>[${tag}] ${spoken}</d>`);
            continue;
          }
          const line = picture.lines.get(shot.sceneId)?.[position - 1] ?? '';
          if (labelOnly(line) && englishDialogue.has(position + 1)) continue;
          if (line.trim()) parts.push(sentence(line));
        }
        parts.push(cameraPhrase(shot));
        return parts.join(' ');
      });
      const sounds = [...new Set(planned.shots.map(s => s.sound?.trim()).filter((s): s is string => !!s))].map(sentence).join(' ') || 'The natural ambient sound of the location continues throughout.';
      const music = input.musicMode === 'bed' ? 'N/A' : profile.music || 'N/A';
      let text: string;
      if (mode === 't2va') {
        text = `integrated_multimodal_description: ${shotParagraphs.join(' ')}\n\noverall_soundscape: ${sounds}\n\nnon_diegetic_music: ${music}`;
      } else {
        const heading = (picture.headings.get(planned.sceneId) ?? planned.sceneId).trim().replace(/[.。]$/u, '');
        const definitions = [
          ...usedSubjects.map(id => sentence(`<Subject ${subjectNo.get(id)}> is ${nameOf(id)}, the person shown in <Picture ${subjectNo.get(id)}>${characterOf(id)?.appearance ? `, ${characterOf(id)!.appearance}` : ''}`)),
          ...usedVoices.map(id => `<Audio ${audioNo.get(id)}> is the voice-timbre reference for ${subjectNo.has(id) ? `<Subject ${subjectNo.get(id)}>` : nameOf(id)} (S${speakerId.get(id)}).`),
        ];
        const named = usedSubjects.map(id => `<Subject ${subjectNo.get(id)}>`);
        const speakersWithVoice = usedVoices.map(id => subjectNo.has(id) ? `<Subject ${subjectNo.get(id)}>` : nameOf(id));
        const summary = `[reference generation${usedVoices.length ? ' + audio reference' : ''}] A ${planned.shots.length}-shot ${orientation} clip set in ${heading}${named.length ? `, featuring ${named.join(' and ')}` : ''}.`
          + (named.length === 1 ? ` ${named[0]} keeps the identity and clothing shown in its reference picture.` : named.length ? ` ${named.join(' and ')} keep the identity and clothing shown in their reference pictures.` : '')
          + (usedVoices.length ? ` ${speakersWithVoice.join(' and ')} ${usedVoices.length === 1 ? 'speaks' : 'speak'} with the voice timbre of ${usedVoices.map(id => `<Audio ${audioNo.get(id)}>`).join(' and ')}.` : '');
        const retention = [
          ...usedSubjects.map(id => `<Subject ${subjectNo.get(id)}> (appears in ${planned.shots.map((s, i) => s.characters.includes(id) ? `[Shot ${i + 1}]` : '').filter(Boolean).join(', ')}): fully_preserved - the identity, face, hair and clothing of ${nameOf(id)} from <Picture ${subjectNo.get(id)}> are retained.`),
          ...usedVoices.map(id => `<Audio ${audioNo.get(id)}>: reference - the voice of ${subjectNo.has(id) ? `<Subject ${subjectNo.get(id)}>` : nameOf(id)} follows the timbre of <Audio ${audioNo.get(id)}> without copying the original signal.`),
        ];
        text = [`subject_definitions:\n${definitions.join('\n')}`, `summary:\n${summary}`, `retention_analysis:\n${retention.join('\n')}`,
          `detailed_description:\n${sentence(`The target video uses this visual style: ${style}`)}\n${shotParagraphs.join('\n')}`, `overall_soundscape:\n${sounds}`, `non_diegetic_music:\n${music}`].join('\n\n');
      }
      const prompt: RenderPrompt = {mode, text, images: usedSubjects.map(id => characterOf(id)!.image!), audio: usedVoices.map(id => characterOf(id)!.voiceSample!)};
      const problems = verifyPrompt(prompt, {spoken: expected, shots: planned.shots.length, cuts: starts.slice(1), seconds});
      if (problems.length) reject(`片段 ${planned.id}（${language}）的提示词未通过自检：${problems.join('；')}`);
      prompts[language] = prompt;
    }
    return {id: planned.id, sceneId: planned.sceneId, shotIds: planned.shots.map(s => s.id), plannedSeconds: planned.plannedSeconds, frames: planned.frames, seed: clipSeed(input.batchId, planned.id), warnings: clipWarnings, prompts};
  });

  const batch: RenderBatch = {id: input.batchId, episodeId: input.episodeId, shotListId: list.id, sourceRevisionId: revision.id,
    adaptations: Object.fromEntries(languages.filter(l => l !== source).map(l => [l, input.adaptations[l]!.id])), languages, width, height, fps: 24,
    clipLimitSeconds: input.clipLimitSeconds ?? DEFAULT_CLIP_LIMIT, profile: structuredClone(profile), clips, warnings: [...new Set(warnings)], createdAt: input.createdAt};
  const jobs = clips.flatMap((clip, index) => languages.map((language, l) => ({clipId: clip.id, language, order: index * languages.length + l})));
  return {batch, jobs};
}

const T2VA_SECTIONS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'] as const;
const R2V_SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const;

/** Structural self-check of a built prompt: sections, shot markers, cut times and the exact spoken words. */
export function verifyPrompt(prompt: Pick<RenderPrompt, 'mode' | 'text'>, expected: {spoken: string[]; shots: number; cuts: number[]; seconds: number}): string[] {
  const problems: string[] = [], text = prompt.text;
  const sections = prompt.mode === 't2va' ? T2VA_SECTIONS : R2V_SECTIONS;
  const found = sections.map(name => [...text.matchAll(new RegExp(`(?:^|\\n\\n)${name}:`, 'gu'))].map(m => m.index ?? -1));
  if (found.some(hits => hits.length !== 1)) problems.push(`${prompt.mode} 段落标题缺失或重复`);
  else if (found.some((hits, i) => i > 0 && hits[0]! <= found[i - 1]![0]!)) problems.push(`${prompt.mode} 段落顺序不对`);
  if (prompt.mode === 't2va' && !text.startsWith('integrated_multimodal_description: [Shot 1]')) problems.push('T2VA 提示词必须从 [Shot 1] 开始');
  // Shot markers and cut times live in the description; R2V's retention analysis also names shots.
  const bodyStart = text.indexOf(prompt.mode === 't2va' ? 'integrated_multimodal_description:' : 'detailed_description:'), bodyEnd = text.indexOf('\n\noverall_soundscape:');
  const body = bodyStart >= 0 && bodyEnd > bodyStart ? text.slice(bodyStart, bodyEnd) : '';
  const shots = [...body.matchAll(/\[Shot (\d+)\]/gu)].map(m => Number(m[1]));
  if (shots.length !== expected.shots || shots.some((n, i) => n !== i + 1)) problems.push(`镜头标记应为 [Shot 1] 到 [Shot ${expected.shots}]`);
  const cuts = [...body.matchAll(/\[Shot (\d+)\] At (\d{2}):(\d{2})\.(\d{3}),/gu)].map(m => Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
  if (cuts.length !== expected.cuts.length || cuts.some((t, i) => Math.abs(t - expected.cuts[i]!) > 0.0015 || (i > 0 && t <= cuts[i - 1]!) || t <= 0 || t >= expected.seconds)) problems.push('切换时间缺失、没有递增或超出片段长度');
  const spoken = [...text.matchAll(/<d>\[[A-Za-z]+\] ([\s\S]*?)<\/d>/gu)].map(m => m[1]);
  const opens = text.split('<d>').length - 1, closes = text.split('</d>').length - 1;
  if (opens !== closes || spoken.length !== opens || spoken.length !== expected.spoken.length || spoken.some((s, i) => s !== expected.spoken[i])) problems.push('<d> 台词与剧本不一致');
  return problems;
}

export interface PackageMeta { series: string; episodeOrdinal: number; episodeTitle: string }
export const RENDER_PACKAGE_FORMAT = 'sciepo-render-package';
export const RENDER_RESULTS_FORMAT = 'sciepo-render-results';

/** The job file a worker renders. It carries prompts and settings only: no tokens and no series bible. */
export function renderPackage(batch: RenderBatch, jobs: (Pick<RenderJob, 'id' | 'clipId' | 'language' | 'order'> & Partial<Pick<RenderJob, 'status'>>)[], meta: PackageMeta) {
  const clips = new Map(batch.clips.map(c => [c.id, c]));
  const ordered = [...jobs].sort((a, b) => a.order - b.order);
  const used = ordered.map(job => clips.get(job.clipId)!.prompts[job.language]!);
  return {
    format: RENDER_PACKAGE_FORMAT, version: 1,
    batch: {id: batch.id, series: meta.series, episode: meta.episodeOrdinal, episodeTitle: meta.episodeTitle, sourceRevisionId: batch.sourceRevisionId, shotListId: batch.shotListId, languages: batch.languages, createdAt: batch.createdAt},
    model: {name: 'MiniMax H3', fps: batch.fps, width: batch.width, height: batch.height},
    references: {images: [...new Set(used.flatMap(p => p.images))], audio: [...new Set(used.flatMap(p => p.audio))]},
    jobs: ordered.map(job => {
      const clip = clips.get(job.clipId)!, prompt = clip.prompts[job.language]!;
      return {id: job.id, clipId: clip.id, language: job.language, mode: prompt.mode, prompt: prompt.text, frames: clip.frames, seconds: framesToSeconds(clip.frames),
        width: batch.width, height: batch.height, seed: clip.seed, images: prompt.images, audio: prompt.audio, output: outputName(meta.episodeOrdinal, clip.id, job.language), shotIds: clip.shotIds,
        // The status when the package was made: a worker skips jobs Sci-epo already knows as succeeded.
        ...(job.status ? {status: job.status} : {})};
    }),
  };
}
export type RenderPackage = ReturnType<typeof renderPackage>;

export interface RenderResult { jobId: string; status: 'succeeded' | 'failed'; file?: string; seconds?: number; bytes?: number; sha256?: string; error?: string }

/** Results from a worker's results.json or serve mode. Dry runs and unknown statuses are skipped, not applied. */
export function parseRenderResults(value: unknown, batchId: string): {results: RenderResult[]; skipped: number} {
  const row = record(value, '结果文件');
  if (row.format !== RENDER_RESULTS_FORMAT || row.version !== 1) reject('这不是 Sci-epo 渲染结果文件（format 应为 sciepo-render-results，version 为 1）。');
  if (row.batchId !== batchId) reject('结果文件属于另一个渲染批次。');
  const items: unknown[] = Array.isArray(row.results) && row.results.length <= 5000 ? row.results : reject('结果文件的 results 必须是不超过 5000 项的列表。');
  let skipped = 0;
  const results: RenderResult[] = [];
  for (const [index, item] of items.entries()) {
    const r = record(item, `第 ${index + 1} 条结果`);
    if (typeof r.jobId !== 'string' || r.jobId.length > 100) reject(`第 ${index + 1} 条结果缺少 jobId。`);
    if (r.status !== 'succeeded' && r.status !== 'failed') { skipped++; continue; }
    const file = r.file === undefined || r.file === null ? undefined : typeof r.file === 'string' && OUTPUT_FILE.test(r.file) ? r.file : reject(`第 ${index + 1} 条结果的文件名只能是不含路径的文件名。`);
    if (r.status === 'succeeded' && !file) reject(`第 ${index + 1} 条结果标记成功，但没有文件名。`);
    const seconds = r.seconds === undefined || r.seconds === null ? undefined : typeof r.seconds === 'number' && Number.isFinite(r.seconds) && r.seconds >= 0 && r.seconds <= 600 ? round2(r.seconds) : reject(`第 ${index + 1} 条结果的时长无效。`);
    const bytes = r.bytes === undefined || r.bytes === null ? undefined : Number.isSafeInteger(r.bytes) && (r.bytes as number) >= 0 ? r.bytes as number : reject(`第 ${index + 1} 条结果的文件大小无效。`);
    const sha256 = r.sha256 === undefined || r.sha256 === null ? undefined : typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(r.sha256) ? r.sha256 : reject(`第 ${index + 1} 条结果的 sha256 无效。`);
    const error = r.error === undefined || r.error === null ? undefined : typeof r.error === 'string' ? r.error.slice(0, 500) : reject(`第 ${index + 1} 条结果的错误说明无效。`);
    results.push({jobId: r.jobId as string, status: r.status, ...(file ? {file} : {}), ...(seconds !== undefined ? {seconds} : {}), ...(bytes !== undefined ? {bytes} : {}), ...(sha256 ? {sha256} : {}), ...(r.status === 'failed' ? {error: error || '工作机报告失败，没有说明原因。'} : {})});
  }
  return {results, skipped};
}

/** The spoken lines of a clip in one language, in prompt order: the words inside <d>, with scene and line position. */
export function spokenLines(clip: RenderClip, list: Pick<ShotList, 'shots'>, language: string): {sceneId: string; position: number; language: string; text: string}[] {
  const prompt = clip.prompts[language];
  if (!prompt) return [];
  const words = [...prompt.text.matchAll(/<d>\[[A-Za-z]+\] ([\s\S]*?)<\/d>/gu)].map(m => m[1]!);
  const positions = clip.shotIds.flatMap(id => {
    const shot = list.shots.find(s => s.id === id);
    return shot ? [...shot.spoken].sort((a, b) => a.line - b.line).map(s => ({sceneId: shot.sceneId, position: s.line})) : [];
  });
  return words.map((text, index) => ({sceneId: positions[index]?.sceneId ?? clip.sceneId, position: positions[index]?.position ?? 0, language, text}));
}

/** Planned start and end of each shot inside its clip; the last shot ends with the clip's frames. */
export function shotTimes(clip: Pick<RenderClip, 'shotIds' | 'frames'>, list: Pick<ShotList, 'shots'>): {shotId: string; start: number; end: number}[] {
  const length = clip.frames / H3_FPS, round3 = (value: number) => Math.round(value * 1000) / 1000;
  let t = 0;
  return clip.shotIds.map((id, index) => {
    const start = Math.min(t, length);
    t += list.shots.find(s => s.id === id)?.durationSeconds ?? 0;
    return {shotId: id, start: round3(start), end: round3(index === clip.shotIds.length - 1 ? length : Math.min(t, length))};
  });
}
