/** The delivery report of a cut, in Markdown: where it came from, how it was made and what it cost, the technical
 * result and the author's verdict in separate sections, and the problems still open. Pure: the server collects the records. */
import type { Cut, Episode, Localization, MediaAsset, Project, PublicRenderSession, RenderBatch, RenderJobV2, RetakeReason, Revision, ShotList, Take } from '../types';
import { CUT_LOUDNESS_RANGE, cutDimensions } from './cut';
import { languageName } from './languages';

export interface CutReportInput {
  cut: Cut; current: boolean; generatedAt: string;
  project: Pick<Project, 'title'> & {computeUnitsPerHour?: number};
  episode: Pick<Episode, 'ordinal' | 'title'>;
  revision: Pick<Revision, 'id' | 'title' | 'createdAt'> & {accepted: boolean; language: string};
  adaptation?: Pick<Localization, 'id' | 'language' | 'createdAt' | 'mode'>;
  list: Pick<ShotList, 'id' | 'createdAt' | 'mode'>;
  batch: RenderBatch; jobs: RenderJobV2[]; sessions: PublicRenderSession[]; media: MediaAsset[];
}

const REASONS: Record<RetakeReason, string> = {picture_broken: '画面旋转或损坏', character_drift: '人物不一致', line_wrong: '台词缺失或错误', lip_sync: '口型不对', garbled_text: '文字乱码', other: '其他'};
const CHECKS: Record<string, string> = {duration: '时长', size: '尺寸', frame_rate: '帧率', audio: '音轨', loudness: '响度', silence: '静音', line: '台词'};
const STATUS: Record<Cut['status'], string> = {queued: '排队中', running: '剪辑中', done: '已完成', failed: '失败'};
const QA: Record<string, string> = {pass: '通过', warning: '提醒', failure: '失败'};
const END: Record<string, string> = {queue_empty: '待渲染的 take 都处理完了', budget: '到了时间预算', stopped: '作者停止', not_current: '批次已不是当前制作版本', failures: '连续两条 take 失败', error: '工作机出错', lost: '工作机失去联系', expired: '会话码过期'};

