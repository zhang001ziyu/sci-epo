import { describe, expect, test } from 'bun:test';
import { applySceneRewrite, buildModelMessages, exportMarkdown, getReviewSources, parseReview, parseScript, snapshotContext } from '../src/core';
import { canonicalJsonBytes } from '../src/core/canonicalJson';
import { DIMENSIONS, type Brief, type Revision } from '../src/types';

const brief: Brief = {title: '轨道检修站', premise: '两名维修员争取最后一班返航。', characters: '阿洛想回家。米娅必须先修好闸门。', worldRules: '备用电池只能启动一次。', authorRules: '不新增电池。允许安静结尾。'};
const script = {title: '最后一班', logline: '回家之前，先决定把最后一点电留给谁。', scenes: [
  {id: 's1', heading: '内景 · 闸门 · 夜', content: '米娅把电池插进控制槽。指示灯熄灭。\n米娅：用完了。', locked: true},
  {id: 's2', heading: '外景 · 月台 · 夜', content: '阿洛收起船票，坐在米娅旁边。\n阿洛：等下一班。', locked: false},
]};
function revision(): Revision {return {id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(script), context: snapshotContext(brief, []), kind: 'generated', instruction: '', mode: 'live', createdAt: '2026-11-05T00:00:00Z'};}
function reviews() {return {assessments: DIMENSIONS.map(dimension => ({dimension, status: 'no_issue', explanation: '结尾从选择中收束，未新增资源。', evidence: [{sourceId: 'authorRules', sourceQuote: '允许安静结尾。', sceneId: 's2', draftQuote: '阿洛：等下一班。'}]}))};}

describe('script contracts', () => {
 test('accepts fenced complete output and preserves verbatim text', () => {
  const result = parseScript('```json\n'+JSON.stringify(script)+'\n```');
  expect(result).toEqual(script);
 });
 test('rejects truncated output instead of saving a partial script', () => {
  expect(() => parseScript('{"title":"坏输出","scenes":[')).toThrow('完整 JSON');
 });
 test('rejects duplicate IDs and missing scenes/content', () => {
  expect(() => parseScript(JSON.stringify({...script, scenes: [script.scenes[0], script.scenes[0]]}))).toThrow('重复');
  expect(() => parseScript(JSON.stringify({...script, scenes: []}))).toThrow();
  expect(() => parseScript(JSON.stringify({...script, scenes: [{id:'s1', heading: '船舱', content:'  '}]}))).toThrow();
 });
});

describe('frozen writing context', () => {
 test('snapshots actual material and cannot be mutated through original objects', () => {
  const mutableBrief = structuredClone(brief);
  const history = [{episodeId: 'e0', ordinal: 1, revisionId: 'r0', title: '前集', scenes: structuredClone(script.scenes)}];
  const snapshot = snapshotContext(mutableBrief, history);
  mutableBrief.worldRules = '无限电池';
  history[0]!.scenes[0]!.content = '未来信息';
  expect(snapshot.brief.worldRules).toBe(brief.worldRules);
  expect(snapshot.previousEpisodes[0]!.scenes[0]!.content).toBe(script.scenes[0]!.content);
  expect(Object.isFrozen(snapshot.previousEpisodes[0]!.scenes)).toBe(true);
  expect(snapshot.hash).toHaveLength(64);
 });
 test('hash stable for reordered fields, changes when source material changes', () => {
  expect(snapshotContext({...brief}, []).hash).toBe(snapshotContext({authorRules: brief.authorRules, worldRules: brief.worldRules, characters: brief.characters, premise: brief.premise, title: brief.title}, []).hash);
  expect(snapshotContext({...brief, worldRules:'电池能用两次。'}, []).hash).not.toBe(snapshotContext(brief, []).hash);
 });
 test('rejects duplicate accepted-history slots', () => {
  const prior = {episodeId:'e0',ordinal:1,revisionId:'r0',title:'前集',scenes:script.scenes};
  expect(() => snapshotContext(brief,[prior,prior])).toThrow('重复');
 });
 test('reused canonical serializer rejects undefined, sparse arrays, cycles', () => {
  expect(() => canonicalJsonBytes({a: undefined})).toThrow();
  expect(() => canonicalJsonBytes(Array(2))).toThrow();
  const cycle: Record<string,unknown> = {}; cycle.self = cycle;
  expect(() => canonicalJsonBytes(cycle)).toThrow();
 });
});

