import { afterEach, describe, expect, test } from 'bun:test';
import { buildModelMessages, snapshotContext } from '../src/core';
import { SHORT_DRAMA_ADAPTATION_RULES, SHORT_DRAMA_CRAFT_GUIDANCE, SHORT_DRAMA_REVIEW_RULES } from '../src/core/formatPrompts';
import { checkLength, lengthInstruction } from '../src/core/length';
import { dialoguePositions, inlineLabel, isLineAligned, labelOnly, minimumSpeechSeconds, requireLineAlignment, scriptLines } from '../src/core/scriptLines';
import { SCRIPT_CRAFT_GUIDANCE } from '../src/core/writingGuidance';
import { createApp } from '../src/server/app';
import { Store } from '../src/server/store';
import type { Brief, Localization, ModelRequest, ProjectBundle, Revision } from '../src/types';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const shortBrief = {title: 'Last Order', premise: 'A rider delivers to strangers at midnight.', characters: 'MAYA: a delivery rider.\nLEO: seventy.', worldRules: 'Ordinary city.', authorRules: 'Each episode ends on a reveal.', language: 'en', format: 'vertical_short_drama' as const, durationTarget: {min: 60, max: 90}};
const script = {title: 'The Last Order', logline: 'A rider sings to a stranger.', scenes: [
  {id: 's1', heading: 'INT. ELEVATOR - NIGHT', content: 'Maya holds one cupcake.\nMAYA: Singing costs extra.', locked: false},
  {id: 's2', heading: 'INT. HALLWAY - CONTINUOUS', content: 'LEO opens the door a crack.\n\nLEO: I didn\'t order anything.\nMaya turns the phone toward him. PAID BY: ANNA LIN.', locked: false},
]};
const aligned = {title: '最后一单', logline: '外卖员给陌生人唱歌。', scenes: [
  {id: 's1', heading: '内景 · 电梯 · 夜', content: '玛雅捧着一个纸杯蛋糕。\n玛雅：唱歌得加钱。'},
  {id: 's2', heading: '内景 · 走廊 · 连续', content: '老林把门开了一条缝。\n老林：我没点外卖。\n玛雅把手机转向他。付款人：林安娜。'},
]};
const merged = {...aligned, scenes: [aligned.scenes[0]!, {...aligned.scenes[1]!, content: '老林把门开了一条缝。\n老林：我没点外卖。玛雅把手机转向他。'}]};

function revision(brief: Brief = shortBrief): Revision {
  return {id: 'r-short', episodeId: 'e', parentId: null, ...script, context: snapshotContext(brief, []), kind: 'generated', instruction: '', mode: 'live', createdAt: '2026-11-07T00:00:00.000Z', language: 'en'};
}
const system = (request: ModelRequest) => buildModelMessages(request)[0]!.content;
const user = (request: ModelRequest) => JSON.parse(buildModelMessages(request)[1]!.content);

