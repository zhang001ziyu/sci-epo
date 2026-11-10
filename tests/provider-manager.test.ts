import {neutralProofs} from './inference-fixtures';
import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store';
import { ProviderManager, providerKey } from '../src/server/providerManager';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
import { auditBatches, verificationFieldTargets } from '../src/core/reviewVerification';
import { snapshotContext } from '../src/core';
import { CREATIVE_ROLES, type ProviderCatalog } from '../src/providerTypes';
import { DIMENSIONS, type ProjectBundle, type Revision, type Review } from '../src/types';
import { ProviderPanel } from '../web/providers';

const stores:Store[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const originalKey='not-a-real-key-for-provider-tests';
const env={SCIEPO_MODEL_PROVIDER:'openai',SCIEPO_MODEL_ID:'initial-model',SCIEPO_MODEL_BASE_URL:'https://provider.example.test/v1',SCIEPO_MODEL_API_KEY:originalKey,SCIEPO_MODEL_SOURCE_PLAN_ID:'personal-test',SCIEPO_MODEL_SOURCE_PLAN_VERSION:'9',SCIEPO_MODEL_MAX_OUTPUT:'65536',SCIEPO_MODEL_TIMEOUT_MS:'1200000'};
const brief={title:'A repair',premise:'A person fixes a door.',characters:'Lin is a mechanic.',worldRules:'No magic.',authorRules:'Keep it simple.',language:'en'};
const context=snapshotContext(brief,[]);
const script={title:'The Door',logline:'A small fix.',scenes:[{id:'s1',heading:'INT. ROOM - NIGHT',content:'Lin closes the door.',locked:false}]};
function harness(fetcher?:typeof fetch,path?:string){
  const store=new Store(path);stores.push(store);
  const requests:{url:string;body:any;headers:Headers}[]=[];
  const fetchImpl=fetcher??(async(url:any,init:any)=>{requests.push({url:String(url),body:JSON.parse(init.body),headers:new Headers(init.headers)});return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.parse(init.body).response_format?'{}':'OK'}}]});}) as typeof fetch;
  const key=randomBytes(32),manager=new ProviderManager(store.db,key,fetchImpl);
  return {store,manager,key,requests};
}
const connection=(id='extra')=>({id,expectedRevision:0,enabled:true,config:{name:'Extra service',baseUrl:'https://extra.example.test/v1',protocol:'chat_completions'},apiKey:'new-test-key'});
const model=(id:string,connectionId='extra')=>({id,expectedRevision:0,enabled:true,config:{name:id,connectionId,connectionRevision:1,modelId:id,reasoningEffort:'omit',maxOutput:2048,timeoutMs:30000}});

