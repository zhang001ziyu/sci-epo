import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { RenderPlanError, clipSeed, cutStamp, h3Frames, h3Size, outputName, parseProductionProfile, parseRenderResults, planClips, planRenderBatch, renderPackage, verifyPrompt, type RenderPlanInput } from '../src/core/h3';
import { SHORT_DRAMA_DEMO, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { Localization, ProductionProfile, Revision, Shot, ShotList } from '../src/types';

const time = '2026-11-10T00:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA, LEO', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const, durationTarget: {min: 60, max: 120}};
const revision = (language: 'en' | 'zh' = 'en'): Revision => ({id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(SHORT_DRAMA_DEMO[language]), language: language === 'en' ? 'en' : 'zh-CN', kind: 'generated', instruction: '', mode: 'demo', createdAt: time, context: snapshotContext({...brief, language: language === 'en' ? 'en' : 'zh-CN'}, [])});
const adaptation = (language: 'en' | 'zh'): Localization => ({id: `l-${language}`, sourceRevisionId: 'r1', language: language === 'en' ? 'en' : 'zh-CN', parentId: null, mode: 'demo', glossary: '', createdAt: time, ...structuredClone(SHORT_DRAMA_DEMO[language])});
const shotList = (language: 'en' | 'zh' = 'en'): ShotList => ({...shortDramaDemoShotList(language), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: language === 'en' ? ['en', 'zh-CN'] : ['zh-CN', 'en'], adaptations: {[language === 'en' ? 'zh-CN' : 'en']: `l-${language === 'en' ? 'zh' : 'en'}`}, mode: 'demo', createdAt: time});
const profile = (extra: Partial<ProductionProfile> = {}): ProductionProfile => ({style: 'Live-action, cinematic', music: 'N/A', characters: [
  {name: 'MAYA', appearance: 'a woman in her twenties in a wet yellow delivery jacket', voice: 'a dry, low female voice'},
  {name: 'LEO', appearance: 'a man of seventy in a gray cardigan', voice: 'a slow, hoarse male voice'},
], ...extra});
const input = (overrides: Partial<RenderPlanInput> = {}): RenderPlanInput => ({batchId: 'b1', createdAt: time, episodeId: 'e1', list: shotList(), revision: revision(), adaptations: {'zh-CN': adaptation('zh')}, profile: profile(), ...overrides});
const shot = (id: string, sceneId: string, durationSeconds: number): Shot => ({id, sceneId, firstLine: 1, lastLine: 1, size: 'close_up', camera: 'static', characters: [], spoken: [], durationSeconds});

describe('H3 frames, sizes and clips', () => {
  test('frames round up to the 17k+5 grid within H3 limits', () => {
    expect(h3Frames(5)).toBe(124);
    expect(h3Frames(15)).toBe(362);
    expect(h3Frames(8)).toBe(192);
    expect(h3Frames(4)).toBe(107);
    expect(h3Frames(1)).toBe(107);
    expect(h3Frames(20)).toBe(362);
    for (const seconds of [4.2, 6.5, 9.1, 12, 13.9]) { const frames = h3Frames(seconds); expect((frames - 5) % 17).toBe(0); expect(frames / 24).toBeGreaterThanOrEqual(seconds); }
    expect(h3Size('9:16')).toEqual({width: 768, height: 1344});
    expect(h3Size('16:9')).toEqual({width: 1344, height: 768});
    expect(cutStamp(7)).toBe('00:07.000');
    expect(cutStamp(63.25)).toBe('01:03.250');
  });

  test('consecutive shots of one scene share a clip within the limit', () => {
    const clips = planClips(shotList().shots);
    expect(clips.map(c => [c.id, c.shots.map(s => s.id), c.plannedSeconds, c.frames])).toEqual([
      ['c01', ['sh1', 'sh2'], 12, 294], ['c02', ['sh3', 'sh4'], 8, 192], ['c03', ['sh5', 'sh6'], 15, 362],
      ['c04', ['sh7'], 5, 124], ['c05', ['sh8', 'sh9'], 11, 277], ['c06', ['sh10', 'sh11'], 13, 328],
    ]);
    expect(planClips(shotList().shots, 5).length).toBe(11);
  });

  test('a long shot gets its own clip and a warning; limits are checked', () => {
    const clips = planClips([shot('a', 's1', 4), shot('b', 's1', 12), shot('c', 's1', 4)], 10);
    expect(clips.map(c => c.shots.map(s => s.id))).toEqual([['a'], ['b'], ['c']]);
    expect(clips[1]!.warnings[0]).toContain('超过 10 秒的片段上限');
    expect(planClips([shot('x', 's1', 18)])[0]!.warnings[0]).toContain('15.08 秒处结束');
    expect(() => planClips([], 4)).toThrow(RenderPlanError);
    expect(() => planClips([], 16)).toThrow(RenderPlanError);
  });

  test('seeds are deterministic per batch and clip', () => {
    expect(clipSeed('b1', 'c01')).toBe(clipSeed('b1', 'c01'));
    expect(clipSeed('b1', 'c01')).not.toBe(clipSeed('b1', 'c02'));
    expect(clipSeed('b1', 'c01')).not.toBe(clipSeed('b2', 'c01'));
    expect(Number.isSafeInteger(clipSeed('b1', 'c01'))).toBe(true);
  });
});

