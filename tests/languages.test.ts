import { afterEach, expect, test } from 'bun:test';
import { Store } from '../src/server/store';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { buildModelMessages, snapshotContext } from '../src/core';
import { alignLocalization, languageTag, publicationSettings, scriptLanguage } from '../src/core/languages';
import type { Revision, ProjectBundle, Localization } from '../src/types';
const stores: Store[]=[];afterEach(()=>{for(const s of stores.splice(0))s.close();});
const brief={title:'Orbital Odd-Jobs',premise:'Pip delivers a birthday cake.',characters:'Pip and Seven',worldRules:'One burst of fuel',authorRules:'Let choices matter.',language:'en',glossary:'Pip = 派普; Seven = 七号'};
function harness(){const store=new Store();stores.push(store);const app=createApp(store,{demo:demoProvider});
 const call=async(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>{const r=await app(new Request('http://127.0.0.1:4317'+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,body:await r.json()};};
 async function setup(){const p=(await call('/api/projects',brief)).body as ProjectBundle;const r=(await call(`/api/episodes/${p.episodes[0]!.id}/generate`,{mode:'demo'})).body as Revision;return {p,r};}
 return {store,call,setup};}
test('new English project produces English demo; translation preserves original and exact scene correspondence',async()=>{
 const h=harness(),{p,r}=await h.setup();expect(r.language).toBe('en');expect(r.scenes[0]!.content).toContain('Pip');
 const result=await h.call(`/api/revisions/${r.id}/localize`,{mode:'demo',language:'zh-CN'});expect(result.status).toBe(200);
 const l=result.body as Localization;expect(l.sourceRevisionId).toBe(r.id);expect(l.scenes.map(s=>s.id)).toEqual(r.scenes.map(s=>s.id));expect(l.scenes[0]!.content).toContain('派普');
 expect(h.store.get('revisions',r.id)).toEqual(r);expect(h.store.get('episodes',r.episodeId)!.acceptedRevisionId).toBeNull();
 expect(h.store.bundle(p.project.id)!.localizations).toHaveLength(1);expect(h.store.all('runs').at(-1)!.kind).toBe('localize');
 const before=l.scenes[0]!.content;const edited=structuredClone(l);edited.scenes[0]!.content+='\n派普重新扣上盒子。';
 const edit=await h.call(`/api/localizations/${l.id}/edit`,edited);expect(edit.status).toBe(200);expect(edit.body.parentId).toBe(l.id);expect(edit.body.mode).toBe('manual');
 expect(h.store.get('localizations',l.id)!.scenes[0]!.content).toBe(before);
});
test('rewriting source keeps English but does not silently reuse an old Chinese translation in publication',async()=>{
 const h=harness(),{p,r}=await h.setup();await h.call(`/api/revisions/${r.id}/localize`,{mode:'demo',language:'zh-CN'});
 const rewritten=await h.call(`/api/revisions/${r.id}/rewrite`,{mode:'demo',sceneId:'s3',instruction:'Preserve the fuel limit.'});expect(rewritten.status).toBe(200);expect(rewritten.body.language).toBe('en');
 const manifest=await h.call(`/api/revisions/${rewritten.body.id}/publication`);expect(manifest.status).toBe(200);expect(manifest.body.versions.find((l:any)=>l.language==='zh-CN').available).toBe(false);expect(manifest.body.timedSubtitlesAvailable).toBe(false);
 expect(h.store.bundle(p.project.id)!.localizations).toHaveLength(1);
 const old=await h.call(`/api/revisions/${r.id}/publication`);expect(old.body.versions.find((l:any)=>l.language==='zh-CN').available).toBe(true);
 expect((await h.call(`/api/revisions/${rewritten.body.id}/localize`,{mode:'demo',language:'zh-CN'})).status).toBe(502);
});
test('language options and glossary freeze with source; localization prompt explicitly uses target rather than input language',async()=>{
 const h=harness(),{r}=await h.setup();
 const message=buildModelMessages({kind:'localize',context:r.context,revision:r,targetLanguage:'ja',episodeTitle:r.title});
 expect(message[0]!.content).toContain('日本語 (ja)');expect(message[1]!.content).toContain('Pip = 派普');expect(message[1]!.content).toContain(r.id);
 const generated=buildModelMessages({kind:'generate',context:r.context,episodeTitle:r.title});expect(generated[0]!.content).toContain('English (en)');expect(generated[0]!.content).not.toContain('以中文完成故事');
 expect(snapshotContext({...brief,language:'ja'},[]).hash).not.toBe(snapshotContext(brief,[]).hash);
 expect(snapshotContext({...brief,glossary:'Pip = 皮普'},[]).hash).not.toBe(snapshotContext(brief,[]).hash);
 expect(scriptLanguage({...r,language:undefined,context:snapshotContext({...brief,language:undefined},[])})).toBe('zh-CN');
});
test('rejects missing and reordered translation scenes, invalid language and same-language paid requests',async()=>{
 const h=harness(),{r}=await h.setup();
 expect(()=>alignLocalization(r,{...r,scenes:r.scenes.slice(1)})).toThrow('编号');
 expect(()=>alignLocalization(r,{...r,scenes:[...r.scenes].reverse()})).toThrow('编号');
 expect(languageTag('it')).toBe('it');expect(()=>languageTag('<script>')).toThrow();
 const count=h.store.all('runs').length;
 expect((await h.call(`/api/revisions/${r.id}/localize`,{mode:'live',language:'en'})).status).toBe(400);
 expect((await h.call(`/api/revisions/${r.id}/localize`,{mode:'demo',language:'../../x'})).status).toBe(400);
 expect(h.store.all('runs')).toHaveLength(count);
});
test('publishing choices are independent of story canon and validate subtitle combinations',async()=>{
 const h=harness(),{p,r}=await h.setup();const before=h.store.contextToken(p.episodes[0]!);
 const publication={audioLanguage:'zh-CN',subtitleLanguages:['zh-CN','en'],subtitleStyle:'burned-bilingual',platform:'bilibili'};
 const saved=await h.call(`/api/projects/${p.project.id}/publication`,publication,'PUT');expect(saved.status).toBe(200);expect(saved.body.project.publication).toEqual(publication);
 expect(h.store.contextToken(p.episodes[0]!)).toBe(before);expect(h.store.get('revisions',r.id)).toEqual(r);
 expect(()=>publicationSettings({...publication,subtitleLanguages:['en']})).toThrow('两种');
 expect(()=>publicationSettings({...publication,subtitleLanguages:['en','en']})).toThrow('重复');
 expect(()=>publicationSettings({...publication,subtitleStyle:'none'})).toThrow();
 expect(publicationSettings({...publication,subtitleStyle:'none',subtitleLanguages:[]})).toMatchObject({subtitleLanguages:[]});
});
