import { afterEach, describe, expect, test } from 'bun:test';
import { exportMarkdown, snapshotContext } from '../src/core';
import { exportLocalization, notesLanguage } from '../src/core/languages';
import { currentAdaptation, otherVersionAdaptations } from '../src/core/manuscripts';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { Episode, Localization, ProjectBundle, Revision, ShotList } from '../src/types';
import { languageOptions, languagesView, voiceLanguagesView } from '../web/languages';
import { adaptationView, exportControl, manuscriptSwitch, missingAdaptationView, readManuscriptPreference, saveManuscriptPreference, MANUSCRIPT_PREFERENCE_KEY } from '../web/manuscript';
import { ShotListPanel, type ShotListContext } from '../web/shotList';

const attack = '<img src=x onerror="alert(1)">';
const time = '2026-11-10T00:00:00.000Z';
const shortBrief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const, durationTarget: {min: 10, max: 20}};
const revision = (id: string, extra: Partial<Revision> = {}): Revision => ({id, episodeId: 'e1', parentId: null, title: 'The Last Order', logline: 'A rider sings.', language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: time, context: snapshotContext(shortBrief, []), scenes: [
  {id: 's1', heading: 'INT. ELEVATOR - NIGHT', content: 'Maya holds a cupcake.\nMAYA: Singing costs extra.', locked: false},
], ...extra});
const adaptation = (id: string, sourceRevisionId: string, content = '玛雅捧着蛋糕。\n玛雅：唱歌得加钱。', extra: Partial<Localization> = {}): Localization => ({id, sourceRevisionId, language: 'zh-CN', parentId: null, mode: 'live', glossary: '', createdAt: time, title: '最后一单', logline: '外卖员唱歌。', scenes: [{id: 's1', heading: '内景 · 电梯 · 夜', content, locked: false}], ...extra});

describe('current adaptation of a revision', () => {
  test('is the newest one of this exact revision in that language', () => {
    const r = revision('r1'), older = adaptation('l1', 'r1'), newer = adaptation('l2', 'r1'), other = adaptation('l3', 'r0'), english = adaptation('l4', 'r1', undefined, {language: 'en'});
    expect(currentAdaptation(r, [older, other, newer, english], 'zh-CN')?.id).toBe('l2');
    expect(currentAdaptation(r, [other], 'zh-CN')).toBeUndefined();
  });

  test('ignores misaligned adaptations for short drama only', () => {
    const misaligned = adaptation('l9', 'r1', '玛雅捧着蛋糕，说唱歌得加钱。'), aligned = adaptation('l1', 'r1');
    expect(currentAdaptation(revision('r1'), [aligned, misaligned], 'zh-CN')?.id).toBe('l1');
    const {format: _f, durationTarget: _d, ...episodic} = shortBrief;
    expect(currentAdaptation(revision('r1', {context: snapshotContext(episodic, [])}), [aligned, misaligned], 'zh-CN')?.id).toBe('l9');
  });

  test('adaptations of other versions of the episode are found but never current', () => {
    const r1 = revision('r1'), r2 = revision('r2', {parentId: 'r1'}), elsewhere = revision('x1', {episodeId: 'e2'});
    const old = adaptation('l1', 'r1'), unrelated = adaptation('l2', 'x1');
    expect(otherVersionAdaptations(r2, [r1, r2, elsewhere], [old, unrelated], 'zh-CN').map(l => l.id)).toEqual(['l1']);
    expect(currentAdaptation(r2, [old, unrelated], 'zh-CN')).toBeUndefined();
  });
});

