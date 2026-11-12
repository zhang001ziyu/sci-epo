/** The script logic check on the review tab: run it, read each finding in plain words, send it to the rewrite box,
 * or keep it with a reason. Shot lists and video wait until every finding of the accepted script is settled. */
import type { Episode, LogicCheck, LogicFinding, ProjectBundle, Revision } from '../src/types';
import { latestLogicCheck, logicGate } from '../src/core/logic';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const KIND: Record<LogicFinding['kind'], string> = {offscreen_knowledge: '场外人物知道了不该知道的事', ending_unstated: '结尾靠的东西没在正文里交代', ending_late: '结尾靠的东西最后才出现', dead_setup: '埋下的东西没用上', unexplained_instruction: '要求没有理由', unseen: '位置上看不到', no_choice: '主角没有做选择'};

/** Reasons typed for keeping a finding, by finding ID, until they are saved. */
export const keepDrafts = new Map<string, string>();

export function logicView(o: {bundle: ProjectBundle; revision: Revision; episode: Episode; busy: boolean; live: boolean; dirty: boolean}): string {
  const {bundle, revision, episode} = o, check = latestLogicCheck(bundle.logicChecks, revision.id);
  const accepted = episode.acceptedRevisionId === revision.id && !episode.needsReview;
  const gate = logicGate(episode, bundle.logicChecks);
  const disabled = (c = false) => o.busy || c ? 'disabled' : '';
  const run = `<button class="button ${check ? 'subtle' : 'primary'}" data-action="logic-run" ${disabled(!o.live || o.dirty)}>${check ? '重新检查这一版' : '检查这一版的剧本逻辑'}</button>`;
  const intro = '<p class="small muted">拍视频之前，先把剧本的逻辑捋顺。这一步逐条核对：场外人物知道的事有没有来源；结尾靠的道具和人物关系有没有提前交代；埋下的东西有没有用上；不合常理的要求有没有理由；人物在那个位置看不看得到；主角有没有做过要付代价的选择。每一条要么改稿解决，要么写明为什么保留。全部处理完，分镜和视频才能开始。</p>';
  const state = !accepted ? '<p class="small">这一版还不是本集的定稿。可以先检查，改好后在剧本页采用；分镜和视频只认已采用的定稿。</p>'
    : gate.passed ? `<div class="inline-success" role="status">剧本逻辑已经捋顺${gate.check.findings.length ? `：${gate.check.findings.length} 个问题都写明了保留的理由` : '，没有发现断开的地方'}。可以去做分镜了。</div>`
    : `<div class="inline-warning" role="status">${esc(gate.message)}</div>`;
  if (!check) return `<section class="logic-panel"><div class="bible-head"><h3>剧本逻辑检查</h3><div class="header-actions">${run}</div></div>${intro}${state}${!o.live ? '<p class="small muted">需要真实模型。</p>' : ''}</section>`;
  const rows = check.findings.map(f => findingView(check, f, disabled())).join('');
  const openCount = check.findings.filter(f => !check.kept?.[f.id]).length;
  const revise = openCount ? `<div class="language-toolbar"><button class="button primary" data-action="logic-revise" ${disabled(!o.live || o.dirty)}>按这 ${openCount} 条整体改稿</button><span class="small muted">一次看全剧本，把相关的问题合在一起改（不是一场一场地改），改完自动再检查一遍。结果另存为新版本，不会自动采用；你对比后再决定。</span></div>` : '';
  return `<section class="logic-panel"><div class="bible-head"><h3>剧本逻辑检查 <span class="small muted">${esc(new Date(check.createdAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}))}</span></h3><div class="header-actions">${run}</div></div>${intro}${state}`
    + `${revise}${check.findings.length ? `<ol class="logic-findings">${rows}</ol>` : '<p>没有发现断开的地方。</p>'}`
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
