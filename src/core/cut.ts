/** Cuts: one v2 batch edited in one language. The take of each clip in order, the gain that levels it, captions for
 * on-screen text, and the ffmpeg arguments that join them. Pure and browser-safe: no Node.js modules and no shell.
 * The server runs the arguments as an argument array and writes the caption text files into the cut's work folder,
 * so script text never becomes filter syntax. */
import type { Caption, Cut, CutClip, CutSettings, CutSize, Localization, RenderBatch, RenderJobV2, Revision, ShotList, Take } from '../types';
import { framesToSeconds, shotTimes } from './h3';
import { scriptLanguage } from './languages';
import { isCharacterLanguage, screenTextOf, scriptLines } from './scriptLines';
import { screenTextLines } from './shotList';

/** Levels from the first H3 run: dialogue clips to −16 LUFS, clips without dialogue to −22, the cut to −14 at −1 dBTP. */
export const DEFAULT_CUT_SETTINGS: CutSettings = {musicAssetId: null, musicLevelDb: -20, dialogueLufs: -16, ambienceLufs: -22, maxGainDb: 9, targetLufs: -14, truePeakDb: -1, fadeMs: 20, size: 'native'};
/** Inclusive ranges the server accepts for the numeric settings. */
export const CUT_SETTING_RANGES = {musicLevelDb: [-40, 0], dialogueLufs: [-30, -8], ambienceLufs: [-36, -8], maxGainDb: [0, 18], targetLufs: [-30, -9], truePeakDb: [-9, 0], fadeMs: [0, 500]} as const satisfies Record<string, readonly [number, number]>;
export type CutNumberSetting = keyof typeof CUT_SETTING_RANGES;
/** Loudness range target of the final normalization, in LU. */
export const CUT_LOUDNESS_RANGE = 11;
/** The limiter aims this far under the true-peak setting; measured on H3 takes, AAC added about 0.2 dB. */
export const AAC_PEAK_MARGIN_DB = 0.5;
export const MUSIC_FADE_IN_SECONDS = 1;
export const MUSIC_FADE_OUT_SECONDS = 2;
/** Scaled sizes per aspect ratio; `native` keeps the rendered size. */
export const CUT_SIZES: Record<'9:16' | '16:9', CutSize[]> = {'9:16': ['720x1280', '1080x1920'], '16:9': ['1280x720', '1920x1080']};
export const CAPTION_LINE_CHARACTERS = {cjk: 16, latin: 32} as const;
export const CAPTION_MAX_LINES = 4;
export const CAPTION_MAX_TEXT = 300;

const round3 = (value: number) => (Math.round(value * 1000) / 1000) || 0;
const n3 = (value: number) => round3(value).toFixed(3);
const n2 = (value: number) => ((Math.round(value * 100) / 100) || 0).toFixed(2);

export const aspectOf = (batch: Pick<RenderBatch, 'width' | 'height'>): '9:16' | '16:9' => batch.width < batch.height ? '9:16' : '16:9';
export function cutDimensions(size: CutSize, batch: Pick<RenderBatch, 'width' | 'height'>): {width: number; height: number} {
  if (size === 'native') return {width: batch.width, height: batch.height};
  const [width, height] = size.split('x').map(Number) as [number, number];
  return {width, height};
}

// ------------------------------------------------------------------ caption text

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
// Kinsoku: no line starts with closing punctuation and none ends with opening punctuation.
const CLOSING = new Set([...'，。、！？；：）」』”’》〉】…']);
const OPENING = new Set([...'（「『“‘《〈【']);
const widthOf = (text: string) => [...text].reduce((sum, c) => sum + (WIDE.test(c) ? 2 : 1), 0);

