/** The episode bible in the shot tab: places, props and where each scene happens, drafted by the model or by hand,
 * then confirmed by the author. Every displayed value is escaped; checks reuse the core validator. */
import type { BibleContent, Episode, ProjectBundle, Revision } from '../src/types';
import { bibleFromHeadings, bibleNotes, bibleState, firstAppearance, parseBible, type BibleState } from '../src/core/bible';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface BibleHooks {
  run(label: string, action: () => Promise<void>): Promise<void>;
  post<T>(path: string, body: unknown): Promise<T>;
  reload(revisionId: string): Promise<void>;
  render(): void;
  notice(message: string): void;
  fail(message: string): void;
  confirm(message: string): boolean;
}
export interface BibleContext { bundle: ProjectBundle; revision: Revision; episode: Episode; busy: boolean; live: boolean }

const STATE_PILLS: Record<BibleState, string> = {
  missing: '<span class="pill changed">还没有</span>',
  draft: '<span class="pill changed">草稿 · 未确认</span>',
  stale: '<span class="pill changed">剧本换了版本 · 要重新确认</span>',
  confirmed: '<span class="pill accepted">已确认</span>',
};

const clone = (b: BibleContent): BibleContent => ({locations: b.locations.map(l => ({...l})), props: b.props.map(p => ({...p})), scenes: b.scenes.map(s => ({...s, props: [...s.props]}))});
/** The bible content laid over the accepted revision's scenes: missing scenes get the first location, removed ones drop. */
function fitted(content: BibleContent, revision: Revision): BibleContent {
  const first = content.locations[0]?.id ?? 'L1';
  return {...clone(content), scenes: revision.scenes.map(s => {
    const old = content.scenes.find(x => x.sceneId === s.id);
    return old ? {...old, props: [...old.props]} : {sceneId: s.id, locationId: first, props: []};
  })};
}

export class BiblePanel {
  private draft: BibleContent | null = null;
  private draftFor = '';
  constructor(private hooks: BibleHooks) {}

  get editing(): boolean { return !!this.draft; }
  reset(): void { this.draft = null; this.draftFor = ''; }

  private accepted(ctx: BibleContext): Revision | undefined {
    return ctx.episode.acceptedRevisionId && !ctx.episode.needsReview ? ctx.bundle.revisions.find(r => r.id === ctx.episode.acceptedRevisionId) : undefined;
  }

  view(ctx: BibleContext): string {
    if (this.draftFor && this.draftFor !== ctx.episode.id) this.reset();
    const revision = this.accepted(ctx), bible = ctx.episode.bible, state = bibleState(bible, revision);
    const disabled = (condition = false) => ctx.busy || condition ? 'disabled' : '';
    const intro = '<p class="small muted">每段视频（大约 15 秒）是分开生成的。不先写定房间和道具长什么样，每段都会自己重新想象一遍，前后就对不上。这里确认之后：生成分镜表时，模型会按这些地点和道具来写构图；生成视频时，每段的开头都会带上这一场的地点和道具描述。</p>';
    const head = (actions: string) => `<div class="bible-head"><div><h3>本集设定 · 地点和道具 ${STATE_PILLS[state]}</h3></div><div class="header-actions">${actions}</div></div>`;
    if (!revision) return `<section class="bible-panel">${head('')}${intro}<div class="inline-warning">先在剧本页采用本集定稿，再整理本集设定。设定跟着定稿走。</div></section>`;
    const viewingOther = ctx.revision.id !== revision.id ? '<p class="small muted">你正在看的不是已采用的定稿。本集设定按已采用的定稿整理。</p>' : '';
    if (this.draft) return `<section class="bible-panel editing">${head(`<button class="button primary" data-action="shots-bible-confirm" ${disabled()}>保存并确认</button><button class="button subtle" data-action="shots-bible-save" ${disabled()}>只保存草稿</button><button class="button subtle" data-action="shots-bible-cancel" ${disabled()}>放弃修改</button>`)}${intro}${viewingOther}${this.editor(this.draft, revision, disabled())}</section>`;
    const draftButton = `<button class="button ${bible ? 'subtle' : 'primary'}" data-action="shots-bible-draft" ${disabled(!ctx.live)}>${bible ? '让模型重新起草' : '让模型起草'}</button>`;
    if (!bible) return `<section class="bible-panel">${head(`${draftButton}<button class="button subtle" data-action="shots-bible-headings" ${disabled()}>按场景标题新建，自己填写</button>`)}${intro}${viewingOther}${!ctx.live ? '<p class="small muted">写作模型还没配置，可以按场景标题新建后自己填写。</p>' : ''}</section>`;
    const content = state === 'stale' ? fitted(bible, revision) : bible;
    const confirm = state === 'confirmed' ? '' : `<button class="button primary" data-action="shots-bible-confirm" ${disabled()}>${state === 'stale' ? '看过了，按新定稿确认' : '看过了，确认'}</button>`;
    const body = this.readView(content, revision, state);
    const open = state !== 'confirmed' ? ' open' : '';
    return `<section class="bible-panel">${head(`${confirm}<button class="button subtle" data-action="shots-bible-edit" ${disabled()}>修改</button>${draftButton}`)}<details class="bible-details"${open}><summary>${esc(content.locations.length)} 个地点 · ${esc(content.props.length)} 个道具 · ${esc(content.scenes.length)} 场${state === 'confirmed' ? ' · 点开查看' : ''}</summary>${intro}${viewingOther}${state === 'stale' ? '<div class="inline-warning">定稿换了版本。下面是按新定稿对齐后的设定：新加的场景先放在第一个地点，请检查。</div>' : ''}${body}</details></section>`;
  }

