/** Deterministic episodic requests. Their messages were captured before format presets
 * existed (tests/fixtures/episodic-prompts.json) and must never change for episodic series. */
import { buildModelMessages, snapshotContext } from '../../src/core';
import type { ContextSnapshot, ModelRequest, Revision } from '../../src/types';

const englishBrief = {
  title: 'The Night Shift',
  premise: 'Two station workers must deliver a birthday cake before the power fails.',
  characters: 'PIP: a careful repair robot.\nSEVEN: a terse duty officer.',
  worldRules: 'The jetpack has one burst. Characters only know what they see or are told.',
  authorRules: 'Write English dialogue. Allow a quiet ending.',
  language: 'en',
  glossary: 'Pip = 派普; Seven = 七号',
  lengthTarget: {min: 300, max: 500, unit: 'words' as const},
};
const chineseBrief = {title: '夜班', premise: '两名站务员要在停电前送达生日蛋糕。', characters: '派普：维修机器人。', worldRules: '喷气包只有一次推进。', authorRules: '允许安静结尾。'};
const history: ContextSnapshot['previousEpisodes'] = [
  {episodeId: 'episode-0', ordinal: 1, revisionId: 'revision-0', title: 'Earlier', scenes: [{id: 's1', heading: 'INT. OFFICE - DAY', content: 'PIP: The box is sealed.', locked: false}]},
];
const englishScenes = [
  {id: 's1', heading: 'INT. OFFICE - NIGHT', content: 'Pip seals the cake box.\n\nSEVEN: She is off tonight.\nPIP\nShe fixed my knee anyway.', locked: true},
  {id: 's2', heading: 'EXT. WALKWAY - CONTINUOUS', content: 'A vent pulls the box outside. Pip fires his only burst.\n\nSEVEN (COMMS): You will need another way back.', locked: false},
];
const chineseScenes = [
  {id: 's1', heading: '内景 · 办公室 · 夜', content: '派普封好蛋糕盒。\n\n七号：她今晚休假。', locked: false},
];

function revision(id: string, context: ContextSnapshot, scenes: Revision['scenes'], language?: string): Revision {
  return {id, episodeId: 'episode-1', parentId: null, title: 'One Last Burst', logline: 'A cake, one burst, one way home.', scenes, context, kind: 'generated', instruction: '', mode: 'live', createdAt: '2026-11-07T00:00:00.000Z', ...(language ? {language} : {})};
}

export function episodicPromptCases(): Record<string, {role: string; content: string}[]> {
  const context = snapshotContext(englishBrief, []);
  const continued = snapshotContext({...englishBrief, title: 'The Night Shift II'}, history);
  const chinese = snapshotContext(chineseBrief, []);
  const english = revision('revision-en', context, englishScenes, 'en');
  const sequel = revision('revision-sequel', continued, englishScenes, 'en');
  const zh = revision('revision-zh', chinese, chineseScenes);
  const messages = (request: ModelRequest) => buildModelMessages(request);
  return {
    generate: messages({kind: 'generate', context, episodeTitle: 'Pilot'}),
    generateWithHistory: messages({kind: 'generate', context: continued, episodeTitle: 'Episode 2'}),
    generateChinese: messages({kind: 'generate', context: chinese, episodeTitle: '第一集'}),
    rewrite: messages({kind: 'rewrite', context, revision: english, sceneId: 's2', instruction: 'Cut the explanation.', episodeTitle: 'Pilot'}),
    localize: messages({kind: 'localize', context, revision: english, targetLanguage: 'zh-CN', episodeTitle: 'Pilot'}),
    causality: messages({kind: 'review', reviewPass: 'causality', context, revision: english, episodeTitle: 'Pilot'}),
    review: messages({kind: 'review', context, revision: english, episodeTitle: 'Pilot'}),
    reviewWithHistory: messages({kind: 'review', context: continued, revision: sequel, episodeTitle: 'Episode 2'}),
    reviewChinese: messages({kind: 'review', context: chinese, revision: zh, episodeTitle: '第一集'}),
  };
}
