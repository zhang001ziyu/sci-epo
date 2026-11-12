import type { Brief, CausalAudit, Episode, ModelProvider, ModelRequest, Project, Revision, Run, Scene } from '../types';
import { applySceneRewrite, exportMarkdown, getReviewSources, parseCausalAudit, parseReview, parseScript, snapshotContext } from '../core';
import { failedReviewVerification, failedVerificationFacts, failedVerificationAudit, parseVerificationFacts, parseVerificationAudit, auditBatches, parseVerificationAuditBatch, mergeVerificationAuditAttempts, type VerificationAuditBatchAttempt, type VerificationAuditBatchResult, type ReviewVerification, type VerificationFacts } from '../core/reviewVerification';
import { checkLength, parseLengthTarget } from '../core/length';
import { Store } from './store';
import { Auth, AuthError } from './auth';
import { ProviderManager, ProviderAdminError } from './providerManager';
import { alignLocalization, defaultPublication, exportLocalization, languageName, languageTag, notesLanguage, publicationSettings, scriptLanguage } from '../core/languages';
import { currentAdaptation } from '../core/manuscripts';
import { Production, type ProductionOptions } from './production';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from './media';
import { Stacks } from './stacks';
import { Sessions } from './sessions';
import { Cuts, type CutsOptions } from './cuts';
import { OWNER_KINDS, isMediaKind } from '../core/mediaKinds';
import { reviewSuggestion } from '../core/reviewSuggestions';
import { AuditValidationError, createModelCaller } from './modelAttempts';
import { DEFAULT_DURATION_TARGET, aspectRatioOf, defaultVoiceLanguages, isShortDrama, parseDurationTarget, parseFormat, parseVoiceLanguages } from '../core/formats';
import { requireLineAlignment } from '../core/scriptLines';
import { boundAdaptations, exportShotListCsv, newestAlignedAdaptations, parseAdaptationBinding, parseShotList, parseShotListOutput, shotListStatus } from '../core/shotList';