describe('evidence-grounded reviews', () => {
 // Request contracts only; explicit checklists do not prove model coverage or judgment.
 test('causal requests name every required scene in original order, including a quiet final scene',()=>{
  const r=revision();r.scenes.push({id:'quiet-ending',heading:'月台',content:'两人静静等待下一班。',locked:false});
  const before=JSON.stringify(r),messages=buildModelMessages({kind:'review',reviewPass:'causality',context:r.context,revision:r,episodeTitle:r.title});
  const payload=JSON.parse(messages[1]!.content),system=messages[0]!.content;
  expect(payload.requiredSceneIds).toEqual(['s1','s2','quiet-ending']);
  expect(payload.script.scenes).toEqual(r.scenes);expect(payload.sources).toEqual(getReviewSources(r));
  expect(system).toContain('checks 必须覆盖每个场景至少一项');
  expect(system).toContain('不能省略结尾或没有激烈冲突的场景');
  expect(system).toContain('仍返回该场的 not_applicable');
  expect(system).toContain('本场动作的 evidence');expect(system).toContain('输出前逐项对照 requiredSceneIds');
  expect(JSON.stringify(r)).toBe(before);
 });
 test('broad reviews name all required dimensions and distinguish the two nonduplicate quotation fields',()=>{
  const r=revision(),messages=buildModelMessages({kind:'review',context:r.context,revision:r,episodeTitle:r.title});
  const payload=JSON.parse(messages[1]!.content),system=messages[0]!.content;
  expect(payload.requiredDimensions).toEqual(DIMENSIONS);expect(payload.sources).toEqual(getReviewSources(r));expect(payload.script.scenes).toEqual(r.scenes);
  expect(system).toContain('五个维度各一项');expect(system).toContain('sourceId、sourceQuote、sceneId、draftQuote 各只出现一次');
  expect(system).toContain('sourceQuote 必须来自 sourceId 对应 sources.text');
  expect(system).toContain('draftQuote 必须来自 sceneId 对应当前场景');
  expect(system).toContain('不能用两个同名 draftQuote 字段覆盖这两个引用');expect(system).toContain('JSON 对象字段名不得重复');
 });
 test('complete review with exact anchors is structurally complete', () => {
  const result = parseReview(JSON.stringify(reviews()), revision());
  expect(result.status).toBe('completed');
  expect(result.assessments).toHaveLength(5);
  expect(result.errors).toEqual([]);
 });
 test('rejects invented source quotes, never marks missing evidence complete', () => {
  const response = reviews(); response.assessments[0]!.evidence[0]!.sourceQuote = '阿洛知道未来。';
  const result = parseReview(JSON.stringify(response), revision());
  expect(result.status).toBe('needs_review');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.assessments.some(a => a.dimension === 'story')).toBe(false);
 });
 test('draft quote must belong to named scene, not just occur somewhere', () => {
  const response = reviews(); response.assessments[0]!.evidence[0]!.sceneId = 's1';
  expect(parseReview(JSON.stringify(response), revision()).status).toBe('needs_review');
 });
 test('missing dimensions, duplicate dimensions, invalid JSON and all not-applicable fail closed', () => {
  expect(parseReview('{}',revision()).status).toBe('needs_review');
  expect(parseReview('not json',revision()).status).toBe('needs_review');
  const response = reviews(); response.assessments[1]!.dimension = 'story';
  expect(parseReview(JSON.stringify(response),revision()).status).toBe('needs_review');
  expect(parseReview(JSON.stringify({assessments:reviews().assessments.map(a => ({...a,status:'not_applicable'}))}),revision()).status).toBe('needs_review');
 });
 test('uncertain can record a missing source honestly without inventing citations', () => {
  const response = reviews(); response.assessments[3] = {...response.assessments[3]!,status:'uncertain',explanation:'返航间隔没有设定，无法核对。',evidence:[]};
  const result = parseReview(JSON.stringify(response),revision());
  expect(result.status).toBe('needs_review');
  expect(result.assessments[3]!.status).toBe('uncertain');
  expect(result.errors).toEqual([]);
 });
 test('distinguishes aesthetic suggestion from factual conflict and disallows self-proven rules', () => {
  const response = reviews();
  const row = {...response.assessments[2]!, status:'issue', issueType:'craft_preference', suggestedFix:'可试读一个更含蓄的版本。',evidence:[{sourceId:'scene:s2',sourceQuote:'阿洛：等下一班。',sceneId:'s2',draftQuote:'阿洛：等下一班。'}]};
  response.assessments[2] = row;
  expect(parseReview(JSON.stringify(response),revision()).status).toBe('completed');
  row.issueType = 'fact_conflict';
  expect(parseReview(JSON.stringify(response),revision()).status).toBe('needs_review');
 });
 test('a review edit scope is explicit and may name the cited source scene rather than the first problem scene', () => {
  const r=revision(),response=reviews();
  const row={...response.assessments[3]!,status:'issue',issueType:'fact_conflict',suggestedFix:'Clarify the battery state in the first scene.',suggestedSceneId:'s1',
   evidence:[{sourceId:'scene:s1',sourceQuote:r.scenes[0]!.content,sceneId:'s2',draftQuote:r.scenes[1]!.content}]};
  response.assessments[3]=row;
  const parsed=parseReview(JSON.stringify(response),r);
  expect(parsed.errors).toEqual([]);expect(parsed.assessments[3]!.suggestedSceneId).toBe('s1');
  expect(parsed.assessments[3]!.evidence[0]!.sceneId).toBe('s2');
  const {suggestedSceneId:_scope,...legacy}=row;response.assessments[3]=legacy;
  const old=parseReview(JSON.stringify(response),r);
  expect(old.errors).toEqual([]);expect(old.assessments[3]!.suggestedSceneId).toBeUndefined();
  expect(old.assessments[3]!.suggestedFix).toBe(row.suggestedFix);
 });
 test('edit scope rejects nonexistent or unrelated scenes and does not accept a scope without a fix', () => {
  const r=revision();r.scenes.push({id:'unrelated',heading:'ELSEWHERE',content:'A distant door closes.',locked:false});
  for(const scope of [null,'','missing','unrelated',['s1','s2']]){
   const response=reviews();Object.assign(response.assessments[0]!,{suggestedFix:'Clarify the action.',suggestedSceneId:scope});
   const parsed=parseReview(JSON.stringify(response),r);
   expect(parsed.errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
   expect(parsed.assessments.some(a=>a.dimension==='story')).toBe(false);
  }
  const response=reviews();Object.assign(response.assessments[0]!,{suggestedSceneId:'s2'});
  expect(parseReview(JSON.stringify(response),r).errors.some(e=>e.includes('实际改稿场景'))).toBe(true);
 });
 test('sources retain accepted history IDs, not candidates added outside snapshot', () => {
  const rev = revision();
  rev.context = snapshotContext(brief,[{episodeId:'e0',ordinal:1,revisionId:'r0',title:'前集',scenes:script.scenes}]);
  expect(getReviewSources(rev).some(s => s.id === 'history:e0:s1')).toBe(true);
 });
});

