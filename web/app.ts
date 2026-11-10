import type { Brief, Episode, Project, ProjectBundle, Revision, Review, Scene, Localization, PublicationSettings } from '../src/types';

import { languagesView, languageOptions } from './languages';
import { scriptLanguage } from '../src/core/languages';
import { checkLength } from '../src/core/length';
import { lengthView, causalityView, assessmentView, verificationView, reviewIssueCount, reviewCompletionLabel, verificationIssueCount } from './quality';
import { ProviderPanel } from './providers';
import { RewriteInstruction } from './rewriteInstruction';
import { modelAttemptsView } from './modelAttempts';
import { ShotListPanel } from './shotList';
import { DEFAULT_DURATION_TARGET } from '../src/core/formats';
type Tab = 'script' | 'review' | 'compare' | 'shots' | 'history' | 'languages';
type Edit = Pick<Revision, 'title' | 'logline' | 'scenes'>;
const root = document.querySelector<HTMLDivElement>('#app')!;
const key = 'sci-epo-workspace-v1';
const blankBrief = (): Brief => ({ title: '', premise: '', characters: '', worldRules: '', authorRules: '', language: 'en', glossary: '', format: 'vertical_short_drama', durationTarget: {...DEFAULT_DURATION_TARGET} });
const shortDramaExample: Brief = {
  title: '最后一单',
  premise: '深夜送外卖的玛雅，每一单都把她卷进陌生人的家事。每集一单，开场就有一个奇怪的订单备注，结尾揭开一个让她不得不跟进的秘密。',
  characters: '玛雅：二十多岁的外卖员，嘴硬心软，正在还债，规定之外的事都要“加钱”，却总忍不住多管一步。\n老林：七十岁的独居老人，和女儿林安娜五年没有联系，固执，怕被人可怜。',
  worldRules: '现实城市，没有超自然设定。外卖平台显示下单人、付款人和订单备注；骑手只知道屏幕上写的和亲眼看到的事。',
  authorRules: '英文对白。每集 60–120 秒、三场以内，开场几行就要有冲突，结尾留下一个具体的悬念。画面靠表情和手机屏幕交代信息，不用旁白。',
  language: 'en', glossary: 'Maya = 玛雅; Leo = 老林; Anna Lin = 林安娜',
  format: 'vertical_short_drama', durationTarget: {...DEFAULT_DURATION_TARGET},
};
const example: Brief = {
  format: 'episodic',
  title: '轨道杂务局',
  premise: '空间站的两名杂务员必须在停电前送达一份生日礼物。每次用科技省事，都要面对它给别人带来的麻烦。温暖、克制的科幻轻喜剧。',
  characters: '派普：维修机器人，做事过分认真，害怕自己只在出故障时才被需要。\n七号：人类值班员，说话简短，讨厌被代替作决定，但会为承诺承担损失。',
  worldRules: '站内交通依赖轨道平台。停电后平台不能移动。便携喷气包只剩一次推进，不会自动补充能量。角色只能知道亲眼看到或被明确告知的信息。',
  language: 'en', glossary: '派普 = Pip；七号 = Seven；轨道杂务局 = Orbital Odd-Jobs Office',
  authorRules: '英文对白，以可见动作承载情绪。允许沉默和完整收束，不强行说教、反转或恋爱。人物的选择要影响结局。',
};
const readSaved = <T>(storageKey: string, fallback: T): T => { try { const value = localStorage.getItem(storageKey); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const saveLocal = (storageKey: string, value: unknown) => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Server-saved versions remain authoritative. */ } };
const saved = readSaved<{projectId?: string; episodeId?: string}>(key, {});
let projects: Project[] = [];
let bundle: ProjectBundle | null = null;
let episodeId = saved.episodeId ?? '';
let revisionId = '';
let tab: Tab = 'script';
let status: {mode: 'live' | 'unconfigured'; modelLabel: string;management?:boolean} = { mode: 'unconfigured', modelLabel: '正在检查' };
let providerPage=location.hash==='#providers';
let pending = '';
let error = '';
let notice = '';
let modal: 'project' | 'episode' | null = null;
let form = blankBrief();
let formBaseline = blankBrief();
let editingProject = false;
let episodeTitle = '';
let editor: Edit | null = null;
let rewriteSceneId = '';
const rewriteInstruction = new RewriteInstruction();
let acknowledgeReview = false;
let acknowledgeLengthException = false;
let ready = false;
let loginNeeded = false;
let accountEmail: string|null = null;
let csrf = '';
let targetLanguage = 'zh-CN';
let localizationId = '';
let localizedDraft: Localization|undefined;
function chooseLocalization(id?: string) {
  const r=revision();if(!r)return;
  if(targetLanguage===scriptLanguage(r))targetLanguage=targetLanguage==='en'?'zh-CN':'en';
  const matches=bundle!.localizations.filter(l=>l.sourceRevisionId===r.id&&l.language===targetLanguage);
  const found=matches.find(l=>l.id===(id??localizationId))??matches.at(-1);
  localizationId=found?.id??'';localizedDraft=found?readSaved<Localization>(`sci-epo-localization:${found.id}`,structuredClone(found)):undefined;
}
function clearPrivateView() {rewriteInstruction.clear();rewriteSceneId='';projects=[];bundle=null;editor=null;localizedDraft=undefined;revisionId='';episodeId='';modal=null;accountEmail=null;csrf='';providerPanel.reset();shotListPanel.reset();}


