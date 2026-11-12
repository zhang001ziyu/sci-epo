/** Version 2 render batches in the production tab: the job grid, the review of takes and render sessions.
 * Pure view helpers; ProductionPanel owns the state and the requests. Every displayed value is escaped.
 * Elements marked data-live hold no text inputs, so a polling refresh can replace them while the author types. */
import type { Caption, Cut, CutSettings, CutSize, MediaAsset, ProductionProfile, PublicRenderSession, QaCheck, RenderBatch, RenderJobV2, RenderSession, RetakeReason, SessionEnd, SessionEvent, Take, TakeQa } from '../src/types';
import { CUT_SETTING_RANGES } from '../src/core/cut';
import { framesToSeconds } from '../src/core/h3';
import { languageName } from '../src/core/languages';
import { formatBytes } from '../src/core/mediaKinds';
import { normalizeSpeakerName } from '../src/core/scriptLines';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
const clock = (value: string) => new Date(value).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const GB = 1024 ** 3;
const size = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : formatBytes(bytes);
export const mediaUrl = (assetId: string) => `/api/media/${encodeURIComponent(assetId)}`;

export const SESSION_NOTEBOOK = 'https://colab.research.google.com/github/zhang001ziyu/sci-epo/blob/main/worker/colab/sciepo_session.ipynb';
export const TAKE_STATUS: Record<Take['status'], string> = {queued: '排队中', claimed: '渲染中', rendered: '已渲染', failed: '失败'};
const STATUS_CLASS: Record<Take['status'], string> = {queued: '', claimed: '', rendered: 'accepted', failed: 'changed'};
export const QA_STATUS: Record<QaCheck['status'], string> = {pass: '通过', warning: '提醒', failure: '失败'};
const QA_LABELS: Record<string, string> = {duration: '时长', size: '尺寸', frame_rate: '帧率', audio: '音轨', loudness: '响度', silence: '静音', line: '台词'};
const SEVERITY: Record<QaCheck['status'], number> = {failure: 0, warning: 1, pass: 2};
export const RETAKE_REASONS: readonly (readonly [RetakeReason, string])[] = [['picture_broken', '画面旋转或损坏'], ['character_drift', '人物不一致'], ['line_wrong', '台词缺失或错误'], ['lip_sync', '口型不对'], ['garbled_text', '文字乱码'], ['other', '其他']];
const REASON_LABELS = Object.fromEntries(RETAKE_REASONS) as Record<RetakeReason, string>;
export const SESSION_STATUS: Record<RenderSession['status'], string> = {waiting: '等待工作机连接', connected: '工作机已连接', setting_up: '正在准备环境', rendering: '正在渲染', finishing: '正在收尾', ended: '已结束', lost: '失去联系', expired: '已过期'};
export const SESSION_END: Record<SessionEnd, string> = {queue_empty: '待渲染的 take 都处理完了', budget: '到了时间预算', stopped: '按你的要求停止', not_current: '批次已不是当前制作版本', failures: '连续两条 take 失败', error: '工作机出错', lost: '工作机失去联系', expired: '会话码过期'};
const STAGES: Record<string, string> = {connected: '已连接', gpu: '检查 GPU', installing: '安装', downloading: '下载模型', starting_comfyui: '启动 ComfyUI', ready: '准备就绪', rendering: '渲染', checking: '质检', uploading: '上传', finishing: '收尾', take_done: 'take 完成', error: '出错'};
const LIVE = new Set<RenderSession['status']>(['waiting', 'connected', 'setting_up', 'rendering', 'finishing', 'lost']);

/** True while a session can still change: the worker may connect, render or come back. */
export const isLiveSession = (session: Pick<RenderSession, 'status'>) => LIVE.has(session.status);
const checkLabel = (check: QaCheck) => QA_LABELS[check.id] ?? check.id;

/** The check with the worst status, failures first. */
export function worstCheck(take: Take | undefined): QaCheck | undefined {
  return take?.qa?.checks.reduce<QaCheck | undefined>((worst, check) => !worst || SEVERITY[check.status] < SEVERITY[worst.status] ? check : worst, undefined);
}

/** Technical results count takes; the author's verdicts count approvals per job and retakes asked. */
export function takeCounts(jobs: RenderJobV2[]) {
  const takes = jobs.flatMap(j => j.takes), latest = jobs.map(j => j.takes.at(-1));
  return {
    jobs: jobs.length,
    rendered: takes.filter(t => t.status === 'rendered').length,
    qaFailed: takes.filter(t => t.status === 'rendered' && !!t.qa?.checks.some(c => c.status === 'failure')).length,
    failed: takes.filter(t => t.status === 'failed').length,
    queued: latest.filter(t => t?.status === 'queued').length,
    rendering: latest.filter(t => t?.status === 'claimed').length,
    approved: jobs.filter(j => j.approvedTake !== undefined).length,
    retakes: takes.filter(t => t.verdict?.decision === 'retake').length,
  };
}

export function countsView(batchId: string, jobs: RenderJobV2[]): string {
  const c = takeCounts(jobs);
  return `<div class="take-counts" data-live="counts-${esc(batchId)}"><span class="small"><strong>渲染结果</strong> 已渲染 ${c.rendered} 条 · 质检失败 ${c.qaFailed} 条 · 渲染失败 ${c.failed} 条 · 排队 ${c.queued} · 渲染中 ${c.rendering}</span><span class="small"><strong>你的决定</strong> 已通过 ${c.approved}/${c.jobs} · 要求重拍 ${c.retakes} 次</span></div>`;
}