  private readView(content: BibleContent, revision: Revision, state: BibleState): string {
    const first = firstAppearance(content), notes = bibleNotes(content);
    const locations = `<table class="bible-table"><thead><tr><th>编号</th><th>地点</th><th>给视频模型的描述（英文）</th><th>说明</th></tr></thead><tbody>${content.locations.map(l => `<tr><td>${esc(l.id)}</td><td>${esc(l.name)}</td><td lang="en">${esc(l.look)}</td><td>${esc(l.note ?? '')}</td></tr>`).join('')}</tbody></table>`;
    const props = content.props.length ? `<table class="bible-table"><thead><tr><th>编号</th><th>道具</th><th>给视频模型的描述（英文）</th><th>说明</th><th>第一次出现</th></tr></thead><tbody>${content.props.map(p => `<tr><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td lang="en">${esc(p.look)}</td><td>${esc(p.note ?? '')}</td><td>${esc(first.get(p.id) ?? '没有出现')}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">还没有道具。结尾或转折要用到的东西，要先在这里登记，并在更早的一场露出来。</p>';
    const scenes = `<ol class="bible-scenes">${content.scenes.map(s => {
      const scene = revision.scenes.find(x => x.id === s.sceneId), location = content.locations.find(l => l.id === s.locationId);
      const used = s.props.map(id => content.props.find(p => p.id === id)?.name ?? id);
      return `<li><strong>${esc(s.sceneId)}</strong> ${esc(scene?.heading ?? '')} → 在 <strong>${esc(location?.name ?? s.locationId)}</strong>${used.length ? `，画面里有：${used.map(esc).join('、')}` : '，没有登记道具'}</li>`;
    }).join('')}</ol>`;
    const noteBlock = notes.length ? `<div class="inline-warning"><strong>确认前看一下</strong><ul>${notes.map(n => `<li>${esc(n.message)}</li>`).join('')}</ul></div>` : '';
    return `<h4>地点</h4>${locations}<h4>道具</h4>${props}<h4>每一场在哪里</h4>${scenes}${noteBlock}${state === 'confirmed' ? '<p class="small muted">修改设定后要重新确认；已经逐镜确认过的镜头也要重新看一遍。</p>' : ''}`;
  }

  private editor(d: BibleContent, revision: Revision, disabled: string): string {
    const item = (kind: 'loc' | 'prop', x: {id: string; name: string; look: string; note?: string}) => `<div class="bible-item"><span class="bible-id">${esc(x.id)}</span><label class="small">名字<input data-bible-${kind}="${esc(x.id)}" data-bible-field="name" value="${esc(x.name)}" maxlength="60" ${disabled}/></label><label class="small">给视频模型的描述（英文，写清大小、颜色、材质、位置）<textarea rows="2" data-bible-${kind}="${esc(x.id)}" data-bible-field="look" maxlength="400" ${disabled}>${esc(x.look)}</textarea></label><label class="small">说明（中文，给自己看）<input data-bible-${kind}="${esc(x.id)}" data-bible-field="note" value="${esc(x.note ?? '')}" maxlength="200" ${disabled}/></label><button class="text-button" data-action="shots-bible-remove" data-id="${esc(x.id)}" ${disabled}>删除</button></div>`;
    const scenes = d.scenes.map(s => {
      const scene = revision.scenes.find(x => x.id === s.sceneId);
      return `<div class="bible-scene-row"><span><strong>${esc(s.sceneId)}</strong> ${esc(scene?.heading ?? '')}</span><label class="small">地点<select data-bible-scene="${esc(s.sceneId)}" ${disabled}>${d.locations.map(l => `<option value="${esc(l.id)}" ${l.id === s.locationId ? 'selected' : ''}>${esc(l.id)} · ${esc(l.name)}</option>`).join('')}</select></label><span class="small">道具：${d.props.length ? d.props.map(p => `<label class="check-label inline"><input type="checkbox" data-bible-scene-prop="${esc(s.sceneId)}" data-prop="${esc(p.id)}" ${s.props.includes(p.id) ? 'checked' : ''} ${disabled}/><span>${esc(p.name)}</span></label>`).join('') : '还没有道具'}</span></div>`;
    }).join('');
    return `<h4>地点</h4>${d.locations.map(l => item('loc', l)).join('')}<button class="text-button" data-action="shots-bible-add-location" ${disabled}>添加地点 ＋</button><h4>道具</h4>${d.props.map(p => item('prop', p)).join('')}<button class="text-button" data-action="shots-bible-add-prop" ${disabled}>添加道具 ＋</button><h4>每一场在哪里、画面里有什么</h4>${scenes}`;
  }