describe('local revision boundary', () => {
 test('one scene changes; base and all unselected fields remain byte-equivalent', () => {
  const base = revision(), before = JSON.stringify(base);
  const result = applySceneRewrite(base,'s2',JSON.stringify({scene:{id:'s2',heading:script.scenes[1]!.heading,content:'阿洛把船票折好，留出半张椅子。'}}));
  expect(JSON.stringify(base)).toBe(before);
  expect(result.scenes[0]).toEqual(base.scenes[0]);
  expect(result.scenes[1]!.content).not.toBe(base.scenes[1]!.content);
  expect(result.title).toBe(base.title);
 });
 test('refuses locked scene, wrong target, extra fields and empty replacement', () => {
  const payload = {scene:{id:'s2',heading:'外景',content:'新场景'}};
  expect(() => applySceneRewrite(revision(),'s1',JSON.stringify(payload))).toThrow('锁定');
  expect(() => applySceneRewrite(revision(),'missing',JSON.stringify(payload))).toThrow('不存在');
  expect(() => applySceneRewrite(revision(),'s2',JSON.stringify({...payload,title:'改名'}))).toThrow('边界');
  expect(() => applySceneRewrite(revision(),'s2',JSON.stringify({scene:{...payload.scene,id:'s3'}}))).toThrow('其他场景');
  expect(() => applySceneRewrite(revision(),'s2',JSON.stringify({scene:{...payload.scene,content:''}}))).toThrow();
 });
 test('rewrite context comes from frozen base, review includes no unrelated mutable brief', () => {
  const rev = revision();
  const messages = buildModelMessages({kind:'rewrite',context:snapshotContext({...brief,worldRules:'未来规则'},[]),revision:rev,episodeTitle:rev.title,sceneId:'s2',instruction:'对白更含蓄'});
  expect(messages[1]!.content).toContain('备用电池只能启动一次。');
  expect(messages[1]!.content).not.toContain('未来规则');
  expect(() => buildModelMessages({kind:'rewrite',context:rev.context,revision:rev,episodeTitle:rev.title,sceneId:'s1',instruction:'改写'})).toThrow('锁定');
 });
 test('export identifies demonstration provenance and never claims adoption', () => {
  const rev = revision(); rev.mode = 'demo';
  expect(exportMarkdown(rev)).toContain('预置演示样例');
  expect(exportMarkdown(rev)).toContain('不表示作者已采用');
  expect(exportMarkdown(rev)).toContain(script.scenes[0]!.content);
 });
});