/** Words of Latin text, single wide characters, and spaces; punctuation sticks to the character it belongs to. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = '', open = '';
  const flush = () => { if (word) { out.push(open + word); open = ''; word = ''; } };
  for (const c of text) {
    if (/\s/u.test(c)) { flush(); if (out.at(-1) !== ' ') out.push(' '); continue; }
    if (OPENING.has(c)) { flush(); open += c; continue; }
    if (CLOSING.has(c)) {
      if (word) { word += c; continue; }
      const last = out.length - 1;
      if (last >= 0 && out[last] !== ' ') out[last] += c; else word = c;
      continue;
    }
    if (WIDE.test(c)) { flush(); out.push(open + c); open = ''; continue; }
    word += c;
  }
  flush();
  if (open) out.push(open);
  return out;
}

function wrapParagraph(text: string, limit: number): string[] {
  const lines: string[] = [];
  let line = '', width = 0, space = false;
  const push = () => { if (line) lines.push(line); line = ''; width = 0; space = false; };
  for (const token of tokens(text)) {
    if (token === ' ') { space = width > 0; continue; }
    const w = widthOf(token), gap = space ? 1 : 0;
    if (width + gap + w <= limit) { line += (space ? ' ' : '') + token; width += gap + w; space = false; continue; }
    push();
    if (w <= limit) { line = token; width = w; continue; }
    // A word longer than a line is split by character.
    for (const c of token) { const cw = widthOf(c); if (width + cw > limit) push(); line += c; width += cw; }
  }
  push();
  return lines;
}

/** About 16 characters per line for Chinese, Japanese and Korean, 32 with word wrap for Latin scripts, at most 4 lines;
 * longer text ends in an ellipsis. Line breaks in the text start new lines. */
export function wrapCaption(text: string, language: string): string {
  const limit = isCharacterLanguage(language) ? CAPTION_LINE_CHARACTERS.cjk * 2 : CAPTION_LINE_CHARACTERS.latin;
  const lines = text.split(/\r\n|\n|\r/u).map(p => p.replace(/\s+/gu, ' ').trim()).filter(Boolean).flatMap(p => wrapParagraph(p, limit));
  if (lines.length <= CAPTION_MAX_LINES) return lines.join('\n');
  const kept = lines.slice(0, CAPTION_MAX_LINES);
  let last = kept[CAPTION_MAX_LINES - 1]!;
  while (last && widthOf(last) + 1 > limit) last = [...last].slice(0, -1).join('');
  kept[CAPTION_MAX_LINES - 1] = `${last.trimEnd()}…`;
  return kept.join('\n');
}

// ------------------------------------------------------------------ plan

/** The take a cut of this kind uses: the approved take for a final cut, the latest rendered take for a draft. */
export function cutTake(job: RenderJobV2, kind: Cut['kind']): Take | undefined {
  if (kind === 'final') {
    const take = job.approvedTake === undefined ? undefined : job.takes.find(t => t.n === job.approvedTake);
    return take?.status === 'rendered' && take.video ? take : undefined;
  }
  return [...job.takes].reverse().find(t => t.status === 'rendered' && !!t.video);
}

/** The job and take of each clip in this language, and the clips that have none yet. */
export function cutSelection(batch: Pick<RenderBatch, 'id' | 'clips'>, jobs: RenderJobV2[], language: string, kind: Cut['kind']): {chosen: {clipId: string; job: RenderJobV2; take: Take}[]; missing: string[]} {
  const chosen: {clipId: string; job: RenderJobV2; take: Take}[] = [], missing: string[] = [];
  for (const clip of batch.clips) {
    const job = jobs.find(j => j.batchId === batch.id && j.clipId === clip.id && j.languages.includes(language));
    const take = job ? cutTake(job, kind) : undefined;
    if (job && take) chosen.push({clipId: clip.id, job, take}); else missing.push(clip.id);
  }
  return {chosen, missing};
}

/** Gain that brings a take to its target, clamped to ±maxGainDb; 0 when the take's loudness is unknown. */
export function cutGain(loudness: number | undefined, dialogue: boolean, settings: Pick<CutSettings, 'dialogueLufs' | 'ambienceLufs' | 'maxGainDb'>): number {
  if (loudness === undefined || !Number.isFinite(loudness)) return 0;
  const target = dialogue ? settings.dialogueLufs : settings.ambienceLufs;
  return (Math.round(Math.max(-settings.maxGainDb, Math.min(settings.maxGainDb, target - loudness)) * 10) / 10) || 0;
}

/** The language the picture is described in: English when the batch has an English version, else the script language.
 * Its viewers read the on-screen text in the picture, so its captions start off. */
export function pictureLanguage(list: Pick<ShotList, 'adaptations'>, revision: Revision): string {
  const source = scriptLanguage(revision);
  return source === 'en' || list.adaptations.en ? 'en' : source;
}

export interface CutPlanInput {
  batch: RenderBatch; jobs: RenderJobV2[]; list: Pick<ShotList, 'shots' | 'adaptations'>; revision: Revision;
  /** Localizations to read the bound adaptation of the cut's language from. */
  localizations: Pick<Localization, 'id' | 'scenes'>[];
  language: string; kind: Cut['kind'];
  settings?: Pick<CutSettings, 'dialogueLufs' | 'ambienceLufs' | 'maxGainDb'>;
}
export interface CutPlan { language: string; kind: Cut['kind']; clips: CutClip[]; missing: string[]; captions: Caption[]; seconds: number; pictureLanguage: string; rehearsal: boolean }

