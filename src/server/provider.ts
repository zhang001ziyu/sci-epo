/** Transport adapted from AINovel app/server/provider.ts and src/providers/llmProvider.ts.
 * No commerce store, production data, credentials, or automatic retries are imported. */
import { buildModelMessages } from '../core';
import type { ModelProvider, ModelRequest } from '../types';

type Env = Record<string, string | undefined>;
type Protocol = 'chat_completions' | 'responses' | 'messages' | 'generateContent';
type ResponseContract = 'json_object' | 'text';
export interface ProviderConfig {
  baseUrl: string; modelId: string; apiKey: string; protocol: Protocol;
  reasoningEffort?: string; maxOutput: number; timeoutMs: number;
}
export class ModelError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ModelError'; }
}
const badConfig = () => new ModelError('configuration', '模型服务配置不完整或不受支持，请检查服务端配置。');
const value = (env: Env, suffix: string) => env[`SCIEPO_MODEL_${suffix}`] ?? env[`AI_NOVEL_${suffix === 'ID' ? 'MODEL' : suffix}`];
function numberSetting(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback;
  const n = Number(raw); if (!Number.isSafeInteger(n) || n < min || n > max) throw badConfig(); return n;
}
function validate(config: ProviderConfig) {
  let url: URL; try { url = new URL(config.baseUrl); } catch { throw badConfig(); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || !config.modelId.trim() || !config.apiKey.trim()) throw badConfig();
  if (config.reasoningEffort && !['omit','minimal','low','medium','high','xhigh'].includes(config.reasoningEffort)) throw badConfig();
  return config;
}
function protocolFor(provider: string, configured?: string): Protocol {
  if (provider === 'anthropic') return 'messages';
  if (provider === 'google') return 'generateContent';
  if (provider !== 'openai') throw badConfig();
  const protocol = configured ?? 'chat_completions';
  if (!['chat_completions','responses'].includes(protocol)) throw badConfig();
  return protocol as Protocol;
}
export function loadProviderConfig(env: Env): ProviderConfig | undefined {
  const hasDedicated = Object.keys(env).some(k => /^(SCIEPO_MODEL_|AI_NOVEL_(PROVIDER|MODEL|BASE_URL|API_KEY))/.test(k) && env[k]);
  const key = value(env, 'API_KEY');
  if (!hasDedicated && !key) return undefined;
  if (!key?.trim()) throw badConfig();
  const provider = value(env, 'PROVIDER') ?? 'openai';
  const protocol = protocolFor(provider, env.SCIEPO_MODEL_PROTOCOL ?? env.AI_NOVEL_OPENAI_PROTOCOL);
  const baseUrl = value(env, 'BASE_URL') ?? ({openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',google:'https://generativelanguage.googleapis.com/v1beta'} as Record<string,string>)[provider];
  const modelId = value(env, 'ID');
  if (!baseUrl || !modelId) throw badConfig();
  const reasoningEffort = value(env, 'REASONING_EFFORT');
  return validate({ baseUrl, modelId, apiKey:key, protocol,
    ...(reasoningEffort ? {reasoningEffort} : {}),
    maxOutput:numberSetting(env.SCIEPO_MODEL_MAX_OUTPUT,8192,256,65536),
    timeoutMs:numberSetting(env.SCIEPO_MODEL_TIMEOUT_MS ?? env.AI_NOVEL_LLM_TIMEOUT_MS,180000,1000,1200000) });
}
export function forRole(base: ProviderConfig, env: Env, kind: ModelRequest['kind']): ProviderConfig {
  const role = {generate:'WRITING',rewrite:'REVISION',review:'QUALITY',localize:'REVISION',storyboard:'WRITING'}[kind];
  const read = (suffix: string) => env[`SCIEPO_MODEL_${role}_${suffix}`] ?? env[`AI_NOVEL_${role}_${suffix === 'ID' ? 'MODEL' : suffix}`];
  const enabled = read('ENABLED');
  if (enabled === undefined || enabled === 'false') return base;
  if (enabled !== 'true') throw badConfig();
  const provider=read('PROVIDER'), baseUrl=read('BASE_URL'), apiKey=read('API_KEY'), modelId=read('ID');
  const supplied=[provider,baseUrl,apiKey].filter(v=>v?.trim()).length;
  if (supplied !== 0 && (supplied !== 3 || !modelId?.trim())) throw badConfig();
  return validate({...base, ...(supplied === 3 ? {baseUrl:baseUrl!,apiKey:apiKey!,protocol:protocolFor(provider!,read('PROTOCOL') ?? env.SCIEPO_MODEL_PROTOCOL ?? env.AI_NOVEL_OPENAI_PROTOCOL)} : {}),
    modelId:modelId ?? base.modelId, reasoningEffort:read('REASONING_EFFORT') ?? base.reasoningEffort,
    maxOutput:numberSetting(read('MAX_OUTPUT'),base.maxOutput,256,65536), timeoutMs:numberSetting(read('TIMEOUT_MS'),base.timeoutMs,1000,1200000) });
}
function buildWire(config: ProviderConfig, messages: {role:string;content:string}[], contract:ResponseContract) {
  const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'), user=messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  const headers: Record<string,string>={'content-type':'application/json'};
  let path:string, body:Record<string,unknown>;
  const reasoning=config.reasoningEffort && config.reasoningEffort!=='omit' ? config.reasoningEffort : undefined;
  if(config.protocol==='messages') {
    path='messages';headers['x-api-key']=config.apiKey;headers['anthropic-version']='2023-06-01';
    // Messages has no generic JSON-object mode. Its native schema mode needs
    // explicit model/gateway capability validation; retain prompt + local validation.
    body={model:config.modelId,system,messages:[{role:'user',content:user}],max_tokens:config.maxOutput,stream:true};
  } else if(config.protocol==='generateContent') {
    path=`models/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`;headers['x-goog-api-key']=config.apiKey;
    body={systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user}]}],generationConfig:{maxOutputTokens:config.maxOutput,...(contract==='json_object'?{responseMimeType:'application/json'}:{})}};
  } else {
    headers.authorization=`Bearer ${config.apiKey}`;
    if(config.protocol==='responses') {
      path='responses';body={model:config.modelId,input:messages,max_output_tokens:config.maxOutput,stream:true,...(reasoning?{reasoning:{effort:reasoning}}:{}),...(contract==='json_object'?{text:{format:{type:'json_object'}}}:{})};
    } else {
      path='chat/completions';body={model:config.modelId,messages,max_tokens:config.maxOutput,stream:true,stream_options:{include_usage:true},...(reasoning?{reasoning_effort:reasoning}:{}),...(contract==='json_object'?{response_format:{type:'json_object'}}:{})};
    }
  }
  return {url:config.baseUrl.replace(/\/+$/,'')+'/'+path,headers,body};
}
const LIMIT=8*1024*1024;
const invalid = () => new ModelError('invalid_response','模型返回了无法识别的内容，原稿已保留。');
/** Syntax is already validated. Track object scopes without reparsing or altering values. */
function requireUniqueJsonKeys(source:string):void {
  const stack:({kind:'object';keys:Set<string>;expectsKey:boolean}|{kind:'array'})[]=[];
  for(let at=0;at<source.length;at++){
    const char=source[at];
    if(char==='"'){
      const start=at++;
      while(at<source.length){
        if(source[at]==='\\'){at+=2;continue;}
        if(source[at]==='"')break;
        at++;
      }
      const frame=stack.at(-1);
      if(frame?.kind==='object'&&frame.expectsKey){
        const key=JSON.parse(source.slice(start,at+1)) as string;
        if(frame.keys.has(key))throw new ModelError('invalid_json','模型返回的 JSON 对象含重复字段，响应未被采用；原稿已保留。');
        frame.keys.add(key);frame.expectsKey=false;
      }
    }else if(char==='{')stack.push({kind:'object',keys:new Set(),expectsKey:true});
    else if(char==='[')stack.push({kind:'array'});
    else if(char==='}'||char===']')stack.pop();
    else if(char===','){const frame=stack.at(-1);if(frame?.kind==='object')frame.expectsKey=true;}
  }
}
function requireJsonObject(output:string):void {
  // Some compatible gateways ignore JSON mode and wrap the complete object in one fence.
  // Validate only this exact outer wrapper; return the original response unchanged below.
  const trimmed=output.trim(),fenced=/^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const source=fenced?fenced[1]!:output;
  let value:unknown;
  try {value=JSON.parse(source);} catch {throw new ModelError('invalid_json','模型未返回完整的 JSON 对象，响应未被采用；原稿已保留。');}
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new ModelError('invalid_json','模型返回的 JSON 顶层不是对象，响应未被采用；原稿已保留。');
  requireUniqueJsonKeys(source);
}
const incomplete = () => new ModelError('incomplete_response','模型输出未完整结束，未保存为剧本；请缩小任务后重试。');
type Obj=Record<string,any>;
function object(value:unknown):Obj { if(!value || typeof value!=='object' || Array.isArray(value)) throw invalid(); return value as Obj; }
function completeReason(reason:unknown, allowed:string[]) {
  if (['length','max_tokens','MAX_TOKENS'].includes(String(reason))) throw new ModelError('output_limit','模型达到输出上限，内容未完成；请缩小任务后重试。');
  if(typeof reason!=='string' || !allowed.includes(reason)) throw incomplete();
}
function plainText(data:unknown,protocol:Protocol):string {
  const p=object(data); if(p.error) throw invalid();
  if(protocol==='chat_completions') {
    const c=p.choices?.[0];completeReason(c?.finish_reason,['stop']);
    return typeof c?.message?.content==='string'?c.message.content:'';
  }
  if(protocol==='responses') {
    if(p.status!=='completed'||p.incomplete_details) throw incomplete();
    return (p.output??[]).flatMap((o:Obj)=>o.type==='message'?(o.content??[]).filter((c:Obj)=>c.type==='output_text').map((c:Obj)=>c.text):[]).join('');
  }
  if(protocol==='messages') {
    completeReason(p.stop_reason,['end_turn','stop_sequence']);
    return (p.content??[]).filter((c:Obj)=>c.type==='text').map((c:Obj)=>c.text).join('');
  }
  const c=p.candidates?.[0];completeReason(c?.finishReason,['STOP']);
  return (c?.content?.parts??[]).filter((v:Obj)=>!v.thought&&typeof v.text==='string').map((v:Obj)=>v.text).join('');
}
async function readResponse(response:Response,protocol:Protocol):Promise<string> {
  if(!response.body) throw invalid();
  const reader=response.body.getReader(), decoder=new TextDecoder();let bytes=0, buffer='', text='', ended=false;
  const sse=(response.headers.get('content-type')??'').includes('text/event-stream');
  const frame=(block:string)=>{
    const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data) return;
    if(data==='[DONE]') {if(!ended)throw incomplete();return;} // Transport termination alone is not proof of complete output.
    let p:Obj;try {p=object(JSON.parse(data));} catch {throw invalid();}
    if(p.error||p.type==='error'||p.type==='response.failed'||p.type==='response.incomplete') throw incomplete();
    if(protocol==='chat_completions') {
      const c=p.choices?.[0];if(typeof c?.delta?.content==='string')text+=c.delta.content;
      if(c?.finish_reason){completeReason(c.finish_reason,['stop']);ended=true;}
    } else if(protocol==='responses') {
      if(p.type==='response.output_text.delta'&&typeof p.delta==='string')text+=p.delta;
      if(p.type==='response.completed') {const final=plainText(p.response,'responses');if(!text)text=final;ended=true;}
    } else if(protocol==='messages') {
      if(p.type==='content_block_start'&&p.content_block?.type==='text'&&typeof p.content_block.text==='string')text+=p.content_block.text;
      if(p.type==='content_block_delta'&&p.delta?.type==='text_delta'&&typeof p.delta.text==='string')text+=p.delta.text;
      if(p.type==='message_delta'&&p.delta?.stop_reason){completeReason(p.delta.stop_reason,['end_turn','stop_sequence']);ended=true;}
    } else {
      const c=p.candidates?.[0];text+=(c?.content?.parts??[]).filter((v:Obj)=>!v.thought&&typeof v.text==='string').map((v:Obj)=>v.text).join('');
      if(c?.finishReason){completeReason(c.finishReason,['STOP']);ended=true;}
    }
  };
  try {
    while(true) {
      const chunk=await reader.read();if(chunk.done)break;
      bytes+=chunk.value.byteLength;if(bytes>LIMIT) throw new ModelError('response_too_large','模型返回内容过大，未保存。');
      buffer+=decoder.decode(chunk.value,{stream:true});
      if(sse){let match:RegExpMatchArray|null;while((match=buffer.match(/\r?\n\r?\n/))){const i=match.index!;frame(buffer.slice(0,i));buffer=buffer.slice(i+match[0].length);if(ended){buffer='';break;}}if(ended)break;}
    }
    buffer+=decoder.decode();
    if(sse){if(!ended&&buffer.trim())frame(buffer);if(!ended)throw incomplete();}
    else {let data:unknown;try{data=JSON.parse(buffer);}catch{throw invalid();}text=plainText(data,protocol);}
    if(!text.trim()) throw invalid();return text;
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Optional fetch injection is for deterministic transport tests, never browser configuration. */
export function createLiveProvider(env:Env=process.env,fetchImpl:typeof fetch=fetch):ModelProvider|undefined {
  const base=loadProviderConfig(env);if(!base)return undefined;
  const configs = Object.fromEntries((['generate','review','rewrite','localize','storyboard'] as const).map(kind=>[kind,forRole(base,env,kind)])) as Record<ModelRequest['kind'],ProviderConfig>;
  return {mode:'live',complete:request=>send(configs[request.kind],buildModelMessages(request),'json_object',fetchImpl)};
}
/** A single immutable configuration serves every pass of one writing operation. */
export function configuredProvider(config:ProviderConfig,fetchImpl:typeof fetch=fetch):ModelProvider {
  return {mode:'live',complete:request=>send(config,buildModelMessages(request),'json_object',fetchImpl)};
}
export async function probeProvider(config:ProviderConfig,fetchImpl:typeof fetch=fetch):Promise<void> {
  const text=await send(config,[{role:'user',content:'Reply with exactly OK. No explanation.'}],'text',fetchImpl);
  if(text.trim()!=='OK')throw new ModelError('probe_output','模型返回了内容，但未按测试要求回复 OK。');
}
async function send(config:ProviderConfig,messages:{role:string;content:string}[],contract:ResponseContract,fetchImpl:typeof fetch):Promise<string> {
    const wire=buildWire(config,messages,contract), controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),config.timeoutMs);
    try {
      // Model calls may pause during reasoning. Match socket-idle and total deadlines,
      // and avoid reusing a stream connection cancelled after its terminal event.
      const response=await fetchImpl(wire.url,{method:'POST',headers:wire.headers,body:JSON.stringify(wire.body),signal:controller.signal,timeout:config.timeoutMs,keepalive:false,redirect:'error'});
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ModelError('upstream_http',`模型服务返回 HTTP ${response.status}，本次操作未完成。`);}
      const output=(await readResponse(response,config.protocol)).split(config.apiKey).join('[凭据已隐藏]');
      // Gateways may ignore native JSON mode. Never repair tokens, strip fences,
      // retry, or change the selected model to satisfy this response contract.
      if(contract==='json_object')requireJsonObject(output);
      return output;
    } catch(error) {
      if(error instanceof ModelError)throw error;
      if(controller.signal.aborted)throw new ModelError('timeout','模型请求超时，结果未确认；请查看任务记录后再重试。');
      throw new ModelError('transport','模型连接中断，本次操作未完成；原稿已保留。');
    } finally {clearTimeout(timer);}
}
