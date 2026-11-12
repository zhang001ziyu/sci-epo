import { describe, expect, test } from 'bun:test';
import { DEFAULT_CUT_SETTINGS, captionFiles, cutArguments, cutCurrent, cutGain, cutPlan, fontFilterValue, parseEbur128, parseLoudnorm, pictureLanguage, wrapCaption, type CutArgumentsInput } from '../src/core/cut';
import { quotedParts, readingSeconds, screenTextOf } from '../src/core/scriptLines';
import { parseShotList, screenTextLines, shotListWarnings } from '../src/core/shotList';
import type { Localization, RenderBatch, RenderClip, RenderJobV2, Revision, ShotList, Take } from '../src/types';

const NOTE_EN = "The delivery note reads: 'Knock three times. Do NOT call 911 if he doesn't answer. Check if he is breathing. Extra $20 under the mat. Payer: Anna Lin.'";
const NOTE_ZH = '备注写着：“敲门三次。没人应别打急救电话。确认他还有气就行。地垫下有二十块小费。付款人：林安娜。”';
const brief = {title: 'Last Order', premise: 'p', characters: '', worldRules: '', authorRules: '', language: 'en', format: 'vertical_short_drama' as const, durationTarget: {min: 10, max: 40}};
const revision = {id: 'r1', episodeId: 'e1', parentId: null, title: 'Last Order', logline: '', kind: 'generated', instruction: '', mode: 'demo', createdAt: '2026-11-12T00:00:00.000Z', language: 'en',
  context: {brief, previousEpisodes: [], hash: 'h'},
  scenes: [{id: 's1', heading: 'INT. HALL - NIGHT', locked: false, content: `Maya walks down the hall.\n${NOTE_EN}\nMAYA: Great. Cheated out of twenty bucks.`}]} as unknown as Revision;
const zh = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', title: '最后一单', logline: '', parentId: null, mode: 'demo', glossary: '', createdAt: '2026-11-12T00:00:00.000Z',
  scenes: [{id: 's1', heading: '内. 走廊 - 夜', locked: false, content: `玛雅走过走廊。\n${NOTE_ZH}\n玛雅：得，先被坑了二十块。`}]} as unknown as Localization;
const list = {id: 'L1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'demo', createdAt: '2026-11-12T00:00:00.000Z',
  cast: [{id: 'C1', name: 'MAYA'}],
  shots: [
    {id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 1, size: 'medium', camera: 'handheld', characters: ['C1'], spoken: [], durationSeconds: 3.5},
    {id: 'sh2', sceneId: 's1', firstLine: 2, lastLine: 2, size: 'insert', camera: 'static', characters: [], spoken: [], durationSeconds: 4.5},
    {id: 'sh3', sceneId: 's1', firstLine: 3, lastLine: 3, size: 'close_up', camera: 'static', characters: ['C1'], spoken: [{line: 3, castId: 'C1'}], durationSeconds: 4},
  ]} as unknown as ShotList;
const prompt = (text: string) => ({mode: 'r2v' as const, text, images: [], audio: []});
const clips: RenderClip[] = [
  {id: 'c01', sceneId: 's1', shotIds: ['sh1', 'sh2'], plannedSeconds: 8, frames: 192, seed: 1, warnings: [], prompts: {en: prompt('picture'), 'zh-CN': prompt('picture')}},
  {id: 'c02', sceneId: 's1', shotIds: ['sh3'], plannedSeconds: 4, frames: 107, seed: 2, warnings: [], prompts: {en: prompt('<d>[English] Great.</d>'), 'zh-CN': prompt('<d>[Chinese] 得。</d>')}},
];
const batch = {id: 'B1', episodeId: 'e1', shotListId: 'L1', sourceRevisionId: 'r1', adaptations: {'zh-CN': 'l1'}, languages: ['en', 'zh-CN'], width: 480, height: 864, fps: 24, clipLimitSeconds: 15,
  profile: {style: '', music: '', characters: []}, clips, warnings: [], createdAt: '2026-11-12T00:00:00.000Z', version: 2, musicMode: 'bed'} as unknown as RenderBatch;