test('one-time migration encrypts credentials, deduplicates roles and never overwrites managed changes',()=>{
 const h=harness();h.manager.importEnvironment(env);const c=h.manager.catalog();
 expect(c.connections).toHaveLength(1);expect(c.models).toHaveLength(1);expect(c.routing.version).toBe(1);
 expect(c.models[0]!.config.maxOutput).toBe(65536);expect(c.models[0]!.config.timeoutMs).toBe(1200000);
 expect(JSON.stringify(c)).not.toContain(originalKey);expect(JSON.stringify(c)).not.toContain('secret');
 expect(JSON.stringify(h.store.db.query('SELECT * FROM model_revisions').all())).not.toContain(originalKey);
 h.manager.importEnvironment({...env,SCIEPO_MODEL_ID:'should-not-reimport'});expect(h.manager.catalog()).toEqual(c);
 const reopened=new ProviderManager(h.store.db,h.key);expect(reopened.catalog()).toEqual(c);expect(reopened.ready()).toBe(true);
});
test('connection edits are CAS protected, keys stay private, address changes require the new key',async()=>{
 const h=harness();h.manager.saveConnection(connection());
 const update={...connection(),expectedRevision:1,apiKey:'',config:{...connection().config,name:'Renamed'}};
 h.manager.saveConnection(update);
 expect(()=>h.manager.saveConnection(update)).toThrow('其他页面');
 expect(()=>h.manager.saveConnection({...update,expectedRevision:2,config:{...update.config,baseUrl:'https://different.example.test/v1'}})).toThrow('重新输入');
 for(const baseUrl of ['http://localhost:1234','https://user:pass@example.test','https://example.test/v1?key=private'])expect(()=>h.manager.saveConnection({...connection('bad'),config:{...connection().config,baseUrl}})).toThrow();
 h.manager.saveModel({...model('check'),config:{...model('check').config,connectionRevision:2}});
 expect(h.manager.catalog().connections[0]!.config.name).toBe('Renamed');
 await h.manager.test({id:'check',revision:1});expect(h.requests.at(-1)!.headers.get('authorization')).toBe('Bearer new-test-key');
});
test('models need tested revisions, roles choose distinct wires, saves do not alter a captured route',async()=>{
 const h=harness();h.manager.saveConnection(connection());
 const roles={} as Record<string,{id:string;revision:number}>;
 for(const role of CREATIVE_ROLES){h.manager.saveModel(model(role));roles[role]={id:role,revision:1};}
 expect(()=>h.manager.publish({expectedVersion:0,roles})).toThrow('连接测试');
 for(const role of CREATIVE_ROLES)await h.manager.test(roles[role]);
 h.manager.publish({expectedVersion:0,roles});expect(h.manager.ready()).toBe(true);
 h.requests.length=0;
 for(const kind of ['generate','review','rewrite','localize'] as const)await h.manager.resolve(kind).provider.complete({kind,context,episodeTitle:'Pilot',...(kind==='generate'?{}:{revision:{...script,id:'r',episodeId:'e',parentId:null,kind:'generated',context,instruction:'',mode:'live',createdAt:''}}),sceneId:'s1',instruction:'Be brief',targetLanguage:'zh-CN'});
 expect(h.requests.map(r=>r.body.model)).toEqual(['writing','quality','revision','revision']);
 expect(h.requests.every(r=>r.headers.get('authorization')==='Bearer new-test-key')).toBe(true);
 const captured=h.manager.resolve('review');
 h.manager.saveModel({...model('quality'),expectedRevision:1,config:{...model('quality').config,modelId:'quality-v2'}});
 await h.manager.test({id:'quality',revision:2});
 h.manager.publish({expectedVersion:1,roles:{...roles,quality:{id:'quality',revision:2}}});
 await captured.provider.complete({kind:'generate',context,episodeTitle:'frozen'});
 expect(h.requests.at(-1)!.body.model).toBe('quality');expect(captured.snapshot.routingVersion).toBe(1);
 expect(h.manager.resolve('review').snapshot.modelId).toBe('quality-v2');
 expect(()=>h.manager.publish({expectedVersion:1,roles})).toThrow('分配已变化');
 expect(()=>h.manager.saveModel({...model('quality'),expectedRevision:2,enabled:false})).toThrow('先切换');
 expect(()=>h.manager.saveConnection({...connection(),expectedRevision:1,enabled:false})).toThrow('先切换');
});
test('credential ciphertext cannot be transplanted across revisions or decrypted with another key',()=>{
 const h=harness();h.manager.importEnvironment(env);const c=h.manager.catalog().connections[0]!;
 h.manager.saveConnection({id:c.id,expectedRevision:1,enabled:true,config:{...c.config,name:'updated'}});
 const row=h.store.db.query<{secret:string},[]>('SELECT secret FROM model_revisions WHERE secret IS NOT NULL ORDER BY revision DESC LIMIT 1').get()!;
 h.store.db.run("UPDATE model_revisions SET secret=? WHERE kind='connection' AND revision=1",[row.secret]);
 expect(()=>h.manager.resolve('generate')).toThrow('无法读取');
 expect(new ProviderManager(h.store.db,randomBytes(32)).ready()).toBe(false);
 const dir=mkdtempSync(join(tmpdir(),'sciepo-key-'));dirs.push(dir);const path=join(dir,'provider.key');
 expect(()=>providerKey(path,true)).toThrow('缺失');const key=providerKey(path,false);expect(readFileSync(path).equals(key)).toBe(true);expect(providerKey(path,true)).toEqual(key);
});
test('failed or interrupted model tests keep static safe results and cannot qualify a new model',async()=>{
 const h=harness((async()=>Response.json({error:'credential '+originalKey},{status:401})) as unknown as typeof fetch);
 h.manager.saveConnection(connection());h.manager.saveModel(model('broken'));await h.manager.test({id:'broken',revision:1});
 const c=h.manager.catalog();expect(c.models[0]!.qualified).toBe(false);expect(c.models[0]!.validation?.status).toBe('failed');expect(JSON.stringify(c)).not.toContain(originalKey);expect(c.models[0]!.validation?.message).toContain('HTTP 401');
 expect(()=>h.manager.publish({expectedVersion:0,roles:Object.fromEntries(CREATIVE_ROLES.map(r=>[r,{id:'broken',revision:1}]))})).toThrow('连接测试');
 h.store.db.run("UPDATE model_validations SET data=json_set(data,'$.status','running')");
 expect(new ProviderManager(h.store.db,h.key).catalog().models[0]!.validation?.status).toBe('failed');
});
test('owner APIs reject anonymous, cross-site and missing CSRF requests; catalog and errors never echo a key',async()=>{
 const h=harness();h.manager.importEnvironment(env);const origin='https://sci.example.test';
 const app=createApp(h.store,{managed:h.manager,demo:demoProvider},process.cwd(),{publicOrigin:origin});
 h.store.db.run('INSERT INTO auth_users VALUES(?,?)',['owner@example.test',await Bun.password.hash('test-only-password',{algorithm:'argon2id',memoryCost:1024,timeCost:1})]);
 const call=(path:string,body?:unknown,headers:Record<string,string>={})=>app(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 expect((await call('/api/providers')).status).toBe(401);
 const login=await call('/api/auth/login',{email:'owner@example.test',password:'test-only-password'}),session=await login.json();
 const cookie=login.headers.get('set-cookie')!;
 expect((await call('/api/providers/connections',connection(),{cookie})).status).toBe(403);
 expect((await call('/api/providers/connections',connection(),{cookie,'x-csrf-token':session.csrf,origin:'https://evil.test'})).status).toBe(403);
 const response=await call('/api/providers',undefined,{cookie});expect(response.status).toBe(200);expect(await response.text()).not.toContain(originalKey);
 const saved=await call('/api/providers/connections',connection(),{cookie,'x-csrf-token':session.csrf});expect(saved.status).toBe(200);expect(await saved.text()).not.toContain('new-test-key');
 const status=await call('/api/status',undefined,{cookie});expect(Object.keys(await status.json()).sort()).toEqual(['management','mode','modelLabel']);
});
test('all four review passes keep one captured model and isolate source-only facts when another tab publishes',async()=>{
 let manager:ProviderManager;const wires:string[]=[],payloads:any[]=[];
 const h=harness((async(_url:any,init:any)=>{
   const b=JSON.parse(init.body),payload=JSON.parse(b.messages.at(-1).content);wires.push(b.model);payloads.push(payload);
   if(wires.length===1){const c=manager.catalog();manager.publish({expectedVersion:c.routing.version,roles:{...c.routing.roles,quality:c.routing.roles!.revision}});}
   let content:string;
   if(wires.length===1)content=JSON.stringify({checks:[{sceneId:'s1',state:'At door',choice:'Close door',obstacleKind:'none',alternative:'Leave it open',verdict:'not_applicable',explanation:'No barrier claimed.',evidence:[{sourceId:'scene:s1',sourceQuote:'Lin closes the door.',sceneId:'s1',draftQuote:'Lin closes the door.'}],constraintEvidence:[]}],pressures:[]});
   else if(wires.length===2)content=JSON.stringify({assessments:DIMENSIONS.map(dimension=>({dimension,status:'no_issue',explanation:'Checked',evidence:[{sourceId:'authorRules',sourceQuote:'Keep it simple.',sceneId:'s1',draftQuote:'Lin closes the door.'}]}))});
   else if(wires.length===3){
    expect(payload.targets).toBeUndefined();expect(payload.draftReview).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('No barrier claimed.');
    content=JSON.stringify({timelineFacts:payload.timelineTargets.map((t:{id:string;sourceId:string;quote:string})=>({targetId:t.id,meaning:{subject:'Test actor',activity:'Cited activity',durationKind:'Cited temporal statement',clock:'Source clock',basis:'Exact source quotation'},status:'consistent',explanation:'Verified temporal statement.',evidence:[{sourceId:t.sourceId,quote:t.quote}]})),omissions:['timeline','accounting','agency','continuity','other'].map(category=>({category,status:'no_issue',explanation:'Verified source-only facts.',sceneIds:['s1'],evidence:[{sourceId:'scene:s1',quote:'Lin closes the door.'}]}))});
   }else {
    // The live provider sometimes omits this optional empty array on supported rows.
    const check=(t:{id:string})=>({targetId:t.id,verdict:'supported',explanation:'Audited against the source.',evidence:[{sourceId:'scene:s1',quote:'Lin closes the door.'}]});
    content=JSON.stringify({inferenceProofs:neutralProofs(payload.inferenceTargets),checks:payload.targets.map(check),fieldChecks:payload.fieldTargets.map(check)});
   }
   return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
 }) as typeof fetch);manager=h.manager;manager.importEnvironment({...env,SCIEPO_MODEL_REVISION_ENABLED:'true',SCIEPO_MODEL_REVISION_ID:'second-model'});
 const app=createApp(h.store,{managed:manager,demo:demoProvider});
 const call=async<T>(path:string,body:unknown):Promise<T>=>{const r=await app(new Request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));expect(r.status).toBe(200);return r.json();};
 const p=await call<ProjectBundle>('/api/projects',brief);const r:Revision={...script,scenes:script.scenes.map(s=>({...s,content:s.content+'\nTwo hours later, Lin checks the latch.'})),id:'original',episodeId:p.episodes[0]!.id,parentId:null,kind:'generated',context,instruction:'',mode:'live',createdAt:''};h.store.insert('revisions',r);
 const result=await call<Review>('/api/revisions/original/review',{mode:'live'});
 expect(result.errors).toEqual([]);expect(result.verification?.status).toBe('completed');
 expect(result.verification?.audit?.status).toBe('completed');
 expect(result.verification?.audit?.schemaVersion).toBe(5);
 expect(wires).toHaveLength(3+auditBatches(result,result.verification!).length);expect(wires.every(model=>model==='initial-model')).toBe(true);
 expect(payloads.slice(3).flatMap(p=>p.targets).map((t:{id:string})=>t.id)).toEqual([...DIMENSIONS.map(d=>`assessment:${d}`),'causal:0','timeline:s1:2',...['timeline','accounting','agency','continuity','other'].map(c=>`omission:${c}`)]);
 expect(payloads.slice(3).flatMap(p=>p.fieldTargets).map((t:{id:string})=>t.id)).toEqual([...DIMENSIONS.map(d=>`assessment:${d}#explanation`),...['state','choice','alternative','explanation'].map(field=>`causal:0#${field}`),...['subject','activity','durationKind','clock','basis'].map(field=>`timeline:s1:2#meaning.${field}`),'timeline:s1:2#explanation',...['timeline','accounting','agency','continuity','other'].map(c=>`omission:${c}#explanation`)]);
 expect(payloads.slice(3).flatMap(p=>p.fieldTargets).find((t:{id:string})=>t.id==='causal:0#explanation').claim).toBe('No barrier claimed.');
 expect(result.verification?.audit?.fieldChecks).toHaveLength(verificationFieldTargets(result,result.verification).length);
 expect(result.verification?.audit?.fieldChecks?.every(c=>Array.isArray(c.counterEvidence)&&c.counterEvidence.length===0)).toBe(true);
 expect(result.verification?.audit?.originalChecks).toEqual(result.verification?.audit?.checks);
 expect(result.verification?.timelineFacts[0]?.boundSource).toEqual({sourceId:'scene:s1',quote:'Two hours later, Lin checks the latch.'});
 expect(JSON.stringify(payloads.slice(3))).toContain('Verified source-only facts.');
 const run=h.store.all('runs')[0]!;expect(run.modelSnapshot?.routingVersion).toBe(1);expect(manager.routing().version).toBe(2);expect(manager.resolve('review').snapshot.modelId).toBe('second-model');expect(run.status).toBe('succeeded');expect(JSON.stringify(run)).not.toContain(originalKey);
});
test('provider UI renders escaped data and independent role choices without credential fields in the catalog',()=>{
 const h=harness();h.manager.importEnvironment(env);const c=h.manager.catalog();c.models[0]!.config.name='<script>bad()</script>';
 const panel=new ProviderPanel({api:async()=>{throw new Error();},run:async()=>{},render:()=>{},refreshStatus:async()=>{}});panel.set(c);
 const roles=panel.view(false);for(const r of CREATIVE_ROLES)expect(roles).toContain(`name="role-${r}"`);
 expect(roles).not.toContain('<script>');expect(roles).toContain('&lt;script&gt;');
 panel.connection=c.connections[0]!;const form=panel.view(false);expect(form).toContain('type="password" value=""');expect(form).not.toContain(originalKey);
 panel.connection=null;panel.section='models';expect(panel.view(false)).toContain('测试连接');
});