/** The clips of a cut in order with offsets, lengths and gains, the clips still missing, and default captions.
 * A missing clip keeps its planned length on the timeline, so captions after it stay in place. */
export function cutPlan(input: CutPlanInput): CutPlan {
  const {batch, list, revision, language, kind} = input, settings = {...DEFAULT_CUT_SETTINGS, ...input.settings};
  const {chosen, missing} = cutSelection(batch, input.jobs, language, kind);
  const clips: CutClip[] = [], places = new Map<string, {offset: number; seconds: number}>();
  let offset = 0;
  for (const clip of batch.clips) {
    const pick = chosen.find(c => c.clipId === clip.id), video = pick?.take.video;
    const seconds = round3(video && video.seconds > 0 ? video.seconds : framesToSeconds(clip.frames));
    places.set(clip.id, {offset: round3(offset), seconds});
    if (pick && video) {
      const dialogue = clip.shotIds.some(id => (list.shots.find(s => s.id === id)?.spoken.length ?? 0) > 0);
      clips.push({clipId: clip.id, jobId: pick.job.id, take: pick.take.n, sha256: video.sha256, ...(video.assetId ? {assetId: video.assetId} : {}), ...(video.drive ? {drive: {...video.drive}} : {}), offset: round3(offset), seconds, gainDb: cutGain(pick.take.qa?.loudness?.integrated, dialogue, settings), dialogue});
    }
    offset += seconds;
  }
  const source = scriptLanguage(revision), picture = pictureLanguage(list, revision);
  const sourceLines = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content)]));
  const adaptationId = language === source ? undefined : batch.adaptations[language];
  const adaptation = adaptationId ? input.localizations.find(l => l.id === adaptationId) : undefined;
  const lines = language === source ? sourceLines : new Map((adaptation?.scenes ?? []).map(s => [s.id, scriptLines(s.content)]));
  const captions: Caption[] = [];
  for (const clip of batch.clips) {
    const place = places.get(clip.id)!;
    for (const time of shotTimes(clip, list)) {
      const shot = list.shots.find(s => s.id === time.shotId);
      if (!shot) continue;
      const positions = screenTextLines(shot, sourceLines.get(shot.sceneId) ?? []);
      const text = [...positions.map(p => screenTextOf(lines.get(shot.sceneId)?.[p - 1] ?? '')).filter(Boolean).join('\n')].slice(0, CAPTION_MAX_TEXT).join('').trim();
      const start = round3(place.offset + time.start), end = round3(Math.min(place.offset + place.seconds, place.offset + time.end));
      if (text && end > start) captions.push({shotId: shot.id, start, end, text, enabled: language !== picture});
    }
  }
  return {language, kind, clips, missing, captions, seconds: round3(offset), pictureLanguage: picture, rehearsal: chosen.some(c => c.take.rehearsal)};
}

/** A final cut is current while every take it uses is still the approved take of its job; a draft while each is still
 * the latest rendered take. */
export function cutCurrent(cut: Pick<Cut, 'kind' | 'clips'>, jobs: RenderJobV2[]): boolean {
  return cut.clips.every(clip => {
    const job = jobs.find(j => j.id === clip.jobId), take = job ? cutTake(job, cut.kind) : undefined;
    return !!take && take.n === clip.take && take.video?.sha256 === clip.sha256;
  });
}

export const sameTakes = (a: CutClip[], b: CutClip[]): boolean =>
  a.length === b.length && a.every((clip, i) => clip.jobId === b[i]!.jobId && clip.take === b[i]!.take && clip.sha256 === b[i]!.sha256);

// ------------------------------------------------------------------ ffmpeg

/** The text files a cut's captions need, wrapped, with names that need no escaping in a filter. */
export function captionFiles(captions: Caption[], language: string): {name: string; text: string; start: number; end: number}[] {
  return captions.filter(c => c.enabled && c.text.trim() && c.end > c.start)
    .map((c, i) => ({name: `caption-${String(i + 1).padStart(3, '0')}.txt`, text: wrapCaption(c.text, language), start: c.start, end: c.end}));
}

