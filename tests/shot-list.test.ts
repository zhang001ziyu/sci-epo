import { describe, expect, test } from 'bun:test';
import { buildModelMessages, snapshotContext } from '../src/core';
import { boundAdaptations, csvCell, exportShotListCsv, mergeWithNext, newestAlignedAdaptations, nextShotId, parseAdaptationBinding, parseShotList, parseShotListOutput, sceneDifferences, shotListStatus, shotListWarnings, shotTexts, splitShot, totalDuration, ShotListError, type ShotListContext } from '../src/core/shotList';
import type { Brief, Localization, Revision, ShotList, ShotListContent } from '../src/types';

const brief: Brief = {title: 'Last Order', premise: 'A rider delivers at midnight.', characters: 'MAYA, LEO', worldRules: 'Ordinary city.', authorRules: 'End on a reveal.', language: 'en', format: 'vertical_short_drama', durationTarget: {min: 10, max: 20}};
const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, title: 'The Last Order', logline: 'A rider sings.', language: 'en', kind: 'generated', instruction: '', mode: 'live', createdAt: '2026-11-07T00:00:00.000Z', context: snapshotContext(brief, []), scenes: [
  {id: 's1', heading: 'INT. ELEVATOR - NIGHT', content: 'Maya holds one cupcake.\nMAYA: Singing costs extra.\n\nThe doors open.', locked: false},
  {id: 's2', heading: 'INT. HALLWAY - CONTINUOUS', content: 'LEO opens the door a crack.\nLEO: I didn\'t order anything.\nMAYA: Then who did?', locked: false},
]};
const zh: Localization = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', parentId: null, mode: 'live', glossary: '', createdAt: revision.createdAt, title: '最后一单', logline: '外卖员唱歌。', scenes: [
  {id: 's1', heading: '内景 · 电梯 · 夜', content: '玛雅捧着一个纸杯蛋糕。\n玛雅：唱歌得加钱。\n电梯门打开。', locked: false},
  {id: 's2', heading: '内景 · 走廊 · 连续', content: '老林把门开了一条缝。\n老林：我没点外卖。\n玛雅：那是谁点的？', locked: false},
]};
const content = (): ShotListContent => ({cast: [{id: 'C1', name: 'MAYA'}, {id: 'C2', name: 'LEO'}], shots: [
  {id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'push_in', characters: ['C1'], spoken: [{line: 2, castId: 'C1'}], durationSeconds: 4},
  {id: 'sh2', sceneId: 's1', firstLine: 3, lastLine: 3, size: 'medium', camera: 'static', characters: ['C1'], spoken: [], durationSeconds: 2},
  {id: 'sh3', sceneId: 's2', firstLine: 1, lastLine: 2, size: 'medium_close_up', camera: 'static', characters: ['C2'], spoken: [{line: 2, castId: 'C2'}], durationSeconds: 4},
  {id: 'sh4', sceneId: 's2', firstLine: 3, lastLine: 3, size: 'close_up', camera: 'static', characters: ['C1'], spoken: [{line: 3, castId: 'C1'}], durationSeconds: 3, composition: 'Maya fills the frame.'},
]});
const list = (overrides: Partial<ShotList> = {}): ShotList => ({...content(), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'live', createdAt: revision.createdAt, ...overrides});
const mutate = (fn: (c: ShotListContent) => void) => { const c = content(); fn(c); return c; };
const kinds = (l: ShotList, context: ShotListContext = {revision, adaptations: {'zh-CN': zh}}) => shotListWarnings(l, context).map(w => w.kind);

