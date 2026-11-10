import {expect,test} from 'bun:test';
import type {ModelAttempt,ProjectBundle,Run} from '../src/types';
import {snapshotContext} from '../src/core';
import {modelAttemptsView} from '../web/modelAttempts';

const time='2026-11-07T00:00:00Z';
const attempt=(change:Partial<ModelAttempt>={}):ModelAttempt=>({callId:1,sequence:1,stage:'verification',batch:3,targetIds:['causal:0#explanation'],attempt:1,status:'failed',errorCode:'invalid_json',startedAt:time,finishedAt:time,elapsedMs:1250,...change});
const recovered=()=>[attempt({retryScheduled:true}),attempt({attempt:2,sequence:2,status:'succeeded',errorCode:undefined,elapsedMs:2400})];

test('legacy, ordinary success and non-format failures do not acquire a format retry notice',()=>{
 expect(modelAttemptsView(undefined)).toBe('');expect(modelAttemptsView({})).toBe('');
 expect(modelAttemptsView({modelAttempts:[]})).toBe('');
 expect(modelAttemptsView({modelAttempts:[attempt({status:'succeeded',errorCode:undefined})]})).toBe('');
 expect(modelAttemptsView({modelAttempts:[attempt({errorCode:'upstream_http'})]})).toBe('');
});

test('successful resend retains the format failure and per-request evidence in a closed history',()=>{
 const run={modelAttempts:recovered()},before=JSON.stringify(run),html=modelAttemptsView(run);
 expect(html).toContain('曾格式失败并重发');expect(html).toContain('invalid_json');
 expect(html).toContain('请求序号 1');expect(html).toContain('请求序号 2');
 expect(html).toContain('陈述核实');expect(html).toContain('批次 3');expect(html).toContain('causal:0#explanation');
 expect(html).toContain('第 1 次');expect(html).toContain('第 2 次');expect(html).toContain('1.25 秒');expect(html).toContain('2.40 秒');
 expect(html).toContain('<details class="evidence model-attempt-history">');expect(html).not.toContain('<details open');
 expect(html).not.toContain('尚无第二次请求记录');expect(html).not.toContain('语义通过');expect(html).not.toContain('审稿通过');
 expect(JSON.stringify(run)).toBe(before);
});

test('successful audit-format resend keeps the first parser failure visible with folded diagnostics',()=>{
 const validationErrors=['缺少核实项目 causal:0#explanation。','重复核实项目 pressure:0。'];
 const run={status:'succeeded' as const,modelAttempts:[attempt({errorCode:'invalid_audit_format',validationErrors,retryScheduled:true}),attempt({attempt:2,sequence:2,status:'succeeded',errorCode:undefined,elapsedMs:2400})]};
 const before=JSON.stringify(run),html=modelAttemptsView(run);
 expect(html).toContain('曾格式失败并重发');expect(html).toContain('审计格式校验失败');expect(html).toContain('invalid_audit_format');
 expect(html.indexOf('已保留审计格式校验失败记录')).toBeLessThan(html.indexOf('model-attempt-history'));
 expect(html).toContain('<details class="evidence model-attempt-validation-errors"><summary>审计格式校验诊断（2）</summary>');
 for(const error of validationErrors)expect(html).toContain(error);
 expect(html).not.toContain('model-attempt-validation-errors" open');
 expect(html).toContain('第 1 次');expect(html).toContain('第 2 次');expect(html).toContain('已返回');
 expect(html).not.toContain('尚无第二次请求记录');expect(html).not.toContain('语义通过');expect(html).not.toContain('审稿通过');
 expect(html).toContain('内容结论见审稿和候选正文');expect(JSON.stringify(run)).toBe(before);
});

test('audit-format failures disclose stops and pending resends without inventing an actual second attempt',()=>{
 for(const change of [{retryStoppedReason:'run_limit' as const},{retryStoppedReason:'call_limit' as const},{retryStoppedReason:'review_stopped' as const},{retryScheduled:true}]){
  const run={modelAttempts:[attempt({errorCode:'invalid_audit_format',validationErrors:['核实记录结构不完整。'],...change})]},before=JSON.stringify(run),html=modelAttemptsView(run);
  expect(html).toContain('格式失败，未继续重发');expect(html).toContain('审计格式校验失败');
  expect(html).toContain('核实记录结构不完整。');expect(html).not.toContain('曾格式失败并重发');expect(html).not.toContain('第 2 次');
  if(change.retryScheduled)expect(html).toContain('尚无第二次请求记录');
  expect(JSON.stringify(run)).toBe(before);
 }
});

