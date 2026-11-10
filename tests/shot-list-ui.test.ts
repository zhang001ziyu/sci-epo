import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import type { Episode, Localization, ProjectBundle, Revision, ShotList } from '../src/types';
import { voiceLanguagesView } from '../web/languages';
import { ShotListPanel, type ShotListContext } from '../web/shotList';

const attack = '<img src=x onerror="alert(1)">';
const time = '2026-11-07T00:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const, durationTarget: {min: 10, max: 20}};
function fixture(options: {aspect?: '9:16' | '16:9'; production?: string; accepted?: string | null} = {}) {
  const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, title: 'T', logline: 'L', language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: time, context: snapshotContext(brief, []), scenes: [
    {id: 's1', heading: `ROOM ${attack}`, content: `Maya waits.\nMAYA: ${attack}`, locked: false},
  ]};
  const zh: Localization = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', parentId: null, mode: 'live', glossary: '', createdAt: time, title: '标题', logline: '梗概', scenes: [{id: 's1', heading: '房间', content: `玛雅等着。\n玛雅：${attack}`, locked: false}]};
  const list: ShotList = {id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: options.aspect ?? '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'live', createdAt: time,
    cast: [{id: 'C1', name: `MAYA${attack}`}],
    shots: [{id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'push_in', characters: ['C1'], spoken: [{line: 2, castId: 'C1'}], durationSeconds: 12, composition: attack, sound: attack}]};
  const episode: Episode = {id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: options.accepted === undefined ? 'r1' : options.accepted, needsReview: false, createdAt: time, ...(options.production ? {productionShotListId: options.production} : {})};
  const bundle: ProjectBundle = {project: {...brief, id: 'p1', createdAt: time, updatedAt: time, voiceLanguages: ['en', 'zh-CN']}, episodes: [episode], revisions: [revision], reviews: [], runs: [], localizations: [zh], shotLists: [list]};
  const ctx: ShotListContext = {bundle, revision, episode, busy: false, live: true, dirty: false};
  return {ctx, revision, list};
}
function panel() {
  const calls = {render: 0, failures: [] as string[]};
  const p = new ShotListPanel({run: async (_label, action) => { await action(); }, post: async () => { throw new Error('no network in tests'); }, reload: async () => {}, render: () => { calls.render++; }, notice: () => {}, fail: message => { calls.failures.push(message); }, confirm: () => true});
  return {p, calls};
}
const field = (dataset: Record<string, string>, value = '', extra: Record<string, unknown> = {}) => ({dataset, value, id: '', ...extra}) as unknown as HTMLSelectElement;

describe('shot-list view', () => {
  test('escapes every model and author value and shows both languages', () => {
    const {ctx} = fixture(), html = panel().p.view(ctx);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('玛雅：');
    expect(html).toContain('MAYA: ');
    expect(html).toContain('<span class="pill">未采用</span>');
  });

  test('frames follow the aspect ratio of the shot list', () => {
    expect(panel().p.view(fixture().ctx)).toContain('shot-frame ratio-9-16');
    const wide = panel().p.view(fixture({aspect: '16:9'}).ctx);
    expect(wide).toContain('shot-frame ratio-16-9');
    expect(wide).toContain('shot-card horizontal');
  });

  test('status shows adoption, current production and why adoption is unavailable', () => {
    expect(panel().p.view(fixture({production: 'v1'}).ctx)).toContain('当前制作版本');
    const unaccepted = panel().p.view(fixture({accepted: null}).ctx);
    expect(unaccepted).toContain('未采用');
    expect(unaccepted).toContain('先在剧本页采用这一版');
    expect(unaccepted).toMatch(/data-action="shots-adopt"[^>]*disabled/);
  });

  test('a revision without a shot list points to the nearest one and its changed scenes', () => {
    const {ctx, revision} = fixture({production: 'v1'});
    const child: Revision = {...revision, id: 'r2', parentId: 'r1', scenes: [{...revision.scenes[0]!, content: 'Maya leaves.'}]};
    const html = panel().p.view({...ctx, revision: child, bundle: {...ctx.bundle, revisions: [revision, child]}});
    expect(html).toContain('这一版还没有分镜表');
    expect(html).toContain('最近的分镜表基于 V1（已采用为制作版本）');
    expect(html).toContain('这些场景不同：s1');
  });
});

describe('shot-list editing', () => {
  test('split and merge keep IDs, speaker changes re-render, and invalid saves are refused locally', () => {
    const {ctx} = fixture(), {p, calls} = panel();
    p.view(ctx);
    expect(p.click('shots-edit', {dataset: {}}, ctx)).toBe(true);
    expect(p.editing).toBe(true);
    const editing = p.view(ctx);
    expect(editing).toContain('data-shot-speaker');
    expect(editing).toContain('从这一行拆开');
    p.click('shots-split', {dataset: {id: 'sh1', line: '2'}}, ctx);
    expect(p.view(ctx)).toContain('data-shot="sh2"');
    p.click('shots-merge', {dataset: {id: 'sh1'}}, ctx);
    expect(p.view(ctx)).not.toContain('data-shot="sh2"');
    expect(p.change(field({shotSpeaker: '', shotId: 'sh1', line: '2'}, ''))).toBe(true);
    expect(calls.render).toBeGreaterThan(0);
    expect(p.input(field({shotField: 'durationSeconds', shotId: 'sh1'}, '0'))).toBe(true);
    p.click('shots-save', {dataset: {}}, ctx);
    expect(calls.failures.at(-1)).toContain('预计时长');
    p.click('shots-remove-cast', {dataset: {id: 'C1'}}, ctx);
    expect(calls.failures.at(-1)).toContain('仍在镜头中出现');
    p.click('shots-cancel', {dataset: {}}, ctx);
    expect(p.editing).toBe(false);
  });

  test('the voice-language checklist always keeps the script language', () => {
    const {ctx} = fixture(), html = voiceLanguagesView(ctx.bundle, false);
    expect(html).toMatch(/value="en" checked disabled/);
    expect(html).toMatch(/value="zh-CN" checked\s*\/>/);
    expect(html).toContain('English（原稿）');
  });
});
