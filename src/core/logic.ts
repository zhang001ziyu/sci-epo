/** Script logic check: the model fills a ledger (who knows what and from where, what the ending depends on, which
 * setups pay off, which instructions lack a reason, what a character could not see, which choices cost the
 * protagonist something), and the program decides the findings from it. Shot lists and video need every finding of
 * the accepted revision to be fixed in a new revision or kept by the author with a reason. Browser-safe. */
import type { Episode, LogicCheck, LogicConduct, LogicFinding, LogicLedger, LogicPremise, Revision, Verdict } from '../types';
import { actionRefs, foldBlocking, parseBlocking } from './blocking';
import { scriptLines } from './scriptLines';

export class LogicError extends Error {}
const reject = (message: string): never => { throw new LogicError(message); };
const record = (value: unknown, label: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject(`${label}格式无效。`);
const list = (value: unknown, label: string, max: number): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) && value.length <= max ? value : reject(`${label}需为不超过 ${max} 项的列表。`);
const text = (value: unknown, label: string, max = 300): string => typeof value === 'string' && value.trim() && value.length <= max ? value.replace(/\s+/gu, ' ').trim() : reject(`${label}需为 1–${max} 个字符的文字。`);
const REF = /^(s[A-Za-z0-9_-]{0,30}):(\d{1,4})$/u;

/** A line reference `<sceneId>:<line>` with its order in the episode, or undefined for null. */
export interface LineRef { ref: string; scene: number; line: number }
export function lineIndex(revision: Pick<Revision, 'scenes'>) {
  const counts = revision.scenes.map(s => scriptLines(s.content).length);
  const at = (ref: string): LineRef | undefined => {
    const m = REF.exec(ref);
    const scene = m ? revision.scenes.findIndex(s => s.id === m[1]) : -1;
    return m && scene >= 0 && Number(m[2]) >= 1 && Number(m[2]) <= counts[scene]! ? {ref, scene, line: Number(m[2])} : undefined;
  };
  const text = (ref: string) => { const r = at(ref); return r ? scriptLines(revision.scenes[r.scene]!.content)[r.line - 1] ?? '' : ''; };
  const before = (a: LineRef, b: LineRef) => a.scene < b.scene || (a.scene === b.scene && a.line < b.line);
  const last = (): LineRef => { const scene = revision.scenes.length - 1; return {ref: `${revision.scenes[scene]!.id}:${counts[scene]}`, scene, line: counts[scene]!}; };
  return {at, text, before, last};
}

