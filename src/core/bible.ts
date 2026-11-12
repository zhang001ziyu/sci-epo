/** The episode bible: the places, props and per-scene setting the author confirms before shots and clips use them.
 * Browser-safe, so the shot tab checks a draft with the same rules as the server. */
import type { BibleContent, BibleLocation, BibleProp, BibleScene, Episode, EpisodeBible, Revision } from '../types';

export class BibleError extends Error {}
const reject = (message: string): never => { throw new BibleError(message); };
const record = (value: unknown, label: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject(`${label}格式无效。`);
/** Text that reaches a clip prompt must not contain prompt syntax. */
const UNSAFE = /[<>]|\[\s*shot\b/iu;
const LOCATION_ID = /^L\d{1,3}$/u, PROP_ID = /^P\d{1,3}$/u;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/u;

function text(value: unknown, label: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') return required ? reject(`${label}不能为空。`) : undefined;
  if (typeof value !== 'string') return reject(`${label}必须是文字。`);
  const t = value.replace(/\s+/gu, ' ').trim();
  if (!t) return required ? reject(`${label}不能为空。`) : undefined;
  if (t.length > max) return reject(`${label}最多 ${max} 个字符。`);
  if (UNSAFE.test(t)) return reject(`${label}不能含有 <、> 或 [Shot，它们在视频提示词里有特殊含义。`);
  return t;
}

function entry<T extends BibleLocation | BibleProp>(item: unknown, index: number, kind: '地点' | '道具', pattern: RegExp): T {
  const row = record(item, `第 ${index + 1} 个${kind}`);
  if (typeof row.id !== 'string' || !pattern.test(row.id)) return reject(`第 ${index + 1} 个${kind}的编号无效，应为 ${kind === '地点' ? 'L1、L2' : 'P1、P2'} 这样的编号。`);
  const name = text(row.name, `${kind} ${row.id} 的名字`, 60, true)!, look = text(row.look, `${kind} ${row.id} 的画面描述`, 400, true)!, note = text(row.note, `${kind} ${row.id} 的说明`, 200, false);
  return {id: row.id, name, look, ...(note ? {note} : {})} as T;
}

/** One validator for model drafts and the author's edits. Every scene of the revision gets exactly one setting, in order. */
export function parseBible(value: unknown, revision: Pick<Revision, 'scenes'>): BibleContent {
  const row = record(value, '本集设定');
  if (!Array.isArray(row.locations) || row.locations.length < 1 || row.locations.length > 30) reject('本集设定需要 1–30 个地点。');
  const props = row.props ?? [];
  if (!Array.isArray(props) || props.length > 40) reject('本集设定最多 40 个道具。');
  const locations = (row.locations as unknown[]).map((item, i) => entry<BibleLocation>(item, i, '地点', LOCATION_ID));
  const propList = (props as unknown[]).map((item, i) => entry<BibleProp>(item, i, '道具', PROP_ID));
  if (new Set(locations.map(l => l.id)).size !== locations.length) reject('地点编号重复。');
  if (new Set(propList.map(p => p.id)).size !== propList.length) reject('道具编号重复。');
  if (!Array.isArray(row.scenes)) reject('本集设定需要列出每一场的地点。');
  const scenes = row.scenes as unknown[], locationIds = new Set(locations.map(l => l.id)), propIds = new Set(propList.map(p => p.id));
  if (scenes.length !== revision.scenes.length) reject(`剧本有 ${revision.scenes.length} 场，设定列了 ${scenes.length} 场；每一场都要写清在哪里。`);
  const settings: BibleScene[] = scenes.map((item, i) => {
    const s = record(item, `第 ${i + 1} 场的设定`), expected = revision.scenes[i]!.id;
    if (s.sceneId !== expected) return reject(`第 ${i + 1} 场应为 ${expected}，设定写的是 ${String(s.sceneId)}；请按剧本顺序列出每一场。`);
    if (typeof s.locationId !== 'string' || !locationIds.has(s.locationId)) return reject(`场景 ${expected} 的地点 ${String(s.locationId)} 不在地点表里。`);
    const used = s.props ?? [];
    if (!Array.isArray(used) || used.length > 12 || used.some(p => typeof p !== 'string' || !propIds.has(p)) || new Set(used).size !== used.length) return reject(`场景 ${expected} 的道具必须是道具表里不重复的编号，最多 12 个。`);
    return {sceneId: expected, locationId: s.locationId, props: [...used] as string[]};
  });
  return {locations, props: propList, scenes: settings};
}

export function parseBibleOutput(raw: string, revision: Pick<Revision, 'scenes'>): BibleContent {
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); }
  catch { return reject('模型输出不是完整的 JSON。'); }
  return parseBible(value, revision);
}

