/** Model instructions for the script logic ledger. Server-only. The model fills slots; the program decides findings. */
import type { Revision } from '../types';
import { studioIntro } from './formatPrompts';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const LOGIC_GUIDANCE = `
你是剧本逻辑核对员。你的任务不是评价好坏，而是按正文如实填一张账，后面由程序判断哪里断了。只依据 user.scenes 的正文和 user.brief；梗概和人物小传里写了、正文里没写的东西，不算观众知道。
行号写成“场景编号:行号”，例如 s2:12，行号就是 user.scenes 里每行的 n。找不到就写 null，不要猜一个行号凑数。宁可写 null，也不要替剧本圆。

1. offscreen：只通过手机消息、电话、便条、订单备注出现、本人不在场的人物。她的每一条消息都列一项，messageRef 是消息出现的那一行。claims 列出这条消息说明她知道的每一件事（包括她怎么知道该提醒什么、她知道某物在哪、她知道此刻屋里发生了什么）。每件事的来源 sourceKind：
   - self：关于她自己的事（她在哪、她想要什么）；
   - present：她当时在场；told：之前有人告诉过她（sourceRef 写告诉她的那一行）；sees：她能看到画面，比如收到了照片或视频（sourceRef 写发照片的那一行）；earlier：正文前面交代过她知道（sourceRef 写那一行）；
   - brief：user.brief 明确写着她知道这件事（只写了人物关系不算：多年没见面的亲人，不代表知道对方家里此刻的事）；
   - none：正文里找不到来源。她不在场又没有收到任何画面，却在关键时刻说出现场正在发生的事，就是 none。
2. ending：ref 是结尾那一行，question 用一句话写结尾留给观众的问题。dependsOn 列出结尾成立所依赖的道具、规则、人物关系和事实，firstRef 写它在正文里第一次出现的那一行；只写在 brief 里、正文没出现的写 null。人物关系也要算：结尾的分量如果靠“他们是亲兄弟”，而正文没有一句台词或画面说出来，firstRef 就是 null。
3. setups：正文特意交代或描写的东西：暗号、钥匙、钱、证物、信件、药、污渍、特别的物件或细节。payoffRef 写它后来被用上或有了下文的那一行，没有就 null；bearsOnEnding 写它是否直接指向结尾的那个问题。
4. instructions：违背常理的要求或做法，比如“让人半夜千万别开灯”，却不说为什么。reasonRef 写正文里给出理由的那一行，没人给理由也没人问，就写 null。
5. sightings：人物看见、发现、读到推动剧情的东西的每一行。visible：按正文写的位置和空间，她在那里能不能看见（yes、no、unclear），why 用一句中文说明。比如站在门口，看不到锁在抽屉里的东西。
6. protagonist 写主角的名字。choices 只列主角亲自做出、本可以不做、要付出她在乎的代价（钱、安全、工作、关系）、并且改变了接下来发生什么的选择。照吩咐办事、走路、开门、看手机、被动看到东西都不算。没有就写空列表。
`.trim();

export function buildLogicMessages(revision: Revision): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief;
  const format = '{"protagonist":"主角名","offscreen":[{"character":"人名","messageRef":"s2:12","claims":[{"fact":"她知道的事","sourceKind":"self|present|told|sees|earlier|brief|none","sourceRef":"s1:3 或 null"}]}],"ending":{"ref":"s2:21","question":"结尾的问题","dependsOn":[{"thing":"打火机","kind":"prop|rule|relationship|fact","firstRef":"s2:21 或 null"}]},"setups":[{"thing":"铜钥匙","ref":"s1:5","payoffRef":null,"bearsOnEnding":false}],"instructions":[{"text":"别开灯","ref":"s1:3","reasonRef":null}],"sightings":[{"who":"人名","what":"看见的东西","ref":"s2:14","visible":"yes|no|unclear","why":"一句中文说明"}],"choices":[{"ref":"s1:9","choice":"主角的选择","cost":"她付出的代价"}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, scriptLanguage(revision))}\n${LOGIC_GUIDANCE}\n输出格式：${format}。fact、question、why、choice、cost 用简体中文写。只返回这一个 JSON 对象。`},
    {role: 'user', content: JSON.stringify({
      task: '按正文填写剧本逻辑账。',
      brief: {characters: brief.characters, worldRules: brief.worldRules, premise: brief.premise},
      scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))})),
    })},
  ];
}