describe('H3 prompts', () => {
  test('T2VA prompts follow the guide and carry the exact lines of each language', () => {
    const {batch, jobs} = planRenderBatch(input());
    expect(batch.languages).toEqual(['en', 'zh-CN']);
    expect(batch.adaptations).toEqual({'zh-CN': 'l-zh'});
    expect(jobs.length).toBe(12);
    expect(jobs.slice(0, 2)).toEqual([{clipId: 'c01', language: 'en', order: 0}, {clipId: 'c01', language: 'zh-CN', order: 1}]);
    const c01 = batch.clips[0]!, en = c01.prompts.en!, zh = c01.prompts['zh-CN']!;
    expect(en.mode).toBe('t2va');
    expect(en.text.startsWith('integrated_multimodal_description: [Shot 1] Live-action, cinematic, a close-up in a vertical 9:16 frame. MAYA appears, a woman in her twenties in a wet yellow delivery jacket.')).toBe(true);
    expect(en.text).toContain('[Shot 2] At 00:07.000, the camera cuts to a medium close-up.');
    expect(en.text).toContain('MAYA (S1), with a dry, low female voice, says: <d>[English] Singing costs extra.</d>');
    expect(en.text).toContain('Her phone shows the order note: "Please sing happy birthday. He thinks everyone forgot."');
    expect(en.text).toContain('The camera pushes in with small amplitude at slow speed.');
    expect(en.text).toContain('\n\noverall_soundscape: Rain dripping, elevator hum. Elevator chime.\n\nnon_diegetic_music: N/A');
    // The Chinese job describes the same picture in English and speaks the Chinese line.
    expect(zh.text).toContain('Rain drips from Maya\'s delivery jacket.');
    expect(zh.text).toContain('MAYA (S1), with a dry, low female voice, says: <d>[Chinese] 唱歌得加钱。</d>');
    expect(zh.text).not.toContain('<d>[English]');
    expect(c01.seed).toBe(clipSeed('b1', 'c01'));
    expect(c01.frames).toBe(294);
  });

  test('speaker IDs follow the order of speech; delivery notes stay outside <d> in English', () => {
    const c03 = planRenderBatch(input()).batch.clips[2]!;
    expect(c03.prompts.en!.text).toContain('LEO (S1), with a slow, hoarse male voice, says: <d>[English] My daughter hasn\'t called me in five years.</d>');
    expect(c03.prompts.en!.text).toContain('MAYA (S2), with a dry, low female voice, says, singing, off-key: <d>[English] Happy birthday to you...</d>');
    expect(c03.prompts['zh-CN']!.text).toContain('MAYA (S2), with a dry, low female voice, says, singing, off-key: <d>[Chinese] 祝你生日快乐……</d>');
    const c06 = planRenderBatch(input()).batch.clips[5]!.prompts.en!.text;
    expect(c06).toContain('MAYA (S1), with a dry, low female voice, says: <d>[English] She says... happy birthday.</d>');
    expect(c06.match(/with a dry, low female voice/gu)?.length).toBe(1);
  });

  test('a reference image switches the clip to R2V with six sections and numbered pictures', () => {
    const withImage = profile(); withImage.characters[0]!.image = 'maya.png';
    const {batch} = planRenderBatch(input({profile: withImage}));
    const c01 = batch.clips[0]!.prompts.en!, c02 = batch.clips[1]!.prompts.en!;
    expect(c01.mode).toBe('r2v');
    expect(c01.images).toEqual(['maya.png']);
    expect(c01.text).toContain('subject_definitions:\n<Subject 1> is MAYA, the person shown in <Picture 1>, a woman in her twenties in a wet yellow delivery jacket.');
    expect(c01.text).toContain('summary:\n[reference generation] A 2-shot vertical 9:16 clip set in INT. APARTMENT ELEVATOR - NIGHT, featuring <Subject 1>. <Subject 1> keeps the identity and clothing shown in its reference picture.');
    expect(c01.text).toContain('retention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the identity, face, hair and clothing of MAYA from <Picture 1> are retained.');
    expect(c01.text).toContain('detailed_description:\nThe target video uses this visual style: Live-action, cinematic.\n[Shot 1] A close-up in a vertical 9:16 frame. <Subject 1> MAYA appears');
    expect(c01.text).toContain('<Subject 1> MAYA (S1), with a dry, low female voice, says: <d>[English] Singing costs extra.</d>');
    expect(c01.text).toContain('\n\noverall_soundscape:\nRain dripping, elevator hum. Elevator chime.\n\nnon_diegetic_music:\nN/A');
    expect(c02.mode).toBe('t2va');
  });

  test('voice samples become audio references for their speakers', () => {
    const voiced = profile(); voiced.characters[0]!.image = 'maya.png'; voiced.characters[0]!.voiceSample = 'maya-voice.wav'; voiced.characters[1]!.voiceSample = 'leo.wav';
    const c03 = planRenderBatch(input({profile: voiced})).batch.clips[2]!.prompts['zh-CN']!;
    expect(c03.mode).toBe('r2v');
    expect(c03.images).toEqual(['maya.png']);
    expect(c03.audio).toEqual(['leo.wav', 'maya-voice.wav']);
    expect(c03.text).toContain('<Audio 1> is the voice-timbre reference for LEO (S1).');
    expect(c03.text).toContain('<Audio 2> is the voice-timbre reference for <Subject 1> (S2).');
    expect(c03.text).toContain('[reference generation + audio reference]');
    expect(c03.text).toContain('LEO (S1), using the voice timbre referenced from <Audio 1>, says: <d>[Chinese] 我女儿五年没给我打过电话了。</d>');
  });

  test('a Chinese source with an English adaptation still writes an English body', () => {
    const {batch} = planRenderBatch(input({list: shotList('zh'), revision: revision('zh'), adaptations: {en: adaptation('en')}}));
    expect(batch.languages).toEqual(['zh-CN', 'en']);
    const zh = batch.clips[0]!.prompts['zh-CN']!.text;
    expect(zh).toContain('Rain drips from Maya\'s delivery jacket.');
    expect(zh).toContain('MAYA (S1), with a dry, low female voice, says: <d>[Chinese] 唱歌得加钱。</d>');
    expect(batch.warnings.some(w => w.includes('构图和声音说明是原稿语言'))).toBe(true);
  });

  test('without an English version the source text is used with a warning', () => {
    const {batch} = planRenderBatch(input({list: shotList('zh'), revision: revision('zh'), adaptations: {}, profile: {style: '', music: '', characters: []}}));
    expect(batch.languages).toEqual(['zh-CN']);
    expect(batch.warnings.some(w => w.includes('没有英文稿'))).toBe(true);
    expect(batch.warnings.some(w => w.includes('没有设置画面风格'))).toBe(true);
    expect(batch.warnings.some(w => w.includes('老林 没有外貌描述'))).toBe(true);
    expect(batch.clips[0]!.prompts['zh-CN']!.text).toContain('玛雅 (S1) says: <d>[Chinese] 唱歌得加钱。</d>');
  });

  test('prompt syntax in the script, profile or shot list is refused', () => {
    const r = revision(); r.scenes[0]!.content = r.scenes[0]!.content.replace('Singing costs extra.', 'Singing costs <d>extra</d>.');
    expect(() => planRenderBatch(input({revision: r}))).toThrow('场景 s1 第 3 行（en）含有 <、> 或 [Shot');
    const list = shotList(); list.shots[0]!.composition = 'See [Shot 3] later.';
    expect(() => planRenderBatch(input({list}))).toThrow('镜头 sh1 的构图或声音说明');
    expect(() => parseProductionProfile({style: 'noir <b>', characters: []})).toThrow('不能包含');
    expect(() => parseProductionProfile({characters: [{name: 'MAYA', image: '../maya.png'}]})).toThrow('只能写文件名');
    expect(() => parseProductionProfile({characters: [{name: 'MAYA', voiceSample: 'maya.png'}]})).toThrow('wav、mp3 或 flac');
    expect(() => parseProductionProfile({characters: [{name: 'MAYA'}, {name: 'maya'}]})).toThrow('重复');
    expect(parseProductionProfile({style: '  Live-action,\n cinematic ', characters: [{name: 'MAYA', appearance: 'a rider', image: 'maya.png'}]})).toEqual({style: 'Live-action, cinematic', music: '', characters: [{name: 'MAYA', appearance: 'a rider', voice: '', image: 'maya.png'}]});
  });

  test('languages must have bound text; unassigned dialogue is flagged', () => {
    expect(() => planRenderBatch(input({languages: ['en', 'ja']}))).toThrow('ja 没有绑定');
    expect(() => planRenderBatch(input({languages: []}))).toThrow(RenderPlanError);
    expect(planRenderBatch(input({languages: ['zh-CN']})).jobs.every(j => j.language === 'zh-CN')).toBe(true);
    const list = shotList(); list.shots[1]!.spoken = [];
    const {batch} = planRenderBatch(input({list}));
    expect(batch.warnings).toContain('场景 s1 第 3 行像是 MAYA 的台词，但分镜表没有标说话人；H3 不会念这一行。');
  });

  test('the self-check catches changed words, missing shots and bad cut times', () => {
    const prompt = planRenderBatch(input()).batch.clips[0]!.prompts.en!;
    const expected = {spoken: ['Singing costs extra.'], shots: 2, cuts: [7], seconds: 12.25};
    expect(verifyPrompt(prompt, expected)).toEqual([]);
    expect(verifyPrompt({...prompt, text: prompt.text.replace('costs extra', 'costs more')}, expected)).toContain('<d> 台词与剧本不一致');
    expect(verifyPrompt({...prompt, text: prompt.text.replace('[Shot 2] At 00:07.000,', 'At 00:07.000,')}, expected).length).toBeGreaterThan(0);
    expect(verifyPrompt(prompt, {...expected, cuts: [6]})).toContain('切换时间缺失、没有递增或超出片段长度');
    expect(verifyPrompt({...prompt, text: prompt.text.replace('\n\noverall_soundscape:', '\n\nsoundscape:')}, expected)).toContain('t2va 段落标题缺失或重复');
  });
});