const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date = (s: string) => new Date(s).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const episode = (): Episode | undefined => bundle?.episodes.find(e => e.id === episodeId);
const revisions = (): Revision[] => bundle?.revisions.filter(r => r.episodeId === episodeId) ?? [];
const revision = (): Revision | undefined => bundle?.revisions.find(r => r.id === revisionId);
const review = (): Review | undefined => bundle?.reviews.filter(r => r.revisionId === revisionId).at(-1);
const rewriteContext = () => ({revisionId,sceneId:rewriteSceneId,review:review()});
const pickEdit = (r: Revision): Edit => ({title:r.title,logline:r.logline,scenes:structuredClone(r.scenes)});
const dirty = () => !!revision() && !!editor && JSON.stringify(editor) !== JSON.stringify(pickEdit(revision()!));
const draftKey = (id: string) => `sci-epo-draft:${id}`;
const canLeave = () => !dirty() || window.confirm('这版有尚未保存的编辑，已暂存在此浏览器。离开后可回到这版继续，确定离开吗？');
const modeName = (mode: string) => mode === 'demo' ? '演示样例' : mode === 'manual' ? '手动编辑' : '模型生成';
const kindName = (kind: string) => ({generated:'初稿',rewrite:'局部改稿',manual:'手动版本'}[kind] ?? kind);
const disabled = (condition = false) => pending || condition ? 'disabled' : '';
function remember() { if (bundle) saveLocal(key, {projectId:bundle.project.id,episodeId}); }
function persistEditor() { if (revisionId && editor) saveLocal(draftKey(revisionId), editor); updateDirtyBadge(); }
function setRevision(id: string) {
  const sameRevision = revisionId === id;
  revisionId = id;
  const r = revision();
  editor = r ? readSaved<Edit>(draftKey(id), pickEdit(r)) : null;
  // Do not trust an obsolete local draft to introduce scene identities or bypass server locks.
  if (r && editor && (typeof editor.title !== 'string' || typeof editor.logline !== 'string' || !Array.isArray(editor.scenes) || editor.scenes.length !== r.scenes.length || editor.scenes.some((s,i) => !s || s.id !== r.scenes[i]?.id || typeof s.heading !== 'string' || typeof s.content !== 'string' || s.locked !== r.scenes[i]?.locked))) editor = pickEdit(r);
  if (!sameRevision || !r?.scenes.some(s=>s.id===rewriteSceneId&&!s.locked)) rewriteSceneId = r?.scenes.find(s => !s.locked)?.id ?? '';
  if (!sameRevision) {rewriteInstruction.clear();shotListPanel.reset();}
  acknowledgeReview = false; acknowledgeLengthException = false;
  chooseLocalization();
}
function updateDirtyBadge() {
  const lengthElement=document.querySelector('#length-check');
  if(lengthElement&&editor&&revision())lengthElement.innerHTML=lengthView(revision()!.context.brief,editor.scenes);
  const el = document.querySelector('#draft-status');
  if (el) { el.textContent = dirty() ? '编辑已暂存 · 尚未保存为版本' : '已保存'; el.classList.toggle('is-dirty',dirty()); }
  document.querySelectorAll<HTMLButtonElement>('[data-requires-saved]').forEach(el => { el.disabled = !!pending || dirty() || (el.dataset.requiresLive === 'true' && status.mode !== 'live'); });
  const adopt = document.querySelector<HTMLButtonElement>('[data-action="accept"]');
  if (adopt) adopt.disabled = !!pending || dirty() || !acknowledgeReview || (episode()?.acceptedRevisionId === revisionId && !episode()?.needsReview);
  document.querySelectorAll<HTMLButtonElement>('[data-action="rewrite"]').forEach(el => { const id=el.dataset.mode==='demo'?'s3':rewriteSceneId; el.disabled=!!pending||dirty()||!id||!!revision()?.scenes.find(s=>s.id===id)?.locked||(el.dataset.mode==='live'&&(status.mode!=='live'||!!rewriteInstruction.problem(rewriteContext()))); });
  const originWarning=document.querySelector<HTMLElement>('#rewrite-origin-warning');
  if(originWarning){const problem=rewriteInstruction.problem(rewriteContext());originWarning.hidden=!problem;originWarning.textContent=problem??'';}
  const save = document.querySelector<HTMLButtonElement>('[data-action="save-script"]');
  if (save) save.disabled = !!pending || !dirty();
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', ...(csrf?{'X-CSRF-Token':csrf}:{}), ...options.headers } });
  const data = await res.json().catch(() => ({error:'服务器未返回有效结果，请查看运行状态。'}));
  if (res.status===401) {loginNeeded=true;clearPrivateView();}
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`);
  return data as T;
}
const post = <T>(path: string, value: unknown) => api<T>(path, {method:'POST',body:JSON.stringify(value)});
const providerPanel=new ProviderPanel({api,run,render,refreshStatus:async()=>{status=await api<typeof status>('/api/status');}});
const shotListPanel=new ShotListPanel({run,post,reload:async revisionId=>{if(bundle)await loadProject(bundle.project.id,revisionId);},render,notice:message=>{notice=message;},fail:message=>{error=message;render();},confirm:message=>window.confirm(message)});
const shotContext=()=>({bundle:bundle!,revision:revision()!,episode:episode()!,busy:!!pending,live:status.mode==='live',dirty:dirty()});
async function loadProject(id: string, selectRevision?: string) {
  bundle = await api<ProjectBundle>(`/api/projects/${encodeURIComponent(id)}`);
  if (!bundle.episodes.some(e => e.id === episodeId)) episodeId = bundle.episodes[0]?.id ?? '';
  setRevision(selectRevision ?? (revisions().some(r => r.id === revisionId) ? revisionId : revisions().at(-1)?.id ?? ''));
  remember();
}
async function run(label: string, action: () => Promise<void>) {
  if (pending) return;
  pending = label; error = ''; notice = ''; render();
  try { await action(); } catch (err) {
    error = err instanceof Error ? err.message : '操作未完成，请重试。';
    if (bundle) { try { bundle = await api<ProjectBundle>(`/api/projects/${encodeURIComponent(bundle.project.id)}`); } catch { /* Keep the original failure and unsaved input. */ } }
  }
  finally { pending = ''; render(); }
}
function sidebar() {
  return `<aside class="sidebar"><a class="brand" href="/" aria-label="Sci-epo 首页"><span class="brand-symbol">S<span>↗</span></span><span>SCI·EPO<small>编剧工作台</small></span></a>
    <div class="nav-section"><div class="nav-label">创作空间 <button class="icon-button" data-action="new-project" aria-label="新建系列" ${disabled()}>＋</button></div>
    ${projects.length ? `<label class="sr-only" for="project-select">选择系列</label><select id="project-select" ${disabled()}>${projects.map(p=>`<option value="${esc(p.id)}" ${bundle?.project.id===p.id?'selected':''}>${esc(p.title)}</option>`).join('')}</select>` : '<p class="sidebar-note">还没有系列，先留下一个故事的种子。</p>'}
    ${bundle?`<button class="nav-link" data-action="edit-project" ${disabled()}><span>☷</span> 系列设定 <span class="arrow">↗</span></button>`:''}</div>
    <div class="nav-section episodes"><div class="nav-label">分集剧本 ${bundle?`<button class="icon-button" data-action="new-episode" aria-label="新建分集" ${disabled()}>＋</button>`:''}</div>
    ${bundle?.episodes.map(e=>`<button class="episode ${e.id===episodeId?'selected':''}" data-action="select-episode" data-id="${esc(e.id)}" ${disabled()}><span class="episode-number">${String(e.ordinal).padStart(2,'0')}</span><span class="episode-name">${esc(e.title)}<small>${e.needsReview?'前文变更 · 待复核':e.acceptedRevisionId?'已有定稿':'创作中'}</small></span>${e.acceptedRevisionId?'<span class="dot"></span>':''}</button>`).join('') ?? ''}
    ${bundle&&!bundle.episodes.length?'<p class="sidebar-note">第一集，从这里开始。</p>':''}</div>
    ${status.management?`<button class="nav-link provider-nav ${providerPage?'selected':''}" data-action="open-providers" ${disabled()}>⚙ <span>模型服务</span><span class="arrow">↗</span></button>`:''}${accountEmail?`<div class="account-row"><small>${esc(accountEmail)}</small><button class="text-button" data-action="logout" ${disabled()}>退出登录</button></div>`:''}<div class="sidebar-bottom"><span class="status-dot ${status.mode==='live'?'online':''}"></span><div>${status.mode==='live'?'模型配置已加载':'写作服务未配置'}<small>剧本优先 · 作者定稿</small></div></div>
  </aside>`;
}
function header() {
  const e=episode(),r=revision();
  return `<header class="workspace-header"><div><div class="eyebrow">${bundle?esc(bundle.project.title):'YOUR NEXT STORY'}${e?` <span>/</span> EPISODE ${String(e.ordinal).padStart(2,'0')}`:''}</div><h1>${e?esc(e.title):bundle?'写下第一集':'让好故事先发生。'}</h1></div><div class="header-actions">${r?`<span class="pill ${r.mode==='demo'?'demo':''}">${modeName(r.mode)}</span><a class="button subtle" href="/api/revisions/${encodeURIComponent(r.id)}/export" download>导出剧本 ↗</a>`:''}</div></header>`;
}
function emptyState() {
  if (!bundle) return `<section class="welcome"><div class="welcome-index">01 / 故事起点</div><h2>一个值得讲下去的故事。</h2><p>先确定人物在乎什么、世界如何运作，<br>再让他们在一场戏里做出选择。</p><button class="button primary" data-action="new-project">建立第一个系列 <span>＋</span></button><div class="journey"><span>创作设定</span><b>→</b><span>剧本初稿</span><b>→</b><span>审读与改稿</span><b>→</b><span>作者定稿</span></div></section>`;
  if (!episode()) return `<section class="welcome"><div class="welcome-index">${esc(bundle.project.title)}</div><h2>从第一场戏开始。</h2><p>${esc(bundle.project.premise)}</p><button class="button primary" data-action="new-episode">新建第一集 ＋</button><button class="button subtle" data-action="edit-project">查看系列设定</button></section>`;
  const lastRun=bundle.runs.filter(r=>r.episodeId===episodeId).at(-1);
  const runNote=lastRun?.status==='failed'?`<div class="inline-warning">上次生成未完成：${esc(lastRun.error)}。失败记录已保留。</div>`:lastRun?.status==='running'?'<div class="inline-warning">本集仍有任务正在运行。完成后刷新可查看结果，请勿重复提交。</div>':'';
  return `<section class="welcome compact">${runNote}<div class="welcome-index">第一版剧本</div><h2>让人物走进场景。</h2><p>根据系列设定和已经采用的前集，生成可编辑的分场剧本。<br>初稿会独立保存，审读后再决定如何修改。</p><button class="button primary" data-action="generate" data-mode="live" ${disabled(status.mode!=='live')}>生成剧本初稿 <span>↗</span></button>${status.mode!=='live'?'<p class="muted small">写作服务尚未配置。服务接通后可使用真实生成。</p>':''}<div class="demo-offer"><span>先熟悉流程</span><button class="text-button" data-action="generate" data-mode="demo" ${disabled()}>载入演示样例 →</button><small>预设文本，仅用于体验编辑、审稿和改稿操作。</small></div></section>`;
}
function tabs() { return `<nav class="tabs" aria-label="剧本工作区">${([['script','剧本'],['review','审读意见'],['compare','版本对读'],['shots','分镜'],['history','版本记录'],['languages','语言与发布']] as const).map(([id,label])=>`<button data-action="tab" data-id="${id}" class="${tab===id?'active':''}" aria-current="${tab===id?'page':'false'}">${label}${id==='review'&&review()?`<span class="tab-count">${reviewIssueCount(review()!,['too_long','too_short','ambiguous'].includes(checkLength(revision()!.context.brief,revision()!.scenes).status))}</span>`:''}</button>`).join('')}</nav>`; }
function scriptView() {
  const r=revision()!;
  if (!editor) return '';
  return `<div class="script-toolbar"><div><span class="label">当前版本</span><strong>V${revisions().findIndex(v=>v.id===r.id)+1}</strong><span id="draft-status" class="small muted ${dirty()?'is-dirty':''}">${dirty()?'编辑已暂存 · 尚未保存为版本':'已保存'}</span></div><button class="button small-button" data-action="save-script" ${disabled(!dirty())}>保存新版本</button></div>
    ${modelAttemptsView(bundle!.runs.filter(run=>run.resultId===r.id&&(run.kind==='rewrite'||run.kind==='generate')).at(-1))}<div id="length-check">${lengthView(r.context.brief,editor.scenes)}</div><article class="script-paper"><div class="paper-kicker">${esc(bundle!.project.title)} / SCRIPT</div><label class="sr-only" for="script-title">剧本标题</label><input id="script-title" class="script-title" value="${esc(editor.title)}" ${disabled()}/><label class="field-label" for="script-logline">本集梗概</label><textarea id="script-logline" class="logline" rows="2" ${disabled()}>${esc(editor.logline)}</textarea>
    ${editor.scenes.map((s,i)=>`<section class="scene" id="scene-${esc(s.id)}"><div class="scene-top"><span class="scene-number">SCENE ${String(i+1).padStart(2,'0')}</span><button class="lock-button ${s.locked?'locked':''}" data-action="toggle-lock" data-id="${esc(s.id)}" data-requires-saved ${disabled(dirty())}>${s.locked?'● 已锁定 · 点击解锁':'○ 锁定这场'}</button></div><label class="sr-only" for="heading-${esc(s.id)}">第 ${i+1} 场场景标题</label><input class="scene-heading" id="heading-${esc(s.id)}" data-scene-field="heading" data-id="${esc(s.id)}" value="${esc(s.heading)}" ${disabled(s.locked)}/><label class="sr-only" for="content-${esc(s.id)}">第 ${i+1} 场剧本正文</label><textarea class="scene-content" id="content-${esc(s.id)}" data-scene-field="content" data-id="${esc(s.id)}" rows="${Math.max(7,s.content.split('\n').length+1)}" ${disabled(s.locked)}>${esc(s.content)}</textarea><div class="scene-bottom"><span>${s.content.length} 字</span><button class="text-button" data-action="focus-rewrite" data-id="${esc(s.id)}" ${disabled(s.locked)}>修改这场 ↗</button></div></section>`).join('')}
    <div class="paper-end">— 本版结束 —</div></article>`;
}
function reviewView() {
  const rv=review(),r=revision()!;
  return `<section class="review-view"><div class="section-title"><div><div class="eyebrow">READ, QUESTION, REVISE</div><h2>让修改有据可循。</h2></div><button class="button primary" data-action="review" data-mode="live" data-requires-saved data-requires-live="true" ${disabled(dirty()||status.mode!=='live')}>${rv?'重新审读':'审读这版'}</button></div><p class="muted review-intro">从故事、人物、对白、连续性和场面五个角度读稿。先检查因果和五维，再对照原文核实解释、补查遗漏。未经核实的原建议不会直接用于改稿；程序另行核对篇幅。</p>${rv&&rv.mode!=='demo'?`<button class="text-button" data-action="verify-review" data-requires-saved data-requires-live="true" ${disabled(dirty()||status.mode!=='live')}>仅核实这份审稿的解释与遗漏 →</button>`:''}${r.mode==='demo'?`<button class="text-button demo-action" data-action="review" data-mode="demo" data-requires-saved ${disabled(dirty())}>体验预设的演示审稿 →</button>`:''}
    ${rv?`<div class="review-meta"><span>${rv.mode==='demo'?'预设审稿演示':'模型辅助审读'} · ${date(rv.createdAt)}</span><strong>${reviewCompletionLabel(rv)}</strong></div>${modelAttemptsView(bundle!.runs.filter(run=>run.kind==='review'&&run.resultId===rv.id).at(-1))}${rv.errors.length?`<div class="inline-warning"><strong>以下项目尚不能视为完成</strong><ul>${rv.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul></div>`:''}${lengthView(r.context.brief,r.scenes)}${verificationView(rv)}${causalityView(rv)}<h3>五维审读</h3>${rv.assessments.map(a=>assessmentView(rv,a)).join('')}`:'<div class="empty-panel"><span class="empty-mark">¶</span><h3>这版还没有审读意见</h3><p>保存当前编辑后发起审读，原文和设定依据会保留在意见旁。</p></div>'}</section>`;
}
function compareView() {
  const r=revision()!,parent=bundle!.revisions.find(p=>p.id===r.parentId);
  if (!parent) return '<section class="empty-panel"><span class="empty-mark">↔</span><h3>初稿还没有对照版本</h3><p>保存一次编辑或生成局部改稿后，可在这里逐场比较。</p></section>';
  return `<section class="compare-view"><div class="section-title"><div><div class="eyebrow">BEFORE / AFTER</div><h2>把变化放在一起看。</h2></div></div><p class="muted">${esc(r.instruction || '手动调整，原版保留。')}</p>${modelAttemptsView(bundle!.runs.filter(run=>run.kind==='rewrite'&&run.resultId===r.id).at(-1))}<div class="compare-head"><span>原版 · ${esc(parent.title)}</span><span>当前候选 · ${esc(r.title)}</span></div>${r.scenes.map(s=>{const before=parent.scenes.find(p=>p.id===s.id);const changed=!before||before.content!==s.content||before.heading!==s.heading;return `<section class="compare-scene"><div class="compare-label">${esc(s.id)} <span class="pill ${changed?'changed':''}">${changed?'内容有变化':'内容保持'}</span></div><div class="compare-grid"><div><h3>${esc(before?.heading??'新增场景')}</h3><pre>${esc(before?.content??'')}</pre></div><div class="${changed?'changed-text':''}"><h3>${esc(s.heading)}</h3><pre>${esc(s.content)}</pre></div></div></section>`;}).join('')}</section>`;
}
function historyView() {
  const rows = [...revisions()].reverse();
  const runs = bundle!.runs.filter(r=>r.episodeId===episodeId).slice().reverse();
  return `<section class="history-view"><div class="section-title"><div><div class="eyebrow">EVERY DRAFT MATTERS</div><h2>每一版，都留得住。</h2></div><button class="button primary" data-action="generate" data-mode="live" ${disabled(status.mode!=='live')}>另写一版初稿</button></div><p class="muted">只有明确采用的版本会成为后续分集的依据。</p><div class="version-list">${rows.map((r,i)=>`<button class="version-row ${r.id===revisionId?'current':''}" data-action="select-revision" data-id="${esc(r.id)}" ${disabled()}><span class="version-index">V${rows.length-i}</span><span class="version-body"><strong>${esc(r.title)}</strong><small>${kindName(r.kind)} · ${modeName(r.mode)} · ${date(r.createdAt)}</small><span>${esc(r.instruction || r.logline)}</span></span><span>${r.id===episode()?.acceptedRevisionId?'<span class="pill accepted">已采用</span>':r.id===revisionId?'正在阅读':'查看 →'}</span></button>`).join('')}</div>${runs.length?`<details class="run-history"><summary>查看生成与审稿运行记录（${runs.length}）</summary>${runs.map(r=>`<div class="run-row"><span>${({generate:'生成初稿',review:'审读',rewrite:'局部改稿',localize:'语言改编',storyboard:'分镜表'}[r.kind])} · ${modeName(r.mode)}</span><span class="${r.status==='failed'?'error-text':''}">${({running:'处理中',succeeded:'完成',failed:'失败'}[r.status])} · ${date(r.createdAt)}</span>${r.modelSnapshot?`<p class="small muted">${esc(r.modelSnapshot.modelName)} · ${esc(r.modelSnapshot.modelId)} · 模型 v${r.modelSnapshot.modelRef.revision} · 分配 v${r.modelSnapshot.routingVersion}</p>`:''}${r.error?`<p>${esc(r.error)}</p>`:''}${modelAttemptsView(r)}</div>`).join('')}</details>`:''}</section>`;
}
function inspector() {
  const r=revision()!,e=episode()!,rv=review(),lengthProblem=['too_long','too_short','ambiguous'].includes(checkLength(r.context.brief,r.scenes).status);
  return `<aside class="inspector"><section class="inspector-section"><div class="eyebrow">NEXT DRAFT</div><h2>一次，改好一场。</h2><p class="muted small">说明你想解决的问题。候选会另存，其他场景保持原样。</p><label class="field-label" for="rewrite-scene">选择场景</label><select id="rewrite-scene" ${disabled()}>${r.scenes.map(s=>`<option value="${esc(s.id)}" ${s.id===rewriteSceneId?'selected':''} ${s.locked?'disabled':''}>${esc(s.heading)}${s.locked?'（已锁定）':''}</option>`).join('')}</select><label class="field-label" for="rewrite-instruction">修改意图</label><textarea id="rewrite-instruction" rows="5" placeholder="例如：保留发生的事，让派普用行动表达歉意，删去重复解释。" ${disabled()}>${esc(rewriteInstruction.value)}</textarea><div id="rewrite-origin-warning" class="inline-warning small" role="status" ${rewriteInstruction.problem(rewriteContext())?'':'hidden'}>${esc(rewriteInstruction.problem(rewriteContext())??'')}</div><button class="button primary full-width" data-action="rewrite" data-mode="live" data-requires-saved data-requires-live="true" ${disabled(dirty()||status.mode!=='live'||!rewriteSceneId||!!rewriteInstruction.problem(rewriteContext()))}>生成改稿候选 →</button>${r.mode==='demo'?`<button class="text-button demo-action" data-action="rewrite" data-mode="demo" data-requires-saved ${disabled(dirty()||!r.scenes.some(s=>s.id==='s3'&&!s.locked))}>体验第三场示例改稿</button>`:''}<p class="small muted">${dirty()?'请先保存编辑，再审读或生成改稿。':'锁定场景不会被改写。'}</p></section>
    <section class="inspector-section adoption"><div class="eyebrow">AUTHOR'S CUT</div><h3>${e.needsReview?'复核前文变化':e.acceptedRevisionId===r.id?'这版已采用':'由你决定定稿'}</h3>${e.needsReview?'<div class="inline-warning small">前文已变化。本版的模型审稿仍使用写作时的资料；请人工对照最新前文，或在版本记录中按新设定另写初稿。</div>':''}<p class="small muted">${!rv?'本版尚未审读。采用前请自行通读确认。':rv.status==='needs_review'||verificationIssueCount(rv)>0?'审读尚有待核实项。采用前请逐项检查。':'审读意见不自动决定定稿，请结合你的创作意图判断。'}</p>${lengthProblem?`<div class="inline-warning small">${esc(checkLength(r.context.brief,r.scenes).message)}<label class="check-label"><input id="length-exception" type="checkbox" ${acknowledgeLengthException?'checked':''} ${disabled()}/><span>我确认保留此篇幅例外，再采用这版。</span></label></div>`:''}<label class="check-label"><input id="adopt-ack" type="checkbox" ${acknowledgeReview?'checked':''} ${disabled(e.acceptedRevisionId===r.id&&!e.needsReview)}/><span>我已读过这版，并愿意采用为本集正式内容。</span></label><button class="button full-width" data-action="accept" data-requires-saved ${disabled(dirty()||!acknowledgeReview||(e.acceptedRevisionId===r.id&&!e.needsReview))}>${e.needsReview?'复核并确认这版':'采用这版'}</button></section>
    <details class="context-details"><summary>本版采用的创作依据</summary><p class="small muted">生成时保存的设定快照；当前设定的后续修改不会覆盖它。</p><h4>故事设想</h4><p>${esc(r.context.brief.premise)}</p><h4>人物</h4><p>${esc(r.context.brief.characters)}</p><h4>世界规则</h4><p>${esc(r.context.brief.worldRules)}</p><h4>作者要求</h4><p>${esc(r.context.brief.authorRules)}</p><p class="small muted">参考已定稿前集：${r.context.previousEpisodes.length} 集</p></details>
  </aside>`;
}
function modalView() {
  if (!modal) return '';
  const modalMessage=`${error?`<div class="message error" role="alert">${esc(error)}</div>`:''}${pending?`<div class="message progress" aria-live="polite"><span class="spinner"></span>${esc(pending)}</div>`:''}`;
  if (modal==='episode') return `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="modal-title" class="modal narrow"><div class="modal-heading"><h2 id="modal-title">新的一集</h2><button class="icon-button" data-action="close-modal" aria-label="关闭" ${disabled()}>×</button></div>${modalMessage}<form id="episode-form"><label class="field-label" for="episode-title">分集名称或创作命题</label><input id="episode-title" name="title" value="${esc(episodeTitle)}" placeholder="例如：停电前的最后一份礼物" maxlength="200" required ${disabled()}/><p class="small muted">生成时将引用本系列设定和已经采用的前集。</p><div class="modal-actions"><button type="button" class="button subtle" data-action="close-modal" ${disabled()}>取消</button><button type="submit" class="button primary" ${disabled()}>创建分集</button></div></form></section></div>`;
  return `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="modal-title" class="modal"><div class="modal-heading"><div><div class="eyebrow">SERIES BIBLE</div><h2 id="modal-title">${editingProject?'系列设定':'建立一个故事世界'}</h2></div><button class="icon-button" data-action="close-modal" aria-label="关闭" ${disabled()}>×</button></div>${modalMessage}<form id="project-form"><div class="form-lead"><p class="muted small">写下真正影响人物选择的设定。你可以随创作逐步补充。</p>${!editingProject?'<button type="button" class="text-button" data-action="fill-example">填入创作示例</button>':''}</div><label class="field-label" for="brief-title">系列名称</label><input id="brief-title" name="title" value="${esc(form.title)}" placeholder="你的系列名称" required maxlength="200" ${disabled()}/><label class="field-label" for="brief-language">剧本原稿语言</label><select id="brief-language" name="language" ${disabled()}>${languageOptions(form.language??'zh-CN')}</select><label class="field-label" for="brief-format">剧集格式 <span>决定写法、审稿标准和分镜画幅</span></label><select id="brief-format" name="format" ${disabled()}><option value="vertical_short_drama" ${form.format==='vertical_short_drama'?'selected':''}>竖屏短剧 · 9:16，每集一两分钟</option><option value="episodic" ${form.format!=='vertical_short_drama'?'selected':''}>常规剧集 · 横屏，单集更长</option></select><fieldset class="length-settings" id="duration-settings" ${form.format==='vertical_short_drama'?'':'hidden'}><legend>每集目标时长（秒）</legend><label class="field-label" for="duration-min">下限</label><input id="duration-min" type="number" min="10" max="600" value="${esc(form.durationTarget?.min??DEFAULT_DURATION_TARGET.min)}" ${disabled()}/><label class="field-label" for="duration-max">上限</label><input id="duration-max" type="number" min="10" max="600" value="${esc(form.durationTarget?.max??DEFAULT_DURATION_TARGET.max)}" ${disabled()}/><p class="small muted">按台词念完、动作演完估算。分镜表会对照这个范围。</p></fieldset><fieldset class="length-settings"><legend>整集正文篇幅（可选）</legend><label class="field-label" for="length-min">下限</label><input id="length-min" type="number" min="1" max="100000" value="${esc(form.lengthTarget?.min||'')}" ${disabled()}/><label class="field-label" for="length-max">上限</label><input id="length-max" type="number" min="1" max="100000" value="${esc(form.lengthTarget?.max||'')}" ${disabled()}/><label class="field-label" for="length-unit">计数单位</label><select id="length-unit" ${disabled()}><option value="words" ${form.lengthTarget?.unit!=='characters'?'selected':''}>词（英文等空格分词语言）</option><option value="characters" ${form.lengthTarget?.unit==='characters'?'selected':''}>字（不含空白，适合中文）</option></select><p class="small muted">包括正文里的角色名与动作，排除标题和梗概。此范围优先于文字简报；留空则识别简报中明确的整集范围。</p></fieldset><label class="field-label" for="brief-premise">故事设想 <span>观众为什么要关心这件事？</span></label><textarea id="brief-premise" name="premise" rows="3" required ${disabled()}>${esc(form.premise)}</textarea><label class="field-label" for="brief-characters">人物与关系 <span>欲望、底线和说话方式</span></label><textarea id="brief-characters" name="characters" rows="3" ${disabled()}>${esc(form.characters)}</textarea><label class="field-label" for="brief-worldRules">世界规则 <span>能力、限制与代价</span></label><textarea id="brief-worldRules" name="worldRules" rows="3" ${disabled()}>${esc(form.worldRules)}</textarea><label class="field-label" for="brief-authorRules">作者要求 <span>文风与需要保留的内容</span></label><textarea id="brief-authorRules" name="authorRules" rows="3" ${disabled()}>${esc(form.authorRules)}</textarea><label class="field-label" for="brief-glossary">跨语言术语表 <span>人物名、地名和科技设定的固定译名</span></label><textarea id="brief-glossary" name="glossary" rows="3" ${disabled()}>${esc(form.glossary??'')}</textarea>${editingProject?'<p class="small muted">修改设定影响后续生成；已有剧本的创作快照继续保留。</p>':''}<div class="modal-actions"><button type="button" class="button subtle" data-action="close-modal" ${disabled()}>取消</button><button type="submit" class="button primary" ${disabled()}>${editingProject?'保存设定':'创建系列 →'}</button></div></form></section></div>`;
}
function render() {
  if(loginNeeded){root.innerHTML=`<main class="login-shell"><section class="login-card"><div class="wordmark">SCI·EPO</div><div class="eyebrow">YOUR PRIVATE WRITING ROOM</div><h1>回到你的故事。</h1><p class="muted">登录编剧工作台</p>${error?`<div class="message error" role="alert">${esc(error)}</div>`:''}<form id="login-form"><label class="field-label" for="login-email">邮箱</label><input id="login-email" name="email" type="email" autocomplete="username" required ${disabled()}/><label class="field-label" for="login-password">密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required ${disabled()}/><button class="button primary full-width" type="submit" ${disabled()}>${pending?'正在登录…':'登录创作空间 →'}</button></form><p class="small muted">英文原稿 · 多语言改编 · 作者定稿</p></section></main>`;return;}
  root.innerHTML=`<div class="app-shell">${sidebar()}<main class="workspace">${providerPage?'<header class="workspace-header"><div><div class="eyebrow">MODEL SERVICES</div><h1>模型服务</h1></div><button class="button subtle" data-action="close-providers">返回剧本 →</button></header>':header()}<div class="message-area" aria-live="polite">${pending?`<div class="message progress"><span class="spinner"></span>${esc(pending)}<span class="small">请稍候，完成后会保留为独立记录。</span></div>`:''}${error?`<div class="message error" role="alert"><span>${esc(error)}</span><button class="text-button" data-action="dismiss-error">关闭</button></div>`:''}${notice?`<div class="message success">${esc(notice)}</div>`:''}</div>${providerPage?providerPanel.view(!!pending):revision()?`${tabs()}<div class="writing-layout ${tab==='languages'||tab==='shots'?'wide-layout':''}"><div class="writing-main">${tab==='script'?scriptView():tab==='review'?reviewView():tab==='compare'?compareView():tab==='shots'?shotListPanel.view(shotContext()):tab==='languages'?languagesView(bundle!,revision()!,targetLanguage,localizationId,localizedDraft,!!pending,status.mode==='live',dirty()):historyView()}</div>${tab==='languages'||tab==='shots'?'':inspector()}</div>`:ready?emptyState():'<div class="empty-panel"><p>正在读取创作空间…</p></div>'}</main></div>${modalView()}`;
  if (modal) requestAnimationFrame(()=>document.querySelector<HTMLInputElement>(modal==='episode'?'#episode-title':'#brief-title')?.focus());
}

root.addEventListener('input', event=>{
  const el=event.target as HTMLInputElement|HTMLTextAreaElement;
  if(providerPanel.input(el as HTMLInputElement))return;
  if(shotListPanel.input(el))return;
  if(el.id==='brief-format'){
    form.format=el.value==='episodic'?'episodic':'vertical_short_drama';
    if(form.format==='vertical_short_drama'&&!form.durationTarget)form.durationTarget={...DEFAULT_DURATION_TARGET};
    const fieldset=document.querySelector<HTMLElement>('#duration-settings');if(fieldset)fieldset.hidden=form.format!=='vertical_short_drama';
    return;
  }
  if(el.id==='duration-min'||el.id==='duration-max'){
    const current=form.durationTarget??{...DEFAULT_DURATION_TARGET};
    form.durationTarget={...current,[el.id==='duration-min'?'min':'max']:Number(el.value)};
    return;
  }
  if(el.dataset.localizationField&&localizedDraft){
    const field=el.dataset.localizationField;
    if(field==='title'||field==='logline')localizedDraft[field]=el.value;
    else {const scene=localizedDraft.scenes[Number(el.dataset.localizationScene)];if(scene&&(field==='heading'||field==='content'))scene[field]=el.value;}
    saveLocal(`sci-epo-localization:${localizedDraft.id}`,localizedDraft);return;
  }
  if (['length-min','length-max','length-unit'].includes(el.id)) {
    const value={min:form.lengthTarget?.min??0,max:form.lengthTarget?.max??0,unit:form.lengthTarget?.unit??'words' as const};
    if(el.id==='length-min')value.min=Number(el.value);else if(el.id==='length-max')value.max=Number(el.value);else value.unit=el.value as 'words'|'characters';
    if(!value.min&&!value.max&&el.id!=='length-unit')delete form.lengthTarget;else form.lengthTarget=value;
    return;
  }
  if (el.id.startsWith('brief-')) form[el.name as Exclude<keyof Brief,'lengthTarget'|'format'|'durationTarget'>]=el.value;
  else if (el.id==='episode-title') episodeTitle=el.value;
  else if (el.id==='rewrite-instruction') {rewriteInstruction.edit(el.value);updateDirtyBadge();}
  else if (editor) {
    if (el.id==='script-title') editor.title=el.value;
    else if (el.id==='script-logline') editor.logline=el.value;
    else if (el.dataset.sceneField) { const s=editor.scenes.find(s=>s.id===el.dataset.id); if (s&&!s.locked) s[el.dataset.sceneField as 'heading'|'content']=el.value; }
    else return;
    persistEditor();
  }
});
root.addEventListener('change', event=>{
  const el=event.target as HTMLInputElement|HTMLSelectElement;
  if(providerPanel.input(el))return;
  if(shotListPanel.change(el))return;
  if(el.id==='target-language'){targetLanguage=el.value;chooseLocalization();render();return;}
  if(el.id==='localization-version'){chooseLocalization(el.value);render();return;}
  if (el.id==='rewrite-scene') {rewriteSceneId=el.value;updateDirtyBadge();}
  if (el.id==='length-exception') acknowledgeLengthException=(el as HTMLInputElement).checked;
  if (el.id==='adopt-ack') { acknowledgeReview=(el as HTMLInputElement).checked; const b=document.querySelector<HTMLButtonElement>('[data-action="accept"]'); if (b) b.disabled=!acknowledgeReview||dirty()||!!pending||(episode()?.acceptedRevisionId===revisionId&&!episode()?.needsReview); }
  if (el.id==='project-select') { if (providerPage&&!providerPanel.canLeave()){el.value=bundle?.project.id??'';return;} if (!canLeave()) { el.value=bundle?.project.id??'';return; } void run('正在打开系列…',async()=>{providerPage=false;providerPanel.reset();history.replaceState(null,'',location.pathname);episodeId='';revisionId='';await loadProject(el.value);}); }
});
root.addEventListener('submit', event=>{
  event.preventDefault();
  if(pending)return;
  const target=event.target as HTMLFormElement;
  if(providerPanel.submit(target))return;
  if(target.id==='login-form'){
    const fields=new FormData(target),email=String(fields.get('email')),password=String(fields.get('password'));
    void run('正在登录…',async()=>{const session=await post<{email:string;csrf:string}>('/api/auth/login',{email,password});accountEmail=session.email;csrf=session.csrf;loginNeeded=false;await init();});return;
  }
  if(target.id==='localization-form'&&localizedDraft){const draft=structuredClone(localizedDraft);void run('正在保存译稿…',async()=>{const l=await post<Localization>(`/api/localizations/${encodeURIComponent(draft.id)}/edit`,{title:draft.title,logline:draft.logline,scenes:draft.scenes});localStorage.removeItem(`sci-epo-localization:${draft.id}`);await loadProject(bundle!.project.id,revisionId);chooseLocalization(l.id);notice='译稿已另存，原稿和旧译稿保留。';});return;}
  if(target.id==='voice-languages-form'){
    const fields=new FormData(target),projectLanguage=bundle!.project.language??'zh-CN';
    const languages=[projectLanguage,...fields.getAll('voiceLanguages').map(String).filter(l=>l!==projectLanguage)];
    void run('正在保存配音语言…',async()=>{bundle=await api<ProjectBundle>(`/api/projects/${encodeURIComponent(bundle!.project.id)}/voice-languages`,{method:'PUT',body:JSON.stringify({languages})});notice='配音语言已保存。之后生成的分镜表会按这些语言对照台词。';});return;
  }
  if(target.id==='publication-form'){const fields=new FormData(target);const settings:PublicationSettings={audioLanguage:String(fields.get('audioLanguage')),subtitleLanguages:fields.getAll('subtitleLanguages').map(String),subtitleStyle:String(fields.get('subtitleStyle')) as PublicationSettings['subtitleStyle'],platform:String(fields.get('platform')) as PublicationSettings['platform']};void run('正在保存发布选择…',async()=>{bundle=await api<ProjectBundle>(`/api/projects/${encodeURIComponent(bundle!.project.id)}/publication`,{method:'PUT',body:JSON.stringify(settings)});notice='发布规格已保存。配音、视频与字幕时间轴将在制作阶段生成。';});return;}
  if (target.id==='project-form') void run('正在保存系列设定…',async()=>{
    const payload={...form};if(payload.lengthTarget&&!payload.lengthTarget.min&&!payload.lengthTarget.max)delete payload.lengthTarget;
    const updated=editingProject?await api<ProjectBundle>(`/api/projects/${encodeURIComponent(bundle!.project.id)}`,{method:'PUT',body:JSON.stringify(payload)}):await post<ProjectBundle>('/api/projects',payload);
    bundle=updated;projects=await api<Project[]>('/api/projects');
    if (!editingProject) {episodeId=bundle.episodes[0]?.id??'';setRevision('');}
    formBaseline={...form};
    modal=null;remember();notice=editingProject?'系列设定已保存。':'系列已建立，接下来创建第一集。';
  });
  if (target.id==='episode-form') void run('正在创建分集…',async()=>{bundle=await post<ProjectBundle>(`/api/projects/${encodeURIComponent(bundle!.project.id)}/episodes`,{title:episodeTitle});episodeId=bundle.episodes.at(-1)?.id??'';setRevision('');modal=null;tab='script';remember();notice='分集已创建，可以开始写初稿。';});
});
root.addEventListener('click', event=>{
  const el=(event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const action=el.dataset.action,id=el.dataset.id??'',mode=el.dataset.mode==='demo'?'demo':'live';
  if (action==='dismiss-error') {error='';render();return;}
  if (action==='tab') {tab=id as Tab;render();return;}
  if (pending) return;
  if(action==='open-providers'){if(providerPage)return;if(!canLeave())return;void run('正在读取模型服务…',async()=>{await providerPanel.load();providerPage=true;history.replaceState(null,'','#providers');});return;}
  if(action==='close-providers'){if(!providerPanel.canLeave())return;providerPanel.reset();providerPage=false;history.replaceState(null,'',location.pathname);render();return;}
  if(providerPanel.click(action??'',id))return;
  if(action?.startsWith('shots-')){if(revision()&&episode())shotListPanel.click(action,el,shotContext());return;}
  if(providerPage&&['new-project','edit-project','new-episode','select-episode'].includes(action??'')){if(!providerPanel.canLeave())return;providerPanel.reset();providerPage=false;history.replaceState(null,'',location.pathname);}
  if(action==='logout'){void run('正在退出…',async()=>{await post('/api/auth/logout',{});for(const k of Object.keys(localStorage))if(k.startsWith('sci-epo-'))localStorage.removeItem(k);clearPrivateView();loginNeeded=true;});return;}
  if(action==='localize'){const sourceId=revisionId,language=targetLanguage;void run(mode==='demo'?'正在载入双语演示…':'正在改编目标语言剧本…',async()=>{const l=await post<Localization>(`/api/revisions/${encodeURIComponent(sourceId)}/localize`,{mode,language});await loadProject(bundle!.project.id,sourceId);chooseLocalization(l.id);tab='languages';notice='语言候选已保存。请对照原稿审读事实、人物语气与对白。';});return;}
  if (action==='new-project'||action==='edit-project') {
    if (!canLeave()) return;editingProject=action==='edit-project';form=editingProject?{title:bundle!.project.title,premise:bundle!.project.premise,characters:bundle!.project.characters,worldRules:bundle!.project.worldRules,authorRules:bundle!.project.authorRules,language:bundle!.project.language??'zh-CN',glossary:bundle!.project.glossary??'',...(bundle!.project.lengthTarget?{lengthTarget:{...bundle!.project.lengthTarget}}:{}),...(bundle!.project.format==='vertical_short_drama'?{format:'vertical_short_drama' as const,durationTarget:{...(bundle!.project.durationTarget??DEFAULT_DURATION_TARGET)}}:{format:'episodic' as const})}:blankBrief();formBaseline={...form};error='';modal='project';render();return;
  }
  if (action==='fill-example') {form=structuredClone(form.format==='vertical_short_drama'?shortDramaExample:example);render();return;}
  if (action==='new-episode') {if (!canLeave())return;episodeTitle='';modal='episode';render();return;}
  if (action==='close-modal') {if(modal==='project'&&JSON.stringify(form)!==JSON.stringify(formBaseline)&&!window.confirm('设定还没有保存。确定关闭并放弃本次编辑吗？'))return;if(modal==='episode'&&episodeTitle.trim()&&!window.confirm('分集尚未创建，确定关闭吗？'))return;modal=null;render();return;}
  if (action==='select-episode') {if (!canLeave())return;episodeId=id;setRevision(revisions().at(-1)?.id??'');tab='script';remember();render();return;}
  if (action==='select-revision') {if (!canLeave())return;setRevision(id);tab='script';render();return;}
  if (action==='focus-rewrite'||action==='use-suggestion') {
    const sceneId=action==='focus-rewrite'?id:el.dataset.scene??'';
    if (revision()?.scenes.find(s=>s.id===sceneId)?.locked) {error='这场已锁定，请先在剧本页解锁。';render();return;}
    if(action==='use-suggestion'){
      if(!rewriteInstruction.useSuggestion({revisionId,sceneId,review:review()},el.dataset.reviewId,el.dataset.target)){
        error='这条建议尚未通过解释核实，或已不是当前审稿记录。请重新对照原文。';render();return;
      }
    }
    rewriteSceneId=sceneId;render();document.querySelector<HTMLTextAreaElement>('#rewrite-instruction')?.focus();return;
  }
  if (action==='generate') { if(!canLeave())return; void run(mode==='demo'?'正在载入演示样例…':'正在创作剧本初稿…',async()=>{const r=await post<Revision>(`/api/episodes/${encodeURIComponent(episodeId)}/generate`,{mode});await loadProject(bundle!.project.id,r.id);tab='script';notice=mode==='demo'?'已载入预设演示样例，不是针对当前设定生成的作品。':'初稿已保存。先通读，再决定需要审读和修改的地方。';});return; }
  if (action==='save-script') { void run('正在保存新版本…',async()=>{const oldId=revisionId;const r=await post<Revision>(`/api/revisions/${encodeURIComponent(oldId)}/edit`,editor);localStorage.removeItem(draftKey(oldId));await loadProject(bundle!.project.id,r.id);notice='编辑已另存为新版本，原版保留。';});return; }
  if (action==='toggle-lock') { void run('正在更新场景锁定…',async()=>{const s=revision()!.scenes.find(s=>s.id===id)!;const r=await post<Revision>(`/api/revisions/${encodeURIComponent(revisionId)}/locks`,{sceneId:id,locked:!s.locked});await loadProject(bundle!.project.id,r.id);notice=s.locked?'这场已解锁。':'这场已锁定，局部改稿会保留它。';});return; }
  if(action==='verify-review'){
    const rv=review();if(!rv||rv.mode==='demo')return;
    void run('正在对照原文核实已有审稿…',async()=>{await post<Review>(`/api/reviews/${encodeURIComponent(rv.id)}/verify`,{mode:'live'});await loadProject(bundle!.project.id,revisionId);tab='review';notice='解释核实已另存为新记录，原审稿继续保留。';});return;
  }
  if (action==='review') { void run(mode==='demo'?'正在载入演示审稿…':'正在审读这版剧本…',async()=>{await post<Review>(`/api/revisions/${encodeURIComponent(revisionId)}/review`,{mode});await loadProject(bundle!.project.id,revisionId);tab='review';notice='审读结果已保存。请结合原文判断每条建议。';});return; }
  if (action==='rewrite') {
    if (mode==='demo') { rewriteSceneId='s3'; rewriteInstruction.clear();rewriteInstruction.edit('演示：修改第三场的解释性对白，保留事件与其他场景。'); }
    const prepared=rewriteInstruction.prepare(rewriteContext());
    if(!prepared.ok){error=prepared.message;render();return;}
    if (!prepared.instruction.trim()) {error='先写下这场戏要解决的问题或希望保留的内容。';render();document.querySelector<HTMLTextAreaElement>('#rewrite-instruction')?.focus();return;}
    if (!rewriteSceneId) {error='请先选择一个未锁定的场景。';render();return;}
    const instruction=prepared.instruction,sceneId=rewriteSceneId;
    void run(mode==='demo'?'正在载入演示改稿…':'正在为选中的场景改稿…',async()=>{const r=await post<Revision>(`/api/revisions/${encodeURIComponent(revisionId)}/rewrite`,{mode,sceneId,instruction,...(prepared.reviewSource?{reviewSource:prepared.reviewSource}:{})});await loadProject(bundle!.project.id,r.id);tab='compare';notice=mode==='demo'?'已载入预设改稿，用于体验版本对读。':'改稿候选已保存，原版与其他场景保留。';});return;
  }
  if (action==='accept') {void run('正在采用这一版…',async()=>{bundle=await post<ProjectBundle>(`/api/episodes/${encodeURIComponent(episodeId)}/accept`,{revisionId,expectedAcceptedRevisionId:episode()!.acceptedRevisionId,expectedContextToken:episode()!.contextToken,acknowledgeReview,acknowledgeLengthException});acknowledgeReview=false;notice='已采用这版，后续分集将以它为创作依据。';});return;}
});
window.addEventListener('beforeunload', event=>{if(providerPanel.changed||dirty()||(modal==='project'&&JSON.stringify(form)!==JSON.stringify(formBaseline))||(modal==='episode'&&episodeTitle.trim())){event.preventDefault();event.returnValue='';}});
root.addEventListener('keydown', event=>{
  if(!modal)return;
  if(event.key==='Escape'&&!pending){event.preventDefault();document.querySelector<HTMLButtonElement>('[data-action="close-modal"]')?.click();return;}
  if(event.key==='Tab'){const focusable=Array.from(document.querySelectorAll<HTMLElement>('.modal button:not(:disabled),.modal input:not(:disabled),.modal textarea:not(:disabled),.modal select:not(:disabled),.modal a[href]'));const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
});
async function init(){
  render();
  try { const sessionResponse=await fetch('/api/auth/session');if(sessionResponse.status===401){clearPrivateView();loginNeeded=true;return;}if(!sessionResponse.ok)throw new Error('账号状态读取失败。');const session=await sessionResponse.json();accountEmail=session.email;csrf=session.csrf;loginNeeded=false;[status,projects]=await Promise.all([api<typeof status>('/api/status'),api<Project[]>('/api/projects')]);const id=projects.some(p=>p.id===saved.projectId)?saved.projectId:projects[0]?.id;if(id)await loadProject(id);if(providerPage&&status.management)await providerPanel.load(); }
  catch(err){error=err instanceof Error?err.message:'工作台读取失败，请刷新重试。';}
  finally{ready=true;render();}
}
void init();
