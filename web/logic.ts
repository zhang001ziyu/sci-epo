/** The script logic check on the review tab: run it, read each finding in plain words, send it to the rewrite box,
 * or keep it with a reason. Shot lists and video wait until every finding of the accepted script is settled. */
import type { Episode, LogicCheck, LogicFinding, ProjectBundle, Revision } from '../src/types';
import { latestLogicCheck, logicGate } from '../src/core/logic';
import { scriptLines } from '../src/core/scriptLines';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const KIND: Record<LogicFinding['kind'], string> = {offscreen_knowledge: '场外人物知道了不该知道的事', ending_unstated: '结尾靠的东西没在正文里交代', ending_late: '结尾靠的东西最后才出现', dead_setup: '埋下的东西没用上', unexplained_instruction: '要求没有理由', unseen: '位置上看不到', no_choice: '主角没有做选择', out_of_reach: '够不着，也没走过去', not_holding: '手里没有这样东西', no_move: '位置或姿势变了，没有动作'};
const POSTURE: Record<string, string> = {standing: '站着', sitting: '坐着', lying: '躺着', kneeling: '跪着'};

/** The blocking the check read from the script, action by action, so the author can see where each person is. */
function blockingView(check: LogicCheck, revision: Revision): string {
  const b = check.ledger.blocking;
  if (!b) return '<p class="small muted">这次检查没有记录走位（是加入走位检查之前做的）。重新检查一次，就能核对人物位置和手里的东西。</p>';
  const zone = (id: string | null) => id ? b.zones.find(z => z.id === id)?.name ?? id : '';
  const thing = (id: string | null) => id ? b.things.find(t => t.id === id)?.name ?? id : '';
  const lines = new Map(revision.scenes.map(s => [s.id, scriptLines(s.content)]));
  const says = (e: NonNullable<LogicCheck['ledger']['blocking']>['events'][number]) => ({
    at: `在${zone(e.zone) || '？'}${e.posture ? `，${POSTURE[e.posture]}` : ''}`, move: `走到${zone(e.zone)}`, stand: '站起来', sit: `坐下${e.zone ? `（${zone(e.zone)}）` : ''}`,
    take: `拿起“${thing(e.thing)}”`, put: `放下“${thing(e.thing)}”${e.zone ? `到${zone(e.zone)}` : ''}`, give: `把“${thing(e.thing)}”递给 ${e.to ?? ''}`,
    use: `对“${thing(e.thing)}”动手${e.with ? `（用“${thing(e.with)}”）` : ''}${e.state ? ` → ${e.state}` : ''}`,
  })[e.kind];
  const rows = b.events.map(e => { const [scene, n] = e.ref.split(':'); return `<tr><td>${esc(e.ref)}</td><td>${esc(lines.get(scene!)?.[Number(n) - 1] ?? '')}</td><td>${esc(e.who)}</td><td>${esc(says(e))}</td></tr>`; }).join('');
  const start = b.things.map(t => `${t.name}：${t.holder ? `${t.holder} 手里` : t.zone ? zone(t.zone) : '不明'}`).join('；');
  return `<details class="logic-blocking"><summary>走位和持物（${b.events.length} 个动作）</summary><p class="small muted">程序按这张表推算每一行开始时谁在哪、站着还是坐着、手里拿着什么，再写进每个视频片段的开场。表和正文对不上时，以正文为准：改正文后重新检查。</p>`
    + `<p class="small"><span class="label">区域</span>${esc(b.zones.map(z => z.name).join('、') || '无')}</p><p class="small"><span class="label">东西一开始在哪</span>${esc(start || '无')}</p>`
    + `<table class="logic-blocking-table"><thead><tr><th>行</th><th>正文</th><th>人物</th><th>动作</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

/** Reasons typed for keeping a finding, by finding ID, until they are saved. */
export const keepDrafts = new Map<string, string>();

export function logicView(o: {bundle: ProjectBundle; revision: Revision; episode: Episode; busy: boolean; live: boolean; dirty: boolean}): string {
  const {bundle, revision, episode} = o, check = latestLogicCheck(bundle.logicChecks, revision.id);
  const accepted = episode.acceptedRevisionId === revision.id && !episode.needsReview;
  const gate = logicGate(episode, bundle.logicChecks);
  const disabled = (c = false) => o.busy || c ? 'disabled' : '';
  const run = `<button class="button ${check ? 'subtle' : 'primary'}" data-action="logic-run" ${disabled(!o.live || o.dirty)}>${check ? '重新检查这一版' : '检查这一版的剧本逻辑'}</button>`;
  const intro = '<p class="small muted">拍视频之前，先把剧本的逻辑捋顺。这一步逐条核对：场外人物知道的事有没有来源；结尾靠的道具和人物关系有没有提前交代；埋下的东西有没有用上；不合常理的要求有没有理由；人物在那个位置看不看得到；对东西动手时够不够得着、有没有走过去、手里有没有那样东西；主角有没有做过要付代价的选择。每一条要么改稿解决，要么写明为什么保留。全部处理完，分镜和视频才能开始。</p>';
  const state = !accepted ? '<p class="small">这一版还不是本集的定稿。可以先检查，改好后在剧本页采用；分镜和视频只认已采用的定稿。</p>'
    : gate.passed ? `<div class="inline-success" role="status">剧本逻辑已经捋顺${gate.check.findings.length ? `：${gate.check.findings.length} 个问题都写明了保留的理由` : '，没有发现断开的地方'}。可以去做分镜了。</div>`
    : `<div class="inline-warning" role="status">${esc(gate.message)}</div>`;
  if (!check) return `<section class="logic-panel"><div class="bible-head"><h3>剧本逻辑检查</h3><div class="header-actions">${run}</div></div>${intro}${state}${!o.live ? '<p class="small muted">需要真实模型。</p>' : ''}</section>`;
  const rows = check.findings.map(f => findingView(check, f, disabled())).join('');
  const openCount = check.findings.filter(f => !check.kept?.[f.id]).length;
  const revise = openCount ? `<div class="language-toolbar"><button class="button primary" data-action="logic-revise" ${disabled(!o.live || o.dirty)}>按这 ${openCount} 条整体改稿</button><span class="small muted">一次看全剧本，把相关的问题合在一起改（不是一场一场地改），改完自动再检查一遍。结果另存为新版本，不会自动采用；你对比后再决定。</span></div>` : '';
  return `<section class="logic-panel"><div class="bible-head"><h3>剧本逻辑检查 <span class="small muted">${esc(new Date(check.createdAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}))}</span></h3><div class="header-actions">${run}</div></div>${intro}${state}`
    + `${revise}${check.findings.length ? `<ol class="logic-findings">${rows}</ol>` : '<p>没有发现断开的地方。</p>'}${blockingView(check, revision)}`
    + '<p class="small muted">改稿后会生成新版本：在剧本页采用新版本，再回到这里重新检查。同一个问题如果还在，之前写的保留理由会沿用。</p></section>';
}

function findingView(check: LogicCheck, f: LogicFinding, disabled: string): string {
  const kept = check.kept?.[f.id], id = esc(f.id);
  const actions = kept
    ? `<p class="small">你选择保留：${esc(kept.reason)}</p><button class="text-button" data-action="logic-unkeep" data-check="${esc(check.id)}" data-id="${id}" ${disabled}>撤销保留</button>`
    : `<div class="language-toolbar"><button class="button small-button" data-action="logic-use" data-id="${id}" data-scene="${esc(f.ref.split(':')[0])}" ${disabled}>带入改稿</button>`
      + `<label class="sr-only" for="logic-reason-${id}">保留的理由</label><input id="logic-reason-${id}" data-logic-reason="${id}" maxlength="300" placeholder="不改的话，写一句为什么保留" value="${esc(keepDrafts.get(f.id) ?? '')}" ${disabled}/>`
      + `<button class="button subtle small-button" data-action="logic-keep" data-check="${esc(check.id)}" data-id="${id}" ${disabled}>保留</button></div>`;
  return `<li class="logic-finding ${kept ? 'kept' : ''}"><span class="pill ${kept ? '' : 'changed'}">${esc(KIND[f.kind])}</span><strong>${esc(f.title)}</strong><p>${esc(f.detail)}</p><p class="small"><span class="label">怎么改</span>${esc(f.fix)}</p>${actions}</li>`;
}

/** The rewrite instruction a finding sends to the rewrite box. */
export const findingInstruction = (f: LogicFinding) => `${f.title}。${f.detail} 修改方向：${f.fix} 只改这一场，不改其他场景发生的事。`;
