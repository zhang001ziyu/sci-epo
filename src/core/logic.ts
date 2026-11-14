/** Script logic check: the model fills a ledger (who knows what and from where, what the ending depends on, which
 * setups pay off, which instructions lack a reason, what a character could not see, which choices cost the
 * protagonist something), and the program decides the findings from it. Shot lists and video need every finding of
 * the accepted revision to be fixed in a new revision or kept by the author with a reason. Browser-safe. */
import type { Episode, LogicCheck, LogicFinding, LogicLedger, Revision } from '../types';
import { foldBlocking, parseBlocking } from './blocking';
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
export function parseLedger(value: unknown, revision: Pick<Revision, 'scenes'>): LogicLedger {
  const row = record(value, '逻辑检查'), index = lineIndex(revision);
  const ref = (v: unknown, label: string): string => typeof v === 'string' && index.at(v) ? v : reject(`${label}的行号 ${String(v)} 不在剧本里，应写成“场景编号:行号”，例如 s1:3。`);
  const optRef = (v: unknown, label: string): string | null => v === null || v === undefined || v === '' ? null : ref(v, label);
  const offscreen = list(row.offscreen, '场外人物', 20).map((item, i) => {
    const o = record(item, `第 ${i + 1} 个场外人物`);
    return {character: text(o.character, '场外人物的名字', 60), messageRef: ref(o.messageRef, '场外人物的消息'),
      claims: list(o.claims, '消息里的信息', 12).map((c, j) => {
        const x = record(c, `第 ${j + 1} 条信息`), kind = x.sourceKind;
        if (!['self', 'present', 'told', 'sees', 'earlier', 'brief', 'none'].includes(kind as string)) reject('信息来源只能是 self、present、told、sees、earlier、brief 或 none。');
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
  try { blocking = row.blocking === undefined || row.blocking === null ? undefined : parseBlocking(row.blocking, ref); }
  catch (error) { return reject(error instanceof Error ? error.message : '走位格式无效。'); }
  return {protagonist, offscreen, ending, setups, instructions, sightings, choices, ...(blocking ? {blocking} : {})};
}

export function parseLedgerOutput(raw: string, revision: Pick<Revision, 'scenes'>): LogicLedger {
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); } catch { return reject('模型输出不是完整的 JSON。'); }
  return parseLedger(value, revision);
}

const quote = (t: string, max = 80) => { const s = t.trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** The findings the program draws from a ledger, in the order of the script. */
export function logicFindings(ledger: LogicLedger, revision: Pick<Revision, 'scenes'>): LogicFinding[] {
  const index = lineIndex(revision), out: LogicFinding[] = [];
  const at = (ref: string) => index.at(ref)!, line = (ref: string) => `“${quote(index.text(ref))}”（${ref}）`;
  for (const o of ledger.offscreen) for (const c of o.claims) {
    const source = c.sourceRef ? at(c.sourceRef) : undefined, message = at(o.messageRef);
    const missing = c.sourceKind === 'none' || (c.sourceKind !== 'brief' && c.sourceKind !== 'self' && (!source || !index.before(source, message)));
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
  const order = (f: LogicFinding) => { const r = index.at(f.ref); return r ? r.scene * 10_000 + r.line : 1e9; };
  return out.sort((a, b) => order(a) - order(b));
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