const take = (n: number, integrated: number, extra: Partial<Take> = {}): Take => ({n, seed: n, status: 'rendered', video: {assetId: `a${n}-${integrated}`, sha256: `${n}`.repeat(64).slice(0, 64), bytes: 10, seconds: 8}, qa: {checks: [], keyframes: [], loudness: {integrated, truePeak: -1}}, ...extra});
const jobs = (): RenderJobV2[] => [
  {id: 'j1', batchId: 'B1', clipId: 'c01', key: 'k1', languages: ['en', 'zh-CN'], order: 0, outputName: 'ep01-c01.mp4', takes: [take(1, -28.3)], updatedAt: ''},
  {id: 'j2', batchId: 'B1', clipId: 'c02', key: 'k2', languages: ['en'], order: 1, outputName: 'ep01-c02-en.mp4', takes: [{...take(1, -10.5), video: {assetId: 'v-en', sha256: 'e'.repeat(64), bytes: 10, seconds: 4.46}}], updatedAt: ''},
  {id: 'j3', batchId: 'B1', clipId: 'c02', key: 'k3', languages: ['zh-CN'], order: 2, outputName: 'ep01-c02-zh-CN.mp4', takes: [{...take(1, -12.3), video: {assetId: 'v-zh', sha256: 'f'.repeat(64), bytes: 10, seconds: 4.46}}], updatedAt: ''},
];

describe('on-screen text', () => {
  test('quoted parts: single quotes only after a colon, apostrophes inside a quote, CJK quotes anywhere', () => {
    expect(quotedParts(NOTE_EN)).toEqual(["Knock three times. Do NOT call 911 if he doesn't answer. Check if he is breathing. Extra $20 under the mat. Payer: Anna Lin."]);
    expect(quotedParts(NOTE_ZH)).toEqual(['敲门三次。没人应别打急救电话。确认他还有气就行。地垫下有二十块小费。付款人：林安娜。']);
    expect(quotedParts("MAYA: Don't go.")).toEqual([]);
    expect(quotedParts('The screen flashes green: \'Tip added: $500.00.\' A follow-up text appears: "Don\'t let him light the match."')).toEqual(['Tip added: $500.00.', "Don't let him light the match."]);
    expect(screenTextOf("MAYA: Don't go.")).toBe("Don't go.");
    expect(screenTextOf('A sign: "50% off; C:\\temp [x] \'y\' %{n}"')).toBe("50% off; C:\\temp [x] 'y' %{n}");
  });

  test('marks are parsed, and a shot without marks falls back to its quoted non-dialogue lines', () => {
    const marked = parseShotList({cast: list.cast, shots: list.shots.map(s => s.id === 'sh2' ? {...s, screenText: [2]} : s)}, revision);
    expect(marked.shots[1]!.screenText).toEqual([2]);
    expect(() => parseShotList({cast: list.cast, shots: list.shots.map(s => s.id === 'sh2' ? {...s, screenText: [3]} : s)}, revision)).toThrow();
    expect(() => parseShotList({cast: list.cast, shots: list.shots.map(s => s.id === 'sh2' ? {...s, screenText: [2, 2]} : s)}, revision)).toThrow();
    const lines = revision.scenes[0]!.content.split('\n');
    expect(screenTextLines(list.shots[1]!, lines)).toEqual([2]);
    expect(screenTextLines({...list.shots[1]!, screenText: []}, lines)).toEqual([]);
    expect(screenTextLines(list.shots[2]!, lines)).toEqual([]);
  });

  test('a note too long to read in its shot warns in every voice language', () => {
    expect(readingSeconds(['一二三四五六七八九'], 'zh-CN')).toBe(1);
    expect(readingSeconds(['a'.repeat(17)], 'en')).toBe(1);
    const warnings = shotListWarnings(list, {revision, adaptations: {'zh-CN': zh}}).filter(w => w.kind === 'screen_text_unreadable');
    expect(warnings.map(w => [w.shotId, w.language])).toEqual([['sh2', 'en'], ['sh2', 'zh-CN']]);
    expect(shotListWarnings(list, {revision, adaptations: {'zh-CN': zh}, readingSpeed: {latin: 60, cjk: 30}}).some(w => w.kind === 'screen_text_unreadable')).toBe(false);
  });
});