describe('short-drama instructions', () => {
  test('generation and rewriting carry the format rules, the duration target and no sci-fi studio framing', () => {
    const r = revision(), context = r.context;
    const generate = system({kind: 'generate', context, episodeTitle: 'Episode 1'});
    const rewrite = system({kind: 'rewrite', context, revision: r, sceneId: 's2', instruction: 'Sharpen the reveal.', episodeTitle: 'Episode 1'});
    for (const prompt of [generate, rewrite]) {
      expect(prompt).toContain('多语言竖屏短剧编剧工作室');
      expect(prompt).not.toContain('科幻动画编剧工作室');
      expect(prompt).toContain(SHORT_DRAMA_CRAFT_GUIDANCE);
      expect(prompt).not.toContain(SCRIPT_CRAFT_GUIDANCE);
      for (const rule of ['开场钩子', '转折', '结尾悬念', '画风中立', '竖屏优先', 'NAME: line', '不默认任何类型', '不能推翻作者设定里的人物身份']) expect(prompt).toContain(rule);
      expect(prompt).toContain('60–90 秒');
      expect(prompt).toContain('不要把人名和台词分成两行');
    }
    expect(SHORT_DRAMA_CRAFT_GUIDANCE).not.toContain('科幻');
    expect(SHORT_DRAMA_CRAFT_GUIDANCE).not.toContain('机器人');
  });

  test('review keeps its structure and adds the short-drama criteria; causality only changes its studio line', () => {
    const r = revision();
    const review = system({kind: 'review', context: r.context, revision: r, episodeTitle: 'Episode 1'});
    expect(review).toContain(SHORT_DRAMA_REVIEW_RULES);
    expect(review).toContain('60–90 秒');
    expect(review).toContain('continuity 另外检查：转折和悬念是否推翻了作者设定');
    expect(review).toContain('"assessments"');
    expect(user({kind: 'review', context: r.context, revision: r, episodeTitle: 'Episode 1'}).requiredDimensions).toEqual(['story', 'character', 'dialogue', 'continuity', 'filmability']);
    const causality = system({kind: 'review', reviewPass: 'causality', context: r.context, revision: r, episodeTitle: 'Episode 1'});
    expect(causality).not.toContain(SHORT_DRAMA_REVIEW_RULES);
    expect(causality).toContain('多语言竖屏短剧编剧工作室');
  });

  test('short-drama adaptation asks for one translated line per numbered source line; episodic adaptation is untouched', () => {
    const r = revision();
    const request: ModelRequest = {kind: 'localize', context: r.context, revision: r, targetLanguage: 'zh-CN', episodeTitle: 'Episode 1'};
    expect(system(request)).toContain(SHORT_DRAMA_ADAPTATION_RULES);
    expect(user(request).script.scenes[1].lines).toEqual([
      {n: 1, text: 'LEO opens the door a crack.'}, {n: 2, text: 'LEO: I didn\'t order anything.'}, {n: 3, text: 'Maya turns the phone toward him. PAID BY: ANNA LIN.'},
    ]);
    const {format: _format, durationTarget: _duration, ...episodicBrief} = shortBrief;
    const episodic = revision(episodicBrief);
    const plain: ModelRequest = {...request, context: episodic.context, revision: episodic};
    expect(system(plain)).not.toContain(SHORT_DRAMA_ADAPTATION_RULES);
    expect(user(plain).script.scenes[0].lines).toBeUndefined();
  });

  test('an explicit word target still applies to short drama', () => {
    const brief = {...shortBrief, lengthTarget: {min: 40, max: 60, unit: 'words' as const}};
    expect(lengthInstruction(brief)).toContain('40–60');
    expect(checkLength(brief, script.scenes)).toMatchObject({status: 'too_short', count: 29});
    expect(system({kind: 'generate', context: snapshotContext(brief, []), episodeTitle: 'Episode 1'})).toContain('整集正文硬性目标：40–60');
  });
});