const SAFE_FONT_PATH = /^[A-Za-z0-9 ._/:()+-]+$/u;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** A font path as a drawtext fontfile value: forward slashes, the drive colon escaped for the option parser
 * (C\:/Windows/Fonts/msyh.ttc) and the value quoted for the filtergraph. Undefined for a path with other characters;
 * the runner then copies the font into the work folder under a plain name. */
export function fontFilterValue(path: string): string | undefined {
  const normalized = path.replace(/\\/gu, '/');
  return SAFE_FONT_PATH.test(normalized) ? `'${normalized.replace(/:/gu, '\\:')}'` : undefined;
}

export interface CutInput { file: string; seconds: number; gainDb: number; audio: boolean }
export interface CutArgumentsInput {
  inputs: CutInput[];
  music?: {file: string; levelDb: number} | null;
  /** Caption text files in ffmpeg's working folder. */
  captions: {file: string; start: number; end: number}[];
  /** Font file for captions, or null to draw none. */
  font: string | null;
  width: number; height: number; fps: number;
  settings: Pick<CutSettings, 'targetLufs' | 'truePeakDb' | 'fadeMs'>;
  output: string; comment?: string;
}
/** loudnorm's first-pass measurement. */
export interface LoudnessMeasurement { i: number; tp: number; lra: number; thresh: number; offset: number }

function drawCaption(caption: {file: string; start: number; end: number}, font: string, width: number, height: number): string {
  if (!SAFE_FILE_NAME.test(caption.file)) throw new Error(`Caption file name ${caption.file} is not a plain file name.`);
  const size = Math.max(16, Math.round(Math.min(width, height) * 0.05)), border = Math.max(4, Math.round(size * 0.35)), spacing = Math.round(size * 0.25);
  return `drawtext=fontfile=${font}:textfile=${caption.file}:expansion=none:fontsize=${size}:fontcolor=white:line_spacing=${spacing}`
    + `:box=1:boxcolor=black@0.6:boxborderw=${border}:x=(w-text_w)/2:y=h*0.72-text_h/2:enable='between(t,${n3(caption.start)},${n3(caption.end)})'`;
}

/** The filter graph: per take video cover-scaled and cropped, audio resampled to 48 kHz stereo with its gain and short
 * fades; both joined with concat; captions drawn from text files; the music bed looped, trimmed, faded, set to its
 * level and ducked under the clip sound; then loudnorm. Pass 1 builds only the audio. */
