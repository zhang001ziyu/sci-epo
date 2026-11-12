import { afterEach, expect, test } from 'bun:test';
import { isLineAligned } from '../src/core/scriptLines';
import { boundAdaptations, parseShotList, shotListWarnings } from '../src/core/shotList';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { SHORT_DRAMA_DEMO, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import { Store } from '../src/server/store';
import type { Localization, ProjectBundle, Revision, ShotList } from '../src/types';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const brief = {title: 'Last Order', premise: 'Midnight deliveries pull a rider into strangers\' secrets.', characters: 'MAYA: a delivery rider.\nLEO: seventy.', worldRules: 'An ordinary city.', authorRules: 'Each episode ends on a reveal.', format: 'vertical_short_drama'};

function harness() {
  const store = new Store(); stores.push(store);
  const app = createApp(store, {demo: demoProvider});
  const call = async (path: string, body?: unknown) => {
    const response = await app(new Request('http://127.0.0.1:4317' + path, {method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
    return {status: response.status, body: await response.json()};
  };
  return {store, call};
}

test('the prepared example is aligned line by line and its prepared shot list passes in both languages', () => {
  expect(isLineAligned(SHORT_DRAMA_DEMO.en, SHORT_DRAMA_DEMO.zh)).toBe(true);
  for (const language of ['en', 'zh'] as const) {
    const list = shortDramaDemoShotList(language);
    expect(parseShotList(list, SHORT_DRAMA_DEMO[language])).toEqual(list);
  }
});

for (const [language, other] of [['en', 'zh-CN'], ['zh-CN', 'en']] as const) {
  test(`a ${language} short-drama series can run the whole demonstration path`, async () => {
    const h = harness();
    const p = (await h.call('/api/projects', {...brief, language})).body as ProjectBundle;
    const r = (await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`, {mode: 'demo'})).body as Revision;
    const fixed = SHORT_DRAMA_DEMO[language === 'en' ? 'en' : 'zh'];
    expect(r.title).toBe(fixed.title);
    expect(r.context.brief.format).toBe('vertical_short_drama');
    const adapted = await h.call(`/api/revisions/${r.id}/localize`, {mode: 'demo', language: other});
    expect(adapted.status).toBe(200);
    const l = adapted.body as Localization;
    const created = await h.call(`/api/revisions/${r.id}/shot-lists`, {mode: 'demo'});
    expect(created.status).toBe(200);
    const list = created.body as ShotList;
    expect(list).toMatchObject({mode: 'demo', aspectRatio: '9:16', voiceLanguages: [language, other], adaptations: {[other]: l.id}});
    expect(list.cast.map(c => c.name)).toEqual(language === 'en' ? ['MAYA', 'LEO'] : ['玛雅', '老林']);
    // The prepared list keeps one two-action shot (the phone buzzes, Maya reads), so the split prompt has an example.
    expect(shotListWarnings(list, {revision: r, adaptations: boundAdaptations(list, [l])}).map(w => [w.kind, w.shotId, w.splitAt])).toEqual([['multiple_actions', 'sh8', 2]]);
    expect((await h.call(`/api/revisions/${r.id}/review`, {mode: 'demo'})).status).toBe(200);
  });
}

test('prepared shot lists are only offered for the unmodified short-drama example', async () => {
  const h = harness();
  const p = (await h.call('/api/projects', {...brief, language: 'en'})).body as ProjectBundle;
  const r = (await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`, {mode: 'demo'})).body as Revision;
  const edited = (await h.call(`/api/revisions/${r.id}/edit`, {title: r.title, logline: r.logline, scenes: r.scenes.map((s, i) => i === 0 ? {...s, content: s.content + '\nMaya waits.'} : s)})).body as Revision;
  const refused = await h.call(`/api/revisions/${edited.id}/shot-lists`, {mode: 'demo'});
  expect(refused.status).toBe(502);
  expect(refused.body.error).toContain('未改动的固定样例');
  const {format: _format, ...episodic} = brief;
  const plain = (await h.call('/api/projects', {...episodic, language: 'en'})).body as ProjectBundle;
  const pip = (await h.call(`/api/episodes/${plain.episodes[0]!.id}/generate`, {mode: 'demo'})).body as Revision;
  expect(pip.title).toContain('One Last Burst');
  expect((await h.call(`/api/revisions/${pip.id}/shot-lists`, {mode: 'demo'})).body.error).toContain('固定短剧示例');
});