/** What the series uses now that this batch does not, so an old batch says its references are outdated. */
export function referenceChanges(batch: Pick<RenderBatch, 'references'>, profile: ProductionProfile | undefined): string[] {
  const notes: string[] = [];
  for (const c of profile?.characters ?? []) {
    const key = normalizeSpeakerName(c.name);
    const now = [['image', c.portrait && c.usePortrait !== false ? c.portrait : undefined, '参考图'], ['audio', c.voiceSampleAsset, '声音样本']] as const;
    for (const [kind, ref, label] of now) {
      const used = (batch.references ?? []).find(r => r.kind === kind && normalizeSpeakerName(r.character) === key);
      if (used && used.sha256 !== ref?.sha256) notes.push(ref ? `${c.name} 的${label}已经换了，这一批仍用原来的。` : `${c.name} 现在不用${label}了，这一批仍在用。`);
      else if (!used && ref) notes.push(`${c.name} 现在有${label}，这一批没有用它。`);
    }
  }
  return notes;
}

function cellVerdict(job: RenderJobV2, latest: Take): string {
  if (job.approvedTake !== undefined) return `<span class="pill accepted">已通过${job.approvedTake !== latest.n ? ` · take ${esc(job.approvedTake)}` : ''}</span>`;
  const pending = latest.status === 'queued' || latest.status === 'claimed';
  if (latest.verdict?.decision === 'retake' || (pending && job.takes.at(-2)?.verdict?.decision === 'retake')) return '<span class="pill changed">要求重拍</span>';
  return latest.status === 'rendered' ? '<span class="small muted">等你审看</span>' : '';
}

/** One grid cell: the latest take, its worst check and the verdict. A job for several languages spans their columns. */
export function jobCell(job: RenderJobV2 | undefined, o: {span: number; selected: boolean; disabled: string}): string {
  const span = o.span > 1 ? ` colspan="${o.span}"` : '', latest = job?.takes.at(-1);
  if (!job || !latest) return `<td${span}>—</td>`;
  const worst = worstCheck(latest), thumb = latest.qa?.contactSheet;
  const shared = job.languages.length > 1 ? `<span class="small muted">${job.languages.map(l => esc(languageName(l))).join('、')} 共用一次渲染</span>` : '';
  return `<td${span} data-live="job-${esc(job.id)}"><button class="take-cell" data-action="production-review" data-id="${esc(job.id)}" aria-pressed="${o.selected}" ${o.disabled}>${thumb ? `<img class="take-thumb" src="${esc(mediaUrl(thumb))}" alt="" loading="lazy"/>` : ''}`
    + `<span><span class="pill ${STATUS_CLASS[latest.status]}">${esc(TAKE_STATUS[latest.status])}</span>take ${esc(latest.n)}${latest.rehearsal ? ' · 演练' : ''}</span>`
    + `${worst ? `<span class="small qa-${worst.status}">质检${esc(QA_STATUS[worst.status])}${worst.status === 'pass' ? '' : `：${esc(checkLabel(worst))}`}</span>` : ''}${cellVerdict(job, latest)}`
    + `${latest.status === 'failed' && latest.error ? `<span class="small error-text">${esc(latest.error)}</span>` : ''}${shared}</button></td>`;
}

function verdictView(take: Take): string {
  const v = take.verdict;
  if (!v) return '';
  if (v.decision === 'approved') return `<span class="pill accepted">已通过</span><span class="small muted">${esc(date(v.at))}</span>`;
  return `<span class="pill changed">要求重拍</span><span class="small">${v.reasons.map(r => esc(REASON_LABELS[r] ?? r)).join('、')}${v.note ? ` · ${esc(v.note)}` : ''}</span>`;
}