export type BibleState = 'missing' | 'draft' | 'stale' | 'confirmed';
/** missing: none; draft: not yet confirmed; stale: confirmed for another revision; confirmed: usable for this revision. */
export function bibleState(bible: EpisodeBible | undefined, revision: Pick<Revision, 'id'> | undefined): BibleState {
  if (!bible) return 'missing';
  if (!revision || bible.revisionId !== revision.id) return 'stale';
  return bible.confirmedAt ? 'confirmed' : 'draft';
}

/** The bible clip prompts and shot lists use: confirmed for exactly this revision. */
export function confirmedBible(episode: Pick<Episode, 'bible'>, revision: Pick<Revision, 'id'> | undefined): EpisodeBible | undefined {
  return bibleState(episode.bible, revision) === 'confirmed' ? episode.bible : undefined;
}

/** The setting of one scene: its location and props, in the bible's order. */
export function sceneSetting(bible: BibleContent, sceneId: string): {location?: BibleLocation; props: BibleProp[]} {
  const scene = bible.scenes.find(s => s.sceneId === sceneId);
  if (!scene) return {props: []};
  const location = bible.locations.find(l => l.id === scene.locationId);
  return {...(location ? {location} : {}), props: scene.props.map(id => bible.props.find(p => p.id === id)).filter((p): p is BibleProp => !!p)};
}

const sentence = (t: string) => /[.!?]$/u.test(t) ? t : `${t}.`;
/** English sentences for the first shot of every clip of a scene, so each clip shows the same room and the same props. */
export function settingSentences(bible: BibleContent, sceneId: string): string[] {
  const {location, props} = sceneSetting(bible, sceneId), out: string[] = [];
  if (location) out.push(sentence(`Setting: ${location.look}`));
  // Props are described for when they are on screen, so a prop revealed later is not shown early.
  if (props.length) out.push(sentence(`Whenever these props are on screen, they look exactly like this: ${props.map(p => p.look.replace(/[.]$/u, '')).join('; ')}`));
  return out;
}

/** Points the author should look at before confirming. They never block saving. */
export function bibleNotes(bible: BibleContent): {id: string; message: string}[] {
  const notes: {id: string; message: string}[] = [];
  for (const item of [...bible.locations, ...bible.props]) if (CJK.test(item.look)) notes.push({id: `look:${item.id}`, message: `${item.id}（${item.name}）的画面描述里有中文。视频模型只读英文，请改成英文描述。`});
  const used = new Set(bible.scenes.map(s => s.locationId)), shown = new Set(bible.scenes.flatMap(s => s.props));
  for (const l of bible.locations) if (!used.has(l.id)) notes.push({id: `unused:${l.id}`, message: `地点 ${l.id}（${l.name}）没有哪一场用到。`});
  for (const p of bible.props) if (!shown.has(p.id)) notes.push({id: `unused:${p.id}`, message: `道具 ${p.id}（${p.name}）没有出现在任何一场里；如果结尾要用它，要先在前面某一场露出来。`});
  return notes;
}

/** The scene where each prop first appears. */
export function firstAppearance(bible: BibleContent): Map<string, string> {
  const first = new Map<string, string>();
  for (const s of bible.scenes) for (const p of s.props) if (!first.has(p)) first.set(p, s.sceneId);
  return first;
}

/** A starting point without a model: one location per distinct scene heading, with empty descriptions for the author to fill. */
export function bibleFromHeadings(revision: Pick<Revision, 'scenes'>): BibleContent {
  const locations: BibleLocation[] = [], byHeading = new Map<string, string>();
  const scenes = revision.scenes.map(scene => {
    const key = scene.heading.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
    let id = byHeading.get(key);
    if (!id) { id = `L${locations.length + 1}`; byHeading.set(key, id); locations.push({id, name: scene.heading.trim().slice(0, 60) || scene.id, look: ''}); }
    return {sceneId: scene.id, locationId: id, props: []};
  });
  return {locations, props: [], scenes};
}