export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
const fail=(status:number,message:string):never=>{throw new HttpError(status,message);};
const now=()=>new Date().toISOString();
const id=()=>crypto.randomUUID();
function obj(value:unknown):Record<string,unknown>{if(!value || typeof value!=='object'||Array.isArray(value))return fail(400,'请求格式不正确。');return value as Record<string,unknown>;}
function str(value:unknown,label:string,max=30000,allowEmpty=false):string {if(typeof value!=='string'||value.length>max||(!allowEmpty&&!value.trim()))return fail(400,`${label}不能为空或过长。`);return value;}
function validLanguage(value:unknown):string {try{return languageTag(value);}catch{return fail(400,'语言代码无效，请使用 en、zh-CN 等语言代码。');}}
/** Only vertical short drama is stored; an absent or episodic format keeps the original brief shape. */
function formatFields(b:Record<string,unknown>,stored?:Brief):Pick<Brief,'format'|'durationTarget'> {
 let format;try{format=parseFormat(b.format??stored?.format??'episodic');}catch(error){return fail(400,error instanceof Error?error.message:'剧集格式无效。');}
 if(format!=='vertical_short_drama')return {};
 const raw=b.durationTarget??stored?.durationTarget;
 try{return {format,durationTarget:raw===undefined||raw===null?{...DEFAULT_DURATION_TARGET}:parseDurationTarget(raw)};}catch(error){return fail(400,error instanceof Error?error.message:'目标时长无效。');}
}
function brief(value:unknown,stored?:Brief):Brief {const b=obj(value);const format=formatFields(b,stored);let lengthTarget;try {if(b.lengthTarget!==undefined&&b.lengthTarget!==null)lengthTarget=parseLengthTarget(b.lengthTarget);}catch(error){return fail(400,error instanceof Error?error.message:'篇幅范围无效。');}return {title:str(b.title,'系列标题',200),premise:str(b.premise,'故事前提'),characters:str(b.characters,'人物资料',30000,true),worldRules:str(b.worldRules,'世界规则',30000,true),authorRules:str(b.authorRules,'作者要求',30000,true),...(b.language!==undefined?{language:validLanguage(b.language)}:{}),...(b.glossary!==undefined?{glossary:str(b.glossary,'术语表',30000,true)}:{}),...(lengthTarget?{lengthTarget}:{}),...format};}
export interface AppOptions { publicOrigin?:string; production?:ProductionOptions; media?:{dir?:string;quotaMb?:number}; workerPublicUrl?:string; cuts?:CutsOptions }
export function createApp(store:Store, providers:{live?:ModelProvider;demo:ModelProvider;managed?:ProviderManager}, root=process.cwd(), options:AppOptions={}) {
 const auth=options.publicOrigin?new Auth(store.db,options.publicOrigin):undefined;
 const clock=options.production?.clock??(()=>new Date());
 // Without a configured folder (tests), media goes to a private temporary folder of this process.
 const media=new MediaStore(store,options.media?.dir??join(tmpdir(),`sciepo-media-${process.pid}`),(options.media?.quotaMb??5120)*1024*1024,fail,id,()=>clock().toISOString());
 const stacks=new Stacks(root);
 const production=new Production(store,fail,id,{...options.production,media,stacks});
 // Cuts start their runner here, after running cuts of an earlier server process have gone back to the queue.
 const cuts=new Cuts(store,media,fail,id,{clock,...options.cuts});
 const sessions=new Sessions(store,media,stacks,production,fail,id,{clock,...(options.workerPublicUrl??auth?.origin?{publicUrl:options.workerPublicUrl??auth!.origin}:{}),onTakeRendered:jobId=>cuts.takeRendered(jobId)});
 function project(pid:string){return store.get('projects',pid)??fail(404,'找不到系列。');}
 function episode(eid:string){return store.get('episodes',eid)??fail(404,'找不到集数。');}
 function revision(rid:string){return store.get('revisions',rid)??fail(404,'找不到剧本版本。');}
 function context(e:Episode){
  const p=project(e.projectId);
  const previous=store.all('episodes').filter(x=>x.projectId===p.id && x.ordinal<e.ordinal && x.acceptedRevisionId).sort((a,b)=>a.ordinal-b.ordinal);
  if(previous.some(x=>x.needsReview))return fail(409,'前集因上游修改需要复核。请先确认前集定稿，再生成后续。');
  return snapshotContext(brief(p),previous.map(x=>{const r=revision(x.acceptedRevisionId!);return {episodeId:x.id,ordinal:x.ordinal,revisionId:r.id,title:r.title,scenes:r.scenes};}));
 }
 function saveRevision(e:Episode,fields:Omit<Revision,'id'|'episodeId'|'createdAt'>){
  const saved=store.insert('revisions',{...fields,id:id(),episodeId:e.id,createdAt:now()});
  let stale=false;
  try {stale=fields.context.hash!==context(e).hash;} catch {stale=true;}
  if(stale)store.update('episodes',{...episode(e.id),needsReview:true});
  return saved;
 }
 function addEpisode(p:Project,title:string){const ordinal=store.all('episodes').filter(e=>e.projectId===p.id).reduce((m,e)=>Math.max(m,e.ordinal),0)+1;return store.insert('episodes',{id:id(),projectId:p.id,ordinal,title,acceptedRevisionId:null,needsReview:false,createdAt:now()});}
 async function model(e:Episode,b:Record<string,unknown>,request:ModelRequest,consume:(raw:string,mode:'live'|'demo',causality?:CausalAudit,verification?:ReviewVerification)=>{id:string}){
  if(b.mode!=='demo'&&b.mode!=='live')return fail(400,'请选择真实生成或示例演练。');
  const resolved=b.mode==='live'?providers.managed?.resolve(request.kind):undefined;
  const provider=resolved?.provider??providers[b.mode]??fail(503,'真实模型尚未配置；可先用示例演练流程。');
  if(store.all('runs').some(r=>r.episodeId===e.id&&r.status==='running'))return fail(409,'本集已有任务正在运行，请等待完成。');
  const run:Run={id:id(),episodeId:e.id,kind:request.kind,status:'running',mode:provider.mode,resultId:null,error:null,createdAt:now(),finishedAt:null,...(resolved?{modelSnapshot:resolved.snapshot}:{})};
  store.insert('runs',run);
  const caller=createModelCaller(provider,request.kind,attempts=>{
   run.modelAttempts=attempts;
   store.update('runs',{...run});
  });
  let causality:CausalAudit|undefined, verification:ReviewVerification|undefined, verificationError:string|undefined;
  async function verify(draft:NonNullable<ModelRequest['draftReview']>) {
   const revision=request.revision!,sources=getReviewSources(revision);
   let facts:VerificationFacts;
   try {
    // Source facts must be reconstructed without seeing or inheriting reviewer claims.
    facts=parseVerificationFacts(await caller.complete({...request,reviewPass:'facts',draftReview:undefined,draftFacts:undefined}),revision,sources);
   } catch {
    verificationError='原文事实整理调用未完成；已有审稿已保留，尚未进行独立陈述审计。';
    facts=failedVerificationFacts(verificationError);
    return failedVerificationAudit(revision,draft,facts,verificationError);
   }
   if(facts.errors.length){
    verificationError='原文事实整理未通过结构、覆盖或引文校验；保留部分结果，未继续独立陈述审计。';
    return failedVerificationAudit(revision,draft,facts,verificationError);
   }
   let batches:string[][];
   try{batches=auditBatches(draft,facts);}catch{
    verificationError='原审稿结构无法建立审计批次；本次事实整理已保留。';return failedVerificationAudit(revision,draft,facts,verificationError);
   }
   if(batches.length>24){verificationError='审计批次超过单次上限，请按分集缩小范围；本次事实整理已保留。';return failedVerificationAudit(revision,draft,facts,verificationError);}
   const results:(VerificationAuditBatchResult|undefined)[]=new Array(batches.length).fill(undefined);
   const batchAttempts:VerificationAuditBatchAttempt[]=[];
   let next=0,stopped=false;
   // Small independent audits share one frozen provider. At most two calls are in flight;
   // a failed batch stops further scheduling, preserving all completed and in-flight results.
   async function worker(){
    while(!stopped&&next<batches.length){
     const index=next++,targets=batches[index]!;
     const parsedAttempts:VerificationAuditBatchResult[]=[];
     const diagnostics:VerificationAuditBatchAttempt[]=[];
     try {
      await caller.complete({...request,reviewPass:'verification',draftReview:draft,draftFacts:facts,auditTargetIds:targets},{batch:index+1,canRetry:()=>!stopped,
       validate(raw,attempt){
        const parsed=parseVerificationAuditBatch(raw,revision,draft,facts,sources,targets,true);
        parsedAttempts.push(structuredClone(parsed));
        diagnostics.push({batch:index+1,callId:attempt.callId,attempt:attempt.attempt,targetIds:[...targets],result:structuredClone(parsed)});
        if(parsed.errors.length)throw new AuditValidationError(parsed.errors);
       }});
      results[index]=mergeVerificationAuditAttempts(parsedAttempts);
     } catch {
      results[index]=mergeVerificationAuditAttempts(parsedAttempts);
      results[index]!.errors=[...new Set([...results[index]!.errors,'该批审计未独立完成结构、覆盖和引文校验；有效部分已保留，未将陈述视作已核实。'])];
     }
     // Normal first-attempt results already live in the audit. Preserve every
     // parsed answer only for failed/resend batches, without duplicating all batches.
     if(diagnostics.some(a=>a.attempt===2||a.result.errors.length))batchAttempts.push(...diagnostics);
     if(results[index]!.errors.length)stopped=true;
    }
   }
   await Promise.all(Array.from({length:Math.min(2,batches.length)},()=>worker()));
   const batchErrors=results.flatMap((r,i)=>(r?.errors??[]).map(message=>`审计第 ${i+1} 批：${message}`));
   if(results.some(r=>!r))batchErrors.push('前一批失败后停止后续审计；未检查项目仍保留为未核实。');
   let result:ReviewVerification;
   try{result=parseVerificationAudit(JSON.stringify({checks:results.flatMap(r=>r?.checks??[]),fieldChecks:results.flatMap(r=>r?.fieldChecks??[])}),revision,draft,facts,sources);}catch{
    verificationError='审计结果无法完成整体校验；原审稿与事实整理已保留。';
    const failed=failedVerificationAudit(revision,draft,facts,verificationError);
    if(failed.audit&&batchAttempts.length)failed.audit.batchAttempts=structuredClone(batchAttempts);
    return failed;
   }
   result.errors=[...new Set([...result.errors,...batchErrors])];
   if(result.audit){
    result.audit.inferenceChecks=results.flatMap(r=>r?.inferenceChecks??[]);
    result.audit.inferenceOriginalFields=results.flatMap(r=>r?.inferenceOriginalFields??[]);
    result.audit.inferenceOriginalParents=results.flatMap(r=>r?.inferenceOriginalParents??[]);
    if(batchAttempts.length)result.audit.batchAttempts=structuredClone(batchAttempts.sort((a,b)=>a.batch-b.batch||a.attempt-b.attempt));
    result.audit.errors=[...new Set([...result.audit.errors,...batchErrors])];
    const notes=results.flatMap(r=>r?.normalizationNotes??[]);
    if(notes.length)result.audit.normalizationNotes=[...new Set([...(result.audit.normalizationNotes??[]),...notes])];
    if(batchErrors.length)result.audit.status='needs_review';
   }
   if(result.audit?.errors.length||result.errors.length){
    result.status='needs_review';verificationError='独立陈述审计未通过调用、结构、覆盖或引文校验；已保留原稿、原审稿及完成的审计部分。';
   }
   return result;
  }
  try{
   // Independent pass: no broad review verdict is supplied to the causality editor.
   let raw:string;
   if(request.kind==='review'&&provider.mode==='live'&&request.reviewPass==='verification') {
    verification=await verify(request.draftReview!); raw='';
   } else {
    if(request.kind==='review'&&provider.mode==='live')causality=parseCausalAudit(await caller.complete({...request,reviewPass:'causality'}),request.revision!);
    if(causality?.errors.length){
     // Keep valid partial findings, but do not spend later calls on a structurally incomplete critic.
     raw='{}';
     verificationError='因果审稿未通过结构、覆盖或引文校验；已有结果已保留，未继续五维审稿、事实整理或独立陈述审计。';
     verification=failedReviewVerification(verificationError);
    }else{
     raw=await caller.complete(request);
     if(request.kind==='review'&&provider.mode==='live'){
      const draft=parseReview(raw,request.revision!,causality);
      if(draft.errors.length){
       verificationError='五维审稿未通过结构、覆盖或引文校验；已有因果与五维审稿结果已保留，未继续事实整理或独立陈述审计。';
       verification=failedReviewVerification(verificationError);
      }else verification=await verify(draft);
     }
    }
   }
   const result=store.db.transaction(()=>{
    const result=consume(raw,provider.mode,causality,verification);
    store.update('runs',{...run,status:verificationError?'failed':'succeeded',error:verificationError??null,resultId:result.id,finishedAt:now()});
    return result;
   })();
   return result;
  }catch(error){
   // Do not expose upstream response bodies, URLs, or credentials.
   const message=error instanceof HttpError?error.message:error instanceof Error&&error.name==='ModelError'?error.message:'输出未通过校验或任务失败；原稿已保留，请查看输入后重试。';
   // Keep the completed causal pass even if the later model request fails.
   const partial=causality&&request.revision?store.insert('reviews',{id:id(),revisionId:request.revision.id,...parseReview('{}',request.revision,causality),verification:failedReviewVerification('前序审稿未完成，尚未核实审稿解释。'),mode:provider.mode,createdAt:now()}):undefined;
   store.update('runs',{...run,status:'failed',resultId:partial?.id??null,error:message,finishedAt:now()});
   return fail(error instanceof HttpError?error.status:502,message);
  }
 }
 async function api(req:Request,url:URL){
  const parts=url.pathname.split('/').filter(Boolean), a=parts[1], target=parts[2], action=parts[3], method=req.method;
  if(method==='GET'&&a==='status'){const live=providers.managed?providers.managed.ready():!!providers.live;return {mode:live?'live':'unconfigured',modelLabel:live?'创作模型配置已加载':'尚未配置真实模型',...(providers.managed?{management:true}:{})};}
  if(method==='GET'&&a==='providers'&&!target)return providers.managed?.catalog()??fail(503,'模型管理尚未启用。');
  if(method==='GET'&&a==='projects'&&!target)return store.all('projects');
  if(method==='GET'&&a==='projects'&&target){const p=project(target);sessions.refreshProject(p.id);return store.bundle(p.id);}
  if(method==='GET'&&a==='revisions'&&target&&action==='export'){
   // The manuscript in the requested language: the source itself, or the current adaptation of this exact revision.
   const r=revision(target),requested=url.searchParams.get('language'),language=requested===null?scriptLanguage(r):validLanguage(requested);
   const markdown=(text:string)=>new Response(text,{headers:{'content-type':'text/markdown; charset=utf-8','content-disposition':`attachment; filename="sci-epo-${r.id}-${language}.md"`}});
   if(language===scriptLanguage(r))return markdown(exportMarkdown(r,notesLanguage(language)));
   const l=currentAdaptation(r,store.all('localizations'),language)??fail(404,`这一版还没有${languageName(language)}稿。`);
   return markdown(exportLocalization(r,l,notesLanguage(language)));
  }
  if(method==='GET'&&a==='localizations'&&target&&action==='export'){
   const l=store.get('localizations',target)??fail(404,'找不到语言版本。');
   return new Response(exportLocalization(revision(l.sourceRevisionId),l,notesLanguage(l.language)),{headers:{'content-type':'text/markdown; charset=utf-8','content-disposition':`attachment; filename="sci-epo-${l.language}-${l.id}.md"`}});
  }
  if(method==='GET'&&a==='shot-lists'&&target&&action==='export'){
   const list=store.get('shot_lists',target)??fail(404,'找不到分镜表。'),r=revision(list.sourceRevisionId),e=episode(r.episodeId);
   const csv=exportShotListCsv({list,revision:r,adaptations:boundAdaptations(list,store.all('localizations')),episodeTitle:e.title,status:shotListStatus(list,e)});
   return new Response(csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="sci-epo-shots-${list.id}.csv"`}});
  }
  if(method==='GET'&&a==='revisions'&&target&&action==='publication'){
   const r=revision(target),e=episode(r.episodeId),p=project(e.projectId),settings=p.publication??defaultPublication();
   const languages=[...new Set([settings.audioLanguage,...settings.subtitleLanguages])];
   // Schema 2: a language is delivered by the newest signed-off final cut of this revision whose takes are still approved.
   const versions=languages.map(language=>{
    const cut=cuts.delivered(r.id,language),batch=cut?store.get('render_batches',cut.batchId):undefined;
    return {language,sourceRevisionId:r.id,localizationId:language===scriptLanguage(r)?null:store.all('localizations').filter(l=>l.sourceRevisionId===r.id&&l.language===language).at(-1)?.id??null,available:language===scriptLanguage(r)||store.all('localizations').some(l=>l.sourceRevisionId===r.id&&l.language===language),
     cut:cut?.output&&batch?{id:cut.id,sha256:cut.output.sha256,seconds:cut.output.seconds,batchId:batch.id,shotListId:batch.shotListId,localizationId:batch.adaptations[language]??null}:null,
     productionStatus:cut?.output&&batch?'delivered' as const:'planning_only' as const};
   });
   const delivered=versions.filter(v=>v.cut).length,productionStatus=!delivered?'planning_only':delivered===versions.length?'delivered':'partly_delivered';
   const pending=productionStatus==='delivered'?['按最终配音和剪辑对齐字幕时间轴']:productionStatus==='partly_delivered'?['语言版本由作者复核','其余语言的配音与画面制作','按最终配音和剪辑对齐字幕时间轴']:['语言版本由作者复核','配音与画面制作','按最终配音和剪辑对齐字幕时间轴'];
   return new Response(JSON.stringify({schemaVersion:2,project:p.title,episode:e.title,sourceRevisionId:r.id,sourceLanguage:scriptLanguage(r),sourceAccepted:e.acceptedRevisionId===r.id&&!e.needsReview,settings,versions,productionStatus,pending,timedSubtitlesAvailable:false},null,2),{headers:{'content-type':'application/json','content-disposition':`attachment; filename="sci-epo-publication-${r.id}.json"`}});
  }
  if(method==='GET'&&a==='media'&&target&&!action){const asset=store.get('media_assets',target)??fail(404,'找不到这个文件。');return media.serve(req,asset);}
  if(method==='GET'){const handled=production.get(a,target,action,url)??sessions.get(a,target,action)??cuts.get(a,target,action,url);if(handled!==undefined)return handled;}
  // Owner uploads are raw bodies streamed into the media store, so they skip the JSON rules below.
  if(method==='PUT'&&a==='projects'&&target&&action==='media'&&!parts[4]){
   const p=project(target),kind=url.searchParams.get('kind');
   if(!isMediaKind(kind)||!OWNER_KINDS.includes(kind))return fail(400,'只能上传参考图、声音样本或配乐。');
   const declared=Number(req.headers.get('content-length')??Number.NaN),label=url.searchParams.get('label')?.trim(),license=url.searchParams.get('license')?.trim();
   const asset=await media.ingest(p.id,kind,req.body,{origin:'owner',...(label?{label}:{}),...(license?{license}:{}),...(Number.isFinite(declared)?{declaredLength:declared}:{})});
   return {asset,bundle:store.bundle(p.id)};
  }
  if(!['POST','PUT'].includes(method))return fail(404,'未找到接口。');
  if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return fail(415,'请使用 JSON 请求。');
  if(Number(req.headers.get('content-length')??0)>1000000)return fail(413,'内容过长，请分集保存。');
  const bodyText=await req.text(); if(bodyText.length>250000)return fail(413,'内容过长，请分集保存。');
  let body:Record<string,unknown>;try{body=obj(JSON.parse(bodyText));}catch{return fail(400,'请求不是有效的 JSON。');}
  if(a==='providers'&&method==='POST'&&!action){
   const manager=providers.managed??fail(503,'模型管理尚未启用。');
   if(target==='connections')return manager.saveConnection(body);
   if(target==='models')return manager.saveModel(body);
   if(target==='routing')return manager.publish(body);
   if(target==='test')return manager.test(body);
   return fail(404,'未找到模型管理接口。');
  }
  if(a==='projects'&&!target&&method==='POST'){
   return store.db.transaction(()=>{const fields=brief(body),language=validLanguage(body.language??'en');const p=store.insert('projects',{...fields,language,glossary:str(body.glossary??'','术语表',30000,true),publication:defaultPublication(),...(fields.format?{voiceLanguages:defaultVoiceLanguages(language)}:{}),id:id(),createdAt:now(),updatedAt:now()});addEpisode(p,'Pilot');return store.bundle(p.id);})();
  }
  if(a==='projects'&&target&&action==='voice-languages'&&method==='PUT'){
   // A production setting: it never changes the frozen brief, the context token or recheck flags.
   const p=project(target);let languages;try{languages=parseVoiceLanguages(body.languages,p.language??'zh-CN');}catch(error){return fail(400,error instanceof Error?error.message:'配音语言无效。');}
   store.update('projects',{...p,voiceLanguages:languages,updatedAt:now()});return store.bundle(p.id);
  }
  if(a==='projects'&&target&&action==='publication'&&method==='PUT'){
   const p=project(target);let settings;try{settings=publicationSettings(body);}catch(error){return fail(400,error instanceof Error?error.message:'发布设置无效。');}
   store.update('projects',{...p,publication:settings,updatedAt:now()});return store.bundle(p.id);
  }
  if(a==='projects'&&target&&!action&&method==='PUT'){
   const p=project(target);store.db.transaction(()=>{
    const {lengthTarget:_oldLength,format:_oldFormat,durationTarget:_oldDuration,...previous}=p;
    const next:Project={...previous,...brief(body,p),updatedAt:now()},language=next.language??'zh-CN';
    if(next.format&&!next.voiceLanguages)next.voiceLanguages=defaultVoiceLanguages(language);
    else if(next.voiceLanguages&&!next.voiceLanguages.includes(language))next.voiceLanguages=[language,...next.voiceLanguages].slice(0,6);
    store.update('projects',next);
    for(const e of store.all('episodes').filter(e=>e.projectId===p.id)) if(store.all('revisions').some(r=>r.episodeId===e.id))store.update('episodes',{...e,needsReview:true});
   })();return store.bundle(p.id);
  }
  if(a==='projects'&&target&&action==='episodes'&&method==='POST'){const p=project(target);addEpisode(p,str(body.title,'分集标题',200));return store.bundle(p.id);}
  if(a==='episodes'&&target&&action==='generate'&&method==='POST'){
   const e=episode(target), ctx=context(e);
   return model(e,body,{kind:'generate',context:ctx,episodeTitle:e.title},(raw,mode)=>{
    const output=parseScript(raw);
    return saveRevision(e,{...output,language:ctx.brief.language??'zh-CN',parentId:null,kind:'generated',context:ctx,instruction:'',mode});
   });
  }
  if(a==='episodes'&&target&&action==='accept'&&method==='POST'){
   const e=episode(target), r=revision(str(body.revisionId,'版本 ID',100));
   if(r.episodeId!==e.id)return fail(400,'该版本不属于本集。');
   if(body.expectedAcceptedRevisionId!==e.acceptedRevisionId)return fail(409,'定稿已发生变化，请刷新后重新对照。');
   if(body.expectedContextToken!==store.contextToken(e))return fail(409,'系列资料或前集定稿已变化，请刷新并重新审读后再采用。');
   if(body.acknowledgeReview!==true)return fail(400,'请确认已审读此版本及未解决的问题，再采用。');
   const lengthCheck=checkLength(r.context.brief,r.scenes);
   if(['too_long','too_short','ambiguous'].includes(lengthCheck.status)&&body.acknowledgeLengthException!==true)return fail(409,`${lengthCheck.message} 请先修改，或明确确认接受篇幅例外。`);
   const reasons=store.all('episodes').filter(x=>x.projectId===e.projectId&&x.ordinal<e.ordinal&&x.needsReview);
   if(reasons.length)return fail(409,'请先复核前集，再确认本集。');
   store.db.transaction(()=>{
    store.update('episodes',{...e,acceptedRevisionId:r.id,needsReview:false});
    if(e.acceptedRevisionId!==r.id)for(const later of store.all('episodes').filter(x=>x.projectId===e.projectId&&x.ordinal>e.ordinal))if(store.all('revisions').some(v=>v.episodeId===later.id))store.update('episodes',{...later,needsReview:true});
   })();return store.bundle(e.projectId);
  }
  if(a==='episodes'&&target&&action==='production-shot-list'&&method==='POST'){
   const e=episode(target),list=store.get('shot_lists',str(body.shotListId,'分镜表 ID',100))??fail(404,'找不到分镜表。');
   // Compare-and-swap: a stale tab must not silently replace a newer production choice.
   if(body.expectedShotListId!==(e.productionShotListId??null))return fail(409,'制作用分镜表已在其他页面更改，请刷新后重新选择。');
   if(list.episodeId!==e.id)return fail(400,'该分镜表不属于本集。');
   if(list.sourceRevisionId!==e.acceptedRevisionId||e.needsReview)return fail(409,'只能采用基于本集当前定稿的分镜表；请先采用并复核这一版剧本。');
   store.update('episodes',{...e,productionShotListId:list.id});return store.bundle(e.projectId);
  }
  if(a==='shot-lists'&&target&&action==='edit'&&method==='POST'){
   const old=store.get('shot_lists',target)??fail(404,'找不到分镜表。'),r=revision(old.sourceRevisionId),e=episode(r.episodeId),p=project(e.projectId);
   const voiceLanguages=p.voiceLanguages??[scriptLanguage(r)];
   let content,adaptations;
   try{content=parseShotList({cast:body.cast,shots:body.shots},r);adaptations=parseAdaptationBinding(body.adaptations,r,store.all('localizations'),voiceLanguages);}
   catch(error){return fail(400,error instanceof Error?error.message:'分镜表格式无效。');}
   return store.insert('shot_lists',{...content,id:id(),episodeId:e.id,sourceRevisionId:r.id,parentId:old.id,aspectRatio:old.aspectRatio,voiceLanguages,adaptations,mode:'manual',createdAt:now()});
  }
  if(a==='localizations'&&target&&action==='edit'&&method==='POST'){
   const l=store.get('localizations',target)??fail(404,'找不到语言版本。'),r=revision(l.sourceRevisionId);
   let output;try{output=alignLocalization(r,parseScript(JSON.stringify(body)));if(isShortDrama(r.context.brief))requireLineAlignment(r,output);}catch(error){return fail(400,error instanceof Error?error.message:'语言版本格式无效。');}
   return store.insert('localizations',{...l,...output,id:id(),parentId:l.id,mode:'manual',createdAt:now()});
  }
  if(a==='reviews'&&target&&action==='verify'&&method==='POST'){
   if(body.mode!=='live')return fail(400,'核实已有审稿需要真实模型。');
   const old=store.get('reviews',target)??fail(404,'找不到原始审稿。'),r=revision(old.revisionId),e=episode(r.episodeId);
   return model(e,body,{kind:'review',reviewPass:'verification',draftReview:old,context:r.context,revision:r,episodeTitle:e.title},(_raw,mode,_causality,verification)=>{
    const verified=verification??failedReviewVerification();
    // Recompute base status; a previously failed verification must not permanently poison a fresh check.
    const base=parseReview(JSON.stringify({assessments:old.assessments}),r,old.causality);
    // Discarded invalid rows cannot be reconstructed from the parsed list. Preserve their errors.
    base.errors=[...new Set([...base.errors,...old.errors])];
    if(base.errors.length)base.status='needs_review';
    return store.insert('reviews',{...base,id:id(),revisionId:r.id,verificationOfReviewId:old.id,verification:verified,status:base.status==='completed'&&verified.status==='completed'?'completed':'needs_review',mode,createdAt:now()});
   });
  }
  if(a==='revisions'&&target&&method==='POST'){
   const r=revision(target),e=episode(r.episodeId);
   if(action==='shot-lists'){
    const voiceLanguages=project(e.projectId).voiceLanguages??[scriptLanguage(r)];
    return model(e,body,{kind:'storyboard',context:r.context,revision:r,episodeTitle:e.title},(raw,mode)=>{
     let content;try{content=parseShotListOutput(raw,r);}catch(error){throw new HttpError(502,`分镜表未通过校验：${error instanceof Error?error.message:''}原稿已保留。`);}
     const adaptations=Object.fromEntries(Object.entries(newestAlignedAdaptations(r,store.all('localizations'),voiceLanguages)).map(([language,l])=>[language,l.id]));
     return store.insert('shot_lists',{...content,id:id(),episodeId:e.id,sourceRevisionId:r.id,parentId:null,aspectRatio:aspectRatioOf(r.context.brief),voiceLanguages,adaptations,mode,createdAt:now()});
    });
   }
   if(action==='localize'){
    const language=validLanguage(body.language);
    if(language===scriptLanguage(r))return fail(400,'原稿已经是此语言，请选择其他语言。');
    return model(e,body,{kind:'localize',context:r.context,revision:r,episodeTitle:e.title,targetLanguage:language},(raw,mode)=>{
     const output=alignLocalization(r,parseScript(raw));
     if(isShortDrama(r.context.brief)){
      try{requireLineAlignment(r,output);}catch(error){throw new HttpError(502,`改编未逐行对齐：${error instanceof Error?error.message:''}原稿已保留，请重试或手动修改译稿。`);}
     }
     return store.insert('localizations',{...output,id:id(),sourceRevisionId:r.id,language,parentId:null,mode,glossary:r.context.brief.glossary??'',createdAt:now()});
    });
   }
   if(action==='review')return model(e,body,{kind:'review',context:r.context,revision:r,episodeTitle:e.title},(raw,mode,causality,verification)=>{
    const base=parseReview(raw,r,causality),verified=mode==='live'?(verification??failedReviewVerification()):undefined;
    return store.insert('reviews',{id:id(),revisionId:r.id,...base,...(verified?{verification:verified,status:base.status==='completed'&&verified.status==='completed'?'completed' as const:'needs_review' as const}:{}),mode,createdAt:now()});
   });
   if(action==='rewrite'){
    const sceneId=str(body.sceneId,'场景 ID',100), instruction=str(body.instruction,'修改要求',8000),scene=r.scenes.find(s=>s.id===sceneId);
    if(!scene)return fail(404,'找不到选中的场景。');if(scene.locked)return fail(409,'该场景已锁定，请先解锁。');
    let reviewSource:import('../types').ReviewSuggestionSource|undefined;
    if(body.reviewSource!==undefined){
     const source=obj(body.reviewSource);reviewSource={reviewId:str(source.reviewId,'审稿 ID',100),targetId:str(source.targetId,'审稿项目',200)};
     const current=store.all('reviews').filter(review=>review.revisionId===r.id).at(-1);
     const allowed=reviewSuggestion(current,reviewSource.reviewId,reviewSource.targetId,sceneId);
     if(!allowed||allowed.instruction!==instruction)return fail(409,'该审稿建议尚未核实或已失效，未调用改稿模型。请刷新后重新选择，或自行编辑修改意图。');
    }
    return model(e,body,{kind:'rewrite',context:r.context,revision:r,sceneId,instruction,episodeTitle:e.title},(raw,mode)=>saveRevision(e,{...applySceneRewrite(r,sceneId,raw),language:scriptLanguage(r),parentId:r.id,kind:'rewrite',context:r.context,instruction,mode,...(reviewSource?{reviewSource}:{})}));
   }
   if(action==='edit'){
    const output=parseScript(JSON.stringify(body));
    for(const locked of r.scenes.filter(s=>s.locked)){
     const candidate=output.scenes.find(s=>s.id===locked.id);
     if(!candidate||candidate.heading!==locked.heading||candidate.content!==locked.content||!candidate.locked||output.scenes.indexOf(candidate)!==r.scenes.indexOf(locked))return fail(409,'锁定场景不可修改或移动，请先单独解锁。');
    }
    for(const scene of output.scenes){const old=r.scenes.find(s=>s.id===scene.id);if(scene.locked!==(old?.locked??false))return fail(400,'请使用锁定操作修改场景保护状态。');}
    return saveRevision(e,{...output,language:scriptLanguage(r),parentId:r.id,kind:'manual',context:r.context,instruction:'作者编辑',mode:'manual'});
   }
   if(action==='locks'){
    const sid=str(body.sceneId,'场景 ID',100);if(typeof body.locked!=='boolean')return fail(400,'锁定状态无效。');if(!r.scenes.some(s=>s.id===sid))return fail(404,'场景不存在。');
    return saveRevision(e,{title:r.title,logline:r.logline,scenes:r.scenes.map(s=>s.id===sid?{...s,locked:body.locked as boolean}:s),language:scriptLanguage(r),parentId:r.id,kind:'manual',context:r.context,instruction:body.locked?'锁定场景':'解锁场景',mode:r.mode});
   }
  }
  if(a==='media'&&target&&action==='delete'&&method==='POST'){
   const asset=store.get('media_assets',target)??fail(404,'找不到这个文件。'),reason=production.mediaInUse(asset)??cuts.mediaInUse(asset);
   if(reason)return fail(409,`不能删除：${reason}`);
   media.delete(asset);return store.bundle(asset.projectId);
  }
  const handled=await production.post(method,a,target,action,body)??sessions.post(method,a,target,action,body,url.origin)??await cuts.post(method,a,target,action,body);if(handled!==undefined)return handled;
  return fail(404,'未找到接口。');
 }
 const securityHeaders={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
 /** Session tokens go to the session API; worker tokens keep the v1 worker API. */
 const workerRoute=(req:Request,url:URL)=>Sessions.handles(req)?sessions.worker(req,url):production.worker(req,url);
 /** A listener that answers only the worker API, so a tunnel to it exposes nothing else of this Sci-epo. */
 async function worker(req:Request):Promise<Response>{
  const url=new URL(req.url);
  try{
   // Workers never send Origin; a browser page that tries to call this listener does.
   if(!url.pathname.startsWith('/api/worker/v1/')||req.headers.get('origin'))return Response.json({error:'未找到接口。'},{status:404,headers:securityHeaders});
   const response=await workerRoute(req,url);
   for(const [k,v]of Object.entries(securityHeaders))response.headers.set(k,v);
   return response;
  }catch(error){const known=error instanceof HttpError;return Response.json({error:known?error.message:'请求失败。'},{status:known?error.status:500,headers:securityHeaders});}
 }
 const appFetch=async function fetch(req:Request):Promise<Response>{
  const url=new URL(req.url);
  const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
  try{
   if(auth?url.host!==new URL(auth.origin).host:!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return fail(403,'请求域名不正确。');
   const write=!['GET','HEAD'].includes(req.method),origin=req.headers.get('origin'),expectedOrigin=auth?.origin??url.origin;
   // Workers authenticate with a bearer token, not a cookie, so their writes carry no Origin and need no CSRF token.
   // A browser still sends Origin, and a foreign one is refused everywhere.
   const workerPath=url.pathname.startsWith('/api/worker/v1/');
   if((origin&&origin!==expectedOrigin)||(auth&&write&&!workerPath&&origin!==expectedOrigin))return fail(403,'不接受跨站请求。');
   let response:Response;
   if(url.pathname==='/api/auth/session'&&req.method==='GET'){
    const session=auth?.session(req);response=auth?(session?Response.json({email:session.email,csrf:session.csrf}):Response.json({error:'请先登录创作空间。'},{status:401})):Response.json({email:null,csrf:''});
   }
   else if(auth&&url.pathname==='/api/auth/login'&&req.method==='POST')response=await auth.login(req,req.headers.get('x-real-ip')??'local');
   else if(auth&&url.pathname==='/api/auth/logout'&&req.method==='POST')response=auth.logout(req);
   else if(workerPath)response=await workerRoute(req,url);
   else if(url.pathname.startsWith('/api/')){auth?.require(req,write);const result=await api(req,url);response=result instanceof Response?result:Response.json(result);}
   else {
    const paths:Record<string,string>={'/':'web/index.html','/app.js':'dist/app.js','/style.css':'web/style.css'};
    const path=paths[url.pathname];if(!path||req.method!=='GET')return fail(404,'页面不存在。');
    response=new Response(Bun.file(`${root}/${path}`));
   }
   for(const [k,v]of Object.entries(headers))response.headers.set(k,v);
   return response;
  }catch(error){const known=error instanceof HttpError||error instanceof AuthError||error instanceof ProviderAdminError;return Response.json({error:known?error.message:'请求失败，已有内容已保留。'},{status:known?error.status:500,headers});}
 };
 return Object.assign(appFetch,{worker,cuts});
}