describe('export notes follow the manuscript language', () => {
  test('notes language', () => {
    expect(notesLanguage('en')).toBe('en');
    expect(notesLanguage('en-GB')).toBe('en');
    expect(notesLanguage('zh-CN')).toBe('zh-CN');
    expect(notesLanguage('ja')).toBe('zh-CN');
  });

  test('an English source export never claims adoption and states its provenance in English', () => {
    const text = exportMarkdown(revision('r1', {mode: 'demo'}), 'en');
    expect(text).toContain('Prepared demonstration example · en · revision r1');
    expect(text).toContain('Body text: ');
    expect(text).toContain('does not mean the author adopted this version');
    expect(text).not.toContain('导出文件');
    expect(exportMarkdown(revision('r1'))).toContain('导出文件不表示作者已采用');
  });

  test('an adaptation export names its source in the language of the adaptation', () => {
    const r = revision('r1'), l = adaptation('l1', 'r1');
    expect(exportLocalization(r, l)).toContain('原稿 r1 · 语言版本 l1');
    const english = exportLocalization(r, {...l, language: 'en', mode: 'demo'}, 'en');
    expect(english).toContain('source revision r1 · adaptation l1');
    expect(english).toContain('Prepared bilingual example; not yet approved by the author.');
  });
});

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function harness() {
  const store = new Store(); stores.push(store);
  const app = createApp(store, {demo: demoProvider});
  const raw = (path: string, body?: unknown) => app(new Request('http://127.0.0.1:4317' + path, {method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
  const call = async (path: string, body?: unknown) => { const response = await raw(path, body); return {status: response.status, body: await response.json()}; };
  return {raw, call};
}

describe('export by language', () => {
  test('exports the source, the current adaptation, and refuses missing or invalid languages', async () => {
    const h = harness();
    const p = (await h.call('/api/projects', {...shortBrief, title: 'Demo'})).body as ProjectBundle;
    const r = (await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`, {mode: 'demo'})).body as Revision;

    const source = await h.raw(`/api/revisions/${r.id}/export?language=en`);
    expect(source.status).toBe(200);
    expect(source.headers.get('content-disposition')).toBe(`attachment; filename="sci-epo-${r.id}-en.md"`);
    const sourceText = await source.text();
    expect(sourceText).toContain(`# ${r.title}`);
    expect(sourceText).toContain('does not mean the author adopted');
    expect(await (await h.raw(`/api/revisions/${r.id}/export`)).text()).toBe(sourceText);

    const missing = await h.raw(`/api/revisions/${r.id}/export?language=zh-CN`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('这一版还没有简体中文稿。');
    expect((await h.raw(`/api/revisions/${r.id}/export?language=Chinese!`)).status).toBe(400);

    const l = (await h.call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: 'zh-CN'})).body as Localization;
    const adapted = await h.raw(`/api/revisions/${r.id}/export?language=zh-CN`);
    expect(adapted.status).toBe(200);
    expect(adapted.headers.get('content-disposition')).toBe(`attachment; filename="sci-epo-${r.id}-zh-CN.md"`);
    const adaptedText = await adapted.text();
    expect(adaptedText).toContain(`# ${l.title}`);
    expect(adaptedText).toContain(`原稿 ${r.id} · 语言版本 ${l.id}`);
    expect(adaptedText).toContain(l.scenes[0]!.content);

    const edited = (await h.call(`/api/revisions/${r.id}/edit`, {title: r.title, logline: r.logline, scenes: r.scenes.map((s, i) => i === 0 ? {...s, heading: `${s.heading} (EDITED)`} : s)})).body as Revision;
    expect((await h.raw(`/api/revisions/${edited.id}/export?language=zh-CN`)).status).toBe(404);
  });
});

const store = (initial?: string) => { const values = new Map<string, string>(initial ? [[MANUSCRIPT_PREFERENCE_KEY, initial]] : []); return {getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, values}; };
const bundle = (localizations: Localization[], revisions = [revision('r1')]): ProjectBundle => ({project: {...shortBrief, id: 'p1', createdAt: time, updatedAt: time, voiceLanguages: ['en', 'zh-CN']}, episodes: [{id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: null, needsReview: false, createdAt: time}], revisions, reviews: [], runs: [], localizations});

describe('manuscript switch and views', () => {
  test('the preference is only Chinese or English and survives in its own key', () => {
    expect(readManuscriptPreference(store())).toBeNull();
    expect(readManuscriptPreference(store('ja'))).toBeNull();
    const s = store(); saveManuscriptPreference('zh-CN', s);
    expect(readManuscriptPreference(s)).toBe('zh-CN');
    expect(MANUSCRIPT_PREFERENCE_KEY.startsWith('sci-epo-')).toBe(false);
  });

  test('without a choice the script language is selected', () => {
    expect(manuscriptSwitch(null, 'en')).toContain('data-id="en" class="active" aria-pressed="true"');
    expect(manuscriptSwitch(null, 'en')).toContain('data-id="zh-CN" class="" aria-pressed="false"');
    expect(manuscriptSwitch('zh-CN', 'en')).toContain('data-id="zh-CN" class="active" aria-pressed="true"');
    expect(manuscriptSwitch(null, 'ja')).toContain('data-id="ja" class="active"');
  });

  test('export offers both languages and disables one without a manuscript of this revision', () => {
    const r = revision('r1');
    const none = exportControl(r, [adaptation('l0', 'r0')]);
    expect(none).toContain(`href="/api/revisions/r1/export?language=en"`);
    expect(none).not.toContain('language=zh-CN');
    expect(none).toContain('aria-disabled="true" title="这一版还没有中文稿"');
    expect(exportControl(r, [adaptation('l1', 'r1')])).toContain(`href="/api/revisions/r1/export?language=zh-CN"`);
  });

  test('an adaptation is shown read-only, escaped, and marked as not the place for review', () => {
    const r = revision('r1'), l = adaptation('l1', 'r1', `玛雅：${attack}`, {title: attack, mode: 'demo'});
    const html = adaptationView({bundle: bundle([l]), revision: r, language: 'zh-CN', versionNumber: 2, busy: false, live: true, dirty: true}, l);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('V2 的改编');
    expect(html).toContain('预置双语演示');
    expect(html).toContain('审读、改稿、锁定和采用都针对原稿（English）');
    expect(html).toContain('原稿有未保存的编辑');
    expect(html).not.toContain('<textarea');
  });

  test('a missing manuscript offers generation and never shows another version\'s text', () => {
    const r2 = revision('r2', {parentId: 'r1'}), old = adaptation('l1', 'r1', '旧版独有的台词');
    const ctx = {bundle: bundle([old], [revision('r1'), r2]), revision: r2, language: 'zh-CN', versionNumber: 2, busy: false, live: false, dirty: false};
    const html = missingAdaptationView(ctx);
    expect(html).toContain('这一版还没有中文稿');
    expect(html).not.toContain('旧版独有的台词');
    expect(html).toContain('本集其他版本有 1 份中文稿');
    expect(html).toMatch(/data-action="localize" data-mode="live" data-origin="script" data-language="zh-CN" data-requires-saved data-requires-live="true" disabled/);
    expect(html).not.toContain('data-mode="demo"');
    expect(missingAdaptationView({...ctx, revision: {...r2, mode: 'demo'}, live: true})).toContain('data-mode="demo" data-origin="script" data-language="zh-CN" >载入预置中文稿');
  });
});

describe('other tabs follow the manuscript language', () => {
  const list: ShotList = {id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'live', createdAt: time,
    cast: [{id: 'C1', name: 'MAYA'}], shots: [{id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'static', characters: ['C1'], spoken: [{line: 2, castId: 'C1'}], durationSeconds: 5}]};
  const episode: Episode = {id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: 'r1', needsReview: false, createdAt: time};
  const panel = () => new ShotListPanel({run: async (_l, a) => { await a(); }, post: async () => { throw new Error('offline'); }, reload: async () => {}, render: () => {}, notice: () => {}, fail: () => {}, confirm: () => true});
  const view = (preferredLanguage?: string) => { const b = {...bundle([adaptation('l1', 'r1')]), episodes: [episode], shotLists: [list]}; const ctx: ShotListContext = {bundle: b, revision: b.revisions[0]!, episode, busy: false, live: true, dirty: false, ...(preferredLanguage ? {preferredLanguage} : {})}; return panel().view(ctx); };

  test('shot-list lines put the manuscript language first', () => {
    const chinese = view('zh-CN');
    expect(chinese.indexOf('玛雅：唱歌得加钱。')).toBeLessThan(chinese.indexOf('MAYA: Singing costs extra.'));
    expect(chinese).toContain('<p lang="en" class="secondary-language">MAYA: Singing costs extra.</p>');
    const english = view('en');
    expect(english.indexOf('MAYA: Singing costs extra.')).toBeLessThan(english.indexOf('玛雅：唱歌得加钱。'));
    expect(view()).toContain('<p lang="en">MAYA: Singing costs extra.</p><p lang="zh-CN">玛雅：唱歌得加钱。</p>');
  });

  test('pickers offer English and Simplified Chinese plus a stored value', () => {
    const options = languageOptions('en');
    expect(options).toContain('value="en"');
    expect(options).toContain('value="zh-CN"');
    expect(options).not.toContain('value="ja"');
    expect(options).not.toContain('value="zh-TW"');
    expect(languageOptions('ja')).toContain('<option value="ja" selected>日本語 · ja</option>');
    const b = bundle([]); b.project.voiceLanguages = ['en', 'zh-CN', 'ko'];
    const voices = voiceLanguagesView(b, false);
    expect(voices).toContain('value="ko" checked');
    expect(voices).not.toContain('value="ja"');
    b.project.publication = {audioLanguage: 'en', subtitleLanguages: ['en', 'fr'], subtitleStyle: 'selectable', platform: 'youtube'};
    const page = languagesView(b, revision('r1'), 'zh-CN', '', undefined, false, true, false);
    expect(page).toContain('name="subtitleLanguages" value="fr" checked');
    expect(page).not.toContain('name="subtitleLanguages" value="de"');
  });
});