/** One validator for the model's ledger. Every reference must name a line of this revision; null means none. */
export interface LedgerOptions {
  /** A live model's answer: blocking must answer every action line (`actionRefs`), so a skipped line is caught. */
  coverage?: boolean;
}
export function parseLedger(value: unknown, revision: Pick<Revision, 'scenes'>, options: LedgerOptions = {}): LogicLedger {
  const row = record(value, '逻辑检查'), index = lineIndex(revision);
  const ref = (v: unknown, label: string): string => typeof v === 'string' && index.at(v) ? v : reject(`${label}的行号 ${String(v)} 不在剧本里，应写成“场景编号:行号”，例如 s1:3。`);
  const optRef = (v: unknown, label: string): string | null => v === null || v === undefined || v === '' ? null : ref(v, label);
  const offscreen = list(row.offscreen, '场外人物', 20).map((item, i) => {
    const o = record(item, `第 ${i + 1} 个场外人物`);
    return {character: text(o.character, '场外人物的名字', 60), messageRef: ref(o.messageRef, '场外人物的消息'),
      claims: list(o.claims, '消息里的信息', 12).map((c, j) => {
        const x = record(c, `第 ${j + 1} 条信息`), kind = x.sourceKind;
        if (!['self', 'history', 'present', 'told', 'sees', 'earlier', 'brief', 'none'].includes(kind as string)) reject('信息来源只能是 self、history、present、told、sees、earlier、brief 或 none。');
        return {fact: text(x.fact, '信息内容'), sourceKind: kind as LogicLedger['offscreen'][number]['claims'][number]['sourceKind'], sourceRef: optRef(x.sourceRef, '信息来源')};
      })};
  });
  const e = record(row.ending, '结尾');
  const ending = {ref: ref(e.ref, '结尾'), question: text(e.question, '结尾的问题'),
    dependsOn: list(e.dependsOn, '结尾依赖的东西', 12).map((d, i) => {
      const x = record(d, `结尾依赖的第 ${i + 1} 项`), kind = x.kind;
      if (!['prop', 'rule', 'relationship', 'fact'].includes(kind as string)) reject('结尾依赖的东西只能是 prop、rule、relationship 或 fact。');
      return {thing: text(x.thing, '结尾依赖的东西', 120), kind: kind as 'prop', firstRef: optRef(x.firstRef, '第一次出现')};
    })};
  const setups = list(row.setups, '埋下的东西', 30).map((s, i) => {
    const x = record(s, `第 ${i + 1} 个埋下的东西`);
    if (typeof x.bearsOnEnding !== 'boolean') reject('bearsOnEnding 需为 true 或 false。');
    return {thing: text(x.thing, '埋下的东西', 120), ref: ref(x.ref, '埋下的位置'), payoffRef: optRef(x.payoffRef, '后来用上的位置'), bearsOnEnding: x.bearsOnEnding as boolean};
  });
  const instructions = list(row.instructions, '要求或行为', 20).map((s, i) => {
    const x = record(s, `第 ${i + 1} 个要求`);
    return {text: text(x.text, '要求的内容', 200), ref: ref(x.ref, '要求的位置'), reasonRef: optRef(x.reasonRef, '理由的位置')};
  });
  const sightings = list(row.sightings, '看见的东西', 20).map((s, i) => {
    const x = record(s, `第 ${i + 1} 个看见的东西`), visible = x.visible;
    if (!['yes', 'no', 'unclear'].includes(visible as string)) reject('visible 只能是 yes、no 或 unclear。');
    return {who: text(x.who, '看的人', 60), what: text(x.what, '看见的东西', 160), ref: ref(x.ref, '看见的位置'), visible: visible as 'yes', why: text(x.why, '为什么看得见', 300)};
  });
  const protagonist = text(row.protagonist, '主角', 60);
  const choices = list(row.choices, '主角的选择', 12).map((s, i) => {
    const x = record(s, `第 ${i + 1} 个选择`);
    return {ref: ref(x.ref, '选择的位置'), choice: text(x.choice, '选择', 200), cost: text(x.cost, '代价', 200)};
  });
  let blocking;
  if (options.coverage && (row.blocking === undefined || row.blocking === null)) reject('缺少走位（blocking）。');
  try { blocking = row.blocking === undefined || row.blocking === null ? undefined : parseBlocking(row.blocking, ref, options.coverage ? actionRefs(revision) : undefined, options.coverage ? revision.scenes.map(s => s.id) : undefined); }
  catch (error) { return reject(error instanceof Error ? error.message : '走位格式无效。'); }
  const verdict = (v: unknown): Verdict => ['yes', 'no', 'unclear'].includes(v as string) ? v as Verdict : reject('plausible 只能是 yes、no 或 unclear。');
  const bool = (v: unknown, label: string): boolean => typeof v === 'boolean' ? v : reject(`${label}需为 true 或 false。`);
  const thingIds = new Set(blocking?.things.map(t => t.id) ?? []);
  const premises = list(row.premises, '东西的来由', 60).map((p, i): LogicPremise => {
    const x = record(p, `第 ${i + 1} 条东西的来由`);
    const thingId = x.thingId === undefined || x.thingId === null || x.thingId === '' ? null : typeof x.thingId === 'string' && thingIds.has(x.thingId) ? x.thingId : reject(`东西的来由里的 ${String(x.thingId)} 不在走位的东西表里。`);
    return {thingId, name: text(x.name, '东西', 80), ref: ref(x.ref, '东西出现'), placement: text(x.placement, '东西怎么放着', 200), placedBy: x.placedBy === null || x.placedBy === undefined || x.placedBy === '' ? null : text(x.placedBy, '谁放的', 60),
      common: bool(x.common, 'common'), reasonRef: optRef(x.reasonRef, '理由'), plausible: verdict(x.plausible), why: text(x.why, '为什么合理', 300)};
  });
  if (options.coverage && blocking) {
    const covered = new Set(premises.map(p => p.thingId)), missing = blocking.things.filter(t => !covered.has(t.id) && !t.holder).map(t => `${t.id}（${t.name}）`);
    if (missing.length) reject(`东西的来由漏了 ${missing.length} 样东西：${missing.slice(0, 10).join('、')}。走位 things 里每一样不在人手里的东西，都要在 premises 里说明它为什么在那里、为什么这样放。`);
  }
  const conduct = list(row.conduct, '人物的做法', 80).map((c, i): LogicConduct => {
    const x = record(c, `第 ${i + 1} 条人物的做法`);
    return {who: text(x.who, '人物', 60), ref: ref(x.ref, '做法'), action: text(x.action, '做法', 200), common: bool(x.common, 'common'), reasonRef: optRef(x.reasonRef, '理由'), plausible: verdict(x.plausible), why: text(x.why, '为什么合理', 300)};
  });
  // Every hand-on-thing action is judged for physical sense, so a "possible" contact in the same zone is still checked.
  if (options.coverage && blocking) {
    const judged = new Set(conduct.map(c => c.ref));
    const missing = [...new Set(blocking.events.filter(e => ['take', 'put', 'give', 'use'].includes(e.kind)).map(e => e.ref))].filter(r => !judged.has(r));
    if (missing.length) reject(`人物的做法漏了 ${missing.length} 个动手的行：${missing.slice(0, 12).join('、')}。blocking 里每个 take、put、give、use 所在的行，都要在 conduct 里判断它合不合理、做不做得到。`);
  }
  return {protagonist, offscreen, ending, setups, instructions, sightings, choices, ...(blocking ? {blocking} : {}), ...(premises.length ? {premises} : {}), ...(conduct.length ? {conduct} : {})};
}