describe('shot-list integrity', () => {
  test('a complete, ordered shot list is accepted and unknown keys are dropped', () => {
    const withText = mutate(c => { (c.shots[0] as unknown as Record<string, unknown>).text = 'copied script text'; });
    const parsed = parseShotList(withText, revision);
    expect(parsed).toEqual(content());
    expect(JSON.stringify(parsed)).not.toContain('copied script text');
    expect(parseShotListOutput('```json\n' + JSON.stringify(content()) + '\n```', revision)).toEqual(content());
    expect(parseShotList(mutate(c => { c.shots[0]!.durationSeconds = 4.26; }), revision).shots[0]!.durationSeconds).toBe(4.3);
  });

  const rejected: [string, (c: ShotListContent) => void, string][] = [
    ['a gap', c => { c.shots[0]!.lastLine = 1; c.shots[0]!.spoken = []; }, '场景 s1 第 2–2 行没有镜头覆盖'],
    ['an overlap', c => { c.shots[1]!.firstLine = 2; }, '重叠'],
    ['a missing final line', c => { c.shots.pop(); }, '场景 s2 第 3–3 行没有镜头覆盖'],
    ['a skipped scene end', c => { c.shots.splice(1, 1); }, '场景 s1 第 3–3 行没有镜头覆盖'],
    ['a return to an earlier scene', c => { c.shots.push({...c.shots[1]!, id: 'sh9'}); }, '排在最后一场之后'],
    ['scene order reversed', c => { c.shots = [c.shots[2]!, c.shots[3]!, c.shots[0]!, c.shots[1]!]; }, '场景 s1 第 1–3 行没有镜头覆盖'],
    ['an unknown scene', c => { c.shots[0]!.sceneId = 's9'; }, '场景 s9 不存在'],
    ['lines past the scene end', c => { c.shots[1]!.lastLine = 4; }, '共 3 行'],
    ['an unknown shot size', c => { (c.shots[0] as unknown as Record<string, unknown>).size = 'cinematic'; }, '景别无效'],
    ['an unknown camera move', c => { (c.shots[0] as unknown as Record<string, unknown>).camera = 'drone'; }, '运镜无效'],
    ['a character outside the cast', c => { c.shots[0]!.characters = ['C7']; }, '入镜人物'],
    ['a spoken line outside the shot', c => { c.shots[0]!.spoken = [{line: 3, castId: 'C1'}]; }, '不在本镜第 1–2 行之内'],
    ['a line with two speakers', c => { c.shots[0]!.spoken = [{line: 2, castId: 'C1'}, {line: 2, castId: 'C2'}]; }, '重复标注'],
    ['an unknown speaker', c => { c.shots[0]!.spoken = [{line: 2, castId: 'C5'}]; }, '不在角色表中'],
    ['a zero duration', c => { c.shots[0]!.durationSeconds = 0.01; }, '预计时长'],
    ['a duration over ten minutes', c => { c.shots[0]!.durationSeconds = 601; }, '预计时长'],
    ['a duplicate shot ID', c => { c.shots[1]!.id = 'sh1'; }, '镜头编号重复'],
    ['a malformed cast ID', c => { c.cast[0]!.id = 'Maya'; }, '编号无效'],
    ['a duplicate cast name', c => { c.cast[1]!.name = 'maya'; }, '角色名字重复'],
    ['an overlong note', c => { c.shots[0]!.composition = 'x'.repeat(501); }, '500 字以内'],
    ['no shots', c => { c.shots = []; }, '1–400 个镜头'],
  ];
  for (const [name, change, message] of rejected) test(`rejects ${name}`, () => {
    expect(() => parseShotList(mutate(change), revision)).toThrow(message);
  });
  test('rejects output that is not JSON with a shot-list error', () => {
    expect(() => parseShotListOutput('cast: none', revision)).toThrow(ShotListError);
  });
});