test('a JSON failure followed by an audit-format failure retains both distinct failed attempts',()=>{
 const html=modelAttemptsView({status:'failed',modelAttempts:[attempt({retryScheduled:true}),attempt({attempt:2,sequence:2,errorCode:'invalid_audit_format',validationErrors:['遗漏完整改法检查。'],retryStoppedReason:'call_limit'})]});
 expect(html).toContain('曾格式失败并重发');expect(html).toContain('错误码 invalid_json');expect(html).toContain('错误码 invalid_audit_format');
 expect(html).toContain('审计格式校验失败');expect(html).toContain('遗漏完整改法检查。');
 expect(html).toContain('该请求已达到重发上限');expect(html).not.toContain('已返回');
});

test('audit parser diagnostics are escaped and old or malformed diagnostics do not create empty disclosure blocks',()=>{
 const attack='<img src=x onerror="alert(1)"><script>x</script>&\'';
 const run={modelAttempts:[attempt({errorCode:'invalid_audit_format',validationErrors:[attack]})]},before=JSON.stringify(run),html=modelAttemptsView(run);
 expect(html).not.toContain('<img');expect(html).not.toContain('<script>');expect(html).not.toContain(attack);
 expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');expect(html).toContain('&amp;&#39;');
 expect(html).toContain('<details class="evidence model-attempt-validation-errors">');expect(JSON.stringify(run)).toBe(before);
 for(const validationErrors of [undefined,[],null,'not an array']){
  const item={...attempt({errorCode:'invalid_audit_format'}),validationErrors} as unknown as ModelAttempt;
  const oldHtml=modelAttemptsView({modelAttempts:[item]});
  expect(oldHtml).toContain('审计格式校验失败');expect(oldHtml).not.toContain('model-attempt-validation-errors');
 }
});

test('a failed resend remains visible and does not present response completion as content approval',()=>{
 const html=modelAttemptsView({modelAttempts:[attempt({retryScheduled:true}),attempt({attempt:2,sequence:2,retryStoppedReason:'call_limit'})]});
 expect(html).toContain('曾格式失败并重发');expect(html.match(/错误码 invalid_json/g)).toHaveLength(2);
 expect(html).toContain('该请求已达到重发上限');expect(html).not.toContain('已返回');
 expect(html).toContain('内容结论见审稿和候选正文');
});

test('budget or policy stops never imply that a scheduled second request already happened',()=>{
 for(const [reason,label] of [['run_limit','本次任务已达到重发总上限'],['call_limit','该请求已达到重发上限'],['review_stopped','审稿已停止'],['not_eligible','此错误不适用格式重发']] as const){
  const html=modelAttemptsView({modelAttempts:[attempt({retryStoppedReason:reason})]});
  expect(html).toContain('格式失败，未继续重发');expect(html).toContain(label);expect(html).not.toContain('曾格式失败并重发');
 }
 const pending=modelAttemptsView({modelAttempts:[attempt({retryScheduled:true})]});
 expect(pending).toContain('格式失败，未继续重发');expect(pending).toContain('尚无第二次请求记录');expect(pending).not.toContain('曾格式失败并重发');
});

test('an actual second attempt is disclosed even when the earlier row is absent from older metadata',()=>{
 const html=modelAttemptsView({modelAttempts:[attempt({attempt:2,status:'running',errorCode:undefined,finishedAt:undefined,elapsedMs:undefined})]});
 expect(html).toContain('曾格式失败并重发');expect(html).toContain('处理中');expect(html).toContain('耗时 未记录');
});

test('finished runs do not display an unfinished attempt as still running',()=>{
 for(const status of ['failed','succeeded'] as const){
  const html=modelAttemptsView({status,modelAttempts:[...recovered().slice(0,1),attempt({attempt:2,status:'running',errorCode:undefined,finishedAt:undefined,elapsedMs:undefined})]});
  expect(html).toContain('曾格式失败并重发');expect(html).toContain('未记录完成');expect(html).not.toContain('处理中');
  expect(html).toContain(status==='failed'?'任务已中断':'任务已结束');
 }
});

test('untrusted stage, identifiers, error, timestamps and stop reasons are escaped as text',()=>{
 const attack='<img src=x onerror="alert(1)"><script>x</script>&\'';
 const forged={...attempt({attempt:2}),stage:attack,callId:attack,sequence:attack,batch:attack,targetIds:[attack],errorCode:attack,startedAt:attack,finishedAt:attack,retryStoppedReason:attack,elapsedMs:attack} as unknown as ModelAttempt;
 const html=modelAttemptsView({modelAttempts:[forged]});
 expect(html).not.toContain('<img');expect(html).not.toContain('<script>');expect(html).not.toContain(attack);
 expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');expect(html).toContain('&amp;&#39;');expect(html).toContain('耗时 未记录');
});

