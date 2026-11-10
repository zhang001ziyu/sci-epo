import { timelineAddress, timelineRecords, fieldTargets, validOmission, validAuditCheck, auditCheck, auditIntact, auditedFactSupported, verificationIntact, reviewTargetSupported, reviewSuggestion, verificationIssueCount, reviewIssueCount, reviewCompletionLabel } from '../src/core/reviewSuggestions';
export { reviewTargetSupported, reviewSuggestion, verificationIssueCount, reviewIssueCount, reviewCompletionLabel } from '../src/core/reviewSuggestions';
import { checkLength } from '../src/core/length';
import { inferenceGaps } from '../src/core/inferenceProof';
import type { TimelineFact, VerificationCheck, VerificationQuote } from '../src/core/reviewVerification';
import type { Assessment, Brief, Review, Scene } from '../src/types';
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const dimensionLabels:Record<string,string>={story:'故事与因果',character:'人物与选择',dialogue:'对白与表达',continuity:'设定与连续性',filmability:'场面与可表演性'};
const assessmentLabels:Record<string,string>={no_issue:'未发现问题',issue:'修改建议',uncertain:'待核实',not_applicable:'不适用'};
const verificationLabels:Record<string,string>={supported:'解释有依据',contradicted:'审稿说法与原文冲突',unsupported:'审稿说法依据不足',uncertain:'审稿说法尚不能确认'};
const factAuditLabels:Record<string,string>={supported:'核实器解释有依据',contradicted:'核实器解释与原文冲突',unsupported:'核实器解释依据不足',uncertain:'核实器解释尚不能确认'};
const omissionLabels:Record<string,string>={timeline:'时间与工时',accounting:'数量与账目',agency:'人物行动与选择',continuity:'状态与信息接续',other:'其他遗漏'};
const timelineLabels:Record<TimelineFact['status'],string>={consistent:'时间陈述相容',conflict:'时间陈述存在冲突',uncertain:'时间陈述仍有歧义'};
const meaningLabels:Record<keyof TimelineFact['meaning'],string>={subject:'主体',activity:'具体活动',durationKind:'时长含义',clock:'时钟与参照系',basis:'陈述依据'};
const fieldLabels:Record<string,string>={suggestedSceneId:'实际修改场景',state:'已有状态',choice:'人物选择',alternative:'更简单的行动',explanation:'解释',suggestedFix:'改法',trigger:'触发条件',threatenedOutcome:'受威胁的目标',currentState:'实际状态',directAlternative:'绕开代价的行动','meaning.subject':'时间陈述的主体','meaning.activity':'时间陈述的活动','meaning.durationKind':'时长含义','meaning.clock':'时钟与参照系','meaning.basis':'时间陈述的依据'};
function quotes(rows:VerificationQuote[]|undefined,label:string):string {
 return (rows??[]).map(e=>`<details class="evidence"><summary>${esc(label)} · ${esc(e.sourceId)}</summary><blockquote>${esc(e.quote)}</blockquote>${e.sourceRef?'<p class="small muted source-line-reference">原文行引用：按冻结原文行定位；定位不等于解释已核实，也不是另一份独立依据。</p>':''}${e.modelQuote?`<details class="evidence quote-normalization"><summary>模型原引文（格式对照）</summary><p class="small muted">仅用于查看空白整理前的文字，不是另一份独立依据。</p><blockquote>${esc(e.modelQuote)}</blockquote></details>`:''}</details>`).join('');
}
function correctionView(correction:string|undefined):string {
 return correction?`<p><strong>核实者更正意见（待作者确认）：</strong>${esc(correction)}</p><p class="small muted">这项更正意见仍需作者对照原文确认，不自动作为改稿指令。</p>`:'';
}
function factExplanation(review:Review,targetId:string,originalLabel:string,body:string):string {
 if(auditedFactSupported(review,targetId))return body;
 const check=auditCheck(review,targetId),correction=check&&check.verdict!=='supported'
  ?`<div class="inline-warning">${check.claimQuote?`<p><strong>审稿争议原话</strong></p><blockquote>${esc(check.claimQuote)}</blockquote>`:''}<p>${esc(check.explanation)}</p>${correctionView(check.correction)}${quotes(check.evidence,'审计依据')}${quotes(check.counterEvidence,'审计反向依据')}</div>`
  :'<p class="inline-warning">此解释尚未通过完整的独立审计，不能作为已确认事实。</p>';
 return `${correction}${parentAuditTrace(review,targetId)}<details class="evidence original-verifier"><summary>原核实器解释与判断（尚不采信）</summary><p class="small muted">原判断：${esc(originalLabel)}。保留原文供对照。</p>${body}</details>`;
}
function factLabel(review:Review,targetId:string,originalLabel:string):string {
 if(auditedFactSupported(review,targetId))return originalLabel;
 const check=auditCheck(review,targetId);
 return check&&check.verdict!=='supported'?factAuditLabels[check.verdict]!:'核实器解释尚未审计';
}
function timelineView(review:Review):string {
 const timeline=timelineRecords(review),heading='<h4>逐条时间核对</h4>';
 if(timeline.state==='missing')return `${heading}<p class="inline-warning">尚未逐条核对时间陈述；重新核实后才能带入原审稿建议。</p>`;
 if(timeline.state==='unbound')return `${heading}<p class="inline-warning">旧版时间核对未标注系统绑定原句；保留旧审稿状态，重新核实后才能带入原审稿建议。</p>`;
 if(timeline.state==='invalid')return `${heading}<p class="inline-warning">时间核对记录含重复标识或无效字段，不能确认核对结果；原建议已暂停带入改稿。</p>`;
 if(!timeline.facts.length)return `${heading}<p class="small muted">本次记录没有时间核对条目。</p>`;
 return heading+(timeline.facts.some(f=>auditedFactSupported(review,f.targetId)&&f.status!=='consistent')?'<p class="inline-warning">时间陈述仍有冲突或歧义；只有事实解释和改法都已核实的对应建议可带入改稿。</p>':'')+timeline.facts.map(f=>{
  const address=timelineAddress(f.targetId)!;
  const relationEvidence=f.evidence.filter(e=>e.sourceId!==f.boundSource.sourceId||e.quote!==f.boundSource.quote);
  const body=`${(Object.keys(meaningLabels) as (keyof TimelineFact['meaning'])[]).map(key=>`<p><strong>${esc(meaningLabels[key])}：</strong>${esc(f.meaning[key])}</p>`).join('')}<p><strong>核对说明：</strong>${esc(f.explanation)}</p>${quotes(relationEvidence,'时间关系依据')}`;
  return `<details class="evidence timeline-fact"${!auditedFactSupported(review,f.targetId)||f.status!=='consistent'?' open':''}><summary>${esc(address.sceneId)} 第 ${esc(address.line)} 行 · ${esc(factLabel(review,f.targetId,timelineLabels[f.status]))}</summary><div class="bound-source"><p><strong>系统绑定原句</strong> · ${esc(f.boundSource.sourceId)}</p><blockquote>${esc(f.boundSource.quote)}</blockquote><p class="small muted">按场景与行号从本次审稿的冻结剧本中读取；绑定原句不等于确认模型解释。</p></div>${factExplanation(review,f.targetId,timelineLabels[f.status],body)}</details>`;
 }).join('');
}
function omissionView(review:Review,o:unknown):string {
 if(!validOmission(o))return '<p class="inline-warning">遗漏检查记录含无效条目，需重新核实；原建议已暂停带入改稿。</p>';
 const targetId=`omission:${o.category}`,label=assessmentLabels[o.status]??'待核实';
 const supported=auditedFactSupported(review,targetId);
 const body=`<p>${esc(o.explanation)}</p>${o.sceneIds?.length?`<p class="small muted">涉及场景：${o.sceneIds.map(esc).join('、')}</p>`:''}${quotes(o.evidence,'核对依据')}${o.suggestedFix?`<details class="evidence unverified-suggestion"><summary>模型提出的改法（${supported?'待作者确认':'尚未核实'}）</summary><p class="small muted">${supported?'已核对这项建议的原文依据与改法；可选择相关场景生成候选，采用仍由作者决定。':'此改法尚未核实，不能作为已确认事实，也不可直接带入改稿。请先对照原文判断是否合适。'}</p><p>${esc(o.suggestedFix)}</p></details>`:''}`;
 return `<details class="evidence omission-fact"${!auditedFactSupported(review,targetId)||o.status==='issue'||o.status==='uncertain'?' open':''}><summary>${esc(omissionLabels[o.category]??o.category)} · ${esc(factLabel(review,targetId,label))}</summary>${factExplanation(review,targetId,label,body)}${(o.suggestedSceneId?[o.suggestedSceneId]:[]).map(sceneId=>suggestionButton(review,targetId,sceneId)).join('')}</details>`;
}
function auditView(review:Review):string {
 const audit=review.verification?.audit;
 if(!audit)return '<div class="inline-warning" role="status"><strong>旧审稿尚未完成独立解释审计</strong><p>原审稿与核实器的时间、遗漏解释都需独立核对；原建议已暂停带入改稿。</p></div>';
 if(audit.schemaVersion!==5)return '<div class="inline-warning" role="status"><strong>旧审计尚未逐句核对复合陈述</strong><p>需逐段核对解释、修改建议和时间含义中的每个陈述，并确认实际修改场景；旧状态保留，原建议已暂停带入改稿。</p></div>';
 const intact=auditIntact(review),ready=intact&&audit.status==='completed'&&audit.checks.every(c=>c.verdict==='supported');
 return `<div class="${ready?'review-meta':'inline-warning'}" role="status"><strong>${ready?'独立解释审计已完成':intact?'独立解释审计需复核':'独立解释审计记录不完整或校验未通过'}</strong><p>${ready?'已分别核对原审稿与核实器的陈述。':'仅逐项核实通过的建议可带入改稿；被驳回或未核实的意见保留供对照。'}</p>${Array.isArray(audit.errors)&&audit.errors.length?`<ul>${audit.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}</div>${Array.isArray(audit.normalizationNotes)&&audit.normalizationNotes.length?`<details class="evidence normalization-notes"><summary>独立审计输出格式整理记录</summary><ul>${audit.normalizationNotes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>`:''}`;
}
export function verificationView(review:Review):string {
 const v=review.verification;
 if(!v)return `<div class="inline-warning" role="status"><strong>${review.mode==='demo'?'演示记录没有执行解释核实':'旧审稿未核实解释'}</strong><p>这些意见保留供对照，尚未检查解释是否符合原文。重新审读可补齐核实；原建议不会直接带入改稿。</p></div>`;
 const bad=verificationIssueCount(review)>0;
 return `<section class="verification"><h3>核实审稿说法与遗漏</h3><div class="${bad?'inline-warning':'review-meta'}" role="status"><strong>${bad?'发现审稿误读、遗漏或待核实项':'本次核实未发现未解决项'}</strong><p>对照原文检查每条解释，并补查时间、账目和人物选择。核实意见仍可质疑，不是文学质量评分。</p>${!verificationIntact(review)?'<p>核实记录不完整或校验未通过；原建议已暂停带入改稿。</p>':''}${Array.isArray(v.errors)&&v.errors.length?`<ul>${v.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}</div>
 ${Array.isArray(v.normalizationNotes)&&v.normalizationNotes.length?`<details class="evidence normalization-notes"><summary>输出格式整理记录</summary><ul>${v.normalizationNotes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>`:''}
 ${auditView(review)}
 ${timelineView(review)}
 <h4>补查遗漏</h4>${Array.isArray(v.omissions)?v.omissions.map(o=>omissionView(review,o)).join(''):'<p class="inline-warning">遗漏检查记录缺失。</p>'}</section>`;
}
function suggestionButton(review:Review,target:string,sceneId:string|undefined):string {
 if(!sceneId||!reviewSuggestion(review,review.id,target,sceneId))return '';
 return `<button class="text-button" data-action="use-suggestion" data-review-id="${esc(review.id)}" data-target="${esc(target)}" data-scene="${esc(sceneId)}">带入 ${esc(sceneId)} 改稿 →</button>`;
}
function parentAuditTrace(review:Review,target:string):string {
 const audit=review.verification?.audit,fields=fieldTargets(review).filter(f=>f.parentId===target);
 if(!audit||!fields.length)return '';
 const proofTrace=(audit.inferenceChecks??[]).filter(p=>p.targetId.startsWith(target+'#')).map(p=>{
  const gaps=inferenceGaps(p),evidence=[...(p.capacity?.evidence??[]),...(p.capacity?.bridgeEvidence??[]),...(p.object?.identityEvidence??[]),...(p.object?.actionEvidence??[]),...(p.object?.locationEvidence??[])];
  return `<details class="evidence inference-proof"><summary>推理前提核对 · ${esc(p.targetId)} · ${gaps.length?'依据不足':'未发现前提缺口'}</summary><p><strong>模型前提说明（仍可质疑）：</strong>${esc(p.explanation)}</p>${gaps.length?`<ul>${gaps.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>`:''}${quotes(evidence,'推理前提依据')}<p class="small muted">模型填写前提，程序检查完整性并限制结论；引文存在仍不保证语义判断正确。</p></details>`;
 }).join('');
 const children=fields.flatMap(field=>{
  const matches=Array.isArray(audit.fieldChecks)?audit.fieldChecks.filter(c=>c?.targetId===field.id):[];
  return matches.length===1&&validAuditCheck(matches[0])&&matches[0].verdict!=='supported'?[{field,check:matches[0]}]:[];
 });
 const reasons=children.length?`<div class="field-audit"><h4>关键陈述逐项核对</h4>${children.map(({field,check})=>{
  const wholeFix=field.field==='suggestedFix'&&field.id===`${field.parentId}#suggestedFix`;
  const label=wholeFix?'完整改法及修改后结果':field.field==='suggestedFix'?'改法片段':fieldLabels[field.field]??field.field;
  return `<div class="inline-warning"><strong>${esc(label)} · ${esc(verificationLabels[check.verdict])}</strong><p class="small">${wholeFix?'本次核对的完整改法':'本次核对的原文片段'}</p><blockquote>${esc(field.claim)}</blockquote>${field.claim!==field.fullClaim?`<details class="evidence field-context"><summary>查看完整字段上下文</summary><blockquote>${esc(field.fullClaim.slice(0,field.start))}<mark>${esc(field.claim)}</mark>${esc(field.fullClaim.slice(field.end))}</blockquote></details>`:''}${check.claimQuote?`<p class="small">审稿争议原话</p><blockquote>${esc(check.claimQuote)}</blockquote>`:''}<p>${esc(check.explanation)}</p>${correctionView(check.correction)}${quotes(check.evidence,'逐项核对依据')}${quotes(check.counterEvidence,'逐项反向依据')}</div>`;
 }).join('')}</div>`:'';
 const prior=Array.isArray(audit.inferenceOriginalParents)?audit.inferenceOriginalParents.find(c=>c?.targetId===target&&validAuditCheck(c)):undefined;
 const originals=Array.isArray(audit.originalChecks)?audit.originalChecks.filter(c=>c?.targetId===target):[],original=prior??(originals.length===1&&validAuditCheck(originals[0])?originals[0]:undefined);
 return proofTrace+reasons+(original?`<details class="evidence original-parent-audit"><summary>原模型整体判断（逐项核对前）</summary><p class="small muted">此记录仅供对照，不能覆盖逐项核对发现的问题。</p><p>原判断：${esc(verificationLabels[original.verdict])}</p><p>${esc(original.explanation)}</p>${correctionView(original.correction)}${quotes(original.evidence,'原整体判断依据')}${quotes(original.counterEvidence,'原整体判断反向依据')}</details>`:'');
}
function targetCard(review:Review,target:string,title:string,label:string,kind:string,body:string,sceneId?:string):string {
 const supported=reviewTargetSupported(review,target),check=auditCheck(review,target);
 const heading=`<div class="assessment-head"><h3>${esc(title)}</h3><span class="pill">${esc(supported?label:check&&check.verdict!=='supported'?verificationLabels[check.verdict]??'尚未核实':'尚未核实')}</span></div>`;
 const parentTrace=parentAuditTrace(review,target);
 if(supported)return `<article class="assessment ${esc(kind)}" data-review-target="${esc(target)}"${sceneId?` data-scene="${esc(sceneId)}"`:''}>${heading}${body}${parentTrace}${suggestionButton(review,target,fieldTargets(review).find(f=>f.parentId===target&&f.field==='suggestedSceneId')?.claim)}</article>`;
 const correction=check&&check.verdict!=='supported'?`<div class="inline-warning"><p>${esc(check.explanation)}</p>${correctionView(check.correction)}${quotes(check.evidence,'核对依据')}${quotes(check.counterEvidence,'反向依据')}</div>`:'<p class="small muted">此项解释尚未完成有效核实，不能将原结论当成已确认事实。</p>';
 return `<article class="assessment uncertain" data-review-target="${esc(target)}"${sceneId?` data-scene="${esc(sceneId)}"`:''}>${heading}${correction}${parentTrace}<details class="evidence original-review"><summary>原审稿说法与引用（尚不采信）</summary><p class="small muted">原结论：${esc(label)}。以下保留原记录供对照，不会自动带入改稿。</p>${body}</details></article>`;
}
export function assessmentView(review:Review,a:Assessment):string {
 const body=`<p>${esc(a.explanation)}</p>${a.issueType?`<span class="issue-type">${a.issueType==='craft_preference'?'审美建议 · 作者决定':'事实冲突判断 · 请核对依据'}</span>`:''}${a.evidence.map(e=>`<details class="evidence"><summary>查看原文与依据 · ${esc(e.sceneId)}</summary><div><span class="label">剧本原文</span><blockquote>${esc(e.draftQuote)}</blockquote><span class="label">依据 · ${esc(e.sourceId)}</span><blockquote>${esc(e.sourceQuote)}</blockquote></div></details>`).join('')}${a.suggestedFix?`<div class="suggestion"><span class="label">建议方向</span><p>${esc(a.suggestedFix)}</p></div>`:''}`;
 return targetCard(review,`assessment:${a.dimension}`,dimensionLabels[a.dimension]!,assessmentLabels[a.status]!,a.status,body,a.suggestedSceneId);
}
export function lengthView(brief: Brief, scenes: Pick<Scene,'content'>[]): string {
 const c=checkLength(brief,scenes),bad=['too_long','too_short','ambiguous'].includes(c.status);
 return `<div class="${bad?'inline-warning':'review-meta'}" role="status"><strong>篇幅核对</strong><span>${esc(c.message)}</span><small>按正文计算，含人物名与动作，不含标题和梗概；词按空白分隔，纯标点不计。</small></div>`;
}
export function causalityView(review: Review): string {
 const a=review.causality;
 if(!a)return `<p class="inline-warning">${review.mode==='demo'?'演示审稿没有执行独立因果核查。':'这次记录未包含独立因果核查，重新审读可补齐。'}</p>`;
 const labels={supported:'限制有原文支持',gap:'因果缺口',uncertain:'待核实',not_applicable:'没有需排除的物理障碍'};
 const pressureLabels={binding:'代价确实约束目标',gap:'压力与目标脱节',uncertain:'压力关联待核实',background:'环境背景'};
 const pressures=a.pressures?`<h4>倒计时与代价</h4>${a.pressures.length?a.pressures.map((p,i)=>{
  const body=`<p><strong>触发与威胁：</strong>${esc(p.trigger)} → ${esc(p.threatenedOutcome)}</p><p><strong>实际状态：</strong>${esc(p.currentState)}</p><p><strong>绕开代价的行动：</strong>${esc(p.directAlternative)}</p><p>${esc(p.explanation)}</p>${p.evidence.map(e=>`<details class="evidence"><summary>核对原文 · ${esc(e.sourceId)}</summary><blockquote>${esc(e.sourceQuote)}</blockquote><blockquote>${esc(e.draftQuote)}</blockquote></details>`).join('')}${quotes(p.blockingEvidence,'阻断绕行路径的依据')}${p.suggestedFix?`<div class="suggestion"><p>${esc(p.suggestedFix)}</p></div>`:''}`;
  return targetCard(review,`pressure:${i}`,p.sceneId,pressureLabels[p.verdict],p.verdict==='gap'?'issue':p.verdict==='uncertain'?'uncertain':'no_issue',body,p.sceneId);
 }).join(''):'<p class="small muted">此次未列出物理压力；仍需结合逐场记录审读。</p>'}`:'<p class="inline-warning">此旧记录尚未独立核对压力与目标的关联。</p>';
 return `<h3>独立因果核查</h3><p class="small muted">逐场核对已有状态、人物选择和更简单的行动。误读或依据不足的解释单独保留，不直接用于改稿。</p>${pressures}${a.checks.map((c,i)=>{
  const body=`<p><strong>已有状态：</strong>${esc(c.state)}</p><p><strong>人物选择：</strong>${esc(c.choice)}</p><p><strong>更简单的行动：</strong>${esc(c.alternative)}</p><p>${esc(c.explanation)}</p>${c.evidence.map(e=>`<details class="evidence"><summary>核对原文 · ${esc(e.sourceId)} → ${esc(e.sceneId)}</summary><blockquote>${esc(e.sourceQuote)}</blockquote><blockquote>${esc(e.draftQuote)}</blockquote></details>`).join('')}${quotes(c.constraintEvidence,'约束依据')}${c.suggestedFix?`<div class="suggestion"><p>${esc(c.suggestedFix)}</p></div>`:''}`;
  return targetCard(review,`causal:${i}`,c.sceneId,labels[c.verdict],c.verdict==='gap'?'issue':c.verdict==='uncertain'?'uncertain':'no_issue',body,c.sceneId);
 }).join('')}`;
}
