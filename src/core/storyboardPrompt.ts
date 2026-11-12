/** Model instructions for shot-list generation. Server-only, so the browser bundle carries no prompts. */
import type { BibleContent, Revision } from '../types';
import { sceneSetting } from './bible';
import { MAX_SHOT_SECONDS, aspectRatioOf, isShortDrama } from './formats';
import { durationInstruction, studioIntro } from './formatPrompts';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const STORYBOARD_GUIDANCE = `
你是分镜编辑，把这一版剧本拆成镜头表，供后续逐镜配音和生成视频。只拆分镜头，不改写、不增删、不重排剧本的任何一行。
user.scenes 按顺序列出每场的剧本行，n 是该场内的行号。每个镜头覆盖同一场中连续的若干行，用 firstLine 和 lastLine 表示；所有镜头按场景顺序和行号顺序排列，每一行恰好属于一个镜头，不遗漏、不重叠。镜头里不要复制剧本文字。
cast 列出所有入镜或说话的人物，id 依次写 C1、C2……，name 按剧本中的人名原样书写。characters 写本镜入镜人物的 id。spoken 列出本镜中每一句台词所在的行号 line 和说话人 castId；动作描写行不是台词。
size 只能取 extreme_close_up、close_up、medium_close_up、medium、medium_wide、wide、insert。camera 只能取 static、push_in、pull_out、pan、tilt、track、handheld。
durationSeconds 是本镜预计时长（秒，可带一位小数）：先按正常语速算台词时长，英文约每秒 2.5 个词，中文约每秒 4 个字，再加上动作和反应需要的时间；有台词的镜头不要短于台词本身。单镜不超过 user.maxShotSeconds 秒，较长的戏拆成多个镜头；有 durationTarget 时，所有镜头的总时长尽量落在这个范围内。
尽量让每个镜头只有一人说话；对话来回时用正反打拆成多个镜头。
画幅为 user.aspectRatio。9:16 竖屏时优先特写、近景和中景，一到两人入镜，构图写清人物在画面上、中、下的位置。
composition 用一句话写构图和人物位置，sound 写本镜需要的环境声或音效，可以省略；两者使用剧本语言。只描述画面内容，不写画风、渲染方式、镜头型号或软件名称，让动画和写实制作都能使用。
`.trim();

/** Vertical short drama only: the lines that show readable text, so the cut can caption them in every language. */
export const SCREEN_TEXT_GUIDANCE = 'screenText 列出本镜中可读文字出现在手机、便条、招牌或文件上的行号（例如手机消息、订单备注、门牌、信件），只写行号，不复制文字；本镜没有这样的行就写 []。';

/** Only with a confirmed episode bible: shots keep the author's places and props. */
export const SETTING_GUIDANCE = 'user.setting 是作者确认过的本集设定：每一场在哪个地点、画面里有哪些道具。composition 里写到的地点和道具必须和它一致，不要把人物挪到别的地方，不要换掉或新增设定里没有的固定物件。';
/** Only with a confirmed episode bible: the duration and one-action rules the shot tab checks. */
export const ACTION_GUIDANCE = '每一行动作描写是一个动作。一个镜头最多放一个动作；连续几个动作时拆成几个镜头。每个动作至少留 1.5 秒；有画面文字时，再留出观众读完文字的时间。';

export function buildStoryboardMessages(revision: Revision, bible?: BibleContent): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief, duration = durationInstruction(brief), shortDrama = isShortDrama(brief);
  const format = `{"cast":[{"id":"C1","name":"剧本中的人名"}],"shots":[{"id":"sh1","sceneId":"s1","firstLine":1,"lastLine":2,"size":"close_up","camera":"static","characters":["C1"],"spoken":[{"line":2,"castId":"C1"}],${shortDrama ? '"screenText":[],' : ''}"durationSeconds":4.5,"composition":"一句话写构图和人物在画面中的位置","sound":"本镜需要的环境声或音效，可省略"}]}`;
  const setting = bible ? revision.scenes.map(s => {
    const {location, props} = sceneSetting(bible, s.id);
    return {sceneId: s.id, location: location ? `${location.name}: ${location.look}` : '', props: props.map(p => `${p.name}: ${p.look}`)};
  }) : undefined;
  return [
    {role: 'system', content: `${studioIntro(brief, scriptLanguage(revision))}\n${STORYBOARD_GUIDANCE}${shortDrama ? `\n${SCREEN_TEXT_GUIDANCE}` : ''}${bible ? `\n${SETTING_GUIDANCE}\n${ACTION_GUIDANCE}` : ''}${duration ? `\n${duration}` : ''}\n输出格式：${format}。只返回 cast 和 shots。`},
    {role: 'user', content: JSON.stringify({
      task: '把这一版剧本拆成镜头表。', aspectRatio: aspectRatioOf(brief), maxShotSeconds: MAX_SHOT_SECONDS,
      ...(brief.durationTarget ? {durationTarget: brief.durationTarget} : {}), characters: brief.characters,
      ...(setting ? {setting} : {}),
      scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))})),
    })},
  ];
}