  input(el: Field): boolean {
    if (!this.draft) return false;
    const field = el.dataset.bibleField as 'name' | 'look' | 'note' | undefined;
    if (!field) return false;
    const target = el.dataset.bibleLoc ? this.draft.locations.find(l => l.id === el.dataset.bibleLoc) : el.dataset.bibleProp ? this.draft.props.find(p => p.id === el.dataset.bibleProp) : undefined;
    if (!target) return false;
    if (field === 'note') { if (el.value.trim()) target.note = el.value; else delete target.note; } else target[field] = el.value;
    return true;
  }

  change(el: Field): boolean {
    if (!this.draft) return false;
    if (el.dataset.bibleScene) { const s = this.draft.scenes.find(x => x.sceneId === el.dataset.bibleScene); if (s) s.locationId = el.value; this.hooks.render(); return true; }
    if (el.dataset.bibleSceneProp) {
      const s = this.draft.scenes.find(x => x.sceneId === el.dataset.bibleSceneProp), prop = el.dataset.prop ?? '';
      if (s) s.props = (el as HTMLInputElement).checked ? [...new Set([...s.props, prop])] : s.props.filter(p => p !== prop);
      this.hooks.render(); return true;
    }
    return this.input(el);
  }

  click(action: string, el: {dataset: DOMStringMap}, ctx: BibleContext): boolean {
    if (!action.startsWith('shots-bible-')) return false;
    const revision = this.accepted(ctx);
    if (!revision) return true;
    const episodeId = ctx.episode.id, path = `/api/episodes/${encodeURIComponent(episodeId)}`, bible = ctx.episode.bible;
    if (action === 'shots-bible-draft') {
      const replaceConfirmed = !!bible?.confirmedAt && bible.revisionId === revision.id;
      if (replaceConfirmed && !this.hooks.confirm('已经确认过的设定会被新的草稿替换，逐镜确认也要重新做。继续吗？')) return true;
      void this.hooks.run('正在起草本集设定…', async () => {
        await this.hooks.post(`${path}/bible-draft`, {mode: 'live', ...(replaceConfirmed ? {replaceConfirmed: true} : {})});
        await this.hooks.reload(ctx.revision.id);
        this.reset();
        this.hooks.notice('本集设定草稿已生成。请逐项看一遍：地点、道具和每一场在哪里，再点确认。');
      });
      return true;
    }
    if (action === 'shots-bible-headings') { this.draft = bibleFromHeadings(revision); this.draftFor = episodeId; this.hooks.render(); return true; }
    if (action === 'shots-bible-edit') { if (bible) { this.draft = fitted(bible, revision); this.draftFor = episodeId; this.hooks.render(); } return true; }
    if (action === 'shots-bible-cancel') { if (this.hooks.confirm('放弃对本集设定的修改吗？')) { this.reset(); this.hooks.render(); } return true; }
    if (action === 'shots-bible-save' || action === 'shots-bible-confirm') {
      const source = this.draft ?? (bible ? fitted(bible, revision) : undefined);
      if (!source) return true;
      let content: BibleContent;
      try { content = parseBible(source, revision); } catch (error) { this.hooks.fail(error instanceof Error ? error.message : '本集设定格式无效。'); return true; }
      const confirm = action === 'shots-bible-confirm';
      void this.hooks.run(confirm ? '正在确认本集设定…' : '正在保存本集设定…', async () => {
        await this.hooks.post(`${path}/bible`, {...content, confirm});
        await this.hooks.reload(ctx.revision.id);
        this.reset();
        this.hooks.notice(confirm ? '本集设定已确认。之后生成的分镜表和视频都会按它来。已有的分镜表可以重新生成，让构图跟设定对上。' : '本集设定草稿已保存，还没有确认。');
      });
      return true;
    }
    if (!this.draft) return true;
    const next = (items: {id: string}[], prefix: string) => `${prefix}${items.reduce((max, x) => Math.max(max, Number(x.id.slice(1)) || 0), 0) + 1}`;
    if (action === 'shots-bible-add-location') this.draft.locations.push({id: next(this.draft.locations, 'L'), name: '新地点', look: ''});
    else if (action === 'shots-bible-add-prop') this.draft.props.push({id: next(this.draft.props, 'P'), name: '新道具', look: ''});
    else if (action === 'shots-bible-remove') {
      const id = el.dataset.id ?? '';
      if (id.startsWith('L')) {
        if (this.draft.scenes.some(s => s.locationId === id)) { this.hooks.fail('还有场景在这个地点，先把那些场景改到别的地点再删除。'); return true; }
        if (this.draft.locations.length <= 1) { this.hooks.fail('至少保留一个地点。'); return true; }
        this.draft.locations = this.draft.locations.filter(l => l.id !== id);
      } else {
        this.draft.props = this.draft.props.filter(p => p.id !== id);
        for (const s of this.draft.scenes) s.props = s.props.filter(p => p !== id);
      }
    } else return true;
    this.hooks.render(); return true;
  }
}