function qaView(qa: TakeQa | undefined): string {
  if (!qa) return '<p class="small muted">还没有质检结果。</p>';
  const checks = [...qa.checks].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
  const list = checks.length
    ? `<ul class="qa-checks">${checks.map(c => `<li class="qa-${c.status}"><span class="qa-status">${esc(QA_STATUS[c.status])}</span><strong>${esc(checkLabel(c))}</strong><span>${esc(c.message)}</span>${c.value !== undefined ? `<span class="small muted">数值 ${esc(c.value)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="small muted">工作机没有报告质检项。</p>';
  const l = qa.loudness;
  return `<h4>质检</h4>${list}${l ? `<p class="small muted">响度 ${esc(l.integrated)} LUFS · 真峰值 ${esc(l.truePeak)} dBTP${l.range !== undefined ? ` · 响度范围 ${esc(l.range)} LU` : ''}</p>` : ''}`;
}

function speechView(qa: TakeQa | undefined): string {
  const speech = qa?.speech;
  if (!speech) return '';
  if (!speech.lines.length) return '<h4>台词核对</h4><p class="small muted">这一条没有要核对的台词。</p>';
  const rows = speech.lines.map(line => {
    const heard = line.heard.trim(), tone = !heard ? 'qa-failure' : line.score < 0.6 ? 'qa-warning' : 'qa-pass';
    return `<tr><td>${esc(line.sceneId)}·${esc(line.position)}${line.language ? ` · ${esc(languageName(line.language))}` : ''}</td><td>${esc(line.expected)}</td><td>${heard ? esc(line.heard) : '<span class="muted">没有识别到</span>'}</td><td class="${tone}">${esc(Math.round(line.score * 100))}%</td></tr>`;
  }).join('');
  return `<h4>台词核对${speech.language ? ` · 识别出的语言 ${esc(languageName(speech.language))}` : ''}</h4><div class="table-scroll"><table class="production-table speech-table"><thead><tr><th>场景·行</th><th>应为</th><th>识别到</th><th>匹配度</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** The shown take: video beside its facts, checks, lines and the decision; the contact sheet and keyframes below. */
function takeView(take: Take, decision: string): string {
  const qa = take.qa;
  const media = take.video
    ? `<video class="review-video" controls playsinline preload="metadata" src="${esc(mediaUrl(take.video.assetId))}" aria-label="take ${esc(take.n)} 的视频"></video>`
    : `<div class="review-placeholder"><strong>${esc(TAKE_STATUS[take.status])}</strong><span class="small muted">${take.status === 'failed' ? '这一条渲染失败，没有视频。' : '还没有视频。'}</span></div>`;
  const facts = [`take ${take.n}`, TAKE_STATUS[take.status], ...(take.video ? [`${take.video.seconds} 秒`, size(take.video.bytes)] : []), `种子 ${take.seed}`, ...(take.renderSeconds !== undefined ? [`渲染用了 ${Math.round(take.renderSeconds)} 秒`] : [])];
  const sheet = qa?.contactSheet ? `<figure class="contact-sheet"><img src="${esc(mediaUrl(qa.contactSheet))}" alt="take ${esc(take.n)} 的联系表" loading="lazy"/><figcaption class="small muted">联系表：每秒一帧，标出了镜头切换。</figcaption></figure>` : '';
  const keyframes = qa?.keyframes.length ? `<h4>每个镜头的关键帧</h4><div class="keyframes">${qa.keyframes.map(k => `<figure><img src="${esc(mediaUrl(k.assetId))}" alt="镜头 ${esc(k.shotId)} 的关键帧" loading="lazy"/><figcaption>${esc(k.shotId)}</figcaption></figure>`).join('')}</div>` : '';
  return `<div class="review-take"><div class="review-media">${media}</div><div class="review-facts"><p class="small">${facts.map(esc).join(' · ')}${take.rehearsal ? ' <span class="pill demo">演练</span>' : ''}</p>`
    + `${take.verdict ? `<p class="review-verdict">${verdictView(take)}</p>` : ''}${take.error ? `<p class="small error-text">${esc(take.error)}</p>` : ''}${qaView(qa)}${speechView(qa)}${decision}</div></div>${sheet}${keyframes}`;
}

export interface ReviewOptions { batch: RenderBatch; job: RenderJobV2; take?: number; current: boolean; disabled: string; reasons: ReadonlySet<RetakeReason>; note: string }

/** The review of one job: the shown take (the latest unless the author picked another), the decision and the other takes. */
export function reviewPanel(o: ReviewOptions): string {
  const {batch, job, disabled} = o, latest = job.takes.at(-1);
  if (!latest) return '';
  const shown = (o.take !== undefined ? job.takes.find(t => t.n === o.take) : undefined) ?? latest;
  const isLatest = shown.n === latest.n, clip = batch.clips.find(c => c.id === job.clipId), prompt = clip?.prompts[job.languages[0] ?? ''];
  // A polling refresh re-renders the whole tab only when this key changes, so a playing video and a typed note survive.
  const layout = ['review', job.id, shown.n, shown.status, shown.verdict?.decision ?? 'none', job.approvedTake ?? 'none', isLatest ? 'latest' : 'earlier', o.current ? 'current' : 'old'].join('-');
  const approve = shown.status !== 'rendered' ? ''
    : job.approvedTake === shown.n ? '<span class="pill accepted">这一条已通过</span>'
    : `<button class="button primary small-button" data-action="production-approve" data-id="${esc(job.id)}" data-take="${esc(shown.n)}" ${disabled}>通过这一条</button>`;
  const retake = !isLatest ? '<p class="small muted">重拍只针对最新的一条 take。</p>'
    : !o.current ? '<p class="small muted">这一批已不是当前制作版本，不能再重拍。</p>'
    : shown.status === 'queued' || shown.status === 'claimed' ? '<p class="small muted">这一条还在排队或渲染，完成后再决定。</p>'
    : `<fieldset class="retake-form"><legend>重拍</legend><div class="retake-reasons">${RETAKE_REASONS.map(([value, label]) => `<label class="check-label"><input type="checkbox" data-production-retake-reason="${value}" ${o.reasons.has(value) ? 'checked' : ''} ${disabled}/><span>${esc(label)}</span></label>`).join('')}</div>`
      + `<label class="field-label" for="retake-note-${esc(job.id)}">说明（可选）</label><textarea id="retake-note-${esc(job.id)}" rows="2" maxlength="500" data-production-retake-note placeholder="例如：第 2 个镜头里外套的颜色变了。" ${disabled}>${esc(o.note)}</textarea>`
      + `<div class="language-toolbar"><button class="button small-button" data-action="production-retake" data-id="${esc(job.id)}" ${disabled}>重拍</button><span class="small muted">用下一个种子排上一条新的 take，原来的保留。</span></div></fieldset>`;
  const others = job.takes.filter(t => t.n !== shown.n).reverse();
  const otherList = `<div class="review-takes" data-live="takes-${esc(job.id)}">${others.length ? `<h4>其他 take</h4><ul class="take-list">${others.map(t => `<li><strong>take ${esc(t.n)}</strong><span class="pill ${STATUS_CLASS[t.status]}">${esc(TAKE_STATUS[t.status])}</span>${t.rehearsal ? '<span class="pill demo">演练</span>' : ''}`
    + `${job.approvedTake === t.n ? '<span class="pill accepted">已通过</span>' : t.verdict?.decision === 'retake' ? verdictView(t) : ''}${t.error ? `<span class="small error-text">${esc(t.error)}</span>` : ''}`
    + `<button class="text-button" data-action="production-review-take" data-id="${esc(job.id)}" data-take="${esc(t.n)}" ${disabled}>查看</button>${t.status === 'rendered' && job.approvedTake !== t.n ? `<button class="text-button" data-action="production-approve" data-id="${esc(job.id)}" data-take="${esc(t.n)}" ${disabled}>通过这一条</button>` : ''}</li>`).join('')}</ul>` : ''}</div>`;
  const promptView = prompt ? `<details class="review-prompt"><summary>提示词 · ${prompt.mode === 'r2v' ? '参考模式 R2V' : '文生 T2VA'}${prompt.images.length ? ` · 参考图 ${prompt.images.map(esc).join('、')}` : ''}${prompt.audio.length ? ` · 声音样本 ${prompt.audio.map(esc).join('、')}` : ''}</summary><pre class="prompt-text">${esc(prompt.text)}</pre></details>` : '';
  const where = clip ? `${esc(clip.id)} · ${esc(clip.shotIds.join('、'))} · ${esc(framesToSeconds(clip.frames))} 秒 · ` : '';
  return `<section class="review-panel" aria-label="审片 ${esc(job.outputName)}"><span hidden data-live="${esc(layout)}"></span>`
    + `<div class="review-head"><div><div class="eyebrow">REVIEW · 审片</div><h3>${esc(job.outputName)}</h3><span class="small muted">${where}${job.languages.map(l => esc(languageName(l))).join('、')}${job.languages.length > 1 ? ' 共用一次渲染' : ''}</span></div><button class="text-button" data-action="production-review-close" ${disabled}>关闭审片</button></div>`
    + `${takeView(shown, `${approve ? `<div class="review-actions">${approve}</div>` : ''}${retake}`)}${otherList}${promptView}</section>`;
}

/** Stage events, newest first; a run of download reports keeps only its newest progress. */
function eventsView(events: SessionEvent[]): string {
  const shown: SessionEvent[] = [];
  for (const event of [...events].reverse()) {
    if (shown.at(-1)?.stage === event.stage && typeof event.data?.bytesDone === 'number') continue;
    shown.push(event);
    if (shown.length === 8) break;
  }
  if (!shown.length) return '';
  const detail = (event: SessionEvent) => {
    const done = event.data?.bytesDone, total = event.data?.bytesTotal, index = event.data?.index, count = event.data?.count;
    if (typeof done === 'number' && typeof total === 'number' && total > 0) {
      const percent = Math.min(100, Math.max(0, Math.round(done / total * 100)));
      return `<progress max="100" value="${percent}">${percent}%</progress><span class="small muted">${esc(size(done))} / ${esc(size(total))}（${percent}%）</span>`;
    }
    return typeof index === 'number' && typeof count === 'number' ? `<span class="small muted">第 ${esc(index)}/${esc(count)} 条</span>` : '';
  };
  return `<ol class="session-events">${shown.map(e => `<li><time datetime="${esc(e.at)}">${esc(clock(e.at))}</time><strong>${esc(STAGES[e.stage] ?? e.stage)}</strong>${e.message ? `<span>${esc(e.message)}</span>` : ''}${detail(e)}</li>`).join('')}</ol>`;
}

export interface SessionViewOptions { now: number; rate?: number; disabled: string; pollError?: string }

/** A live session: status, time, estimate, compute units, recent stages and the stop buttons. */
export function sessionLive(s: PublicRenderSession, o: SessionViewOptions): string {
  const waiting = s.status === 'waiting', id = esc(s.id);
  const elapsed = s.startedAt ? Math.max(0, (o.now - Date.parse(s.startedAt)) / 60_000) : undefined;
  const total = s.estimate.setupMinutes + s.estimate.renderMinutes;
  const left = elapsed === undefined ? '' : total - elapsed >= 0.5 ? ` · 预计还要约 ${Math.ceil(total - elapsed)} 分钟` : ' · 已超过估算';
  const estimate = `预计共 ${round1(total)} 分钟（准备 ${round1(s.estimate.setupMinutes)} + 渲染 ${round1(s.estimate.renderMinutes)}，${s.estimate.takes} 条 take）${s.estimate.measured ? '' : ' · 默认估算'}`;
  const time = elapsed === undefined ? `会话码 ${date(s.expiresAt)} 前有效` : `已运行 ${Math.floor(elapsed)} 分钟`;
  const units = o.rate !== undefined && s.mode === 'pull'
    ? `<p class="small">按每小时 ${esc(o.rate)} 个计算单元：${elapsed !== undefined ? `已用约 ${esc(round1(elapsed / 60 * o.rate))} 个，` : ''}整场预计约 ${esc(round1(total / 60 * o.rate))} 个。</p>` : '';
  const worker = s.worker?.gpu ? `<p class="small muted">GPU：${esc(s.worker.gpu)}${s.worker.vramGb ? `（${esc(s.worker.vramGb)} GB）` : ''}</p>` : '';
  const stop = s.stopRequest ? `<p class="small">已请求${s.stopRequest.when === 'now' ? '立即停止' : '这一条渲染完就停'}（${esc(clock(s.stopRequest.at))}），工作机最多 30 秒内收到。</p>` : '';
  const lost = s.status === 'lost' ? '<p class="small error-text">3 分钟没有收到工作机的消息。它恢复后会接着渲染；它领走的 take 在 15 分钟租约到期后重新排队。Colab 运行时已经断开的话，可以直接开始新的会话。</p>' : '';
  const buttons = waiting
    ? `<button class="button small-button" data-action="production-reissue-code" data-id="${id}" ${o.disabled}>换一个会话码</button><button class="button subtle small-button" data-action="production-stop" data-id="${id}" data-when="now" ${o.disabled}>取消会话</button>`
    : `<button class="button small-button" data-action="production-stop" data-id="${id}" data-when="after_take" ${o.disabled || (s.stopRequest ? 'disabled' : '')}>这一条渲染完就停</button><button class="button subtle small-button" data-action="production-stop" data-id="${id}" data-when="now" ${o.disabled || (s.stopRequest?.when === 'now' ? 'disabled' : '')}>立即停止</button>`;
  // The phase is in the key: waiting shows the code and a lost session lets a new one start, so a change of phase re-renders the page.
  return `<div class="session-live" data-live="session-${id}-${waiting ? 'waiting' : s.status === 'lost' ? 'lost' : 'live'}"><div class="session-head"><strong>${s.mode === 'rehearsal' ? '演练会话（不花 GPU）' : 'Colab GPU 会话'}</strong><span class="pill ${s.status === 'lost' ? 'changed' : 'accepted'}">${esc(SESSION_STATUS[s.status])}</span></div>`
    + `<p class="small">${esc(time)}${esc(left)} · ${esc(estimate)} · 时间预算 ${esc(s.settings.budgetMinutes)} 分钟</p>${units}${worker}${stop}${lost}${o.pollError ? `<p class="small error-text">${esc(o.pollError)}</p>` : ''}${eventsView(s.events)}<div class="language-toolbar">${buttons}</div></div>`;
}

/** The code with its copy button and the notebook steps. Shown once: the server keeps only the token's hash. */
export function codeOnce(code: string, mode: RenderSession['mode'], copied: boolean): string {
  const local = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/#]|$)/u.test(code);
  return `<div class="inline-warning token-once session-code" role="status"><strong>会话码只显示这一次</strong><input readonly value="${esc(code)}" aria-label="会话码"/>`
    + (local ? '<p class="small error-text">会话码里的地址是这台电脑自己，Colab 连不上。要交给 Colab，请用 SCIEPO_WORKER_PORT 开一个只有工作机接口的端口，用隧道连到它，把隧道地址设为 SCIEPO_WORKER_PUBLIC_URL 后重启 Sci-epo，再换一个会话码。</p>' : '')
    + `<div class="language-toolbar"><button class="button small-button" data-action="production-copy-code">${copied ? '已复制 ✓' : '复制会话码'}</button><button class="text-button" data-action="production-hide-code">我已复制，隐藏</button></div>`
    + `<ol class="session-steps"><li>打开 <a href="${esc(SESSION_NOTEBOOK)}" target="_blank" rel="noreferrer">Colab 会话笔记本 ↗</a>。</li><li>在“代码执行程序 → 更改运行时类型”里选 ${mode === 'rehearsal' ? 'CPU（演练不加载模型）' : 'G4'}。</li><li>运行笔记本里唯一的代码单元。</li><li>出现“Session code 会话码”输入框时粘贴会话码，按回车。</li></ol>`
    + '<span class="small">会话码只对这一批有效，会话结束或换码后作废。渲染期间保持 Colab 页面打开，除非你的 Colab 方案支持后台运行。离开这一页后就看不到它了；丢了就点“换一个会话码”。</span></div>';
}

/** The start form of a current batch: the mode, an optional budget and what is waiting to render. */
export function sessionStart(batch: RenderBatch, jobs: RenderJobV2[], draft: {mode: RenderSession['mode']; budget: string}, disabled: string): string {
  const pending = jobs.filter(j => j.takes.at(-1)?.status === 'queued'), frames = pending.reduce((sum, j) => sum + (batch.clips.find(c => c.id === j.clipId)?.frames ?? 0), 0), id = esc(batch.id);
  const mode = (value: RenderSession['mode'], label: string) => `<label class="check-label"><input type="radio" name="session-mode-${id}" value="${value}" data-production-session-mode="${id}" ${draft.mode === value ? 'checked' : ''} ${disabled}/><span>${label}</span></label>`;
  return `<div class="session-start"><div class="language-toolbar">${mode('pull', 'Colab GPU')}${mode('rehearsal', '演练（不花 GPU）')}`
    + `<label for="session-budget-${id}">时间预算（分钟，可不填）</label><input id="session-budget-${id}" class="small-input" type="number" min="5" max="720" step="1" placeholder="默认" value="${esc(draft.budget)}" data-production-session-budget="${id}" ${disabled}/>`
    + `<button class="button primary" data-action="production-start-session" data-id="${id}" ${disabled || (pending.length ? '' : 'disabled')}>开始渲染会话</button></div>`
    + `<p class="small muted">${pending.length ? `待渲染 ${pending.length} 条 take，共 ${frames} 帧（约 ${esc(framesToSeconds(frames))} 秒画面）。` : '没有待渲染的 take。要求重拍后会排上新的 take。'}预算不填时为估算的 1.5 倍、至少 15 分钟；到了预算，工作机不再开始新的 take。演练用占位画面走完整个流程，检查连接、上传和审片，不加载模型。</p></div>`;
}

/** An ended or expired session: the summary and the compute-unit balance read in Colab before and after. */
export function sessionSummary(s: PublicRenderSession, o: {rate?: number; readings: {before: string; after: string}; disabled: string}): string {
  const sum = s.summary, id = esc(s.id);
  const estimated = sum && sum.computeUnits === undefined && o.rate !== undefined && s.mode === 'pull' ? round1(sum.minutes / 60 * o.rate) : undefined;
  const facts = sum ? [`用时 ${sum.minutes} 分钟`, ...(sum.computeUnits !== undefined ? [`约 ${sum.computeUnits} 个计算单元`] : estimated !== undefined ? [`约 ${estimated} 个计算单元（按现在的单价估算）`] : []),
    `渲染完成 ${sum.takesRendered} 条`, `失败 ${sum.takesFailed} 条`, `未送达 ${sum.undelivered} 条${sum.undelivered ? '（已重新排队）' : ''}`] : [];
  const r = s.readings, used = r?.before !== undefined && r.after !== undefined ? `<p class="small">按 Colab 的读数，这次用掉 ${esc(round2(r.before - r.after))} 个计算单元。</p>` : '';
  return `<div class="session-summary"><div class="session-head"><strong>${s.mode === 'rehearsal' ? '演练会话' : 'Colab GPU 会话'}${s.status === 'expired' ? '已过期' : '已结束'}</strong><span class="pill">${esc(s.end ? SESSION_END[s.end] ?? s.end : SESSION_STATUS[s.status])}</span><span class="small muted">${esc(date(s.endedAt ?? s.createdAt))}</span></div>`
    + `${facts.length ? `<p class="small">${facts.map(esc).join(' · ')}</p>` : '<p class="small muted">没有会话摘要：工作机没有连上，或没有正常结束。</p>'}${sum?.message ? `<p class="small muted">${esc(sum.message)}</p>` : ''}${used}`
    + `<div class="language-toolbar readings"><label for="reading-before-${id}">开始前的计算单元余额</label><input id="reading-before-${id}" class="small-input" type="number" min="0" step="0.01" value="${esc(o.readings.before)}" data-production-reading="before" data-id="${id}" ${o.disabled}/>`
    + `<label for="reading-after-${id}">结束后的余额</label><input id="reading-after-${id}" class="small-input" type="number" min="0" step="0.01" value="${esc(o.readings.after)}" data-production-reading="after" data-id="${id}" ${o.disabled}/>`
    + `<button class="button subtle small-button" data-action="production-save-readings" data-id="${id}" ${o.disabled}>保存读数</button></div><p class="small muted">余额在 Colab 的“代码执行程序 → 查看资源”里。</p></div>`;
}

// ------------------------------------------------------------------ cuts

export const CUT_STATUS: Record<Cut['status'], string> = {queued: '排队中', running: '剪辑中', done: '已剪好', failed: '失败'};
const CUT_STATUS_CLASS: Record<Cut['status'], string> = {queued: '', running: '', done: 'accepted', failed: 'changed'};
export const CUT_KIND: Record<Cut['kind'], string> = {draft: '草稿', final: '正式成片'};
const decibels = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : String(round1(value));
const sizeLabel = (size: CutSize, batch: Pick<RenderBatch, 'width' | 'height'>) => size === 'native' ? `按渲染尺寸（${batch.width}×${batch.height}）` : size.replace('x', '×');

/** The plan of a final cut as the server returns it, kept while the author edits it. */
export interface CutFormDraft {
  settings: CutSettings; captions: Caption[]; sizes: CutSize[]; seconds: number; pictureLanguage: string; musicRequired: boolean;
  /** '' until the author chooses, 'none' for no music, or a music asset ID. */
  music: string;
  /** The music level as typed. */
  musicLevel: string;
  ffmpeg: {found: boolean; hint?: string};
}

/** One cut: status, the player when it is done, facts, warnings and errors. It holds no inputs, so polling can replace it;
 * the status is in the key, so a finished cut draws the page again with its sign-off controls. */
export function cutView(cut: Cut, o: {current: boolean; batch: Pick<RenderBatch, 'width' | 'height'>}): string {
  const out = cut.output, id = esc(cut.id);
  const verdict = cut.signOff ? `<span class="pill ${cut.signOff.decision === 'signed_off' ? 'accepted' : 'changed'}">${cut.signOff.decision === 'signed_off' ? '已签收' : '已驳回'}</span>` : '';
  const pills = `<span class="pill ${CUT_STATUS_CLASS[cut.status]}">${esc(CUT_STATUS[cut.status])}</span>${cut.rehearsal ? '<span class="pill demo">演练</span>' : ''}${o.current ? '' : '<span class="pill changed">不是当前版本</span>'}${verdict}`;
  const settings = [sizeLabel(cut.settings.size, o.batch), cut.settings.musicAssetId ? `配乐 ${decibels(cut.settings.musicLevelDb)} dB` : cut.settings.noMusic ? '不加配乐' : '没有配乐', `字幕 ${cut.captions.filter(c => c.enabled).length} 条`];
  const facts = out ? [`${out.seconds} 秒`, `响度 ${decibels(out.loudness)} LUFS`, `真峰值 ${decibels(out.truePeak)} dBTP`, size(out.bytes)] : [];
  const player = cut.status === 'done' && out ? `<video controls playsinline preload="metadata" src="${esc(mediaUrl(out.assetId))}" class="cut-video" aria-label="${esc(CUT_KIND[cut.kind])}视频"></video>` : '';
  const waiting = cut.status === 'queued' ? '<p class="small muted">排在队里，前面的成片剪完就开始。</p>' : cut.status === 'running' ? '<p class="small muted">正在用 ffmpeg 剪辑，通常一两分钟。</p>' : '';
  const stale = o.current ? '' : `<p class="small">${cut.kind === 'final' ? '有片段通过了另一条 take，这一版不是当前版本，不能签收。要交付请重新剪正式成片。' : '有片段渲染了更新的 take，这一版草稿不是当前版本。'}</p>`;
  return `<div class="cut-item" data-live="cut-${id}-${cut.status}"><div class="session-head"><strong>${esc(CUT_KIND[cut.kind])}</strong>${pills}<span class="small muted">${esc(date(cut.createdAt))}</span></div>`
    + `${player}${facts.length ? `<p class="small">${facts.map(esc).join(' · ')}</p>` : ''}<p class="small muted">${settings.map(esc).join(' · ')}</p>${waiting}${stale}`
    + `${cut.error ? `<p class="small error-text">${esc(cut.error)}</p>` : ''}${(cut.warnings ?? []).map(w => `<p class="small qa-warning">${esc(w)}</p>`).join('')}`
    + `${cut.status === 'done' || cut.status === 'failed' ? `<a class="text-button" href="/api/cuts/${encodeURIComponent(cut.id)}/report" download>交付报告 ↗</a>` : ''}</div>`;
}

/** Sign-off of a finished final cut: the verdict so far, a note and the two decisions. Outside the polled region. */
export function cutSignOff(cut: Cut, o: {current: boolean; note: string; disabled: string}): string {
  if (cut.kind !== 'final' || cut.status !== 'done') return '';
  if (cut.rehearsal) return '<p class="small muted">演练成片用的是占位画面，不能签收或交付。</p>';
  const id = esc(cut.id), s = cut.signOff;
  const decided = s ? `<p class="small">${s.decision === 'signed_off' ? '你已签收' : '你已驳回'}（${esc(date(s.at))}）${s.note ? `：${esc(s.note)}` : ''}</p>` : '';
  return `<div class="cut-signoff">${decided}<label class="field-label" for="cut-note-${id}">说明（驳回时必填）</label><textarea id="cut-note-${id}" rows="2" maxlength="1000" data-production-cut-note="${id}" placeholder="例如：第 3 段的消息字幕太快。" ${o.disabled}>${esc(o.note)}</textarea>`
    + `<div class="language-toolbar"><button class="button primary small-button" data-action="production-cut-signoff" data-id="${id}" data-decision="signed_off" ${o.disabled || (o.current ? '' : 'disabled')}>内容成立，签收</button>`
    + `<button class="button subtle small-button" data-action="production-cut-signoff" data-id="${id}" data-decision="rejected" ${o.disabled}>驳回</button>`
    + `<span class="small muted">签收是你对内容的结论，和上面的技术结果分开记录；签收后交付报告存进媒体库，发布清单把这一语言标为已交付。</span></div></div>`;
}

/** The form of a final cut: music, its level, the output size and the captions of on-screen text. */
export function cutForm(batch: Pick<RenderBatch, 'id' | 'width' | 'height'>, language: string, draft: CutFormDraft, o: {music: MediaAsset[]; disabled: string}): string {
  const key = esc(`${batch.id}:${language}`), field = (name: string) => `data-production-cut-field="${name}" data-cut-key="${key}"`;
  const [low, high] = CUT_SETTING_RANGES.musicLevelDb;
  const options = [...(draft.musicRequired ? [['', '请选择配乐…'] as const] : []), ...o.music.map(m => [m.id, `${m.label ?? m.id}${m.license ? ` · ${m.license}` : ' · 没有授权说明'}`] as const), ['none', '不加配乐'] as const];
  const music = `<label for="cut-music-${key}">配乐</label><select id="cut-music-${key}" ${field('music')} ${o.disabled}>${options.map(([value, label]) => `<option value="${esc(value)}" ${draft.music === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`
    + `<label for="cut-level-${key}">配乐音量（dB）</label><input id="cut-level-${key}" class="small-input" type="number" min="${low}" max="${high}" step="1" value="${esc(draft.musicLevel)}" ${field('musicLevel')} ${o.disabled}/>`;
  const sizes = `<label for="cut-size-${key}">输出尺寸</label><select id="cut-size-${key}" ${field('size')} ${o.disabled}>${draft.sizes.map(s => `<option value="${esc(s)}" ${draft.settings.size === s ? 'selected' : ''}>${esc(sizeLabel(s, batch))}</option>`).join('')}</select>`;
  const caption = (c: Caption, i: number) => {
    const attrs = (name: string) => `data-production-caption="${name}" data-cut-key="${key}" data-index="${i}"`;
    return `<tr><th scope="row">${esc(c.shotId)}</th><td><input type="checkbox" ${attrs('enabled')} ${c.enabled ? 'checked' : ''} aria-label="显示镜头 ${esc(c.shotId)} 的字幕" ${o.disabled}/></td>`
      + `<td><textarea rows="2" maxlength="300" ${attrs('text')} aria-label="镜头 ${esc(c.shotId)} 的字幕文字" ${o.disabled}>${esc(c.text)}</textarea></td>`
      + `<td><input class="small-input" type="number" min="0" max="${esc(draft.seconds)}" step="0.1" value="${esc(c.start)}" ${attrs('start')} aria-label="镜头 ${esc(c.shotId)} 的字幕开始" ${o.disabled}/></td>`
      + `<td><input class="small-input" type="number" min="0" max="${esc(draft.seconds)}" step="0.1" value="${esc(c.end)}" ${attrs('end')} aria-label="镜头 ${esc(c.shotId)} 的字幕结束" ${o.disabled}/></td></tr>`;
  };
  const captions = draft.captions.length
    ? `<div class="table-scroll"><table class="production-table caption-table"><thead><tr><th>镜头</th><th>显示</th><th>文字</th><th>开始（秒）</th><th>结束（秒）</th></tr></thead><tbody>${draft.captions.map(caption).join('')}</tbody></table></div>`
      + `<p class="small muted">字幕取自剧本或改编里这些行引号中的文字，按镜头的时间显示，可以改字、缩短、挪时间或关掉。${esc(languageName(draft.pictureLanguage))}是画面描述用的语言，观众能直接读画面上的字，所以它的字幕默认关闭。</p>`
    : '<p class="small muted">分镜表里没有标出画面文字的行，这一版没有字幕。可以在分镜页的镜头里勾选“画面文字”。</p>';
  return `<fieldset class="cut-form"><legend>正式成片 · ${esc(languageName(language))}</legend>${draft.ffmpeg.found ? '' : `<div class="inline-warning" role="status">${esc(draft.ffmpeg.hint ?? '')}</div>`}`
    + `<div class="language-toolbar">${music}${sizes}</div>${draft.musicRequired ? '<p class="small muted">这一批用整集配乐：片段里没有背景音乐，正式成片要选一条配乐，或明确选择不加配乐。配乐在对白下自动压低，开头淡入 1 秒、结尾淡出 2 秒。</p>' : ''}`
    + `<h4>画面文字字幕</h4>${captions}<div class="language-toolbar"><button class="button primary small-button" data-action="production-cut-create" data-id="${esc(batch.id)}" data-language="${esc(language)}" ${o.disabled || (draft.ffmpeg.found ? '' : 'disabled')}>开始剪辑正式成片</button>`
    + `<button class="text-button" data-action="production-cut-cancel" data-id="${esc(batch.id)}" data-language="${esc(language)}" ${o.disabled}>取消</button></div></fieldset>`;
}

/** Music in the media store and the upload with its license note; the note goes into the delivery report. */
export function musicUpload(batchId: string, music: MediaAsset[], license: string, disabled: string): string {
  const id = esc(batchId);
  const list = music.length ? `<ul class="media-list">${music.map(m => `<li><span><strong>${esc(m.label ?? m.id)}</strong> · ${esc(size(m.bytes))}${m.license ? ` · ${esc(m.license)}` : ' · <span class="muted">没有授权说明</span>'}</span></li>`).join('')}</ul>` : '<p class="small muted">还没有上传配乐。</p>';
  return `<div class="cut-music"><h4>配乐</h4>${list}<div class="language-toolbar"><label for="music-license-${id}">授权说明</label><input id="music-license-${id}" data-production-music-license value="${esc(license)}" maxlength="300" placeholder="例如：CC BY 4.0，作者某某；或我自己创作" ${disabled}/>`
    + `<label class="button subtle small-button file-button">上传配乐<input type="file" accept="audio/wav,audio/x-wav,audio/mpeg,audio/flac,audio/mp4,.wav,.mp3,.flac,.m4a" data-production-music-upload aria-label="上传配乐" ${disabled}/></label></div>`
    + '<p class="small muted">WAV、MP3、FLAC 或 M4A，不超过 30 MB。配乐的版权由你负责；授权说明会写进交付报告。</p></div>';
}
