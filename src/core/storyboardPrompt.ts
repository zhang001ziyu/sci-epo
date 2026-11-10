/** Model instructions for shot-list generation. Server-only, so the browser bundle carries no prompts. */
import type { Revision } from '../types';
import { MAX_SHOT_SECONDS, aspectRatioOf } from './formats';
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

export function buildStoryboardMessages(revision: Revision): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief, duration = durationInstruction(brief);
  const format = '{"cast":[{"id":"C1","name":"剧本中的人名"}],"shots":[{"id":"sh1","sceneId":"s1","firstLine":1,"lastLine":2,"size":"close_up","camera":"static","characters":["C1"],"spoken":[{"line":2,"castId":"C1"}],"durationSeconds":4.5,"composition":"一句话写构图和人物在画面中的位置","sound":"本镜需要的环境声或音效，可省略"}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, scriptLanguage(revision))}\n${STORYBOARD_GUIDANCE}${duration ? `\n${duration}` : ''}\n输出格式：${format}。只返回 cast 和 shots。`},
    {role: 'user', content: JSON.stringify({
      task: '把这一版剧本拆成镜头表。', aspectRatio: aspectRatioOf(brief), maxShotSeconds: MAX_SHOT_SECONDS,
      ...(brief.durationTarget ? {durationTarget: brief.durationTarget} : {}), characters: brief.characters,
      scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))})),
    })},
  ];
}
