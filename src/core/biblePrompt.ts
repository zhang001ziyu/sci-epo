/** Model instructions for the episode bible draft. Server-only, so the browser bundle carries no prompts. */
import type { Revision } from '../types';
import { studioIntro } from './formatPrompts';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const BIBLE_GUIDANCE = `
你是美术统筹，从这一版剧本整理本集设定，供后续分镜和视频生成保持前后一致。只整理剧本已经写出或明确暗示的内容，不新增情节，不改剧本。
locations 列出本集的地点，id 依次写 L1、L2……。同一个地方只列一次，即使场景标题写法略有不同；不同的地方分开列。
props 列出剧情会用到、或者镜头会拍到的具体物件，id 依次写 P1、P2……。结尾或转折要用到的物件必须列出。
scenes 按剧本顺序列出每一场：sceneId 用原场景编号，locationId 写这一场所在的地点，props 写这一场画面里会出现的道具编号。道具第一次被用到之前，要让它在更早的一场或同一场里出现。
name 用剧本语言写简短名字。note 用简体中文写一句话，告诉作者这是什么、为什么要固定下来。
look 用英文写一个名词短语，从物件或地方本身写起，写清会被看见、必须保持不变的特征：大小、颜色、材质、新旧、摆放位置、光线来源。例如 "a narrow galley kitchen with pale green tiles, a steel sink under a single window and one warm ceiling lamp"。不写画风、渲染方式、镜头型号或软件名称，不写人物，不写动作。
`.trim();

export function buildBibleMessages(revision: Revision): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief;
  const format = '{"locations":[{"id":"L1","name":"地点名","look":"English noun phrase","note":"给作者的一句中文说明"}],"props":[{"id":"P1","name":"道具名","look":"English noun phrase","note":"给作者的一句中文说明"}],"scenes":[{"sceneId":"s1","locationId":"L1","props":["P1"]}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, scriptLanguage(revision))}\n${BIBLE_GUIDANCE}\n输出格式：${format}。只返回 locations、props 和 scenes。`},
    {role: 'user', content: JSON.stringify({
      task: '整理这一版剧本的本集设定：地点、道具，以及每一场在哪里、用到哪些道具。',
      worldRules: brief.worldRules, characters: brief.characters,
      scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))})),
    })},
  ];
}
