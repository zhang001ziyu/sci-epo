import { CREATIVE_ROLES, type ProviderCatalog, type ProviderRef, type ConnectionConfig, type ManagedModelConfig, type ProviderEntity } from '../src/providerTypes';

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const roleNames={writing:'生成剧本',quality:'审稿',revision:'改稿与语言改编'};
const protocolNames={chat_completions:'OpenAI 兼容 · Chat Completions',responses:'OpenAI 兼容 · Responses',messages:'Anthropic · Messages',generateContent:'Google · Gemini'};
const refValue=(ref:ProviderRef)=>`${ref.id}@${ref.revision}`;
type Hooks={api:<T>(path:string,options?:RequestInit)=>Promise<T>;run:(label:string,fn:()=>Promise<void>)=>Promise<void>;render:()=>void;refreshStatus:()=>Promise<void>};
export class ProviderPanel {
  catalog:ProviderCatalog|null=null;
  section:'roles'|'connections'|'models'='roles';
  connection:ProviderEntity<ConnectionConfig>|null=null;
  model:ProviderEntity<ManagedModelConfig>|null=null;
  routes:Record<string,string>={};
  changed=false;
  message='';
  constructor(private hooks:Hooks){}
  reset(){this.catalog=null;this.connection=null;this.model=null;this.routes={};this.changed=false;this.message='';}
  set(data:ProviderCatalog){this.catalog=data;this.routes=Object.fromEntries(CREATIVE_ROLES.map(role=>[role,data.routing.roles?refValue(data.routing.roles[role]):'']));this.changed=false;}
  async load(){this.set(await this.hooks.api<ProviderCatalog>('/api/providers'));}
  private async save(path:string,body:unknown){const data=await this.hooks.api<ProviderCatalog>('/api/providers/'+path,{method:'POST',body:JSON.stringify(body)});this.set(data);await this.hooks.refreshStatus();}
  canLeave(){return !this.changed||window.confirm('模型配置尚未保存，确定放弃这些编辑吗？');}
  input(target:HTMLInputElement|HTMLSelectElement){
    const field=target.name;
    if(!field||!target.closest('[data-provider-form]'))return false;
    this.changed=true;
    if(field.startsWith('role-'))this.routes[field.slice(5)]=target.value;
    else if(this.connection){
      if(field==='enabled')this.connection.enabled=(target as HTMLInputElement).checked;
      else if(field!=='apiKey')(this.connection.config as unknown as Record<string,string>)[field]=target.value;
    }else if(this.model){
      if(field==='enabled')this.model.enabled=(target as HTMLInputElement).checked;
      else if(field==='connectionId'){this.model.config.connectionId=target.value;this.model.config.connectionRevision=this.catalog!.connections.find(c=>c.id===target.value)?.revision??0;}
      else (this.model.config as unknown as Record<string,string|number>)[field]=['maxOutput','timeoutMs'].includes(field)?Number(target.value):target.value;
    }
    return true;
  }
  submit(form:HTMLFormElement){
    if(!form.hasAttribute('data-provider-form'))return false;
    if(form.id==='provider-connection-form'&&this.connection){
      const draft=structuredClone(this.connection),apiKey=String(new FormData(form).get('apiKey')??'');
      // No API Key is stored in panel state, localStorage, returned HTML or notices.
      void this.hooks.run('正在保存服务连接…',async()=>{await this.save('connections',{id:draft.id,expectedRevision:draft.revision,enabled:draft.enabled,config:draft.config,...(apiKey?{apiKey}:{})});this.connection=null;this.message=draft.enabled?'服务已保存。更新已有服务后，请编辑对应模型并测试，再应用到角色。':'服务已停用，对应模型暂不可用于创作。';});
    }else if(form.id==='provider-model-form'&&this.model){
      const draft=structuredClone(this.model);
      void this.hooks.run('正在保存模型…',async()=>{await this.save('models',{id:draft.id,expectedRevision:draft.revision,enabled:draft.enabled,config:draft.config});this.model=null;this.message=draft.enabled?'模型已保存，请执行连接测试后分配给创作角色。':'模型已停用。启用服务与模型后，测试通过即可重新分配。';});
    }else if(form.id==='provider-roles-form'){
      const roles=Object.fromEntries(CREATIVE_ROLES.map(role=>{const [id,revision]=this.routes[role]!.split('@');return [role,{id,revision:Number(revision)}];}));
      const expectedVersion=this.catalog!.routing.version;
      void this.hooks.run('正在应用角色模型…',async()=>{await this.save('routing',{roles,expectedVersion});this.message='角色模型已生效。新任务使用此分配，正在运行的任务保持原配置。';});
    }
    return true;
  }
  click(action:string,id:string){
    if(!action.startsWith('provider-'))return false;
    if(action==='provider-test'){
      const model=this.catalog!.models.find(m=>m.id===id)!;
      if(this.catalog!.models.some(m=>m.validation?.status==='running'))return true;
      void this.hooks.run('正在测试模型连接（一次真实请求）…',async()=>{await this.save('test',{id,revision:model.revision});const result=this.catalog!.models.find(m=>m.id===id)?.validation;this.message=result?.message??'测试已结束。';});return true;
    }
    if(!this.canLeave())return true;
    this.connection=null;this.model=null;this.changed=false;this.message='';
    if(this.catalog)this.set(this.catalog);
    if(action==='provider-refresh'){void this.hooks.run('正在刷新模型配置…',()=>this.load());return true;}
    if(action==='provider-section')this.section=id as typeof this.section;
    if(action==='provider-new-connection'){this.section='connections';this.connection={id:crypto.randomUUID(),revision:0,enabled:true,config:{name:'',baseUrl:'',protocol:'chat_completions'}};}
    if(action==='provider-edit-connection')this.connection=structuredClone(this.catalog!.connections.find(c=>c.id===id)!);
    if(action==='provider-new-model'){this.section='models';const c=this.catalog!.connections.find(c=>c.enabled);this.model={id:crypto.randomUUID(),revision:0,enabled:true,config:{name:'',connectionId:c?.id??'',connectionRevision:c?.revision??0,modelId:'',reasoningEffort:'omit',maxOutput:8192,timeoutMs:180000}};}
    if(action==='provider-edit-model'){this.model=structuredClone(this.catalog!.models.find(m=>m.id===id)!);this.model.config.connectionRevision=this.catalog!.connections.find(c=>c.id===this.model!.config.connectionId)?.revision??0;}
    this.hooks.render();return true;
  }
  view(busy:boolean){
    const d=busy?'disabled':'',c=this.catalog;
    if(!c)return '<section class="empty-panel">正在读取模型配置…</section>';
    const available=(model:ProviderEntity<ManagedModelConfig>)=>model.enabled&&c.connections.some(conn=>conn.id===model.config.connectionId&&conn.enabled);
    const input=(label:string,name:string,value:unknown,type='text',extra='')=>`<label class="field-label" for="provider-${name}">${label}</label><input id="provider-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra} ${d}/>`;
    const actions=`<div class="modal-actions"><button type="button" class="button subtle" data-action="provider-cancel" ${d}>取消编辑</button><button class="button primary" type="submit" ${d}>保存${this.connection?'服务':'模型'}</button></div>`;
    const toggle=(value:boolean)=>`<label class="check-label"><input type="checkbox" name="enabled" ${value?'checked':''} ${d}/><span>启用</span></label>`;
    let body='';
    if(this.connection){const x=this.connection.config;body=`<form id="provider-connection-form" data-provider-form class="provider-form"><h2>${this.connection.revision?'编辑服务':'添加服务'}</h2>${input('服务名称','name',x.name,'text','required maxlength="200" placeholder="例如：个人创作服务"')}<label class="field-label" for="provider-protocol">接口协议</label><select id="provider-protocol" name="protocol" ${d}>${Object.entries(protocolNames).map(([v,n])=>`<option value="${v}" ${v===x.protocol?'selected':''}>${n}</option>`).join('')}</select>${input('API 根地址','baseUrl',x.baseUrl,'url','required placeholder="https://example.com/v1"')}<p class="small muted">填写服务商给出的根地址，不包含 chat/completions 等请求路径。</p>${input('API Key','apiKey','','password',`autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore ${this.connection.revision?'placeholder="留空保留现有密钥"':'required'}`)}<p class="small muted">密钥加密保存在服务器，不会回显。修改地址或协议时需重新填写密钥。</p>${toggle(this.connection.enabled)}${actions}</form>`;}
    else if(this.model){const x=this.model.config;body=`<form id="provider-model-form" data-provider-form class="provider-form"><h2>${this.model.revision?'编辑模型':'添加模型'}</h2>${input('显示名称','name',x.name,'text','required maxlength="200"')}<label class="field-label" for="provider-connectionId">服务连接</label><select id="provider-connectionId" name="connectionId" required ${d}><option value="">选择服务</option>${c.connections.filter(conn=>conn.enabled||conn.id===x.connectionId).map(conn=>`<option value="${esc(conn.id)}" ${conn.id===x.connectionId?'selected':''}>${esc(conn.config.name)} · v${conn.revision}${conn.enabled?'':' · 已停用'}</option>`).join('')}</select>${input('供应商模型标识','modelId',x.modelId,'text','required maxlength="300" placeholder="填写服务商提供的完整模型 ID"')}<div class="provider-fields">${input('最大输出 tokens','maxOutput',x.maxOutput,'number','min="256" max="65536" required')}${input('请求时限（毫秒）','timeoutMs',x.timeoutMs,'number','min="1000" max="1200000" step="1000" required')}</div><label class="field-label" for="provider-reasoningEffort">推理参数</label><select id="provider-reasoningEffort" name="reasoningEffort" ${d}>${['omit','minimal','low','medium','high','xhigh'].map(v=>`<option value="${v}" ${v===x.reasoningEffort?'selected':''}>${v==='omit'?'跟随服务默认（不发送）':v}</option>`).join('')}</select><p class="small muted">按服务商支持的参数填写。输出预算包含模型所需的生成预算，不等同于剧本词数。</p>${toggle(this.model.enabled)}${actions}</form>`;}
    else if(this.section==='roles'){
      const models=[...c.models,...c.activeModels.filter(m=>!c.models.some(x=>refValue(x)===refValue(m)))];
      body=`<form id="provider-roles-form" data-provider-form><div class="section-title"><div><h2>每个环节，选合适的模型。</h2><p class="muted">当前分配 v${c.routing.version}。语言改编沿用改稿模型。</p></div></div>${CREATIVE_ROLES.map(role=>`<div class="provider-role"><div><label class="field-label" for="provider-role-${role}">${roleNames[role]}</label><p class="small muted">${role==='writing'?'根据创作设定生成分场初稿。':role==='quality'?'独立因果检查与五维审稿均使用此模型。':'按指定范围改写，保留其他场景。'}</p></div><select name="role-${role}" id="provider-role-${role}" required ${d}><option value="">请选择已测试模型</option>${models.filter(m=>available(m)&&m.qualified).map(m=>`<option value="${esc(refValue(m))}" ${this.routes[role]===refValue(m)?'selected':''}>${esc(m.config.name)} · v${m.revision} · ${esc(c.connections.find(x=>x.id===m.config.connectionId)?.config.name)}</option>`).join('')}</select></div>`).join('')}<div class="provider-footer"><p class="small muted">保存后只影响新任务。每次生成与审稿都会记录实际使用的模型版本。</p><button class="button primary" type="submit" ${d}>保存并应用分配</button></div></form>`;
    }else if(this.section==='connections')body=`<div class="section-title"><h2>服务连接</h2><button class="button primary" data-action="provider-new-connection" ${d}>添加服务 ＋</button></div><p class="muted">同一服务可添加多个模型，共用一份密钥。</p><div class="provider-list">${c.connections.map(conn=>`<article class="provider-row"><div><h3>${esc(conn.config.name)} <span class="small muted">v${conn.revision} · ${conn.enabled?'启用':'停用'}</span></h3><p>${esc(protocolNames[conn.config.protocol])}</p><p class="small muted provider-url">${esc(conn.config.baseUrl)}</p><small class="muted">密钥已配置</small></div><button class="button" data-action="provider-edit-connection" data-id="${esc(conn.id)}" ${d}>编辑服务</button></article>`).join('')||'<p class="empty-panel">还没有服务连接，请先添加。</p>'}</div>`;
    else body=`<div class="section-title"><h2>模型目录</h2><button class="button primary" data-action="provider-new-model" ${busy||!c.connections.some(conn=>conn.enabled)?'disabled':''}>添加模型 ＋</button></div><p class="muted">新模型保存后先测试，再到角色分配中应用。连接测试会发起一次真实请求。</p><div class="provider-list">${c.models.map(m=>`<article class="provider-row"><div><h3>${esc(m.config.name)} <span class="small muted">v${m.revision} · ${m.enabled?'启用':'停用'}</span></h3><p class="provider-url">${esc(m.config.modelId)}</p><p class="small muted">${esc(c.connections.find(conn=>conn.id===m.config.connectionId)?.config.name)} · 服务 v${m.config.connectionRevision}${c.connections.some(conn=>conn.id===m.config.connectionId&&conn.enabled)?'':' · 服务已停用'} · 输出 ${m.config.maxOutput} tokens · ${m.config.timeoutMs/1000} 秒</p><p class="small ${m.validation?.status==='failed'?'error-text':'muted'}">${esc(m.validation?.message??'尚未测试此版本')}${m.validation?` · ${esc(new Date(m.validation.testedAt).toLocaleString('zh-CN'))}`:''}</p></div><div class="provider-row-actions"><button class="button" data-action="provider-edit-model" data-id="${esc(m.id)}" ${d}>编辑模型</button><button class="button" data-action="provider-test" data-id="${esc(m.id)}" ${busy||!available(m)?'disabled':''}>测试连接</button></div></article>`).join('')||'<p class="empty-panel">先添加服务，再添加该服务支持的模型。</p>'}</div>`;
    return `<section class="providers-view"><div class="provider-intro"><p class="muted">管理你的模型服务，并为写作流程分别选择模型。</p>${c.source?`<p class="small muted">初始配置来源：${esc(c.source)}。此处修改仅用于 Sci-epo。</p>`:''}</div>${this.message?`<p class="message success" role="status">${esc(this.message)}</p>`:''}<nav class="tabs" aria-label="模型服务设置">${Object.entries({roles:'角色分配',connections:'服务连接',models:'模型目录'}).map(([v,n])=>`<button class="tab ${this.section===v?'active':''}" data-action="provider-section" data-id="${v}" ${d}>${n}</button>`).join('')}<button class="text-button provider-refresh" data-action="provider-refresh" ${d}>刷新</button></nav>${body}</section>`;
  }
}