describe('shot-list reading and warnings', () => {
  test('texts come from the revision and the bound adaptation by line position', () => {
    const views = shotTexts(list(), revision, {'zh-CN': zh});
    expect(views[0]!.lines).toEqual([
      {position: 1, texts: {en: 'Maya holds one cupcake.', 'zh-CN': '玛雅捧着一个纸杯蛋糕。'}},
      {position: 2, texts: {en: 'MAYA: Singing costs extra.', 'zh-CN': '玛雅：唱歌得加钱。'}, speakerId: 'C1'},
    ]);
    expect(totalDuration(list())).toBe(13);
    expect(boundAdaptations(list(), [zh])).toEqual({'zh-CN': zh});
  });

  test('a clean shot list within the target has no warnings', () => {
    expect(kinds(list())).toEqual([]);
  });

  test('each warning kind is reported without blocking', () => {
    const long = list({shots: content().shots.map((s, i) => i === 0 ? {...s, durationSeconds: 16} : s)});
    expect(kinds(long)).toContain('too_long');
    const rushed = list({shots: content().shots.map((s, i) => i === 2 ? {...s, durationSeconds: 0.5} : s)});
    expect(shotListWarnings(rushed, {revision, adaptations: {'zh-CN': zh}}).filter(w => w.kind === 'too_short_for_speech').map(w => w.language)).toEqual(['en', 'zh-CN']);
    const shared = list({shots: content().shots.map((s, i) => i === 2 ? {...s, lastLine: 3, spoken: [{line: 2, castId: 'C2'}, {line: 3, castId: 'C1'}]} : s).filter((_, i) => i !== 3)});
    expect(kinds(shared)).toContain('multiple_speakers');
    const wrongVoice = list({shots: content().shots.map((s, i) => i === 3 ? {...s, spoken: [{line: 3, castId: 'C2'}]} : s)});
    expect(shotListWarnings(wrongVoice, {revision, adaptations: {'zh-CN': zh}}).find(w => w.kind === 'label_mismatch')?.message).toContain('剧本写的说话人是 MAYA，镜头标注的是 LEO');
    const silent = list({shots: content().shots.map((s, i) => i === 3 ? {...s, spoken: []} : s)});
    expect(kinds(silent)).toContain('unassigned_dialogue');
    const shifted = {...zh, scenes: [zh.scenes[0]!, {...zh.scenes[1]!, content: '老林：我没点外卖。\n老林把门开了一条缝。\n玛雅：那是谁点的？'}]};
    expect(shotListWarnings(list(), {revision, adaptations: {'zh-CN': shifted}}).filter(w => w.kind === 'dialogue_misaligned')).toHaveLength(2);
    expect(kinds(list({shots: content().shots.map(s => ({...s, durationSeconds: 1}))}))).toContain('total_duration');
    expect(kinds(list({adaptations: {}}), {revision, adaptations: {}})).toContain('missing_language');
    expect(shotListWarnings(list(), {revision, adaptations: {'zh-CN': zh}, newest: {'zh-CN': 'l2'}}).map(w => w.kind)).toEqual(['adaptation_not_newest']);
  });

  test('status distinguishes adopted, current and adoptable lists', () => {
    expect(shotListStatus(list(), {acceptedRevisionId: 'r1', needsReview: false, productionShotListId: 'v1'})).toEqual({adopted: true, current: true, adoptable: false});
    expect(shotListStatus(list(), {acceptedRevisionId: 'r1', needsReview: true, productionShotListId: 'v1'})).toEqual({adopted: true, current: false, adoptable: false});
    expect(shotListStatus(list(), {acceptedRevisionId: 'r2', needsReview: false, productionShotListId: 'v1'})).toEqual({adopted: true, current: false, adoptable: false});
    expect(shotListStatus(list(), {acceptedRevisionId: 'r1', needsReview: false})).toEqual({adopted: false, current: false, adoptable: true});
  });

  test('scene differences cover changed, added and removed scenes', () => {
    const changed = {scenes: [{...revision.scenes[0]!, content: 'Maya holds two cupcakes.'}, {id: 's3', heading: 'NEW', content: 'New.', locked: false}]};
    expect(sceneDifferences(revision, changed)).toEqual(['s1', 's2', 's3']);
    expect(sceneDifferences(revision, revision)).toEqual([]);
  });
});

describe('editing operations', () => {
  test('split gives only the new part a new ID and partitions lines, speakers and time', () => {
    const split = splitShot(content(), 'sh1', 2);
    expect(split.shots.map(s => s.id)).toEqual(['sh1', 'sh5', 'sh2', 'sh3', 'sh4']);
    expect(split.shots[0]).toMatchObject({firstLine: 1, lastLine: 1, spoken: [], durationSeconds: 2});
    expect(split.shots[1]).toMatchObject({firstLine: 2, lastLine: 2, spoken: [{line: 2, castId: 'C1'}], durationSeconds: 2});
    expect(parseShotList(split, revision)).toEqual(split);
    expect(() => splitShot(content(), 'sh2', 3)).toThrow('不能从第 3 行拆开');
    expect(nextShotId([{id: 'sh2'}, {id: 'custom'}])).toBe('sh3');
  });

  test('merge keeps the first ID, joins notes and refuses to cross scenes', () => {
    const merged = mergeWithNext(content(), 'sh3');
    expect(merged.shots.map(s => s.id)).toEqual(['sh1', 'sh2', 'sh3']);
    expect(merged.shots[2]).toMatchObject({firstLine: 1, lastLine: 3, characters: ['C2', 'C1'], durationSeconds: 7, composition: 'Maya fills the frame.'});
    expect(parseShotList(merged, revision)).toEqual(merged);
    expect(() => mergeWithNext(content(), 'sh2')).toThrow('同一场');
  });
});