describe('cut plans', () => {
  test('drafts use the latest rendered take, gains level each clip, and captions come in the cut language', () => {
    const plan = cutPlan({batch, jobs: jobs(), list, revision, localizations: [zh], language: 'zh-CN', kind: 'draft'});
    expect(plan.missing).toEqual([]);
    expect(plan.clips.map(c => [c.clipId, c.jobId, c.take, c.offset, c.seconds, c.gainDb, c.dialogue])).toEqual([['c01', 'j1', 1, 0, 8, 6.3, false], ['c02', 'j3', 1, 8, 4.46, -3.7, true]]);
    expect(plan.pictureLanguage).toBe('en');
    expect(plan.captions).toEqual([{shotId: 'sh2', start: 3.5, end: 8, text: '敲门三次。没人应别打急救电话。确认他还有气就行。地垫下有二十块小费。付款人：林安娜。', enabled: true}]);
    const en = cutPlan({batch, jobs: jobs(), list, revision, localizations: [zh], language: 'en', kind: 'draft'});
    expect(en.clips.map(c => c.jobId)).toEqual(['j1', 'j2']);
    expect(en.captions[0]).toMatchObject({shotId: 'sh2', enabled: false});
    expect(pictureLanguage(list, revision)).toBe('en');
  });

  test('a final cut needs approved takes, and a cut stops being current when its takes change', () => {
    const all = jobs();
    expect(cutPlan({batch, jobs: all, list, revision, localizations: [zh], language: 'zh-CN', kind: 'final'}).missing).toEqual(['c01', 'c02']);
    all[0]!.approvedTake = 1; all[2]!.approvedTake = 1;
    const final = cutPlan({batch, jobs: all, list, revision, localizations: [zh], language: 'zh-CN', kind: 'final'});
    expect(final.missing).toEqual([]);
    const draft = cutPlan({batch, jobs: all, list, revision, localizations: [zh], language: 'zh-CN', kind: 'draft'});
    all[0]!.takes.push(take(2, -20));
    expect(cutCurrent({kind: 'draft', clips: draft.clips}, all)).toBe(false);
    expect(cutCurrent({kind: 'final', clips: final.clips}, all)).toBe(true);
    all[0]!.approvedTake = 2;
    expect(cutCurrent({kind: 'final', clips: final.clips}, all)).toBe(false);
  });

  test('gains are clamped, and unknown loudness keeps the take as it is', () => {
    expect(cutGain(-28.3, false, DEFAULT_CUT_SETTINGS)).toBe(6.3);
    expect(cutGain(-10.5, true, DEFAULT_CUT_SETTINGS)).toBe(-5.5);
    expect(cutGain(-50, false, DEFAULT_CUT_SETTINGS)).toBe(9);
    expect(cutGain(undefined, true, DEFAULT_CUT_SETTINGS)).toBe(0);
  });
});

