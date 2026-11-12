/** Version 2 render plans: picture and job keys, one job per distinct render, per-take seeds, the lines and shot
 * times a worker checks against, and default speed estimates. Server-only (node:crypto); prompts come from h3.ts. */
import { createHash } from 'node:crypto';
import type { BatchReference, RenderBatch, RenderClip, RenderPreset, StackRef } from '../types';
import { canonicalJsonBytes } from './canonicalJson';

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const pad2 = (value: number) => String(value).padStart(2, '0');

/** FNV-1a over "pictureKey:n": every language of a clip gets the same seed for the same take number. */
export function takeSeed(pictureKey: string, n: number): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${pictureKey}:${n}`)) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}

/** The prompt without the words inside <d>…</d>, which is the same for every language of a clip. */
export const pictureText = (prompt: string) => prompt.replace(/<d>[\s\S]*?<\/d>/gu, '<d></d>');

export interface PlannedJobV2 { clipId: string; key: string; languages: string[]; order: number; outputName: string }

/** Keys for every clip and language; languages whose job keys match become one job. */
export function planJobsV2(batch: Pick<RenderBatch, 'clips' | 'languages'>, preset: RenderPreset, references: BatchReference[], episodeOrdinal: number): {clips: RenderClip[]; jobs: PlannedJobV2[]} {
  const hashOf = new Map(references.map(r => [r.name, r.sha256]));
  const refs = (names: string[]) => names.map(name => hashOf.get(name) ?? name);
  const jobs: PlannedJobV2[] = [];
  const clips = batch.clips.map(clip => {
    const first = clip.prompts[batch.languages[0]!]!;
    const pictureKey = sha256Hex(canonicalJsonBytes({shots: clip.shotIds, mode: first.mode, picture: pictureText(first.text), frames: clip.frames, preset, references: refs([...first.images, ...first.audio])}));
    const groups = new Map<string, string[]>();
    for (const language of batch.languages) {
      const prompt = clip.prompts[language]!;
      const key = sha256Hex(canonicalJsonBytes({pictureKey, mode: prompt.mode, prompt: prompt.text, references: refs([...prompt.images, ...prompt.audio])}));
      groups.set(key, [...(groups.get(key) ?? []), language]);
    }
    for (const [key, languages] of groups) {
      const suffix = languages.length === batch.languages.length ? '' : `-${languages.join('+')}`;
      jobs.push({clipId: clip.id, key, languages, order: jobs.length, outputName: `ep${pad2(episodeOrdinal)}-${clip.id}${suffix}.mp4`});
    }
    return {...clip, pictureKey, seed: takeSeed(pictureKey, 1)};
  });
  return {clips, jobs};
}

// Browser-safe clip helpers live in h3.ts, so cuts can use them without node:crypto; existing imports keep working.
export { shotTimes, spokenLines } from './h3';

/** Key of a measured rate: stack, size, sampling steps and GPU. */
export const rateKey = (stack: StackRef, width: number, height: number, steps: number, gpu: string) =>
  `${stack.id}@${stack.version}:${width}x${height}:${steps}:${gpu.replace(/\s+/gu, ' ').trim().slice(0, 80)}`;

export const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Seconds per frame from the stack's measured defaults (keys like "480x864x20"), scaled by pixels and steps. */
export function defaultRate(defaults: Record<string, number>, width: number, height: number, steps: number): number {
  const exact = defaults[`${width}x${height}x${steps}`];
  if (exact) return exact;
  const [base, rate] = Object.entries(defaults)[0] ?? ['480x864x20', 0.62];
  const [bw, bh, bs] = base.split('x').map(Number) as [number, number, number];
  // Text encoding and decoding do not scale with steps, so a share of the time stays fixed.
  return rate * (width * height) / (bw * bh) * (0.15 + 0.85 * steps / bs);
}