describe('adaptation binding and export', () => {
  test('only line-aligned adaptations of the same revision in a voice language can be bound', () => {
    const misaligned = {...zh, id: 'l3', scenes: [zh.scenes[0]!, {...zh.scenes[1]!, content: '老林把门开了一条缝。老林：我没点外卖。\n玛雅：那是谁点的？'}]};
    expect(parseAdaptationBinding({'zh-CN': 'l1'}, revision, [zh, misaligned], ['en', 'zh-CN'])).toEqual({'zh-CN': 'l1'});
    expect(() => parseAdaptationBinding({'zh-CN': 'l3'}, revision, [zh, misaligned], ['en', 'zh-CN'])).toThrow('没有逐行对齐');
    expect(() => parseAdaptationBinding({ja: 'l1'}, revision, [zh], ['en', 'zh-CN'])).toThrow('不是需要改编的配音语言');
    expect(() => parseAdaptationBinding({'zh-CN': 'l9'}, revision, [zh], ['en', 'zh-CN'])).toThrow('不属于这一版剧本');
    expect(newestAlignedAdaptations(revision, [zh, misaligned, {...zh, id: 'l4'}], ['en', 'zh-CN'])['zh-CN']!.id).toBe('l4');
  });

  test('CSV has a byte order mark, one row per shot, both languages and neutralized formulas', () => {
    const csv = exportShotListCsv({list: list(), revision, adaptations: {'zh-CN': zh}, episodeTitle: '=HYPERLINK("x")', status: {adopted: true, current: false}});
    expect(csv.startsWith('\uFEFF"episode","shot_list_version"')).toBe(true);
    const rows = csv.slice(1).trimEnd().split('\r\n');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('"text_en","text_zh-CN","est_seconds","duration_basis"');
    expect(rows[1]).toStartWith('"\'=HYPERLINK(""x"")","v1","r1","zh-CN:l1","adopted_not_current","9:16","1","sh1","s1","1-2","close_up","push_in","MAYA","MAYA"');
    expect(rows[1]).toContain('"Maya holds one cupcake.\nMAYA: Singing costs extra.","玛雅捧着一个纸杯蛋糕。\n玛雅：唱歌得加钱。","4","estimate"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('plain "quoted"')).toBe('"plain ""quoted"""');
  });
});

describe('storyboard request', () => {
  test('sends numbered lines, the frame, the shot limit and the duration target', () => {
    const [system, user] = buildModelMessages({kind: 'storyboard', context: revision.context, revision, episodeTitle: 'Episode 1'});
    expect(system!.content).toContain('每一行恰好属于一个镜头');
    expect(system!.content).toContain('10–20 秒');
    const payload = JSON.parse(user!.content);
    expect(payload).toMatchObject({aspectRatio: '9:16', maxShotSeconds: 15, durationTarget: {min: 10, max: 20}});
    expect(payload.scenes[0].lines).toEqual([{n: 1, text: 'Maya holds one cupcake.'}, {n: 2, text: 'MAYA: Singing costs extra.'}, {n: 3, text: 'The doors open.'}]);
    const {format: _f, durationTarget: _d, ...episodicBrief} = brief;
    const episodic = {...revision, context: snapshotContext(episodicBrief, [])};
    const plain = JSON.parse(buildModelMessages({kind: 'storyboard', context: episodic.context, revision: episodic, episodeTitle: 'Episode 1'})[1]!.content);
    expect(plain.aspectRatio).toBe('16:9');
    expect(plain.durationTarget).toBeUndefined();
  });
});
