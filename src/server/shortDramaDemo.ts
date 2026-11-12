/** Prepared vertical short-drama example in English and line-aligned Simplified Chinese.
 * One set of line references serves both languages. This is fixture text, not model output. */
import type { LogicLedger, Revision, ShotListContent } from '../types';

export const SHORT_DRAMA_DEMO = {
  en: {
    title: 'The Last Order · Fixed Short-Drama Example',
    logline: 'A delivery rider is paid to sing to a stranger at midnight, then reads a message he must not see. This prepared example is not model output.',
    scenes: [
      {id: 's1', heading: 'INT. APARTMENT ELEVATOR - NIGHT', content: 'Rain drips from Maya\'s delivery jacket. She holds a clear box with one cupcake inside.\nHer phone shows the order note: "Please sing happy birthday. He thinks everyone forgot."\nMAYA: Singing costs extra.\nThe doors open on floor nine. She sighs and steps out.', locked: false},
      {id: 's2', heading: 'INT. NINTH-FLOOR HALLWAY - CONTINUOUS', content: 'LEO, seventy, opens his door a crack. The chain stays on.\nLEO: I didn\'t order anything.\nMaya turns the phone toward him. PAID BY: ANNA LIN.\nLeo\'s face goes still.\nLEO: My daughter hasn\'t called me in five years.\nMAYA (singing, off-key): Happy birthday to you...\nLeo slides the chain off. His hand shakes as he takes the box.', locked: false},
      {id: 's3', heading: 'INT. NINTH-FLOOR HALLWAY - MOMENTS LATER', content: 'Maya\'s phone buzzes. A message from ANNA LIN.\nMaya reads it. Her smile fades.\nLEO: What did she say?\nMaya hides the phone behind her back. On the screen: "Don\'t tell him I\'m in the hospital."\nMAYA: She says... happy birthday.', locked: false},
    ],
  },
  zh: {
    title: '最后一单 · 固定短剧示例',
    logline: '外卖员被要求在午夜给陌生老人唱生日歌，随后读到一条不能让他看见的消息。此为预置示例，不是模型生成。',
    scenes: [
      {id: 's1', heading: '内景 · 公寓电梯 · 夜', content: '玛雅的外卖服还在滴水。她捧着一个透明盒，里面只有一个纸杯蛋糕。\n手机屏幕上，订单备注写着：“请帮我唱一首生日歌。他以为所有人都忘了。”\n玛雅：唱歌得加钱。\n电梯门在九楼打开。她叹了口气，走出去。', locked: false},
      {id: 's2', heading: '内景 · 九楼走廊 · 连续', content: '老林，七十岁，把门开了一条缝，门链没摘。\n老林：我没点外卖。\n玛雅把手机转向他。付款人：林安娜。\n老林的脸一下子僵住。\n老林：我女儿五年没给我打过电话了。\n玛雅（跑调地唱）：祝你生日快乐……\n老林摘下门链。他接过盒子，手在发抖。', locked: false},
      {id: 's3', heading: '内景 · 九楼走廊 · 片刻后', content: '玛雅的手机震了一下，林安娜发来一条消息。\n玛雅读着消息，笑容慢慢消失。\n老林：她说什么了？\n玛雅把手机藏到身后。屏幕上写着：“别告诉他我在住院。”\n玛雅：她说……生日快乐。', locked: false},
    ],
  },
};

type Notes = [composition: string, sound?: string];
const STRUCTURE = [
  {id: 'sh1', sceneId: 's1', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'push_in', characters: ['C1'], spoken: [], durationSeconds: 7},
  {id: 'sh2', sceneId: 's1', firstLine: 3, lastLine: 4, size: 'medium_close_up', camera: 'static', characters: ['C1'], spoken: [{line: 3, castId: 'C1'}], durationSeconds: 5},
  {id: 'sh3', sceneId: 's2', firstLine: 1, lastLine: 2, size: 'medium', camera: 'static', characters: ['C2'], spoken: [{line: 2, castId: 'C2'}], durationSeconds: 5},
  {id: 'sh4', sceneId: 's2', firstLine: 3, lastLine: 3, size: 'insert', camera: 'static', characters: [], spoken: [], durationSeconds: 3},
  {id: 'sh5', sceneId: 's2', firstLine: 4, lastLine: 5, size: 'close_up', camera: 'push_in', characters: ['C2'], spoken: [{line: 5, castId: 'C2'}], durationSeconds: 8},
  {id: 'sh6', sceneId: 's2', firstLine: 6, lastLine: 6, size: 'medium_close_up', camera: 'static', characters: ['C1'], spoken: [{line: 6, castId: 'C1'}], durationSeconds: 7},
  {id: 'sh7', sceneId: 's2', firstLine: 7, lastLine: 7, size: 'close_up', camera: 'static', characters: ['C1', 'C2'], spoken: [], durationSeconds: 5},
  {id: 'sh8', sceneId: 's3', firstLine: 1, lastLine: 2, size: 'close_up', camera: 'static', characters: ['C1'], spoken: [], durationSeconds: 6},
  {id: 'sh9', sceneId: 's3', firstLine: 3, lastLine: 3, size: 'medium', camera: 'static', characters: ['C2'], spoken: [{line: 3, castId: 'C2'}], durationSeconds: 5},
  {id: 'sh10', sceneId: 's3', firstLine: 4, lastLine: 4, size: 'insert', camera: 'static', characters: ['C1'], spoken: [], durationSeconds: 6},
  {id: 'sh11', sceneId: 's3', firstLine: 5, lastLine: 5, size: 'close_up', camera: 'push_in', characters: ['C1'], spoken: [{line: 5, castId: 'C1'}], durationSeconds: 7},
] as const;
const NOTES: Record<'en' | 'zh', Notes[]> = {
  en: [
    ['Maya fills the upper half of the frame; the glowing order note sits in the lower third.', 'Rain dripping, elevator hum.'],
    ['Maya rolls her eyes at the phone as the doors slide open behind her.', 'Elevator chime.'],
    ['Leo\'s face in the narrow gap above the door chain, centered in the frame.'],
    ['The phone screen fills the frame: PAID BY: ANNA LIN.'],
    ['Leo\'s face, eyes lowered; the door chain crosses the lower edge of the frame.'],
    ['Maya sings to the gap in the door, the cupcake box raised in front of her chest.', 'Off-key singing echoes down the hallway.'],
    ['Hands only: Leo\'s shaking hands take the box from Maya\'s.', 'The door chain rattles.'],
    ['Maya\'s face lit by the phone; her smile fades.', 'Phone buzz.'],
    ['Leo in the open doorway, holding the box, waiting for her answer.'],
    ['The phone behind Maya\'s back fills the lower frame; the message is readable.'],
    ['Maya forces a smile; hold on her eyes.'],
  ],
  zh: [
    ['玛雅占据画面上半部分，亮着的订单备注在下三分之一。', '雨水滴落，电梯嗡鸣。'],
    ['电梯门在玛雅身后打开，她对着手机翻了个白眼。', '电梯到达提示音。'],
    ['老林的脸卡在门链上方的门缝里，位于画面中央。'],
    ['手机屏幕占满画面：付款人：林安娜。'],
    ['老林的脸，目光垂下；门链横在画面下缘。'],
    ['玛雅对着门缝唱歌，纸杯蛋糕盒举在胸前。', '跑调的歌声在走廊里回响。'],
    ['只拍手：老林颤抖的手从玛雅手里接过盒子。', '门链哗啦作响。'],
    ['手机的光照亮玛雅的脸，她的笑容慢慢消失。', '手机震动。'],
    ['老林站在敞开的门口，捧着盒子等她回答。'],
    ['玛雅背后的手机占据画面下部，消息清晰可读。'],
    ['玛雅挤出一个笑容，镜头停在她的眼睛上。'],
  ],
};

