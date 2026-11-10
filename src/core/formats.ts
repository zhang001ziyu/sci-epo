/** Series format presets: values, defaults and validation shared by the server and the browser.
 * The matching model instructions live in formatPrompts.ts, which only the server imports. */
import type { Brief, DurationTarget, Format } from '../types';
import { languageTag } from './languages';

export const FORMATS = ['vertical_short_drama', 'episodic'] as const;
export const DEFAULT_DURATION_TARGET: DurationTarget = {min: 60, max: 120};
/** The longest single clip of the first video target (MiniMax H3, about 15 seconds). */
export const MAX_SHOT_SECONDS = 15;

export const formatOf = (brief: Pick<Brief, 'format'>): Format => brief.format ?? 'episodic';
export const isShortDrama = (brief: Pick<Brief, 'format'>): boolean => formatOf(brief) === 'vertical_short_drama';
export const aspectRatioOf = (brief: Pick<Brief, 'format'>): '9:16' | '16:9' => isShortDrama(brief) ? '9:16' : '16:9';

export function parseFormat(value: unknown): Format {
  if (value !== 'vertical_short_drama' && value !== 'episodic') throw new Error('剧集格式无效，请选择竖屏短剧或常规剧集。');
  return value;
}

export function parseDurationTarget(value: unknown): DurationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('目标时长格式无效。');
  const {min, max} = value as Record<string, unknown>;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 10 || max > 600 || max < min) {
    throw new Error('目标时长需为 10–600 秒内的整数范围，上限不得小于下限。');
  }
  return {min, max};
}

/** Every vertical short drama is voiced in its script language, English and Simplified Chinese. */
export function defaultVoiceLanguages(scriptLanguage: string): string[] {
  return [...new Set([scriptLanguage, 'en', 'zh-CN'])];
}

export function parseVoiceLanguages(value: unknown, scriptLanguage: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new Error('请选择 1–6 种配音语言。');
  const languages = value.map(languageTag);
  if (new Set(languages).size !== languages.length) throw new Error('配音语言不能重复。');
  if (!languages.includes(scriptLanguage)) throw new Error('配音语言必须包含剧本原稿语言。');
  return languages;
}