test('app binds notices to the selected script, exact review and comparison, while history retains each run',async()=>{
 // The browser entry point has module-level state; isolate it from other app lifecycle tests.
 if(process.env.SCI_EPO_RETRY_UI_CHILD!=='1'){
  const child=Bun.spawn([process.execPath,'test',import.meta.path,'--test-name-pattern','app binds notices'],{env:{...process.env,SCI_EPO_RETRY_UI_CHILD:'1'},stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0)throw new Error(`Isolated retry UI lifecycle failed:\n${out}\n${err}`);
  expect(code).toBe(0);return;
 }
 const brief={title:'Clock farm',premise:'A garden job.',characters:'Two partners.',worldRules:'All clocks can stop.',authorRules:'Keep the source.',language:'en'};
 const original={id:'source',episodeId:'episode',parentId:null,title:'Pilot',logline:'A choice.',scenes:[{id:'s1',heading:'FARM',content:'Bolt closes the box.',locked:false}],context:snapshotContext(brief,[]),kind:'generated' as const,instruction:'',mode:'live' as const,createdAt:time};
 const child={...original,id:'child',parentId:'source',kind:'rewrite' as const,instruction:'Clarify the line.'};
 const review={id:'review-current',revisionId:'child',status:'needs_review' as const,mode:'live' as const,createdAt:time,errors:[],assessments:[]};
 const run=(id:string,kind:Run['kind'],resultId:string|null,marker:string):Run=>({id,kind,resultId,episodeId:'episode',status:'succeeded',mode:'live',error:null,createdAt:time,finishedAt:time,modelAttempts:recovered().map(a=>({...a,stage:kind==='rewrite'?'rewrite':'facts',targetIds:[marker]}))});
 const state:ProjectBundle={project:{...brief,id:'project',createdAt:time,updatedAt:time},episodes:[{id:'episode',projectId:'project',ordinal:1,title:'Pilot',acceptedRevisionId:null,needsReview:false,createdAt:time}],revisions:[original,child],reviews:[{...review,id:'review-old'},review],runs:[run('write-run','rewrite','child','write-current-marker'),run('old-review-run','review','review-old','old-review-marker'),run('review-run','review',review.id,'review-current-marker'),run('unrelated-run','review',null,'unrelated-marker')],localizations:[]};
 const listeners=new Map<string,(event:any)=>void>(),root={innerHTML:'',addEventListener:(name:string,fn:(event:any)=>void)=>listeners.set(name,fn)},nodes=new Map<string,any>();
 const touched=['document','window','location','history','localStorage','requestAnimationFrame','fetch'],descriptors=new Map(touched.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const install=(key:string,value:unknown)=>Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const click=(data:Record<string,string>)=>{const button={dataset:data,disabled:false,closest:()=>button};listeners.get('click')!({target:button});};
 try{
  install('document',{querySelector:(selector:string)=>{if(selector==='#app')return root;if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',hidden:false,disabled:false,focus:()=>{},classList:{toggle:()=>{}}});return nodes.get(selector);},querySelectorAll:()=>[],activeElement:null});
  install('window',{addEventListener:()=>{},confirm:()=>true});install('location',{hash:'',pathname:'/'});install('history',{replaceState:()=>{}});
  install('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});install('requestAnimationFrame',(fn:()=>void)=>{fn();return 0;});
  install('fetch',async(input:string|URL|Request)=>{const url=String(input),body=url==='/api/auth/session'?{email:'owner@example.test',csrf:'test'}:url==='/api/status'?{mode:'live',modelLabel:'Test provider'}:url==='/api/projects'?[state.project]:url==='/api/projects/project'?state:undefined;if(!body)throw new Error('Unexpected request '+url);return Response.json(body);});
  await import(new URL('../web/app.ts?model-attempts-lifecycle-test',import.meta.url).href);
  for(let i=0;i<100&&!root.innerHTML.includes('script-paper');i++)await new Promise(r=>setTimeout(r,0));
  expect(root.innerHTML).toContain('script-paper');expect(root.innerHTML).toContain('write-current-marker');expect(root.innerHTML).not.toContain('review-current-marker');
  click({action:'tab',id:'review'});
  expect(root.innerHTML).toContain('review-current-marker');expect(root.innerHTML).not.toContain('old-review-marker');expect(root.innerHTML).not.toContain('write-current-marker');expect(root.innerHTML).not.toContain('unrelated-marker');
  click({action:'tab',id:'compare'});
  expect(root.innerHTML).toContain('write-current-marker');expect(root.innerHTML).not.toContain('review-current-marker');
  click({action:'tab',id:'history'});
  for(const marker of ['write-current-marker','old-review-marker','review-current-marker','unrelated-marker'])expect(root.innerHTML).toContain(marker);
  click({action:'select-revision',id:'source'});click({action:'tab',id:'script'});
  expect(root.innerHTML).not.toContain('model-attempts');
 }finally{for(const key of touched){const descriptor=descriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