describe('captions and ffmpeg arguments', () => {
  test('captions wrap by character for Chinese and by word for English, at most four lines', () => {
    expect(wrapCaption('一二三四五六七八九十一二三四五六七八九十', 'zh-CN').split('\n').map(l => [...l].length)).toEqual([16, 4]);
    expect(wrapCaption('Knock three times. Do NOT call 911 if he does not answer.', 'en')).toBe('Knock three times. Do NOT call\n911 if he does not answer.');
    const long = wrapCaption('字'.repeat(100), 'zh-CN').split('\n');
    expect(long).toHaveLength(4);
    expect(long[3]!.endsWith('…')).toBe(true);
    expect(wrapCaption('第一行\n第二行', 'zh-CN')).toBe('第一行\n第二行');
  });

  test('caption text only reaches ffmpeg through files, and the font path is escaped for the filter', () => {
    const hostile = "50% off; C:\\temp [x] 'y' %{pts} drawtext=evil:text=a,b";
    const files = captionFiles([{shotId: 'sh2', start: 3.5, end: 8, text: hostile, enabled: true}, {shotId: 'sh9', start: 9, end: 10, text: 'off', enabled: false}], 'en');
    expect(files.map(f => f.name)).toEqual(['caption-001.txt']);
    const input: CutArgumentsInput = {inputs: [{file: 'C:\\media\\a.mp4', seconds: 8, gainDb: 6.3, audio: true}, {file: 'C:\\media\\b.mp4', seconds: 4.46, gainDb: -3.7, audio: false}],
      music: {file: 'C:\\media\\m.flac', levelDb: -20}, captions: files.map(f => ({file: f.name, start: f.start, end: f.end})), font: 'C:\\Windows\\Fonts\\msyh.ttc',
      width: 720, height: 1280, fps: 24, settings: DEFAULT_CUT_SETTINGS, output: 'cut.mp4'};
    const pass1 = cutArguments(input), pass2 = cutArguments(input, {i: -16.5, tp: 5.8, lra: 19, thresh: -29.3, offset: 0.7});
    expect(pass1.slice(-5)).toEqual(['-map', '[aout]', '-f', 'null', '-']);
    const graph1 = pass1[pass1.indexOf('-filter_complex') + 1]!, graph2 = pass2[pass2.indexOf('-filter_complex') + 1]!;
    expect(graph1).toContain('print_format=json');
    expect(graph1).not.toContain('drawtext');
    expect(graph2).toContain("drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile=caption-001.txt:expansion=none");
    expect(graph2).toContain("enable='between(t,3.500,8.000)'");
    expect(graph2).not.toContain('evil');
    expect(graph2).toContain('anullsrc=r=48000:cl=stereo');
    expect(graph2).toContain('volume=6.3dB');
    expect(graph2).toContain('scale=720:1280:force_original_aspect_ratio=increase:flags=lanczos,crop=720:1280,setsar=1');
    expect(graph2).toContain('sidechaincompress');
    expect(graph2).toContain('amix=inputs=2:duration=first:dropout_transition=0:normalize=0');
    expect(graph2).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-16.50:measured_TP=5.80');
    expect(pass2).toEqual(expect.arrayContaining(['-stream_loop', '-1', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'cut.mp4']));
    expect(pass2.join(' ')).not.toContain(hostile);
    expect(fontFilterValue('C:\\Users\\Zhang 张\\font.ttc')).toBeUndefined();
    expect(() => cutArguments({...input, captions: [{file: "x';drawtext.txt", start: 0, end: 1}]}, null)).toThrow();
    expect(cutArguments({...input, music: null}, null).join(' ')).not.toContain('-stream_loop');
  });

  test('loudness readings are parsed from ffmpeg output', () => {
    const json = '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-16.51",\n\t"input_tp" : "5.83",\n\t"input_lra" : "19.00",\n\t"input_thresh" : "-29.29",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.69"\n}\n';
    expect(parseLoudnorm(json)).toEqual({i: -16.51, tp: 5.83, lra: 19, thresh: -29.29, offset: 0.69});
    expect(parseLoudnorm(json.replace('-16.51', '-inf'))).toBeNull();
    expect(parseLoudnorm('no json here')).toBeNull();
    const summary = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.0 LUFS\n    Threshold: -24.4 LUFS\n\n  True peak:\n    Peak:       -0.8 dBFS\n';
    expect(parseEbur128(summary)).toEqual({integrated: -14, truePeak: -0.8});
    expect(parseEbur128('nothing')).toEqual({integrated: null, truePeak: null});
  });
});
