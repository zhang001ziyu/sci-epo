/** Blocking: where people and things are, line by line. The model lists zones, things and the actions of the script;
 * the program applies each action's preconditions and effects, so "acts on a thing in another zone without moving"
 * and "uses a thing he does not hold" become findings, and every clip can start from the state of its first line.
 * Browser-safe. */
import type { BlockingKind, LogicBlocking, LogicFinding, Posture, Revision } from '../types';
import type { LineRef } from './logic';
import { normalizeSpeakerName, scriptLines } from './scriptLines';

export class BlockingError extends Error {}
const reject = (message: string): never => { throw new BlockingError(message); };
const record = (value: unknown, label: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject(`${label}格式无效。`);
const list = (value: unknown, label: string, max: number): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) && value.length <= max ? value : reject(`${label}需为不超过 ${max} 项的列表。`);
// Text that reaches a clip prompt must not contain prompt syntax.
const UNSAFE = /[<>]|\[\s*shot\b/iu;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/u;
const text = (value: unknown, label: string, max: number): string => {
  const t = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!t || t.length > max) return reject(`${label}需为 1–${max} 个字符的文字。`);
  if (UNSAFE.test(t)) return reject(`${label}不能含有 <、> 或 [Shot。`);
  return t;
};
const optText = (value: unknown, label: string, max: number): string | null => value === undefined || value === null || value === '' ? null : text(value, label, max);
const KINDS: BlockingKind[] = ['at', 'move', 'stand', 'sit', 'take', 'put', 'give', 'use'];
const POSTURES: Posture[] = ['standing', 'sitting', 'lying', 'kneeling'];

interface Index { at(ref: string): LineRef | undefined; text(ref: string): string }

/** One validator for the model's blocking. `ref` checks a line reference of the revision. */
export function parseBlocking(value: unknown, ref: (v: unknown, label: string) => string): LogicBlocking {
  const row = record(value, '走位');
  const zones = list(row.zones, '区域', 40).map((item, i) => {
    const z = record(item, `第 ${i + 1} 个区域`);
    if (typeof z.id !== 'string' || !/^z\d{1,3}$/u.test(z.id)) reject(`第 ${i + 1} 个区域的编号应为 z1、z2 这样的编号。`);
    return {id: z.id as string, name: text(z.name, `区域 ${String(z.id)} 的名字`, 60), en: text(z.en, `区域 ${String(z.id)} 的英文`, 120)};
  });
  const zoneIds = new Set(zones.map(z => z.id));
  if (zoneIds.size !== zones.length) reject('区域编号重复。');
  const zone = (v: unknown, label: string): string | null => v === undefined || v === null || v === '' ? null : typeof v === 'string' && zoneIds.has(v) ? v : reject(`${label}的区域 ${String(v)} 不在区域表里。`);
  const things = list(row.things, '东西', 60).map((item, i) => {
    const t = record(item, `第 ${i + 1} 样东西`);
    if (typeof t.id !== 'string' || !/^t\d{1,3}$/u.test(t.id)) reject(`第 ${i + 1} 样东西的编号应为 t1、t2 这样的编号。`);
    const id = t.id as string, place = zone(t.zone, `东西 ${id}`), holder = optText(t.holder, `东西 ${id} 的持有人`, 60);
    if (place && holder) reject(`东西 ${id} 不能同时在区域里又在人手里。`);
    return {id, name: text(t.name, `东西 ${id} 的名字`, 60), en: text(t.en, `东西 ${id} 的英文`, 120), ref: ref(t.ref, `东西 ${id} 第一次出现`), zone: place, holder};
  });
  const thingIds = new Set(things.map(t => t.id));
  if (thingIds.size !== things.length) reject('东西编号重复。');
  const thing = (v: unknown, label: string): string | null => v === undefined || v === null || v === '' ? null : typeof v === 'string' && thingIds.has(v) ? v : reject(`${label}的东西 ${String(v)} 不在东西表里。`);
  const events = list(row.events, '动作', 300).map((item, i) => {
    const e = record(item, `第 ${i + 1} 个动作`), kind = e.kind as BlockingKind, label = `第 ${i + 1} 个动作（${String(e.kind)}）`;
    if (!KINDS.includes(kind)) reject(`动作类型只能是 ${KINDS.join('、')}。`);
    const posture = e.posture === undefined || e.posture === null || e.posture === '' ? null : POSTURES.includes(e.posture as Posture) ? e.posture as Posture : reject(`posture 只能是 ${POSTURES.join('、')}。`);
    const out = {ref: ref(e.ref, label), who: text(e.who, `${label}的人物`, 60), kind, zone: zone(e.zone, label), posture, thing: thing(e.thing, label), with: thing(e.with, label), to: optText(e.to, `${label}的接收人`, 60), state: optText(e.state, `${label}的状态`, 60)};
    if (kind === 'move' && !out.zone) reject(`${label}要写走到哪个区域（zone）。`);
    if (['take', 'put', 'give', 'use'].includes(kind) && !out.thing) reject(`${label}要写对哪样东西（thing）。`);
    if (kind === 'give' && !out.to) reject(`${label}要写递给谁（to）。`);
    return out;
  });
  return {zones, things, events};
}

