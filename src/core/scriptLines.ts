/** Script-line addressing shared by shot lists, line-aligned adaptations and their checks.
 * Label detection is a heuristic: it only feeds warnings, never acceptance decisions. */
import type { Scene } from '../types';

/** Non-blank lines of a scene's content with trailing whitespace removed. Position 1 is the first. */
export function scriptLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/u).map(line => line.replace(/\s+$/u, '')).filter(line => line.trim().length > 0);
}

export interface SpeakerLabel { name: string; note?: string; text: string }

// NAME: line / NAME (whispering): line, with an uppercase Latin name that ends in a letter or digit.
const LATIN_INLINE = /^\s*(\p{Lu}(?:[\p{Lu}\p{N}.'’ -]{0,30}[\p{Lu}\p{N}])?)\s*(?:\(([^)]{1,60})\))?\s*:\s*(\S.*)$/u;
// 名字：台词 / 名字（低声）：台词, with a name of 1–8 CJK letters. Longer prefixes are action lines
// such as 屏幕闪过一道绿光：“……”.
const CJK_INLINE = /^\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9·・]{0,7})\s*(?:[（(]([^）)]{1,30})[）)])?\s*[：:]\s*(\S.*)$/u;
// Spoken lines do not open with a quotation mark; 备注写着：“……” or ON SCREEN: "..." introduces visible text.
const QUOTED_TEXT = /^["'“‘「『]/u;
// NAME or NAME (CONT'D) alone on a line, the layout of older screenplay-style scripts.
const LATIN_LABEL_ONLY = /^\s*(\p{Lu}(?:[\p{Lu}\p{N}.'’ -]{0,30}[\p{Lu}\p{N}])?)\s*(?:\(([^)]{1,60})\))?\s*$/u;
// 名字 or 名字（低声） alone on a line, as adaptations of that layout write it. No sentence punctuation allowed.
const CJK_LABEL_ONLY = /^\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9·・]{0,11})\s*(?:[（(]([^）)]{1,30})[）)])?\s*$/u;

function label(match: RegExpExecArray | null, withText: boolean): SpeakerLabel | undefined {
  if (!match) return undefined;
  const name = match[1]!.trim(), note = match[2]?.trim();
  return {name, ...(note ? {note} : {}), text: withText ? match[3]!.trim() : ''};
}

export function inlineLabel(line: string): SpeakerLabel | undefined {
  const found = label(LATIN_INLINE.exec(line), true) ?? label(CJK_INLINE.exec(line), true);
  return found && !QUOTED_TEXT.test(found.text) ? found : undefined;
}

export function labelOnly(line: string): SpeakerLabel | undefined {
  return label(LATIN_LABEL_ONLY.exec(line), false) ?? label(CJK_LABEL_ONLY.exec(line), false);
}

/** Positions of lines the script marks as dialogue, with the label's speaker name. */
export function dialoguePositions(content: string): Map<number, string> {
  const lines = scriptLines(content), result = new Map<number, string>();
  lines.forEach((line, index) => {
    const inline = inlineLabel(line);
    if (inline) { result.set(index + 1, inline.name); return; }
    const only = labelOnly(line), next = lines[index + 1];
    if (only && next !== undefined && !inlineLabel(next) && !labelOnly(next)) result.set(index + 2, only.name);
  });
  return result;
}

export const normalizeSpeakerName = (name: string): string => name.replace(/\s*[(（][^)）]*[)）]\s*/gu, '').trim().toLocaleUpperCase();

/** Adaptations of vertical short drama must translate every script line in place. */
export function requireLineAlignment(source: {scenes: Pick<Scene, 'id' | 'content'>[]}, adaptation: {scenes: Pick<Scene, 'id' | 'content'>[]}): void {
  source.scenes.forEach((scene, index) => {
    const target = adaptation.scenes[index];
    const expected = scriptLines(scene.content).length, actual = target ? scriptLines(target.content).length : 0;
    if (!target || target.id !== scene.id || expected !== actual) throw new Error(`第 ${index + 1} 场（${scene.id}）原稿有 ${expected} 行，改编有 ${actual} 行；逐行对齐的改编必须一行对应一行。`);
  });
  if (adaptation.scenes.length !== source.scenes.length) throw new Error(`原稿有 ${source.scenes.length} 场，改编有 ${adaptation.scenes.length} 场；逐行对齐的改编必须保留全部场景。`);
}

export function isLineAligned(source: {scenes: Pick<Scene, 'id' | 'content'>[]}, adaptation: {scenes: Pick<Scene, 'id' | 'content'>[]}): boolean {
  try { requireLineAlignment(source, adaptation); return true; } catch { return false; }
}

/** Fast speaking rates, so the result is a lower bound on the time the lines need. */
export const SPEECH_RATES = {wordsPerSecond: 3, charactersPerSecond: 5} as const;
const CHARACTER_LANGUAGES = /^(zh|ja|ko)(-|$)/u;
export const spokenText = (line: string): string => inlineLabel(line)?.text ?? line.trim();

export function minimumSpeechSeconds(lines: string[], language: string): number {
  const text = lines.map(spokenText).join(' ');
  const byCharacter = CHARACTER_LANGUAGES.test(language);
  const count = byCharacter
    ? [...text].filter(c => /[\p{L}\p{N}]/u.test(c)).length
    : text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  const rate = byCharacter ? SPEECH_RATES.charactersPerSecond : SPEECH_RATES.wordsPerSecond;
  return Math.ceil((count / rate) * 10) / 10;
}