describe('script lines', () => {
  test('lines, inline labels and label-only lines are recognized without counting blank lines', () => {
    expect(scriptLines(script.scenes[1]!.content)).toHaveLength(3);
    expect(inlineLabel('MAYA (singing, off-key): Happy birthday to you...')).toEqual({name: 'MAYA', note: 'singing, off-key', text: 'Happy birthday to you...'});
    expect(inlineLabel('DR. CHEN: Sit down.')?.name).toBe('DR. CHEN');
    expect(inlineLabel('玛雅（跑调地唱）：祝你生日快乐……')).toEqual({name: '玛雅', note: '跑调地唱', text: '祝你生日快乐……'});
    expect(inlineLabel('老林：我没点外卖。')?.name).toBe('老林');
    for (const action of ['Maya turns the phone toward him. PAID BY: ANNA LIN.', 'LEO, seventy, opens the door.', '玛雅把手机转向他。付款人：林安娜。', '手机屏幕上，订单备注写着：“请唱歌。”']) expect(inlineLabel(action)).toBeUndefined();
    // Chinese action lines that introduce on-screen text, from the real 2026-11-08 adaptation.
    for (const action of ['备注写着：“敲门三次。没人应别打急救电话。”', '屏幕闪过一道醒目的绿光：“已到账小费：500.00美元。”', '紧接着弹下一行字：“不管里面装了什么，绝不能让他擦着火柴。”', 'ON SCREEN: "Tip added: $500.00."']) expect(inlineLabel(action)).toBeUndefined();
    expect(inlineLabel('老林（颤抖）：外卖送到了。别看你不该看的东西。')?.name).toBe('老林');
    expect(labelOnly('BOLT (CONT\'D)')).toEqual({name: 'BOLT', note: 'CONT\'D', text: ''});
    expect(labelOnly('SILENCE.')).toBeUndefined();
    expect([...dialoguePositions('NIA\nEight hours outside.\nHe taps his chassis.\nBOLT: Ten days.').entries()]).toEqual([[2, 'NIA'], [4, 'BOLT']]);
    // Adaptations of label-only scripts keep the layout; the real 2026-11-08 run produced these lines.
    expect(labelOnly('老林')).toEqual({name: '老林', text: ''});
    expect(labelOnly('老林（发抖）')).toEqual({name: '老林', note: '发抖', text: ''});
    expect(labelOnly('门开了。')).toBeUndefined();
    expect([...dialoguePositions('防盗链哗啦作响。\n老林\n我没点外卖。赶紧走。\n玛雅赶在他摔上门前，把运动鞋卡进了门框。').entries()]).toEqual([[3, '老林']]);
  });

  test('alignment errors name the scene and both line counts', () => {
    const source = revision();
    expect(isLineAligned(source, aligned)).toBe(true);
    expect(() => requireLineAlignment(source, merged)).toThrow('第 2 场（s2）原稿有 3 行，改编有 2 行');
    expect(() => requireLineAlignment(source, {scenes: aligned.scenes.slice(0, 1)})).toThrow('改编有 0 行');
  });

  test('speech minimums use fast rates per language and ignore speaker labels', () => {
    expect(minimumSpeechSeconds(['LEO: My daughter hasn\'t called me in five years.'], 'en')).toBe(2.7);
    expect(minimumSpeechSeconds(['老林：我女儿五年没给我打过电话了。'], 'zh-CN')).toBe(2.6);
    expect(minimumSpeechSeconds([], 'en')).toBe(0);
  });
});

describe('line-aligned adaptation routes', () => {
  function harness(localized: unknown) {
    const store = new Store(); stores.push(store);
    const live = {mode: 'live' as const, async complete(request: ModelRequest) { return JSON.stringify(request.kind === 'generate' ? script : localized); }};
    const app = createApp(store, {live, demo: {...live, mode: 'demo'}});
    const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await app(new Request('http://127.0.0.1:4317' + path, {method, headers: {'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
      return {status: response.status, body: await response.json()};
    };
    return {store, call};
  }
  async function draft(h: ReturnType<typeof harness>, brief: object) {
    const p = (await h.call('/api/projects', brief)).body as ProjectBundle;
    return (await h.call(`/api/episodes/${p.episodes[0]!.id}/generate`, {mode: 'live'})).body as Revision;
  }

  test('a short-drama adaptation that merges lines is rejected and recorded as a failed run', async () => {
    const h = harness(merged), r = await draft(h, shortBrief);
    const result = await h.call(`/api/revisions/${r.id}/localize`, {mode: 'live', language: 'zh-CN'});
    expect(result.status).toBe(502);
    expect(result.body.error).toContain('第 2 场（s2）原稿有 3 行，改编有 2 行');
    expect(h.store.all('localizations')).toHaveLength(0);
    expect(h.store.all('runs').at(-1)).toMatchObject({kind: 'localize', status: 'failed'});
  });

  test('aligned adaptations are saved, and manual edits must keep the alignment', async () => {
    const h = harness(aligned), r = await draft(h, shortBrief);
    const saved = await h.call(`/api/revisions/${r.id}/localize`, {mode: 'live', language: 'zh-CN'});
    expect(saved.status).toBe(200);
    const l = saved.body as Localization;
    expect((await h.call(`/api/localizations/${l.id}/edit`, merged)).status).toBe(400);
    expect((await h.call(`/api/localizations/${l.id}/edit`, {...aligned, title: '最后一单（修订）'})).status).toBe(200);
  });

  test('episodic adaptations keep the original rules and are not checked line by line', async () => {
    const {format: _format, durationTarget: _duration, ...episodicBrief} = shortBrief;
    const h = harness(merged), r = await draft(h, episodicBrief);
    expect((await h.call(`/api/revisions/${r.id}/localize`, {mode: 'live', language: 'zh-CN'})).status).toBe(200);
  });
});