/** One line of free text: no line breaks, no table separators. */
const text = (value: unknown) => String(value ?? '').replace(/\s*\r?\n\s*/gu, ' / ').replace(/\|/gu, '\\|').trim();
const code = (value: unknown) => `\`${String(value ?? '').replace(/`/gu, '')}\``;
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(1)}`;
const number = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits).replace('-', '−');
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function cutReport(input: CutReportInput): string {
  const {cut, batch, jobs, media} = input, settings = cut.settings, out: string[] = [];
  const asset = (id: string | null | undefined) => id ? media.find(m => m.id === id) : undefined;
  const takeOf = (jobId: string, n: number): {job?: RenderJobV2; take?: Take} => { const job = jobs.find(j => j.id === jobId); return {job, take: job?.takes.find(t => t.n === n)}; };
  const kind = cut.kind === 'final' ? '正式成片' : '草稿';
  out.push(`# 成片报告 · ${text(input.project.title)} · 第 ${input.episode.ordinal} 集《${text(input.episode.title)}》 · ${languageName(cut.language)} · ${kind}`, '');
  out.push(`生成于 ${input.generatedAt}。成片 ${code(cut.id)}，${STATUS[cut.status]}。${cut.rehearsal ? '这是演练成片：画面是占位画面，不能签收或交付。' : ''}${!input.current ? '它用的 take 已经不是当前版本。' : ''}`, '');

  out.push('## 来源', '');
  out.push(`- 剧本版本 ${code(input.revision.id)}《${text(input.revision.title)}》，${languageName(input.revision.language)}，${input.revision.accepted ? '是本集当前定稿' : '已不是本集当前定稿'}。`);
  out.push(input.adaptation ? `- 语言改编 ${code(input.adaptation.id)}（${languageName(input.adaptation.language)}，${input.adaptation.createdAt}）。` : '- 剧本原稿语言，不用改编。');
  out.push(`- 分镜表 ${code(input.list.id)}（${input.list.createdAt}）。`);
  const preset = batch.preset;
  out.push(`- 渲染批次 ${code(batch.id)}：${batch.width}×${batch.height}${preset ? `，${preset.steps} 步${preset.turbo ? '，加速' : ''}，工作机栈 ${code(`${preset.stack.id} ${preset.stack.version}`)}` : ''}，${batch.musicMode === 'native' ? '片段自带配乐' : '整集配乐'}，创建于 ${batch.createdAt}。`, '');
  out.push('| 片段 | 输出名 | take | 种子 | 会话 | 时长（秒） | SHA-256 |', '|---|---|---|---|---|---|---|');
  for (const clip of cut.clips) {
    const {job, take} = takeOf(clip.jobId, clip.take);
    out.push(`| ${clip.clipId} | ${text(job?.outputName ?? clip.jobId)} | ${clip.take}${take?.rehearsal ? '（演练）' : ''} | ${take?.seed ?? '—'} | ${take?.sessionId ? code(take.sessionId) : '—'} | ${clip.seconds} | ${code(clip.sha256)} |`);
  }
  out.push('');

  out.push('## 设置', '');
  const music = asset(settings.musicAssetId);
  out.push(`- 输出尺寸：${settings.size === 'native' ? `按渲染尺寸（${batch.width}×${batch.height}）` : settings.size.replace('x', '×')}。`);
  out.push(settings.musicAssetId ? `- 配乐：${text(music?.label ?? settings.musicAssetId)}，音量 ${number(settings.musicLevelDb)} dB，在片段声音下自动压低${music?.license ? `；授权说明：${text(music.license)}` : '；没有填写授权说明'}。`
    : settings.noMusic ? '- 配乐：作者选择不加配乐。' : '- 配乐：没有。');
  out.push(`- 片段电平：有对白的片段到 ${number(settings.dialogueLufs)} LUFS，没有对白的到 ${number(settings.ambienceLufs)} LUFS，增益不超过 ±${number(settings.maxGainDb)} dB；片段之间 ${settings.fadeMs} ms 淡入淡出。`);
  out.push(`- 整片响度：${number(settings.targetLufs)} LUFS，真峰值不超过 ${number(settings.truePeakDb)} dBTP，响度范围 ${CUT_LOUDNESS_RANGE} LU。`);
  for (const clip of cut.clips) {
    const {take} = takeOf(clip.jobId, clip.take), measured = take?.qa?.loudness?.integrated;
    out.push(`  - ${clip.clipId}：${clip.dialogue ? '有对白' : '无对白'}，测得 ${number(measured)} LUFS，增益 ${signed(clip.gainDb)} dB。`);
  }
  const enabled = cut.captions.filter(c => c.enabled);
  out.push(`- 画面文字字幕：${cut.captions.length} 条，显示 ${enabled.length} 条。`);
  for (const caption of cut.captions) out.push(`  - ${caption.shotId} · ${caption.start.toFixed(2)}–${caption.end.toFixed(2)} 秒 · ${caption.enabled ? '显示' : '不显示'} · ${text(caption.text)}`);
  out.push('');

  out.push('## 渲染会话', '');
  if (!input.sessions.length) out.push('- 没有会话记录。');
  let minutes = 0, units = 0, unitsKnown = false;
  for (const s of input.sessions) {
    const sum = s.summary, rate = input.project.computeUnitsPerHour;
    const estimated = sum?.computeUnits ?? (sum && rate !== undefined && s.mode === 'pull' ? round2(sum.minutes / 60 * rate) : undefined);
    if (sum) minutes += sum.minutes;
    if (estimated !== undefined) { units += estimated; unitsKnown = true; }
    const readings = s.readings?.before !== undefined || s.readings?.after !== undefined
      ? `作者读数：开始前 ${s.readings?.before ?? '—'}，结束后 ${s.readings?.after ?? '—'}${s.readings?.before !== undefined && s.readings.after !== undefined ? `，用掉 ${round2(s.readings.before - s.readings.after)}` : ''}`
      : '作者没有记录计算单元读数';
    out.push(`- 会话 ${code(s.id)}（${s.mode === 'rehearsal' ? '演练' : 'Colab GPU'}）：${s.worker?.gpu ? `GPU ${text(s.worker.gpu)}，` : ''}${s.startedAt ?? s.createdAt} 到 ${s.endedAt ?? '未结束'}`
      + `${sum ? `，用时 ${sum.minutes} 分钟${estimated !== undefined ? `，估算 ${estimated} 个计算单元` : ''}，渲染完成 ${sum.takesRendered} 条、失败 ${sum.takesFailed} 条、未送达 ${sum.undelivered} 条` : '，没有会话摘要'}`
      + `${s.end ? `，结束原因：${END[s.end] ?? s.end}` : ''}；${readings}。`);
  }
  if (input.sessions.length) out.push(`- 合计用时 ${round1(minutes)} 分钟${unitsKnown ? `，估算 ${round2(units)} 个计算单元` : ''}。`);
  out.push('');

  out.push('## 文件', '', '| 文件 | 类型 | 字节 | SHA-256 |', '|---|---|---|---|');
  for (const clip of cut.clips) out.push(`| ${clip.clipId} · take ${clip.take} | 渲染视频 | ${asset(clip.assetId)?.bytes ?? '—'} | ${code(clip.sha256)} |`);
  if (music) out.push(`| ${text(music.label ?? '配乐')} | 配乐 | ${music.bytes} | ${code(music.sha256)} |`);
  if (cut.output) out.push(`| 成片 | 成片视频 | ${cut.output.bytes} | ${code(cut.output.sha256)} |`);
  out.push('');

  out.push('## 质检结果', '');
  for (const clip of cut.clips) {
    const {job, take} = takeOf(clip.jobId, clip.take), qa = take?.qa;
    out.push(`### ${clip.clipId} · take ${clip.take}（${text(job?.outputName ?? clip.jobId)}）`, '');
    if (!qa) { out.push('- 没有质检结果。', ''); continue; }
    if (qa.loudness) out.push(`- 响度 ${number(qa.loudness.integrated)} LUFS，真峰值 ${number(qa.loudness.truePeak)} dBTP${qa.loudness.range !== undefined ? `，响度范围 ${number(qa.loudness.range)} LU` : ''}。`);
    for (const check of qa.checks) out.push(`- ${QA[check.status] ?? check.status} · ${CHECKS[check.id] ?? check.id}：${text(check.message)}${check.value !== undefined ? `（${check.value}）` : ''}`);
    for (const line of qa.speech?.lines ?? []) out.push(`- 台词 ${line.sceneId}·${line.position}：应为“${text(line.expected)}”，识别到“${text(line.heard) || '（没有）'}”，匹配 ${Math.round(line.score * 100)}%`);
    out.push('');
  }

  out.push('## 重拍', '');
  const retakes = cut.clips.flatMap(clip => {
    const job = jobs.find(j => j.id === clip.jobId);
    return (job?.takes ?? []).filter(t => t.verdict?.decision === 'retake').map(t => `- ${text(job!.outputName)} take ${t.n}：${t.verdict!.reasons.map(r => REASONS[r] ?? r).join('、') || '没有写原因'}${t.verdict!.note ? `；${text(t.verdict!.note)}` : ''}（${t.verdict!.at}）`);
  });
  out.push(...(retakes.length ? retakes : ['- 没有重拍。']), '');

  out.push('## 技术结果', '');
  out.push(`- 状态：${STATUS[cut.status]}${cut.error ? `：${text(cut.error)}` : ''}。`);
  const planned = round2(cut.clips.reduce((sum, c) => sum + c.seconds, 0)), size = cutDimensions(settings.size, batch);
  if (cut.output) {
    out.push(`- 时长 ${cut.output.seconds} 秒（计划 ${planned} 秒），${size.width}×${size.height}，H.264 和 AAC。`);
    out.push(`- 响度 ${number(cut.output.loudness)} LUFS（目标 ${number(settings.targetLufs)}），真峰值 ${number(cut.output.truePeak)} dBTP（上限 ${number(settings.truePeakDb)}）。`);
  } else out.push(`- 还没有成片文件（计划 ${planned} 秒）。`);
  for (const warning of cut.warnings ?? []) out.push(`- 提醒：${text(warning)}`);
  out.push('');

  out.push('## 作者结论', '');
  const verdict = cut.signOff;
  out.push(cut.kind === 'draft' ? '- 草稿只用来预览，不签收。'
    : !verdict ? '- 还没有结论。'
    : verdict.decision === 'signed_off' ? `- 内容成立，签收（${verdict.at}）${verdict.note ? `：${text(verdict.note)}` : '。'}`
    : `- 驳回（${verdict.at}）：${text(verdict.note)}`, '');

  out.push('## 未解决的问题', '');
  const problems: string[] = [];
  if (cut.status === 'failed') problems.push(`剪辑失败：${text(cut.error)}`);
  if (cut.rehearsal) problems.push('演练成片用的是占位画面，不能交付。');
  if (!input.current) problems.push(cut.kind === 'final' ? '有片段的通过 take 变了，这个成片不是当前版本。' : '有片段渲染了更新的 take，这个草稿不是当前版本。');
  for (const clip of cut.clips) {
    const {job, take} = takeOf(clip.jobId, clip.take);
    if (job && job.approvedTake !== clip.take) problems.push(`${clip.clipId} 用的 take ${clip.take} 还没有通过${job.approvedTake !== undefined ? `（通过的是 take ${job.approvedTake}）` : ''}。`);
    for (const check of take?.qa?.checks ?? []) if (check.status !== 'pass') problems.push(`${clip.clipId} · take ${clip.take} 的质检${check.status === 'failure' ? '失败' : '提醒'}：${CHECKS[check.id] ?? check.id}，${text(check.message)}`);
  }
  if (cut.output?.loudness !== null && cut.output?.loudness !== undefined && Math.abs(cut.output.loudness - settings.targetLufs) > 1) problems.push(`整片响度 ${number(cut.output.loudness)} LUFS，离目标 ${number(settings.targetLufs)} LUFS 超过 1 LU。`);
  if (cut.output?.truePeak !== null && cut.output?.truePeak !== undefined && cut.output.truePeak > settings.truePeakDb + 0.2) problems.push(`真峰值 ${number(cut.output.truePeak)} dBTP 超过上限 ${number(settings.truePeakDb)} dBTP。`);
  for (const warning of cut.warnings ?? []) problems.push(text(warning));
  out.push(...(problems.length ? problems.map(p => `- ${p}`) : ['- 没有发现未解决的问题。']), '');
  return out.join('\n');
}