test('discarding role edits restores the saved selection; dismissing the prompt keeps the draft',()=>{
 const h=harness();h.manager.importEnvironment({...env,SCIEPO_MODEL_QUALITY_ENABLED:'true',SCIEPO_MODEL_QUALITY_ID:'review-model'});
 const c=h.manager.catalog(),panel=new ProviderPanel({api:async()=>{throw new Error();},run:async()=>{},render:()=>{},refreshStatus:async()=>{}});panel.set(c);
 const saved=panel.routes.quality!;
 panel.input({name:'role-quality',value:panel.routes.writing,closest:()=>true} as unknown as HTMLSelectElement);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let discard=false;
 Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm:()=>discard}});
 try {
   panel.click('provider-section','models');expect(panel.section).toBe('roles');expect(panel.changed).toBe(true);expect(panel.routes.quality).toBe(panel.routes.writing);
   discard=true;panel.click('provider-section','models');panel.click('provider-section','roles');
   expect(panel.changed).toBe(false);expect(panel.routes.quality).toBe(saved);expect(h.manager.routing()).toEqual(c.routing);
 } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('an unused model can be disabled after its service; enabling still requires an enabled current service',async()=>{
 const h=harness();h.manager.saveConnection(connection());h.manager.saveModel(model('unused'));await h.manager.test({id:'unused',revision:1});
 h.manager.saveConnection({...connection(),expectedRevision:1,enabled:false,apiKey:''});
 const update={...model('unused'),expectedRevision:1,enabled:false,config:{...model('unused').config,connectionRevision:2}};
 h.manager.saveModel(update);
 expect(h.manager.catalog().models[0]!.enabled).toBe(false);
 expect(()=>h.manager.saveModel({...update,expectedRevision:2,enabled:true})).toThrow('停用');
 expect(()=>h.manager.saveModel({...update,expectedRevision:2,config:{...update.config,connectionRevision:1}})).toThrow('更新');
 h.manager.saveConnection({...connection(),expectedRevision:2,apiKey:''});
 h.manager.saveModel({...update,expectedRevision:2,enabled:true,config:{...update.config,connectionRevision:3}});
 expect(h.manager.catalog().models[0]!.enabled).toBe(true);expect(h.manager.catalog().models[0]!.qualified).toBe(false);
});

test('a disabled service removes its models from role choices and testing but remains visible in their editor',async()=>{
 const h=harness();h.manager.importEnvironment(env);h.manager.saveConnection(connection());h.manager.saveModel(model('unused'));await h.manager.test({id:'unused',revision:1});
 h.manager.saveConnection({...connection(),expectedRevision:1,enabled:false,apiKey:''});
 const c=h.manager.catalog(),panel=new ProviderPanel({api:async()=>{throw new Error();},run:async()=>{},render:()=>{},refreshStatus:async()=>{}});panel.set(c);
 expect(panel.view(false)).not.toContain('value="unused@1"');
 panel.section='models';expect(panel.view(false)).toContain('data-action="provider-test" data-id="unused" disabled');
 panel.click('provider-edit-model','unused');expect(panel.view(false)).toContain('<option value="extra" selected>Extra service · v2 · 已停用</option>');
 expect(panel.model!.config.connectionRevision).toBe(2);
 expect(()=>h.manager.publish({expectedVersion:1,roles:{...c.routing.roles,quality:{id:'unused',revision:1}}})).toThrow('停用');
});