function cutGraph(input: CutArgumentsInput, loudness: LoudnessMeasurement | null | 'measure'): string {
  const {width, height, fps} = input, n = input.inputs.length, video = loudness !== 'measure', parts: string[] = [];
  const fade = Math.max(0, input.settings.fadeMs) / 1000, total = input.inputs.reduce((sum, clip) => sum + clip.seconds, 0);
  input.inputs.forEach((clip, i) => {
    const seconds = n3(clip.seconds);
    if (video) parts.push(`[${i}:v]tpad=stop_mode=clone:stop_duration=1,trim=duration=${seconds},setpts=PTS-STARTPTS,fps=${fps},`
      + `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1,format=yuv420p[v${i}]`);
    const source = clip.audio ? `[${i}:a]atrim=duration=${seconds},asetpts=PTS-STARTPTS,` : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds},`;
    const fades = fade > 0 ? `,afade=t=in:st=0:d=${n3(fade)},afade=t=out:st=${n3(Math.max(0, clip.seconds - fade))}:d=${n3(fade)}` : '';
    parts.push(`${source}aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${seconds},volume=${clip.gainDb.toFixed(1)}dB${fades}[a${i}]`);
  });
  parts.push(`${input.inputs.map((_, i) => video ? `[v${i}][a${i}]` : `[a${i}]`).join('')}concat=n=${n}:v=${video ? 1 : 0}:a=1${video ? '[vcat]' : ''}[acat]`);
  if (video) {
    let draws: string[] = [];
    if (input.font !== null && input.captions.length) {
      const font = fontFilterValue(input.font) ?? (() => { throw new Error('The caption font path needs characters that a filter cannot carry; copy the font first.'); })();
      draws = input.captions.map(c => drawCaption(c, font, width, height));
    }
    parts.push(`[vcat]${draws.length ? draws.join(',') : 'null'}[vout]`);
  }
  let mix = 'acat';
  if (input.music) {
    const fadeIn = Math.min(MUSIC_FADE_IN_SECONDS, total / 3), fadeOut = Math.min(MUSIC_FADE_OUT_SECONDS, total / 3);
    parts.push('[acat]asplit=2[dry][key]');
    parts.push(`[${n}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${n3(total)},asetpts=PTS-STARTPTS,`
      + `afade=t=in:st=0:d=${n3(fadeIn)},afade=t=out:st=${n3(total - fadeOut)}:d=${n3(fadeOut)},volume=${input.music.levelDb.toFixed(1)}dB[bed]`);
    parts.push('[bed][key]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[duck]');
    parts.push('[dry][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]');
    mix = 'mix';
  }
  // AAC encoding adds a few tenths of a dB of inter-sample peaks, so the limiter aims a little under the limit.
  const peak = Math.max(-9, input.settings.truePeakDb - AAC_PEAK_MARGIN_DB);
  const target = `loudnorm=I=${input.settings.targetLufs}:TP=${peak}:LRA=${CUT_LOUDNESS_RANGE}`;
  if (loudness === 'measure') parts.push(`[${mix}]${target}:print_format=json[aout]`);
  else if (loudness) parts.push(`[${mix}]${target}:measured_I=${n2(loudness.i)}:measured_TP=${n2(loudness.tp)}:measured_LRA=${n2(loudness.lra)}:measured_thresh=${n2(loudness.thresh)}:offset=${n2(loudness.offset)}:linear=true,aresample=48000[aout]`);
  else parts.push(`[${mix}]anull[aout]`);
  return parts.join(';');
}

/** ffmpeg arguments, without the program. Without `measured`: pass 1, which measures the mixed sound and prints
 * loudnorm's JSON to stderr. With `measured` (null when nothing could be measured): pass 2, which renders the cut to
 * `output` with H.264 CRF 18 and AAC 192 kbps. ffmpeg runs in the folder that holds the caption files. */
export function cutArguments(input: CutArgumentsInput, measured?: LoudnessMeasurement | null): string[] {
  if (!input.inputs.length) throw new Error('A cut needs at least one clip.');
  const render = measured !== undefined;
  const args = ['-hide_banner', '-nostdin', '-nostats', ...(render ? ['-loglevel', 'error', '-y'] : [])];
  for (const clip of input.inputs) args.push('-i', clip.file);
  if (input.music) args.push('-stream_loop', '-1', '-i', input.music.file);
  args.push('-filter_complex', cutGraph(input, render ? measured ?? null : 'measure'));
  if (!render) return [...args, '-map', '[aout]', '-f', 'null', '-'];
  return [...args, '-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1', ...(input.comment ? ['-metadata', `comment=${input.comment}`] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(input.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', input.output];
}

/** loudnorm's JSON from pass 1; null when it is missing or the sound was silent. */
export function parseLoudnorm(stderr: string): LoudnessMeasurement | null {
  const key = stderr.lastIndexOf('"input_i"');
  if (key < 0) return null;
  const open = stderr.lastIndexOf('{', key), close = stderr.indexOf('}', key);
  if (open < 0 || close < 0) return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(stderr.slice(open, close + 1)) as Record<string, unknown>; } catch { return null; }
  const value = (name: string) => { const v = Number(data[name]); return Number.isFinite(v) ? v : undefined; };
  const i = value('input_i'), tp = value('input_tp'), lra = value('input_lra'), thresh = value('input_thresh'), offset = value('target_offset');
  if (i === undefined || tp === undefined || lra === undefined || thresh === undefined || offset === undefined || i < -99 || thresh < -99) return null;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return {i: clamp(i, -99, 0), tp: clamp(tp, -99, 99), lra: clamp(lra, 0, 99), thresh: clamp(thresh, -99, 0), offset: clamp(offset, -99, 99)};
}

/** Integrated loudness and true peak from the summary of ffmpeg's ebur128 filter. */
export function parseEbur128(stderr: string): {integrated: number | null; truePeak: number | null} {
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) return {integrated: null, truePeak: null};
  const summary = stderr.slice(at);
  const find = (pattern: RegExp) => { const v = Number(pattern.exec(summary)?.[1]); return Number.isFinite(v) ? v : null; };
  return {integrated: find(/^\s*I:\s*(\S+)\s*LUFS/mu), truePeak: find(/^\s*Peak:\s*(\S+)\s*dBFS/mu)};
}

/** ffprobe arguments that print one line per audio stream. */
export const audioProbeArguments = (file: string): string[] => ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file];
/** ffprobe arguments that print the duration in seconds. */
export const durationProbeArguments = (file: string): string[] => ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file];
/** ffmpeg arguments that measure loudness and true peak with ebur128 and print only the summary. */
export const loudnessArguments = (file: string): string[] => ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'];
