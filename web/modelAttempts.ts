import type { ModelAttempt, Run } from '../src/types';

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const stages:Record<string,string>={generate:'生成剧本',review:'五维审稿',causality:'因果审稿',facts:'原文事实整理',verification:'陈述核实',rewrite:'局部改稿',localize:'语言改编',storyboard:'分镜表'};
const statuses:Record<string,string>={running:'处理中',succeeded:'已返回',failed:'失败'};
const stopped:Record<string,string>={call_limit:'该请求已达到重发上限',run_limit:'本次任务已达到重发总上限',review_stopped:'审稿已停止',not_eligible:'此错误不适用格式重发'};

/** A scheduled retry is not evidence that a second request was actually started. */
export function modelAttemptsView(run:(Pick<Run,'modelAttempts'>&Partial<Pick<Run,'status'>>)|undefined):string {
 const attempts=Array.isArray(run?.modelAttempts)?run.modelAttempts.filter((a):a is ModelAttempt=>!!a&&typeof a==='object'):[];
 const retried=attempts.some(a=>a.attempt===2);
 const auditFormatFailed=attempts.some(a=>a.status==='failed'&&a.errorCode==='invalid_audit_format');
 if(!retried&&!auditFormatFailed&&!attempts.some(a=>a.status==='failed'&&a.errorCode==='invalid_json'))return '';
 const heading=retried?'曾格式失败并重发':'格式失败，未继续重发';
 return `<section class="inline-warning model-attempts" role="status"><strong>${heading}</strong><p class="small">${auditFormatFailed?'已保留审计格式校验失败记录。':''}这里记录调用与格式处理经过，内容结论见审稿和候选正文。</p><details class="evidence model-attempt-history"><summary>查看模型请求记录（${attempts.length}）</summary><ol>${attempts.map(a=>{
  const elapsed=typeof a.elapsedMs==='number'&&Number.isFinite(a.elapsedMs)&&a.elapsedMs>=0?`${(a.elapsedMs/1000).toFixed(2)} 秒`:'未记录';
  const status=a.status==='running'&&run?.status&&run.status!=='running'?(run.status==='failed'?'未记录完成（任务已中断）':'未记录完成（任务已结束）'):(statuses[a.status]??a.status);
  const reason=a.retryStoppedReason?`<p>未继续重发：${esc(stopped[a.retryStoppedReason]??a.retryStoppedReason)}</p>`:'';
  const scheduled=a.retryScheduled&&!attempts.some(next=>next.callId===a.callId&&next.attempt===2)?'<p>已安排格式重发，尚无第二次请求记录。</p>':'';
  const diagnostics=Array.isArray(a.validationErrors)&&a.validationErrors.length?`<details class="evidence model-attempt-validation-errors"><summary>审计格式校验诊断（${a.validationErrors.length}）</summary><ul>${a.validationErrors.map(error=>`<li>${esc(error)}</li>`).join('')}</ul></details>`:'';
  return `<li><strong>请求序号 ${esc(a.sequence)} · ${esc(stages[a.stage]??a.stage)}${a.batch!==undefined?` · 批次 ${esc(a.batch)}`:''} · 调用 ${esc(a.callId)} · 第 ${esc(a.attempt)} 次</strong><p>${esc(status)}${a.errorCode==='invalid_audit_format'?' · 审计格式校验失败':''}${a.errorCode?` · 错误码 ${esc(a.errorCode)}`:''} · 耗时 ${elapsed}</p>${Array.isArray(a.targetIds)&&a.targetIds.length?`<p>核实项目：${a.targetIds.map(esc).join('、')}</p>`:''}<p class="small muted">开始 ${esc(a.startedAt)}${a.finishedAt?` · 结束 ${esc(a.finishedAt)}`:''}</p>${diagnostics}${reason}${scheduled}</li>`;
 }).join('')}</ol></details></section>`;
}
