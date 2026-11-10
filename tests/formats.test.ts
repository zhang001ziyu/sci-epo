import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { snapshotContext } from '../src/core';
import { canonicalJsonBytes } from '../src/core/canonicalJson';
import { aspectRatioOf, defaultVoiceLanguages, formatOf, parseDurationTarget, parseFormat, parseVoiceLanguages } from '../src/core/formats';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { Store } from '../src/server/store';
import type { ProjectBundle, Revision } from '../src/types';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const base = {title: 'Last Order', premise: 'A rider delivers to strangers at midnight.', characters: 'MAYA: a delivery rider.', worldRules: 'Ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en'};

function harness() {
  const store = new Store(); stores.push(store);
  const app = createApp(store, {demo: demoProvider});
  async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await app(new Request('http://127.0.0.1:4317' + path, {method, headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
    return {status: response.status, body: await response.json()};
  }
  const token = (episodeId: string) => store.contextToken(store.get('episodes', episodeId)!);
  return {store, call, token};
}

describe('format presets', () => {
  test('parse formats, duration targets and voice languages strictly', () => {
    expect(parseFormat('vertical_short_drama')).toBe('vertical_short_drama');
    expect(parseFormat('episodic')).toBe('episodic');
    for (const bad of ['short', '', null, 3]) expect(() => parseFormat(bad)).toThrow();
    expect(parseDurationTarget({min: 60, max: 120})).toEqual({min: 60, max: 120});
    for (const bad of [{min: 5, max: 60}, {min: 60, max: 601}, {min: 90, max: 60}, {min: 60.5, max: 90}, {min: '60', max: 90}, null, []]) expect(() => parseDurationTarget(bad)).toThrow();
    expect(defaultVoiceLanguages('en')).toEqual(['en', 'zh-CN']);
    expect(defaultVoiceLanguages('zh-CN')).toEqual(['zh-CN', 'en']);
    expect(defaultVoiceLanguages('ja')).toEqual(['ja', 'en', 'zh-CN']);
    expect(parseVoiceLanguages(['zh-CN', 'en'], 'en')).toEqual(['zh-CN', 'en']);
    expect(() => parseVoiceLanguages(['zh-CN'], 'en')).toThrow('原稿语言');
    expect(() => parseVoiceLanguages(['en', 'en'], 'en')).toThrow('重复');
    expect(() => parseVoiceLanguages([], 'en')).toThrow();
    expect(formatOf({})).toBe('episodic');
    expect(aspectRatioOf({format: 'vertical_short_drama'})).toBe('9:16');
    expect(aspectRatioOf({})).toBe('16:9');
  });

  test('snapshots freeze short-drama fields and keep episodic snapshots byte-identical', () => {
    const short = snapshotContext({...base, format: 'vertical_short_drama'}, []);
    expect(short.brief.format).toBe('vertical_short_drama');
    expect(short.brief.durationTarget).toEqual({min: 60, max: 120});
    expect(snapshotContext({...base, format: 'vertical_short_drama', durationTarget: {min: 45, max: 90}}, []).brief.durationTarget).toEqual({min: 45, max: 90});
    const legacy = snapshotContext(base, []);
    const explicitEpisodic = snapshotContext({...base, format: 'episodic', durationTarget: {min: 60, max: 90}}, []);
    expect(explicitEpisodic).toEqual(legacy);
    expect('format' in legacy.brief).toBe(false);
    expect(short.hash).not.toBe(legacy.hash);
  });
});

describe('series routes', () => {
  test('a new short-drama series stores format, default duration and Chinese plus English voices', async () => {
    const h = harness();
    const created = (await h.call('/api/projects', {...base, format: 'vertical_short_drama'})).body as ProjectBundle;
    expect(created.project.format).toBe('vertical_short_drama');
    expect(created.project.durationTarget).toEqual({min: 60, max: 120});
    expect(created.project.voiceLanguages).toEqual(['en', 'zh-CN']);
    const plain = (await h.call('/api/projects', base)).body as ProjectBundle;
    for (const key of ['format', 'durationTarget', 'voiceLanguages']) expect(key in plain.project).toBe(false);
    expect((await h.call('/api/projects', {...base, format: 'serial'})).status).toBe(400);
    expect((await h.call('/api/projects', {...base, format: 'vertical_short_drama', durationTarget: {min: 200, max: 100}})).status).toBe(400);
  });

  test('existing series keep their context token; format and duration edits change it and require recheck', async () => {
    const h = harness();
    const p = (await h.call('/api/projects', base)).body as ProjectBundle, episode = p.episodes[0]!;
    const {title, premise, characters, worldRules, authorRules, language} = base;
    const legacy = createHash('sha256').update(canonicalJsonBytes({projectId: p.project.id, episodeId: episode.id, brief: {title, premise, characters, worldRules, authorRules, language, glossary: ''}, previous: []})).digest('hex');
    expect(h.token(episode.id)).toBe(legacy);
    expect(p.episodes[0]!.contextToken).toBe(legacy);

    const r = (await h.call(`/api/episodes/${episode.id}/generate`, {mode: 'demo'})).body as Revision;
    expect('format' in r.context.brief).toBe(false);
    const short = (await h.call(`/api/projects/${p.project.id}`, {...base, format: 'vertical_short_drama'}, 'PUT')).body as ProjectBundle;
    expect(short.project.durationTarget).toEqual({min: 60, max: 120});
    expect(short.project.voiceLanguages).toEqual(['en', 'zh-CN']);
    expect(short.episodes[0]!.needsReview).toBe(true);
    const shortToken = h.token(episode.id);
    expect(shortToken).not.toBe(legacy);

    const kept = (await h.call(`/api/projects/${p.project.id}`, {...base, durationTarget: {min: 90, max: 150}}, 'PUT')).body as ProjectBundle;
    expect(kept.project.format).toBe('vertical_short_drama');
    expect(kept.project.durationTarget).toEqual({min: 90, max: 150});
    expect(h.token(episode.id)).not.toBe(shortToken);

    const back = (await h.call(`/api/projects/${p.project.id}`, {...base, format: 'episodic'}, 'PUT')).body as ProjectBundle;
    expect('format' in back.project).toBe(false);
    expect('durationTarget' in back.project).toBe(false);
    expect(h.token(episode.id)).toBe(legacy);
  });

  test('voice languages are a production setting: no recheck, no token change, script language required', async () => {
    const h = harness();
    const p = (await h.call('/api/projects', {...base, format: 'vertical_short_drama'})).body as ProjectBundle, episode = p.episodes[0]!;
    const r = (await h.call(`/api/episodes/${episode.id}/generate`, {mode: 'demo'})).body as Revision;
    const before = h.token(episode.id);
    const accepted = (await h.call(`/api/episodes/${episode.id}/accept`, {revisionId: r.id, expectedAcceptedRevisionId: null, expectedContextToken: before, acknowledgeReview: true, acknowledgeLengthException: true})).body as ProjectBundle;
    expect(accepted.episodes[0]!.acceptedRevisionId).toBe(r.id);
    const updated = await h.call(`/api/projects/${p.project.id}/voice-languages`, {languages: ['en', 'zh-CN', 'ja']}, 'PUT');
    expect(updated.status).toBe(200);
    const bundle = updated.body as ProjectBundle;
    expect(bundle.project.voiceLanguages).toEqual(['en', 'zh-CN', 'ja']);
    expect(bundle.episodes[0]!.needsReview).toBe(false);
    expect(h.token(episode.id)).toBe(before);
    expect((await h.call(`/api/projects/${p.project.id}/voice-languages`, {languages: ['zh-CN']}, 'PUT')).status).toBe(400);
    const renamed = (await h.call(`/api/projects/${p.project.id}`, {...base, language: 'fr'}, 'PUT')).body as ProjectBundle;
    expect(renamed.project.voiceLanguages).toEqual(['fr', 'en', 'zh-CN', 'ja']);
  });
});
