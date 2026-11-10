/** Adapted from AINovel providerStore/crypto: immutable revisions, CAS, qualified
 * models and frozen routes. Single-owner Sci-epo has no commerce/user plans. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { CREATIVE_ROLES, type ConnectionConfig, type ManagedModelConfig, type ProviderEntity, type ProviderRef, type ProviderRouting, type ProviderCatalog, type ModelValidation, type CreativeRole, type ModelSnapshot, type ManagedModel } from '../providerTypes';
import type { ModelRequest } from '../types';
import { configuredProvider, forRole, loadProviderConfig, ModelError, probeProvider, type ProviderConfig } from './provider';

export class ProviderAdminError extends Error { constructor(public status:number,message:string){super(message);} }
const fail=(status:number,message:string):never=>{throw new ProviderAdminError(status,message);};
const now=()=>new Date().toISOString();
const object=(x:unknown):Record<string,unknown>=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:fail(400,'配置格式无效。');
function text(x:unknown,label:string,max=200):string {if(typeof x!=='string'||!x.trim()||x.length>max||/[\x00-\x1f]/.test(x))return fail(400,`${label}为空或格式无效。`);return x.trim();}
function integer(x:unknown,label:string,min=0,max=1_000_000):number {if(typeof x!=='number'||!Number.isSafeInteger(x)||x<min||x>max)return fail(400,`${label}超出允许范围。`);return x;}
function identifier(x:unknown):string {const id=text(x,'配置 ID',100);if(!/^[a-zA-Z0-9_-]+$/.test(id))return fail(400,'配置 ID 格式无效。');return id;}
function reference(x:unknown):ProviderRef {const r=object(x);return {id:identifier(r.id),revision:integer(r.revision,'版本',1)};}
function enabled(x:unknown):boolean {if(typeof x!=='boolean')return fail(400,'启用状态无效。');return x;}
type Kind='connection'|'model';
type Config=ConnectionConfig|ManagedModelConfig;

export function providerKey(path:string,hasExistingSecrets:boolean):Buffer {
  if(!existsSync(path)) {
    if(hasExistingSecrets)throw new Error('模型凭据保护文件缺失，请从备份恢复。');
    writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});
  }
  const key=readFileSync(path);
  // Windows reports mode 0o666 for every writable file and controls access with NTFS ACLs,
  // so the group/other permission check applies only on POSIX hosts (the deployment target).
  const openToOthers=process.platform!=='win32'&&(statSync(path).mode&0o077)!==0;
  if(key.length!==32||openToOthers)throw new Error('模型凭据保护文件格式或权限无效。');
  return key;
}

export class ProviderManager {
  constructor(private db:Database,private key:Buffer,private fetchImpl:typeof fetch=fetch) {
    if(key.length!==32)throw new Error('模型凭据保护未配置。');
    db.exec(`CREATE TABLE IF NOT EXISTS model_entities(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS model_revisions(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,secret TEXT,created_at TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
      CREATE TABLE IF NOT EXISTS model_validations(id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,qualified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS model_routes(version INTEGER PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    // Constructor is run once at startup; interrupted diagnostics must not look active.
    db.run("UPDATE model_validations SET data=json_set(data,'$.status','failed','$.message','服务重启，连接测试未完成。') WHERE json_extract(data,'$.status')='running'");
  }
  private seal(secret:string,id:string,revision:number):string {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`sciepo-provider-v1:${id}:${revision}`));
    const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),ciphertext].map(x=>x.toString('base64')).join('.');
  }
  private credential(id:string,revision:number):string {
    try {
      const row=this.db.query<{secret:string},[string,number]>("SELECT secret FROM model_revisions WHERE kind='connection' AND id=? AND revision=?").get(id,revision);
      if(!row?.secret)throw new Error();
      const [iv,tag,data]=row.secret.split('.').map(x=>Buffer.from(x,'base64'));
      if(!iv||iv.length!==12||!tag||tag.length!==16||!data)throw new Error();
      const cipher=createDecipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(`sciepo-provider-v1:${id}:${revision}`));cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
    } catch {return fail(503,'服务密钥无法读取，请检查凭据备份。');}
  }
  private get<T extends Config>(kind:Kind,id:string,revision?:number):ProviderEntity<T> {
    const row=this.db.query<{id:string;revision:number;enabled:number;data:string},[string,string,number|null]>(`SELECT e.id,r.revision,e.enabled,r.data FROM model_entities e JOIN model_revisions r ON e.kind=r.kind AND e.id=r.id WHERE e.kind=? AND e.id=? AND r.revision=COALESCE(?,e.revision)`).get(kind,id,revision??null);
    if(!row)return fail(404,'服务、模型或配置版本不存在。');
    return {id:row.id,revision:row.revision,enabled:row.enabled===1,config:JSON.parse(row.data)};
  }
  private save(kind:Kind,id:string,expected:number,config:Config,isEnabled:boolean,secret:string|null=null) {
    const prior=this.db.query<{revision:number},[string,string]>('SELECT revision FROM model_entities WHERE kind=? AND id=?').get(kind,id);
    if((prior?.revision??0)!==expected)return fail(409,'配置已在其他页面修改，请刷新后重新编辑。');
    if(!prior&&this.db.query<{n:number},[]>('SELECT count(*) n FROM model_entities').get()!.n>=200)return fail(400,'配置数量已达上限，请整理已有服务与模型。');
    const revision=expected+1;
    this.db.run('INSERT INTO model_revisions VALUES(?,?,?,?,?,?)',[kind,id,revision,JSON.stringify(config),secret,now()]);
    this.db.run('INSERT INTO model_entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled',[kind,id,revision,Number(isEnabled)]);
    return this.get(kind,id);
  }
  routing():ProviderRouting {
    const row=this.db.query<{version:number;data:string;created_at:string},[]>('SELECT * FROM model_routes ORDER BY version DESC LIMIT 1').get();
    return row?{version:row.version,roles:JSON.parse(row.data),createdAt:row.created_at}:{version:0,roles:null,createdAt:null};
  }
  private used(kind:Kind,id:string):boolean {
    return Object.values(this.routing().roles??{}).some(ref=>kind==='model'?ref.id===id:this.get<ManagedModelConfig>('model',ref.id,ref.revision).config.connectionId===id);
  }
  saveConnection(body:unknown) {
    const b=object(body),id=identifier(b.id),expected=integer(b.expectedRevision,'版本'),c=object(b.config),isEnabled=enabled(b.enabled);
    const name=text(c.name,'服务名称'),baseUrl=text(c.baseUrl,'API 地址',2000),protocol=text(c.protocol,'协议');
    let url:URL;try {url=new URL(baseUrl);} catch {return fail(400,'API 地址无效。');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return fail(400,'API 地址必须是 HTTPS，且不能包含账号、查询参数或片段。');
    if(!['chat_completions','responses','messages','generateContent'].includes(protocol))return fail(400,'不支持此接口协议。');
    const config:ConnectionConfig={name,baseUrl:url.href.replace(/\/+$/,''),protocol:protocol as ConnectionConfig['protocol']};
    return this.db.transaction(()=>{
      if(!isEnabled&&this.used('connection',id))return fail(409,'此服务正在用于创作，请先切换角色模型再停用。');
      const prior=expected?this.get<ConnectionConfig>('connection',id):undefined;
      const supplied=b.apiKey;
      if(supplied!==undefined&&typeof supplied!=='string')return fail(400,'API Key 格式无效。');
      if(prior&&(!supplied||!supplied.trim())&&(prior.config.baseUrl!==config.baseUrl||prior.config.protocol!==config.protocol))return fail(400,'修改服务地址或协议时，请重新输入该服务的 API Key。');
      const key=typeof supplied==='string'&&supplied.trim()?supplied.trim():expected?this.credential(id,expected):'';
      if(!key||key.length>8192||/[\x00-\x1f]/.test(key))return fail(400,'请填写有效的 API Key。');
      this.save('connection',id,expected,config,isEnabled,this.seal(key,id,expected+1));
      return this.catalog();
    })();
  }
  saveModel(body:unknown) {
    const b=object(body),id=identifier(b.id),expected=integer(b.expectedRevision,'版本'),c=object(b.config),isEnabled=enabled(b.enabled);
    const config:ManagedModelConfig={name:text(c.name,'模型名称'),connectionId:text(c.connectionId,'服务 ID',100),connectionRevision:integer(c.connectionRevision,'服务版本',1),modelId:text(c.modelId,'供应商模型标识',300),reasoningEffort:text(c.reasoningEffort,'推理设置'),maxOutput:integer(c.maxOutput,'输出 token 上限',256,65536),timeoutMs:integer(c.timeoutMs,'超时毫秒',1000,1200000)};
    return this.db.transaction(()=>{
      const connection=this.get<ConnectionConfig>('connection',config.connectionId);
      if(connection.revision!==config.connectionRevision)return fail(409,'服务已更新，请重新选择当前服务。');
      if(isEnabled&&!connection.enabled)return fail(409,'服务已停用，请先启用服务或选择其他服务。');
      if(!['omit','minimal','low','medium','high','xhigh'].includes(config.reasoningEffort))return fail(400,'推理设置无效。');
      if(isEnabled&&['messages','generateContent'].includes(connection.config.protocol)&&config.reasoningEffort!=='omit')return fail(400,'此协议暂不发送推理参数，请选择跟随服务默认。');
      if(!isEnabled&&this.used('model',id))return fail(409,'此模型正在用于创作，请先切换角色模型再停用。');
      this.save('model',id,expected,config,isEnabled);return this.catalog();
    })();
  }
  private model(ref:ProviderRef):ManagedModel {
    const model=this.get<ManagedModelConfig>('model',ref.id,ref.revision);
    const row=this.db.query<{data:string;qualified:number},[string,number]>('SELECT data,qualified FROM model_validations WHERE id=? AND revision=?').get(ref.id,ref.revision);
    return {...model,validation:row?JSON.parse(row.data):null,qualified:row?.qualified===1};
  }
  catalog():ProviderCatalog {
    const refs=(kind:Kind)=>this.db.query<{id:string;revision:number},[string]>('SELECT id,revision FROM model_entities WHERE kind=? ORDER BY rowid').all(kind);
    const routing=this.routing();
    return {connections:refs('connection').map(r=>({...this.get<ConnectionConfig>('connection',r.id),keyConfigured:true})),models:refs('model').map(r=>this.model(r)),activeModels:Object.values(routing.roles??{}).filter((r,i,a)=>a.findIndex(x=>x.id===r.id&&x.revision===r.revision)===i).map(r=>this.model(r)),routing,source:this.db.query<{value:string},[]>('SELECT value FROM model_metadata WHERE name=\'source\'').get()?.value??null};
  }
  private config(ref:ProviderRef,qualified=false):{config:ProviderConfig;model:ManagedModel;connection:ProviderEntity<ConnectionConfig>} {
    const model=this.model(ref),connection=this.get<ConnectionConfig>('connection',model.config.connectionId,model.config.connectionRevision);
    if(!model.enabled||!connection.enabled)return fail(409,'所选模型或服务已停用，请在模型服务页面调整。');
    if(qualified&&!model.qualified)return fail(409,'请先通过该模型版本的连接测试，再分配给创作角色。');
    return {model,connection,config:{baseUrl:connection.config.baseUrl,protocol:connection.config.protocol,apiKey:this.credential(connection.id,connection.revision),modelId:model.config.modelId,reasoningEffort:model.config.reasoningEffort,maxOutput:model.config.maxOutput,timeoutMs:model.config.timeoutMs}};
  }
  publish(body:unknown) {
    const b=object(body),expected=integer(b.expectedVersion,'分配版本'),rolesObject=object(b.roles);
    const roles=Object.fromEntries(CREATIVE_ROLES.map(role=>[role,reference(rolesObject[role])])) as Record<CreativeRole,ProviderRef>;
    return this.db.transaction(()=>{
      if(this.routing().version!==expected)return fail(409,'角色分配已变化，请刷新后再保存。');
      for(const ref of Object.values(roles))this.config(ref,true);
      this.db.run('INSERT INTO model_routes VALUES(?,?,?)',[expected+1,JSON.stringify(roles),now()]);return this.catalog();
    })();
  }
  ready():boolean {try {const roles=this.routing().roles;return !!roles&&CREATIVE_ROLES.every(role=>{this.config(roles[role],true);return true;});}catch{return false;}}
  resolve(kind:ModelRequest['kind']) {
    // Shot lists use the writing role, so existing published role assignments stay complete.
    const role:CreativeRole=kind==='generate'||kind==='storyboard'?'writing':kind==='review'?'quality':'revision',routing=this.routing();
    if(!routing.roles)return fail(503,'请先在模型服务页面完成角色分配。');
    const ref=routing.roles[role],{config,model,connection}=this.config(ref,true);
    const snapshot:ModelSnapshot={routingVersion:routing.version,role,modelRef:ref,connectionRef:{id:connection.id,revision:connection.revision},modelName:model.config.name,modelId:model.config.modelId,connectionName:connection.config.name,protocol:connection.config.protocol};
    return {provider:configuredProvider(config,this.fetchImpl),snapshot};
  }
  async test(body:unknown) {
    const ref=reference(body),current=this.get<ManagedModelConfig>('model',ref.id);
    if(current.revision!==ref.revision)return fail(409,'模型已更新，请测试最新版本。');
    if(this.db.query("SELECT 1 FROM model_validations WHERE json_extract(data,'$.status')='running'").get())return fail(409,'已有模型连接测试正在运行，请等待完成。');
    const {config}=this.config(ref),prior=this.model(ref).validation;
    if(prior&&Date.now()-Date.parse(prior.testedAt)<10000)return fail(429,'刚完成连接测试，请稍后再试。');
    const record=(status:ModelValidation['status'],message:string)=>{const validation:ModelValidation={status,message,testedAt:now()};this.db.run('INSERT INTO model_validations VALUES(?,?,?,?) ON CONFLICT(id,revision) DO UPDATE SET data=excluded.data,qualified=MAX(model_validations.qualified,excluded.qualified)',[ref.id,ref.revision,JSON.stringify(validation),Number(status==='passed')]);return validation;};
    record('running','正在请求模型。');
    try {await probeProvider(config,this.fetchImpl);record('passed','连接测试通过，模型完整回复 OK。');}
    catch(error){record('failed',error instanceof ModelError?error.message:'模型连接测试未完成。');}
    return this.catalog();
  }
  /** One-time migration of the already authorized runtime configuration. */
  importEnvironment(env:Record<string,string|undefined>):void {
    if(this.db.query('SELECT 1 FROM model_entities LIMIT 1').get()||this.routing().version)return;
    const base=loadProviderConfig(env);if(!base)return;
    this.db.transaction(()=>{
      const connections=new Map<string,ProviderRef>(),models=new Map<string,ProviderRef>(),roles={} as Record<CreativeRole,ProviderRef>;
      for(const role of CREATIVE_ROLES){
        const config=forRole(base,env,role==='writing'?'generate':role==='quality'?'review':'rewrite');
        const ckey=JSON.stringify([config.baseUrl,config.protocol,config.apiKey]);
        let connection=connections.get(ckey);
        if(!connection){const id=crypto.randomUUID();connection={id,revision:1};this.save('connection',id,0,{name:env.SCIEPO_MODEL_SOURCE_PLAN_ID?'AINovel 个人创作服务':'已有模型服务',baseUrl:config.baseUrl,protocol:config.protocol},true,this.seal(config.apiKey,id,1));connections.set(ckey,connection);}
        const mconfig:ManagedModelConfig={name:config.modelId,connectionId:connection.id,connectionRevision:connection.revision,modelId:config.modelId,reasoningEffort:config.reasoningEffort??'omit',maxOutput:config.maxOutput,timeoutMs:config.timeoutMs};
        const mkey=JSON.stringify(mconfig);let model=models.get(mkey);
        if(!model){const id=crypto.randomUUID();model={id,revision:1};this.save('model',id,0,mconfig,true);this.db.run('INSERT INTO model_validations VALUES(?,?,?,1)',[id,1,JSON.stringify({status:'inherited',message:'沿用部署前的运行配置；可主动执行连接测试。',testedAt:now()})]);models.set(mkey,model);}
        roles[role]=model;
      }
      this.db.run('INSERT INTO model_routes VALUES(1,?,?)',[JSON.stringify(roles),now()]);
      this.db.run('INSERT INTO model_metadata VALUES(?,?)',['source',env.SCIEPO_MODEL_SOURCE_PLAN_ID?`AINovel 个人方案 · 发布版本 ${env.SCIEPO_MODEL_SOURCE_PLAN_VERSION??'未知'}`:'已导入原服务端配置']);
    })();
  }
}