export interface PersonState { zone: string | null; posture: Posture | null; since: string | null }
export interface ThingState { zone: string | null; holder: string | null; state: string | null }
/** People by normalized name, things by ID. */
export interface SceneState { people: Map<string, PersonState>; things: Map<string, ThingState> }
const clone = (s: SceneState): SceneState => ({people: new Map([...s.people].map(([k, v]) => [k, {...v}])), things: new Map([...s.things].map(([k, v]) => [k, {...v}]))});
const key = normalizeSpeakerName;
const quote = (t: string, max = 80) => { const s = t.trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const POSTURE_ZH: Record<Posture, string> = {standing: '站着', sitting: '坐着', lying: '躺着', kneeling: '跪着'};

/** Applies every action in script order. `before(sceneId, line)` is the state just before that line;
 * people are placed anew in every scene (by their `at`), what they hold carries over. */
export function foldBlocking(blocking: LogicBlocking, revision: Pick<Revision, 'scenes'>, index: Index): {findings: LogicFinding[]; before(sceneId: string, line: number): SceneState | undefined} {
  const zones = new Map(blocking.zones.map(z => [z.id, z])), things = new Map(blocking.things.map(t => [t.id, t]));
  const findings: LogicFinding[] = [], snapshots = new Map<string, SceneState>();
  const zoneName = (id: string | null) => id ? zones.get(id)?.name ?? id : '不明的地方';
  const thingName = (id: string) => things.get(id)?.name ?? id;
  const line = (ref: string) => `“${quote(index.text(ref))}”（${ref}）`;
  const names = new Map<string, string>();
  const order = (ref: string) => { const r = index.at(ref)!; return r.scene * 10_000 + r.line; };
  const events = blocking.events.map((e, i) => ({e, i})).sort((a, b) => order(a.e.ref) - order(b.e.ref) || a.i - b.i).map(x => x.e);
  for (const e of events) { if (!names.has(key(e.who))) names.set(key(e.who), e.who); if (e.to && !names.has(key(e.to))) names.set(key(e.to), e.to); }
  const state: SceneState = {people: new Map(), things: new Map(blocking.things.map(t => [t.id, {zone: t.zone, holder: t.holder ? key(t.holder) : null, state: null}]))};
  const add = (kind: LogicFinding['kind'], ref: string, subject: string, title: string, detail: string, fix: string) => {
    const id = `${kind}:${ref}:${quote(subject, 40)}`;
    if (!findings.some(f => f.id === id)) findings.push({id, kind, ref, title, detail, fix});
  };
  const person = (who: string) => { const k = key(who); let p = state.people.get(k); if (!p) { p = {zone: null, posture: null, since: null}; state.people.set(k, p); } return p; };
  const since = (p: PersonState) => p.since ? `（${line(p.since)}）` : '';

  revision.scenes.forEach((scene, sceneIndex) => {
    const mine = events.filter(e => index.at(e.ref)!.scene === sceneIndex);
    state.people = new Map();
    // `at` says where the scene first shows a person: they are there from the start of the scene.
    const first = new Map<string, (typeof events)[number]>();
    for (const e of mine) if (!first.has(key(e.who))) first.set(key(e.who), e);
    for (const [k, e] of first) if (e.kind === 'at') state.people.set(k, {zone: e.zone, posture: e.posture, since: e.ref});
    const count = scriptLines(scene.content).length;
    for (let n = 1; n <= count; n++) {
      const ref = `${scene.id}:${n}`;
      snapshots.set(ref, clone(state));
      for (const e of mine.filter(x => x.ref === ref)) {
        const p = person(e.who), who = e.who, k = key(who);
        const target = e.thing ? state.things.get(e.thing)! : undefined, tName = e.thing ? thingName(e.thing) : '';
        // Reach: in the person's hands, or in the zone the person is in. Unknown positions are never findings.
        const reach = (): {ok: true} | {ok: false; where: string} => {
          if (!target) return {ok: true};
          if (target.holder) {
            if (target.holder === k) return {ok: true};
            const other = state.people.get(target.holder);
            return !other?.zone || !p.zone || other.zone === p.zone ? {ok: true} : {ok: false, where: `${names.get(target.holder) ?? target.holder} 手里（在${zoneName(other.zone)}）`};
          }
          return !target.zone || !p.zone || target.zone === p.zone ? {ok: true} : {ok: false, where: zoneName(target.zone)};
        };
        const outOfReach = (verb: string) => {
          const r = reach();
          if (r.ok) return;
          add('out_of_reach', ref, `${who}:${tName}`, `${who} 在${zoneName(p.zone)}，够不着“${quote(tName, 30)}”`,
            `${line(ref)}：${who} 要${verb}“${tName}”，可这时 ${who} 在${zoneName(p.zone)}${since(p)}，“${tName}”在${r.where}。正文没有写 ${who} 走过去。看得见不等于够得着，观众会问 ${who} 是怎么碰到的；分镜和视频也只能凭空补一段走位。`,
            `在这一行之前加一个走过去的动作（比如“${who} 走到${target?.zone ? zoneName(target.zone) : '那里'}”），或者把“${tName}”放到 ${who} 身边。`);
        };
        const holds = (id: string) => state.things.get(id)!.holder === k;
        const known = (id: string) => { const t = state.things.get(id)!; return !!(t.holder || t.zone); };
        const notHolding = (id: string, verb: string) => {
          if (holds(id) || !known(id)) return;
          const t = state.things.get(id)!, name = thingName(id);
          add('not_holding', ref, `${who}:${name}`, `${who} ${verb}“${quote(name, 30)}”，可手里没有它`,
            `${line(ref)}：${who} ${verb}“${name}”，可在这之前它${t.holder ? `在 ${names.get(t.holder) ?? t.holder} 手里` : `放在${zoneName(t.zone)}`}，正文没有写 ${who} 拿起它。`,
            `在这之前加一句 ${who} 拿起或接过“${name}”，或者改成用 ${who} 手里已有的东西。`);
        };
        switch (e.kind) {
          case 'at':
            if (p.since && p.since !== ref && ((e.zone && p.zone && e.zone !== p.zone) || (e.posture && p.posture && e.posture !== p.posture))) {
              const change = e.zone && p.zone && e.zone !== p.zone ? `从${zoneName(p.zone)}到了${zoneName(e.zone)}` : `从${POSTURE_ZH[p.posture!]}变成了${POSTURE_ZH[e.posture!]}`;
              add('no_move', ref, who, `${who} ${change}，中间没有动作`, `${line(ref)}：${who} 之前${since(p)}${p.posture ? POSTURE_ZH[p.posture] : ''}在${zoneName(p.zone)}，这里${change}，正文没有写起身或走过去。镜头之间人物不会自己换位置。`, `在这之前加一个起身或走过去的动作，或者让 ${who} 留在原处。`);
            }
            if (e.zone) p.zone = e.zone;
            if (e.posture) p.posture = e.posture;
            p.since = ref;
            break;
          case 'move':
            // Walking means standing; an earlier seat needs no separate "stands up".
            p.zone = e.zone; p.since = ref; p.posture = 'standing';
            break;
          case 'stand': p.posture = 'standing'; break;
          case 'sit':
            if (e.zone && p.zone && e.zone !== p.zone) add('out_of_reach', ref, `${who}:${e.zone}`, `${who} 在${zoneName(p.zone)}，却坐到了${zoneName(e.zone)}`, `${line(ref)}：${who} 这时在${zoneName(p.zone)}${since(p)}，正文没有写 ${who} 走到${zoneName(e.zone)}。`, `在这之前加一个走过去的动作，或者让 ${who} 就地坐下。`);
            p.posture = 'sitting';
            if (e.zone) { p.zone = e.zone; p.since = ref; }
            break;
          case 'take':
            outOfReach('拿起');
            target!.holder = k; target!.zone = null;
            break;
          case 'put': {
            notHolding(e.thing!, '放下');
            if (e.zone && p.zone && e.zone !== p.zone) add('out_of_reach', ref, `${who}:${tName}:${e.zone}`, `${who} 在${zoneName(p.zone)}，却把“${quote(tName, 30)}”放到了${zoneName(e.zone)}`, `${line(ref)}：${who} 这时在${zoneName(p.zone)}${since(p)}，正文没有写 ${who} 走到${zoneName(e.zone)}。`, `在这之前加一个走过去的动作，或者让 ${who} 放在身边。`);
            target!.holder = null; target!.zone = e.zone ?? p.zone ?? target!.zone;
            break;
          }
          case 'give': {
            notHolding(e.thing!, '递出');
            const q = state.people.get(key(e.to!));
            if (q?.zone && p.zone && q.zone !== p.zone) add('out_of_reach', ref, `${who}:${e.to}:${tName}`, `${who} 把“${quote(tName, 30)}”递给 ${e.to}，可两人不在一处`, `${line(ref)}：${who} 在${zoneName(p.zone)}${since(p)}，${e.to} 在${zoneName(q.zone)}${since(q)}，正文没有写谁走过去。`, `在这之前让其中一人走过去。`);
            target!.holder = key(e.to!); target!.zone = null;
            break;
          }
          case 'use':
            outOfReach('碰到');
            if (e.with) notHolding(e.with, '要用');
            if (e.state) target!.state = e.state;
            break;
        }
      }
    }
  });
  return {findings, before: (sceneId, n) => { const s = snapshots.get(`${sceneId}:${n}`); return s ? clone(s) : undefined; }};
}

const sentence = (t: string) => /[.!?]$/u.test(t) ? t : `${t}.`;
const english = (t: string | null | undefined): t is string => !!t && !CJK.test(t) && !UNSAFE.test(t);
const thingPhrase = (t: {en: string}, s: ThingState) => `${t.en.replace(/[.]$/u, '')}${english(s.state) ? ` (${s.state})` : ''}`;

/** The English opening state of a clip for the people in it: zone, posture, what each holds, and the things within
 * their reach. Pieces without English text are left out and reported. */
export function openingState(blocking: LogicBlocking, state: SceneState, people: {key: string; name: string}[]): {text: string; missing: string[]} {
  const zones = new Map(blocking.zones.map(z => [z.id, z])), things = new Map(blocking.things.map(t => [t.id, t])), parts: string[] = [], missing: string[] = [];
  const zoneEn = (id: string | null) => { const z = id ? zones.get(id) : undefined; if (z && !english(z.en)) missing.push(z.name); return z && english(z.en) ? z.en.replace(/[.]$/u, '') : ''; };
  const occupied = new Set<string>();
  for (const {key: k, name} of people) {
    const p = state.people.get(normalizeSpeakerName(k));
    const held = [...state.things].filter(([, s]) => s.holder === normalizeSpeakerName(k)).map(([id, s]) => {
      const t = things.get(id)!; if (!english(t.en)) { missing.push(t.name); return ''; } return thingPhrase(t, s);
    }).filter(Boolean);
    const where = p ? zoneEn(p.zone) : '';
    if (p?.zone) occupied.add(p.zone);
    if (!p?.posture && !where && !held.length) continue;
    const verb = p?.posture ? `is ${p.posture}` : 'is';
    parts.push(sentence(`${name} ${verb}${where ? ` ${where}` : ''}${held.length ? `${p?.posture || where ? ',' : ''} holding ${held.join(' and ')}` : ''}`));
  }
  const near = [...state.things].filter(([, s]) => !s.holder && s.zone && occupied.has(s.zone)).slice(0, 4);
  for (const [id, s] of near) { const t = things.get(id)!, where = zoneEn(s.zone); if (!english(t.en)) { missing.push(t.name); continue; } if (where) parts.push(sentence(`${capitalize(thingPhrase(t, s))} is ${where}`)); }
  return {text: parts.length ? `Continuity at the start of this clip: ${parts.join(' ')}` : '', missing: [...new Set(missing)]};
}
const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
