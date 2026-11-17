/** Whole-script revision from the logic check's findings, after Dramaturge's coordinated revision: one plan that
 * fixes the findings together across scenes, then the full script. Server-only. */
import type { LogicFinding, LogicLedger, ReviseContext, Revision } from '../types';
import { craftGuidance, lineFormatReminder, studioIntro } from './formatPrompts';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const REVISE_GUIDANCE = `
你是改稿编剧。user.findings 是程序从这一版剧本里查出的逻辑断点，每条有位置（场景编号:行号）、问题和修改方向。你的任务是一次改好整份剧本，让这些断点都接上，同时不制造新的断点。
先想整体，再动局部：
1. plan：先写改法。几条问题常常是同一个根子（比如场外人物知道得太多、结尾道具来得太晚），能用一处改动同时解决的，合在一起改。每项写清解决哪几条（findings 用编号）、怎么改、改哪几场。
2. 改完后逐条自查：场外人物说出的每件事，前面是否有她能知道的来源（她收到的照片、电话、别人的话）；结尾用到的道具、规则、人物关系，是否在结尾之前已经出现在画面或台词里；抛出的线索（人物注意到、拿起、说到的东西）是否用上或指向结尾的问题，用不上就删；不合常理的要求是否给了半句理由；人物“看见”的东西在她的位置是否看得见；人物对东西动手时是否就在它旁边，不在旁边时是否写了他走过去；用的东西是否在他手里；位置、姿势的每次变化是否都有一行动作；每样东西的放法是否符合放它的人的意图和常识，人物的关键做法是否有他自己的理由；主角是否亲自做了一个要付代价、改变后面发生什么的选择。补走位时加一行简短的动作描写就够，不要改动作的结果。
改动场外人物的消息时，保留她知道每件事的来源（比如“他发短信告诉我”），不要为了改别的地方把原有的来源删掉；新加的信息也要给出来源。
3. 改得越少越好。优先用已经出现过的人物、东西和台词去解决问题；不要为了交代一件事或补一条问题，凭空加照片、便条、遗像、标语、日记这类道具，除非放它的人本来就有理由把它放在那里。新加的每样东西和每个动作，都要同样符合常识和动机，不能制造新的问题。
4. 每个动作在物理上要做得到：手、身体和东西的位置要对得上（东西在墙上或竖着的面上，就不能把它压在台面上；一只手拿着东西，就只剩一只手可用）；改动作时照 user.facts 里每样东西现在的位置和放法写，不要让东西换地方。
5. user.facts.resolved 是这个剧本之前几轮已经改好的问题，改稿时不能让它们再出现。
6. 保留作者的设定、人物、场景编号和顺序、整体篇幅和结尾留下的问题方向。locked 为 true 的场景一字不改。不新增人物和支线，不用旁白交代，不把解释塞进长台词。
`.trim();

/** Facts from the check a revision must keep: each place's layout, where each thing is, and fixed problems. */
export function reviseFacts(ledger: LogicLedger, resolved: string[]): ReviseContext {
  const b = ledger.blocking, zone = (id: string | null) => id ? b?.zones.find(z => z.id === id)?.name ?? id : '';
  return {
    layout: (b?.sets ?? []).map(s => `${s.name}（${s.scenes.join('、')}）：${s.en}`),
    things: (b?.things ?? []).map(t => `${t.name}：${t.holder ? `在 ${t.holder} 手里` : [zone(t.zone), t.placement ?? ''].filter(Boolean).join('，') || '位置未写'}`),
    resolved,
  };
}

export function buildReviseMessages(revision: Revision, findings: LogicFinding[], note?: string, facts?: ReviseContext): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief, language = scriptLanguage(revision);
  const format = '{"plan":[{"findings":["问题编号"],"change":"中文说明怎么改","scenes":["s1"]}],"title":"本集名","logline":"一句话梗概","scenes":[{"id":"s1","heading":"场景标题","content":"改好的整场正文"}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, language)}\n${craftGuidance(brief)}\n${REVISE_GUIDANCE}\n输出格式：${format}。scenes 按原顺序列出全部场景，包括没改的场景。${lineFormatReminder(brief)}`},
    {role: 'user', content: JSON.stringify({
      task: '按剧本逻辑检查的结果，整体修改这一版剧本。',
      ...(note ? {authorNote: note} : {}),
      brief: {premise: brief.premise, characters: brief.characters, worldRules: brief.worldRules, authorRules: brief.authorRules, ...(brief.durationTarget ? {durationTarget: brief.durationTarget} : {})},
      findings: findings.map(f => ({id: f.id, where: f.ref, problem: `${f.title}。${f.detail}`, direction: f.fix})),
      ...(facts ? {facts} : {}),
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
