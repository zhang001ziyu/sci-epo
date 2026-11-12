import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { openIssues, readinessItems, unconfirmedItems } from '../src/core/readiness';
import { SHORT_DRAMA_DEMO, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { Episode, Localization, ProductionProfile, Review, Revision, ShotList } from '../src/types';

const time = '2026-11-12T08:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA, LEO', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const};
const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(SHORT_DRAMA_DEMO.en), language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: time, context: snapshotContext(brief, [])};
const zh: Localization = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', parentId: null, mode: 'live', glossary: '', createdAt: time, ...structuredClone(SHORT_DRAMA_DEMO.zh)};
const list: ShotList = {...shortDramaDemoShotList('en'), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'live', createdAt: time};
const episode: Episode = {id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: 'r1', needsReview: false, createdAt: time, productionShotListId: 'v1'};
const profile: ProductionProfile = {style: '', music: '', characters: [
  {name: 'MAYA', appearance: 'a rider in a yellow jacket, hood down', voice: 'a dry voice', portrait: {assetId: 'a', sha256: 'a'.repeat(64), approvedAt: time}},
  {name: 'LEO', appearance: '', voice: ''},
]};
const review = (overrides: Partial<Review> = {}): Review => ({id: 'rv1', revisionId: 'r1', status: 'completed', errors: [], mode: 'live', createdAt: time,
  assessments: [{dimension: 'story', status: 'issue', explanation: 'Anna knows about the match without any way to see it.', evidence: []}, {dimension: 'dialogue', status: 'no_issue', explanation: 'ok', evidence: []}],
  causality: {status: 'completed', errors: [], checks: [{sceneId: 's2', state: '', choice: '', obstacleKind: 'none', alternative: '', verdict: 'gap', explanation: 'Why not call 911?', evidence: [], constraintEvidence: []}]}, ...overrides});
const ids = (items: {id: string; status: string}[], status: string) => items.filter(i => i.status === status).map(i => i.id);

describe('readiness', () => {
  test('a reviewed, adopted episode with portraits passes; open issues and missing descriptions warn', () => {
    const items = readinessItems({episode, revision, list, reviews: [review()], localizations: [zh], profile});
    expect(ids(items, 'failed')).toEqual(['portrait:LEO']);
    expect(ids(items, 'passed')).toEqual(expect.arrayContaining(['accepted', 'review', 'shot_list', 'adaptation:zh-CN', 'portrait:MAYA']));
    expect(ids(items, 'warning')).toEqual(expect.arrayContaining(['issue:assessment:story', 'issue:causal:s2:0', 'appearance:LEO', 'voice:LEO']));
    expect(items.find(i => i.id === 'issue:assessment:story')).toMatchObject({link: {tab: 'review'}, message: expect.stringContaining('Anna knows')});
    expect(openIssues(review()).map(i => i.id)).toEqual(['issue:assessment:story', 'issue:causal:s2:0']);
    expect(unconfirmedItems(items, ['portrait:LEO']).every(i => i.status === 'warning')).toBe(true);
  });

  test('no review, a demo review, an unaccepted script and an old shot list fail', () => {
    expect(readinessItems({episode, revision, list, reviews: [], localizations: [zh], profile}).find(i => i.id === 'review')!.status).toBe('failed');
    expect(readinessItems({episode, revision, list, reviews: [review({mode: 'demo'})], localizations: [zh], profile}).find(i => i.id === 'review')!.message).toContain('示例演练');
    expect(readinessItems({episode, revision, list, reviews: [review({status: 'needs_review'})], localizations: [zh], profile}).find(i => i.id === 'review')!.status).toBe('failed');
    // A review of another revision does not count for the accepted one.
    expect(readinessItems({episode, revision, list, reviews: [review({revisionId: 'r0'})], localizations: [zh], profile}).find(i => i.id === 'review')!.status).toBe('failed');
    const recheck = readinessItems({episode: {...episode, needsReview: true}, revision, list, reviews: [review()], localizations: [zh], profile});
    expect(recheck.find(i => i.id === 'accepted')!.status).toBe('failed');
    expect(recheck.find(i => i.id === 'shot_list')!.status).toBe('failed');
    expect(readinessItems({episode: {...episode, acceptedRevisionId: null}, reviews: [], localizations: []}).map(i => i.id)).toEqual(['accepted']);
    const unbound = readinessItems({episode, revision, list: {...list, adaptations: {}}, reviews: [review()], localizations: [zh], profile});
    expect(unbound.find(i => i.id === 'adaptation:zh-CN')!.status).toBe('failed');
  });

  test('shot-list warnings appear with a link to the shot, and opting out of a portrait warns', () => {
    const items = readinessItems({episode, revision, list, reviews: [review()], localizations: [zh], profile: {...profile, characters: [profile.characters[0]!, {name: 'LEO', appearance: 'old', voice: 'hoarse', usePortrait: false}]}});
    expect(items.find(i => i.id === 'portrait:LEO')).toMatchObject({status: 'warning'});
    const shotWarnings = items.filter(i => i.id.startsWith('shot_warning:'));
    for (const w of shotWarnings) expect(w).toMatchObject({status: 'warning', link: {tab: 'shots'}});
  });
});