describe('job packages and results', () => {
  test('a package lists every job in order with output names and no secrets', () => {
    const {batch, jobs} = planRenderBatch(input());
    const pkg = renderPackage(batch, jobs.map((j, i) => ({...j, id: `j${i}`})).reverse(), {series: 'Last Order', episodeOrdinal: 1, episodeTitle: 'Pilot'});
    expect(pkg.format).toBe('sciepo-render-package');
    expect(pkg.model).toEqual({name: 'MiniMax H3', fps: 24, width: 768, height: 1344});
    expect(pkg.jobs.map(j => j.output).slice(0, 3)).toEqual(['ep01-c01-en.mp4', 'ep01-c01-zh-CN.mp4', 'ep01-c02-en.mp4']);
    expect(pkg.jobs[0]).toMatchObject({id: 'j0', clipId: 'c01', language: 'en', mode: 't2va', frames: 294, seconds: 12.25, seed: clipSeed('b1', 'c01'), images: [], audio: [], shotIds: ['sh1', 'sh2']});
    expect(JSON.stringify(pkg)).not.toMatch(/token|premise|worldRules/iu);
    expect(outputName(12, 'c03', 'zh-CN')).toBe('ep12-c03-zh-CN.mp4');
  });

  test('results are validated and dry runs are skipped', () => {
    const ok = {format: 'sciepo-render-results', version: 1, batchId: 'b1', results: [
      {jobId: 'j0', status: 'succeeded', file: 'ep01-c01-en.mp4', seconds: 12.25, bytes: 1024, sha256: 'a'.repeat(64)},
      {jobId: 'j1', status: 'failed', error: 'CUDA out of memory'},
      {jobId: 'j2', status: 'dry_run', file: 'ep01-c02-en.mp4'},
    ]};
    expect(parseRenderResults(ok, 'b1')).toEqual({skipped: 1, results: [
      {jobId: 'j0', status: 'succeeded', file: 'ep01-c01-en.mp4', seconds: 12.25, bytes: 1024, sha256: 'a'.repeat(64)},
      {jobId: 'j1', status: 'failed', error: 'CUDA out of memory'},
    ]});
    expect(() => parseRenderResults({...ok, batchId: 'b2'}, 'b1')).toThrow('另一个渲染批次');
    expect(() => parseRenderResults({...ok, format: 'other'}, 'b1')).toThrow('不是 Sci-epo 渲染结果文件');
    expect(() => parseRenderResults({...ok, results: [{jobId: 'j0', status: 'succeeded'}]}, 'b1')).toThrow('没有文件名');
    expect(() => parseRenderResults({...ok, results: [{jobId: 'j0', status: 'succeeded', file: '../../etc/passwd'}]}, 'b1')).toThrow('不含路径');
  });
});