export function parseLedgerOutput(raw: string, revision: Pick<Revision, 'scenes'>, options: LedgerOptions = {}): LogicLedger {
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); } catch { return reject('模型输出不是完整的 JSON。'); }
  return parseLedger(value, revision, options);
}

const quote = (t: string, max = 80) => { const s = t.trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** The findings the program draws from a ledger, in the order of the script. */
export function logicFindings(ledger: LogicLedger, revision: Pick<Revision, 'scenes'>): LogicFinding[] {
  const index = lineIndex(revision), out: LogicFinding[] = [];
  const at = (ref: string) => index.at(ref)!, line = (ref: string) => `“${quote(index.text(ref))}”（${ref}）`;
  for (const o of ledger.offscreen) for (const c of o.claims) {
    const source = c.sourceRef ? at(c.sourceRef) : undefined, message = at(o.messageRef);
    // Her own facts, her long-standing history with the person or place, and the brief need no line in the text.
    // A source on the message's own line is the message saying how she knows ("he texted me ...").
    const missing = c.sourceKind === 'none' || (!['brief', 'self', 'history'].includes(c.sourceKind) && (!source || index.before(message, source)));
    if (missing) out.push({id: `offscreen:${o.messageRef}:${quote(c.fact, 40)}`, kind: 'offscreen_knowledge', ref: o.messageRef,
      title: `${o.character} 不在场，却知道“${quote(c.fact, 60)}”`,
      detail: `${o.character} 只通过消息出现。${line(o.messageRef)} 里她知道这件事，但在这之前，正文里没有她能知道的来源：她不在现场，没人告诉她，她也看不到画面。观众会问“她怎么知道的”。`,
      fix: '在这条消息之前加一个来源（比如玛雅发了照片、打了电话），或者改掉这条消息，让她只说她能知道的事。'});
  }
  const ending = at(ledger.ending.ref);
  for (const d of ledger.ending.dependsOn) {
    const first = d.firstRef ? at(d.firstRef) : undefined;
    const KIND: Record<string, string> = {prop: '道具', rule: '规则', relationship: '人物关系', fact: '事实'};
    if (!first) out.push({id: `ending_unstated:${quote(d.thing, 40)}`, kind: 'ending_unstated', ref: ledger.ending.ref,
      title: `结尾靠的${KIND[d.kind]}“${quote(d.thing, 40)}”在正文里没出现`,
      detail: `结尾 ${line(ledger.ending.ref)} 要靠这个${KIND[d.kind]}才成立，但它只写在系列设定或梗概里，画面和台词里都没有。观众不知道它，结尾就没有分量。`,
      fix: `在结尾之前用一句台词或一个动作把它交代出来。`});
    else if (first.scene === ending.scene && first.line >= ending.line) out.push({id: `ending_late:${quote(d.thing, 40)}`, kind: 'ending_late', ref: d.firstRef!,
      title: `结尾靠的${KIND[d.kind]}“${quote(d.thing, 40)}”到最后才第一次出现`,
      detail: `它第一次出现在 ${line(d.firstRef!)}，也就是结尾这一行。结尾依赖的东西要先让观众看见，用的时候才成立；最后一刻才冒出来，像是临时变出来的。`,
      fix: '让它在更早的一场或同一场的前面先露一次面。'});
  }
  for (const s of ledger.setups) if (!s.payoffRef && !s.bearsOnEnding) out.push({id: `dead_setup:${s.ref}:${quote(s.thing, 40)}`, kind: 'dead_setup', ref: s.ref,
    title: `“${quote(s.thing, 40)}”埋下了，后来没用上`,
    detail: `${line(s.ref)} 抛出了它，之后正文再没用到，它也不指向结尾的问题（${quote(ledger.ending.question, 60)}）。观众会等它的下文，结果什么都没有。`,
    fix: '要么删掉，要么让它在后面派上用场，或者让它指向结尾的那个问题。'});
  for (const s of ledger.instructions) if (!s.reasonRef) out.push({id: `unexplained:${s.ref}`, kind: 'unexplained_instruction', ref: s.ref,
    title: `“${quote(s.text, 50)}”没有理由`,
    detail: `${line(s.ref)} 里的要求不合常理，正文里没人给出理由，人物也没问。观众会卡在这里。`,
    fix: '加半句理由（台词就行），或者让人物追问一句。'});
  for (const s of ledger.sightings) if (s.visible !== 'yes') out.push({id: `unseen:${s.ref}`, kind: 'unseen', ref: s.ref,
    title: `${s.who} 在那个位置${s.visible === 'no' ? '看不到' : '不一定看得到'}“${quote(s.what, 40)}”`,
    detail: `${line(s.ref)}：${s.why}`,
    fix: '把东西挪到她看得见的地方，或者让她走过去、凑近看。'});
  if (!ledger.choices.length) out.push({id: 'no_choice', kind: 'no_choice', ref: ledger.ending.ref,
    title: `${ledger.protagonist} 整集没有做过一个有代价的选择`,
    detail: `${ledger.protagonist} 一直在走路、看手机、照吩咐做事，推动剧情的都是别人或消息。主角不做选择，观众就不会替她着急。`,
    fix: `给 ${ledger.protagonist} 一个要付代价的决定，比如冒着罚款或风险做一件规定之外的事。`});
  if (ledger.blocking) out.push(...foldBlocking(ledger.blocking, revision, index).findings);
  // Common sense: a thing is where it is, placed the way it is, for a reason an ordinary viewer accepts.
  for (const p of ledger.premises ?? []) {
    const unexplained = !p.common && !p.reasonRef;
    if (p.plausible === 'yes' && !unexplained) continue;
    out.push({id: `implausible:${p.ref}:${quote(p.name, 40)}`, kind: 'implausible', ref: p.ref,
      title: p.plausible === 'no' ? `“${quote(p.name, 30)}”${quote(p.placement, 40)}，不合常理` : `“${quote(p.name, 30)}”为什么${quote(p.placement, 40)}，正文没交代`,
      detail: `${line(p.ref)}：${p.why}${p.placedBy ? `（放的人：${p.placedBy}）` : ''}${unexplained && p.plausible === 'yes' ? ' 观众不会自然想到它会这样放着，正文也没给理由。' : ''}`,
      fix: p.plausible === 'no' ? '换一个符合这个人意图的放法或地点（要藏的东西藏起来，要用的东西放在手边），或者加一句让观众信服的理由。' : '加半句理由（台词或动作），或者改成观众一看就懂的放法。'});
  }
  for (const c of ledger.conduct ?? []) {
    const unexplained = !c.common && !c.reasonRef;
    if (c.plausible === 'yes' && !unexplained) continue;
    out.push({id: `unmotivated:${c.ref}:${quote(c.who, 20)}`, kind: 'unmotivated', ref: c.ref,
      title: c.plausible === 'no' ? `${c.who} “${quote(c.action, 40)}”，不合常理或做不到` : `${c.who} 为什么“${quote(c.action, 40)}”，正文没交代`,
      detail: `${line(c.ref)}：${c.why}`,
      fix: '让这个做法有看得见的理由（他想要什么、怕什么），或者改成这个人在这种处境下会做的事。'});
  }
  const order = (f: LogicFinding) => { const r = index.at(f.ref); return r ? r.scene * 10_000 + r.line : 1e9; };
  return out.sort((a, b) => order(a) - order(b));
}

/** Findings of independent passes over the same script, merged by kind and line: every break any pass found, once,
 * with `seen` saying how many passes found it. The first pass's wording and ledger are kept. */
export function mergePasses(ledgers: LogicLedger[], revision: Pick<Revision, 'scenes'>): {ledger: LogicLedger; findings: LogicFinding[]} {
  const per = ledgers.map(l => logicFindings(l, revision)), slot = (f: LogicFinding) => `${f.kind}@${f.ref}`;
  if (per.length < 2) return {ledger: ledgers[0]!, findings: per[0] ?? []};
  const seen = (f: LogicFinding) => per.filter(list => list.some(g => slot(g) === slot(f))).length;
  const out: LogicFinding[] = [], taken = new Set<string>();
  // A later pass adds only the lines and kinds no earlier pass reported, so one break is listed once.
  for (const list of per) {
    for (const f of list) if (!taken.has(slot(f))) out.push({...f, seen: seen(f)});
    for (const f of list) taken.add(slot(f));
  }
  const index = lineIndex(revision), order = (f: LogicFinding) => { const r = index.at(f.ref); return r ? r.scene * 10_000 + r.line : 1e9; };
  return {ledger: ledgers[0]!, findings: out.sort((a, b) => order(a) - order(b))};
}

/** Reasons the author gave in the previous check of the same revision, for the findings that are still there. A finding
 * keeps its reason by ID, or, since the model words a fact differently each run, by the same kind and line when exactly
 * one old and one new finding share them. */
export function carryKept(previous: LogicCheck[], findings: LogicFinding[], lines?: {revisionId: string; text(revisionId: string, ref: string): string}): Record<string, {reason: string; at: string}> {
  const kept: Record<string, {reason: string; at: string}> = {};
  // A finding's place is its line: by reference within the revision, by the line's words across revisions, so a
  // reason follows the unchanged line of a parent revision and never a line whose words changed.
  const slot = (revisionId: string, f: Pick<LogicFinding, 'kind' | 'ref'>) => lines ? `${f.kind}@${lines.text(revisionId, f.ref).trim()}` : `${f.kind}@${f.ref}`;
  const count = (revisionId: string, list: LogicFinding[]) => list.reduce((m, f) => m.set(slot(revisionId, f), (m.get(slot(revisionId, f)) ?? 0) + 1), new Map<string, number>());
  const target = lines?.revisionId ?? '', newCount = count(target, findings);
  // Newest check first, so the latest reason wins; a reason from an older check fills a finding a newer one lost.
  for (const check of [...previous].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const oldCount = count(check.revisionId, check.findings), same = !lines || check.revisionId === lines.revisionId;
    for (const [fid, reason] of Object.entries(check.kept ?? {})) {
      const old = check.findings.find(f => f.id === fid), at = old && slot(check.revisionId, old);
      const match = (same ? findings.find(f => f.id === fid) : undefined)
        ?? (old && !at!.endsWith('@') && oldCount.get(at!) === 1 && newCount.get(at!) === 1 ? findings.find(f => slot(target, f) === at) : undefined);
      if (match && !kept[match.id]) kept[match.id] = reason;
    }
  }
  return kept;
}

/** The latest valid check of this revision. */
export const latestLogicCheck = (checks: LogicCheck[] | undefined, revisionId: string): LogicCheck | undefined =>
  // Demo checks come only from the prepared ledger of the unmodified example, so they count like live ones.
  (checks ?? []).filter(c => c.revisionId === revisionId && c.mode !== 'manual').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

export type LogicGate = {passed: true; check: LogicCheck} | {passed: false; reason: 'not_accepted' | 'missing' | 'open'; message: string; check?: LogicCheck; open?: LogicFinding[]};

/** Script before video: shot lists and video need the accepted revision's logic check with every finding kept by the author. */
export function logicGate(episode: Pick<Episode, 'acceptedRevisionId' | 'needsReview'>, checks: LogicCheck[] | undefined): LogicGate {
  if (!episode.acceptedRevisionId || episode.needsReview) return {passed: false, reason: 'not_accepted', message: '先把剧本捋顺：本集还没有采用定稿，或前面的改动需要复核。'};
  const check = latestLogicCheck(checks, episode.acceptedRevisionId);
  if (!check) return {passed: false, reason: 'missing', message: '先把剧本捋顺：定稿还没做“剧本逻辑检查”。请在审读页运行它，逐条处理后再做分镜和视频。'};
  const open = check.findings.filter(f => !check.kept?.[f.id]);
  if (open.length) return {passed: false, reason: 'open', check, open, message: `先把剧本捋顺：剧本逻辑检查还有 ${open.length} 个问题没处理（${open.slice(0, 3).map(f => f.title).join('；')}${open.length > 3 ? '……' : ''}）。改稿后重新检查，或在审读页对每一条写明保留的理由。`};
  return {passed: true, check};
}