export function shortDramaDemoShotList(language: 'en' | 'zh'): ShotListContent {
  return {
    cast: language === 'en' ? [{id: 'C1', name: 'MAYA'}, {id: 'C2', name: 'LEO'}] : [{id: 'C1', name: '玛雅'}, {id: 'C2', name: '老林'}],
    shots: STRUCTURE.map((shot, index) => {
      const [composition, sound] = NOTES[language][index]!;
      return {...shot, characters: [...shot.characters], spoken: shot.spoken.map(s => ({...s})), composition, ...(sound ? {sound} : {})};
    }),
  };
}

/** True only for the unmodified example in the given language. */
export function isShortDramaDemo(revision: Pick<Revision, 'title' | 'scenes'>, language: 'en' | 'zh'): boolean {
  const fixed = SHORT_DRAMA_DEMO[language];
  return revision.title === fixed.title && revision.scenes.length === fixed.scenes.length
    && revision.scenes.every((s, i) => s.id === fixed.scenes[i]!.id && s.heading === fixed.scenes[i]!.heading && s.content === fixed.scenes[i]!.content);
}

/** The prepared logic ledger of the fixed example: every message has a source, every setup pays off, and Maya sings
 * for free, so the check finds nothing. Line references are the same in both languages. */
export function shortDramaDemoLedger(language: 'en' | 'zh'): LogicLedger {
  const en = language === 'en';
  return {
    protagonist: en ? 'MAYA' : '玛雅',
    offscreen: [{character: en ? 'ANNA LIN' : '林安娜', messageRef: 's3:4', claims: [{fact: en ? 'she is in the hospital' : '她在住院', sourceKind: 'self', sourceRef: null}]},
      {character: en ? 'ANNA LIN' : '林安娜', messageRef: 's1:2', claims: [{fact: en ? 'her father thinks everyone forgot his birthday' : '父亲以为大家都忘了他的生日', sourceKind: 'brief', sourceRef: null}]}],
    ending: {ref: 's3:5', question: en ? 'Will Maya keep Anna\'s secret from Leo?' : '玛雅会一直替安娜瞒着老林吗？',
      dependsOn: [{thing: en ? 'Anna is Leo\'s daughter' : '安娜是老林的女儿', kind: 'relationship', firstRef: 's2:5'}, {thing: en ? 'the hospital message' : '住院的消息', kind: 'fact', firstRef: 's3:4'}]},
    setups: [{thing: en ? 'the order note' : '订单备注', ref: 's1:2', payoffRef: 's2:6', bearsOnEnding: true}, {thing: en ? 'the cupcake' : '纸杯蛋糕', ref: 's1:1', payoffRef: 's2:7', bearsOnEnding: false}],
    instructions: [{text: en ? 'Please sing happy birthday' : '请帮我唱一首生日歌', ref: 's1:2', reasonRef: 's1:2'}],
    sightings: [{who: en ? 'MAYA' : '玛雅', what: en ? 'the message on her phone' : '手机上的消息', ref: 's3:2', visible: 'yes', why: en ? 'it is on the phone in her hand' : '消息就在她手里的手机上'}],
    choices: [{ref: 's2:6', choice: en ? 'Maya sings although singing costs extra' : '唱歌本来要加钱，玛雅还是唱了', cost: en ? 'she gives away what she said she charges for' : '她白白做了本该加钱的事'}],
  };
}
