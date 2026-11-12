/** Whole-script revision from the logic check's findings, after Dramaturge's coordinated revision: one plan that
 * fixes the findings together across scenes, then the full script. Server-only. */
import type { LogicFinding, Revision } from '../types';
import { craftGuidance, lineFormatReminder, studioIntro } from './formatPrompts';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const REVISE_GUIDANCE = `
你是改稿编剧。user.findings 是程序从这一版剧本里查出的逻辑断点，每条有位置（场景编号:行号）、问题和修改方向。你的任务是一次改好整份剧本，让这些断点都接上，同时不制造新的断点。
先想整体，再动局部：
1. plan：先写改法。几条问题常常是同一个根子（比如场外人物知道得太多、结尾道具来得太晚），能用一处改动同时解决的，合在一起改。每项写清解决哪几条（findings 用编号）、怎么改、改哪几场。
2. 改完后逐条自查：场外人物说出的每件事，前面是否有她能知道的来源（她收到的照片、电话、别人的话）；结尾用到的道具、规则、人物关系，是否在结尾之前已经出现在画面或台词里；抛出的线索是否用上或指向结尾的问题，用不上就删；不合常理的要求是否给了半句理由；人物“看见”的东西在她的位置是否看得见；主角是否亲自做了一个要付代价、改变后面发生什么的选择。
3. 保留作者的设定、人物、场景编号和顺序、整体篇幅和结尾留下的问题方向。locked 为 true 的场景一字不改。不新增人物和支线，不用旁白交代，不把解释塞进长台词。
`.trim();

export function buildReviseMessages(revision: Revision, findings: LogicFinding[], note?: string): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief, language = scriptLanguage(revision);
  const format = '{"plan":[{"findings":["问题编号"],"change":"中文说明怎么改","scenes":["s1"]}],"title":"本集名","logline":"一句话梗概","scenes":[{"id":"s1","heading":"场景标题","content":"改好的整场正文"}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, language)}\n${craftGuidance(brief)}\n${REVISE_GUIDANCE}\n输出格式：${format}。scenes 按原顺序列出全部场景，包括没改的场景。${lineFormatReminder(brief)}`},
    {role: 'user', content: JSON.stringify({
      task: '按剧本逻辑检查的结果，整体修改这一版剧本。',
      ...(note ? {authorNote: note} : {}),
      brief: {premise: brief.premise, characters: brief.characters, worldRules: brief.worldRules, authorRules: brief.authorRules, ...(brief.durationTarget ? {durationTarget: brief.durationTarget} : {})},
      findings: findings.map(f => ({id: f.id, where: f.ref, problem: `${f.title}。${f.detail}`, direction: f.fix})),
      script: {title: revision.title, logline: revision.logline, scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, locked: s.locked, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))}))},
    })},
  ];
}

export interface RevisePlanItem { findings: string[]; change: string; scenes: string[] }
/** The plan part of a revision answer: what changes where, for which findings. */
export function parseRevisePlan(value: unknown, findingIds: Set<string>, sceneIds: Set<string>): RevisePlanItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('改稿结果需要 1–20 项改法（plan）。');
  return value.map((item, i) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const change = typeof row.change === 'string' && row.change.trim() && row.change.length <= 600 ? row.change.trim() : (() => { throw new Error(`第 ${i + 1} 项改法缺少说明。`); })();
    const ids = Array.isArray(row.findings) ? row.findings.filter((x): x is string => typeof x === 'string' && findingIds.has(x)) : [];
    const scenes = Array.isArray(row.scenes) ? row.scenes.filter((x): x is string => typeof x === 'string' && sceneIds.has(x)) : [];
    return {findings: [...new Set(ids)], change, scenes: [...new Set(scenes)]};
  });
}
