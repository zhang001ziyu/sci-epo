import type { PublicationSettings, Revision, Localization, ScriptOutput } from '../types';

export const LANGUAGES = [
  {code:'en',name:'English'}, {code:'zh-CN',name:'简体中文'}, {code:'zh-TW',name:'繁體中文'},
  {code:'ja',name:'日本語'}, {code:'ko',name:'한국어'}, {code:'es',name:'Español'},
  {code:'fr',name:'Français'}, {code:'de',name:'Deutsch'}, {code:'pt-BR',name:'Português (Brasil)'},
] as const;
/** Languages the workspace offers in its pickers and manuscript switch. LANGUAGES keeps names for stored values. */
export const WORKSPACE_LANGUAGES = [{code:'en',name:'English'}, {code:'zh-CN',name:'简体中文'}] as const;
export type NotesLanguage = 'en' | 'zh-CN';
/** Exported provenance notes are written in English for English manuscripts, otherwise in Chinese. */
export const notesLanguage = (code: string): NotesLanguage => /^en(-|$)/u.test(code) ? 'en' : 'zh-CN';
/** Accept canonical BCP-47 tags so storage is not limited to the initial language picker. */
export function languageTag(input: unknown): string {
  if (typeof input !== 'string' || input.length > 35 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input)) throw new Error('语言代码无效，请使用 en、zh-CN 等语言代码。');
  const tag = Intl.getCanonicalLocales(input)[0];
  if (!tag) throw new Error('语言代码无效。');
  return tag;
}
export const languageName = (code: string) => LANGUAGES.find(l=>l.code===code)?.name ?? code;
export const scriptLanguage = (r: Revision) => r.language ?? r.context.brief.language ?? 'zh-CN';
export const defaultPublication = (): PublicationSettings => ({audioLanguage:'en',subtitleLanguages:['en','zh-CN'],subtitleStyle:'selectable',platform:'youtube'});
export function publicationSettings(value: unknown): PublicationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发布版本设置无效。');
  const row = value as Record<string,unknown>;
  if (!Array.isArray(row.subtitleLanguages) || row.subtitleLanguages.length > 8 || !['selectable','burned-bilingual','none'].includes(String(row.subtitleStyle)) || !['youtube','bilibili','general'].includes(String(row.platform))) throw new Error('发布版本设置无效。');
  const subtitleLanguages = row.subtitleLanguages.map(languageTag);
  if (new Set(subtitleLanguages).size !== subtitleLanguages.length) throw new Error('字幕语言不能重复。');
  if (row.subtitleStyle === 'burned-bilingual' && subtitleLanguages.length !== 2) throw new Error('双语画面字幕需要恰好两种语言。');
  if (row.subtitleStyle === 'selectable' && !subtitleLanguages.length) throw new Error('请选择至少一种字幕语言。');
  if (row.subtitleStyle === 'none' && subtitleLanguages.length) throw new Error('无字幕版本不能同时选择字幕语言。');
  return {audioLanguage:languageTag(row.audioLanguage),subtitleLanguages,subtitleStyle:row.subtitleStyle as PublicationSettings['subtitleStyle'],platform:row.platform as PublicationSettings['platform']};
}
export function alignLocalization(source: Revision, output: ScriptOutput): ScriptOutput {
  if (output.scenes.length !== source.scenes.length || output.scenes.some((s,i)=>s.id!==source.scenes[i]?.id)) throw new Error('语言改编必须保留原稿的场景编号、数量和顺序。');
  return {...output,scenes:output.scenes.map(s=>({...s,locked:false}))};
}
export function exportLocalization(source: Revision, target: Localization, notes: NotesLanguage = 'zh-CN'): string {
  const provenance = notes === 'en'
    ? [`> ${scriptLanguage(source)} → ${target.language} · source revision ${source.id} · adaptation ${target.id} · ${target.createdAt}`, `> ${target.mode==='demo'?'Prepared bilingual example':target.mode==='manual'?'Adaptation edited by the author':'Adaptation candidate'}; not yet approved by the author.`]
    : [`> ${scriptLanguage(source)} → ${target.language} · 原稿 ${source.id} · 语言版本 ${target.id}`, `> ${target.mode==='demo'?'预置双语演示':'语言改编候选'}；尚未表示作者已审定。`];
  return [`# ${target.title}`, '', target.logline, '', ...provenance, '', ...target.scenes.flatMap(s=>[`## ${s.heading}`, '', s.content, ''])].join('\n');
}
