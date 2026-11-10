import { describe, expect, test } from 'bun:test';
import { configuredProvider, createLiveProvider, loadProviderConfig, ModelError, probeProvider } from '../src/server/provider';
import { snapshotContext } from '../src/core';
import type { ModelRequest, Revision } from '../src/types';
const env={AI_NOVEL_PROVIDER:'openai',AI_NOVEL_BASE_URL:'https://provider.example/v1',AI_NOVEL_MODEL:'test-model',AI_NOVEL_API_KEY:'test-only-credential'};
const request:ModelRequest={kind:'generate',episodeTitle:'第一集',context:snapshotContext({title:'星港',premise:'误投包裹',characters:'机器人想回家',worldRules:'燃料有限',authorRules:'允许安静结束'},[])};
const revision:Revision={id:'r1',episodeId:'e1',parentId:null,title:'A clock',logline:'A choice.',scenes:[{id:'s1',heading:'ROOM',content:'Lance waits ten minutes.',locked:false}],context:request.context,kind:'generated',instruction:'',mode:'live',createdAt:'2026-11-07T00:00:00Z'};
const transport=(fn:(url:RequestInfo|URL,init?:RequestInit)=>Promise<Response>)=>fn as typeof fetch;
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function sse(frames:unknown[],split=false){const bytes=new TextEncoder().encode(frames.map(f=>'data: '+(typeof f==='string'?f:JSON.stringify(f))+'\n\n').join(''));return new Response(new ReadableStream({start(c){if(split)for(const b of bytes)c.enqueue(Uint8Array.of(b));else c.enqueue(bytes);c.close();}}),{headers:{'content-type':'text/event-stream'}});}
describe('server-only model transport',()=>{
 test('unconfigured has no live provider; partial config fails closed',()=>{expect(loadProviderConfig({})).toBeUndefined();expect(createLiveProvider({})).toBeUndefined();expect(()=>loadProviderConfig({AI_NOVEL_MODEL:'a'})).toThrow(ModelError);});
 test('URL credentials, query and insecure nonlocal URLs rejected',()=>{for(const baseUrl of ['http://provider.example','https://user:pass@provider.example','https://provider.example?key=secret'])expect(()=>loadProviderConfig({...env,AI_NOVEL_BASE_URL:baseUrl})).toThrow(ModelError);});
 test('chat request carries original messages, private auth and no redirects; no retry',async()=>{let calls=0;const p=createLiveProvider(env,transport(async(url,init)=>{calls++;expect(String(url)).toBe('https://provider.example/v1/chat/completions');expect(init?.redirect).toBe('error');expect(init?.keepalive).toBe(false);expect((init as BunFetchRequestInit).timeout).toBe(180000);expect((init?.headers as Record<string,string>).authorization).toBe('Bearer test-only-credential');const body=JSON.parse(String(init?.body));expect(body.messages[1].content).toContain('误投包裹');return json({choices:[{finish_reason:'stop',message:{content:'{"title":"new"}'}}]});}));expect(await p!.complete(request)).toBe('{"title":"new"}');expect(calls).toBe(1);});
 test('SSE survives individual UTF-8 bytes and joins delta text',async()=>{const p=createLiveProvider(env,transport(async()=>sse([{choices:[{delta:{content:'{"text":"你好'}}]},{choices:[{delta:{content:'世界"}'},finish_reason:'stop'}]},'[DONE]'],true)));expect(await p!.complete(request)).toBe('{"text":"你好世界"}');});
 test('truncated stream and length finish never become successful scripts',async()=>{for(const frames of [[{choices:[{delta:{content:'partial'}}]}],[{choices:[{delta:{content:'partial'},finish_reason:'length'}]},'[DONE]']]){const p=createLiveProvider(env,transport(async()=>sse(frames)));await expect(p!.complete(request)).rejects.toBeInstanceOf(ModelError);}});
 test('DONE without explicit successful finish_reason rejects even complete JSON',async()=>{const p=createLiveProvider(env,transport(async()=>sse([{choices:[{delta:{content:'{}'}}]},'[DONE]'])));await expect(p!.complete(request)).rejects.toBeInstanceOf(ModelError);});
 test('complete terminal event releases a stream even if the upstream keeps the connection open',async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: {"usage":'));},cancel(){cancelled=true;}});
  const p=createLiveProvider(env,transport(async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{expect(await Promise.race([p!.complete(request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Waited for EOF after complete event')),1000);})])).toBe('{}');expect(cancelled).toBe(true);}finally{clearTimeout(timer);}
 });
 test('HTTP and transport errors never expose body or credential',async()=>{for(const mock of [transport(async()=>new Response('test-only-credential',{status:403})),transport(async()=>{throw new Error('test-only-credential https://private.example');})]){let caught:Error|undefined;try{await createLiveProvider(env,mock)!.complete(request);}catch(e){caught=e as Error;}expect(caught).toBeInstanceOf(ModelError);expect(caught!.message).not.toContain('test-only-credential');expect(caught!.message).not.toContain('private.example');}});
 test('enabled role model-only override inherits connection; disabled override ignored',async()=>{const models:string[]=[];const p=createLiveProvider({...env,AI_NOVEL_WRITING_ENABLED:'true',AI_NOVEL_WRITING_MODEL:'writer-model',AI_NOVEL_REVISION_ENABLED:'false',AI_NOVEL_REVISION_MODEL:'ignored'},transport(async(_url,init)=>{models.push(JSON.parse(String(init?.body)).model);return json({choices:[{finish_reason:'stop',message:{content:'{}'}}]});}));await p!.complete(request);expect(models).toEqual(['writer-model']);});
 test('partial enabled dedicated credentials fail before transport',()=>{expect(()=>createLiveProvider({...env,AI_NOVEL_WRITING_ENABLED:'true',AI_NOVEL_WRITING_BASE_URL:'https://other.example'})).toThrow(ModelError);});
 test('Responses streaming completed event required',async()=>{const p=createLiveProvider({...env,AI_NOVEL_OPENAI_PROTOCOL:'responses'},transport(async()=>sse([{type:'response.output_text.delta',delta:'{}'},{type:'response.completed',response:{status:'completed',output:[]}}])));expect(await p!.complete(request)).toBe('{}');});
 test('Anthropic streaming uses messages adapter',async()=>{const p=createLiveProvider({...env,AI_NOVEL_PROVIDER:'anthropic'},transport(async(url,init)=>{expect(String(url)).toEndWith('/messages');expect((init?.headers as Record<string,string>)['x-api-key']).toBe(env.AI_NOVEL_API_KEY);return sse([{type:'content_block_delta',delta:{type:'text_delta',text:'{}'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}]);}));expect(await p!.complete(request)).toBe('{}');});
 test('Google streaming excludes thought parts and requires STOP',async()=>{const p=createLiveProvider({...env,AI_NOVEL_PROVIDER:'google'},transport(async(url)=>{expect(String(url)).toContain(':streamGenerateContent?alt=sse');return sse([{candidates:[{content:{parts:[{text:'hidden',thought:true},{text:'{}'}]},finishReason:'STOP'}]}]);}));expect(await p!.complete(request)).toBe('{}');});
 test('upstream echo of credential is scrubbed',async()=>{const p=createLiveProvider(env,transport(async()=>json({choices:[{finish_reason:'stop',message:{content:'{"echo":"test-only-credential"}'}}]})));expect(await p!.complete(request)).not.toContain(env.AI_NOVEL_API_KEY);});

 test('all creative calls use the native chat JSON-object contract on the unchanged configured route',async()=>{
  const requests:ModelRequest[]=[request,
   ...([undefined,'causality','facts','verification'] as const).map(reviewPass=>({...request,kind:'review' as const,revision,reviewPass,...(reviewPass==='verification'?{draftReview:{assessments:[]},draftFacts:{status:'completed' as const,timelineFacts:[],omissions:[],errors:[]}}:{})})),
   {...request,kind:'rewrite',revision,sceneId:'s1',instruction:'Keep the pause.'},
   {...request,kind:'localize',revision,targetLanguage:'en'},
  ];
  const config=loadProviderConfig(env)!,before=JSON.stringify(config);let calls=0;
  const p=configuredProvider(config,transport(async(url,init)=>{
   calls++;const body=JSON.parse(String(init?.body));
   expect(String(url)).toBe('https://provider.example/v1/chat/completions');expect(body.model).toBe('test-model');
   expect(body.response_format).toEqual({type:'json_object'});expect(body.response_format.json_schema).toBeUndefined();
   expect(body.messages[0].content).toContain('JSON');
   return json({choices:[{finish_reason:'stop',message:{content:'{}'}}]});
  }));
  for(const r of requests)expect(await p.complete(r)).toBe('{}');
  expect(calls).toBe(7);expect(JSON.stringify(config)).toBe(before);
 });

 test('Responses and Gemini use their native JSON fields; Messages keeps its documented prompt-only wire',async()=>{
  for(const protocol of ['responses','generateContent','messages'] as const){
   const config={...loadProviderConfig(env)!,protocol};
   const p=configuredProvider(config,transport(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));expect(body.response_format).toBeUndefined();
    if(protocol==='responses'){expect(body.text).toEqual({format:{type:'json_object'}});return json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});}
    if(protocol==='generateContent'){expect(body.generationConfig).toEqual({maxOutputTokens:8192,responseMimeType:'application/json'});return json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]});}
    expect(body.output_config).toBeUndefined();return json({stop_reason:'end_turn',content:[{type:'text',text:'{}'}]});
   }));
   expect(await p.complete(request)).toBe('{}');
  }
 });

 test('plain OK probes stay plain text for every protocol and do not promise JSON support',async()=>{
  for(const protocol of ['chat_completions','responses','generateContent','messages'] as const){
   const config={...loadProviderConfig(env)!,protocol};let calls=0;
   await probeProvider(config,transport(async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));expect(body.response_format).toBeUndefined();expect(body.text).toBeUndefined();expect(body.output_config).toBeUndefined();expect(body.generationConfig?.responseMimeType).toBeUndefined();
    if(protocol==='responses')return json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]});
    if(protocol==='generateContent')return json({candidates:[{finishReason:'STOP',content:{parts:[{text:'OK'}]}}]});
    if(protocol==='messages')return json({stop_reason:'end_turn',content:[{type:'text',text:'OK'}]});
    return json({choices:[{finish_reason:'stop',message:{content:'OK'}}]});
   }));expect(calls).toBe(1);
  }
 });

 test('one complete JSON fence is validated without changing the original response or retrying',async()=>{
  for(const output of ['```json\n{"quote":"Lance said: wait ten minutes."}\n```','```\n{}\n```',' \n```json\r\n{ "text": "Keep every word." }\r\n```\n ']){
   let calls=0;const p=createLiveProvider(env,transport(async(_url,init)=>{calls++;expect(JSON.parse(String(init?.body)).response_format).toEqual({type:'json_object'});return json({choices:[{finish_reason:'stop',message:{content:output}}]});}));
   expect(await p!.complete(request)).toBe(output);expect(calls).toBe(1);
  }
  const output='```json\n{"quote":"An exact source sentence."}\n```';
  const p=createLiveProvider(env,transport(async()=>sse([{choices:[{delta:{content:output.slice(0,12)}}]},{choices:[{delta:{content:output.slice(12)},finish_reason:'stop'}]},'[DONE]'])));
  expect(await p!.complete(request)).toBe(output);
 });

 test('ignored JSON mode fails closed on bare tokens, extra fence content and non-object JSON with no repair or retry',async()=>{
  for(const output of ['{"checks":[Lance {"targetId":"causal:0"}]}','Here is JSON:\n```json\n{}\n```','```json\n{}\n```\nDone.','```json\n{}\n```\n```json\n{}\n```','```javascript\n{}\n```','```json\n{"checks":[Lance {}]}\n```','```json\n[]\n```','```json\n{"quote":"unfinished\n```','null','[]','true','42','"Lance"','{"quote":"unfinished','test-only-credential private-provider-response']){
   let calls=0;const p=createLiveProvider(env,transport(async()=>{calls++;return json({choices:[{finish_reason:'stop',message:{content:output}}]});}));
   let error:unknown;try{await p!.complete(request);}catch(caught){error=caught;}
   expect(error).toBeInstanceOf(ModelError);expect((error as ModelError).code).toBe('invalid_json');
   expect((error as Error).message).not.toContain(output);expect((error as Error).message).not.toContain(env.AI_NOVEL_API_KEY);
   expect(calls).toBe(1);
  }
  const output=' \n{"quote":"Lance said: wait ten minutes."}\n ';
  const p=createLiveProvider(env,transport(async()=>json({choices:[{finish_reason:'stop',message:{content:output}}]})));
  expect(await p!.complete(request)).toBe(output); // Valid strings and formatting are not rewritten.
 });

 test('a completed SSE stream still requires valid JSON rather than trusting its stop flag',async()=>{
  let calls=0;const p=createLiveProvider(env,transport(async()=>{calls++;return sse([{choices:[{delta:{content:'{"checks":['}}]},{choices:[{delta:{content:'Lance]}'},finish_reason:'stop'}]},'[DONE]']);}));
  await expect(p!.complete(request)).rejects.toMatchObject({code:'invalid_json'});expect(calls).toBe(1);
 });

 test('duplicate JSON keys at any object depth are invalid even when JSON.parse would silently overwrite them',async()=>{
  const duplicates=[
   '{"a":1,"a":2}', '{"a":1,"a":1}', '{"":null,"":{}}', '{"__proto__":1,"__proto__":2}',
   '{"nested":{"x":{},"x":[]}}', '{"rows":[{"same":1},{"inside":{"draftQuote":"first","draftQuote":"second"}}]}',
   '{"a":{"b":"value"},"a":{"c":1}}',
   String.raw`{"a":1,"\u0061":2}`, String.raw`{"a\"b":1,"a\u0022b":2}`,
   String.raw`{"a/b":1,"a\/b":2}`, '{"🚀":1,"\\ud83d\\ude80":2}',
   '{"assessments":[{"dimension":"continuity","evidence":[{"sceneId":"s2","draftQuote":"The current scene.","draftQuote":"The cited source."}]}]}',
  ];
  for(const output of [...duplicates,`\`\`\`json\n${duplicates[0]}\n\`\`\``,`\`\`\`\n${duplicates[4]}\n\`\`\``]){
   let calls=0;const p=createLiveProvider(env,transport(async()=>{calls++;return json({choices:[{finish_reason:'stop',message:{content:output}}]});}));
   let error:unknown;try{await p!.complete(request);}catch(caught){error=caught;}
   expect(error).toBeInstanceOf(ModelError);expect((error as ModelError).code).toBe('invalid_json');
   expect((error as Error).message).toContain('重复字段');expect((error as Error).message).not.toContain(output);
   expect(calls).toBe(1); // The provider reports a format failure; only the bounded run-level policy may resend.
  }
 });

 test('unique decoded keys preserve scopes, case, escaped strings and the exact original response',async()=>{
  const values=[
   '{}', '{"rows":[{"key":1},{"key":2}],"nested":{"key":3},"key":4}',
   '{"a":1,"A":2," a":3}', String.raw`{"é":1,"e\u0301":2}`,
   JSON.stringify({'a"b':1,'a\\b':2,'a\\"b':3,text:'"a":1,"a":2, {"nested":[}]} \\ "draftQuote": "not a key"'}),
   '{"object":{},"array":[null,true,false,1.5,-2e3,[],{"same":"one"},{"same":"two"}],"after":"value"}',
   String.raw`{"escaped":"a\\\"b","quote":"\"","slash":"\\","unicode":"\u0061","key":1}`,
  ];
  for(const output of [...values,`\`\`\`json\r\n${values[1]}\r\n\`\`\``]){
   const p=createLiveProvider(env,transport(async()=>json({choices:[{finish_reason:'stop',message:{content:output}}]})));
   expect(await p!.complete(request)).toBe(output);
  }
 });

 test('completed SSE output rejects repeated keys split across chunks without trusting finish_reason',async()=>{
  const p=createLiveProvider(env,transport(async()=>sse([
   {choices:[{delta:{content:'{"evidence":[{"draft'}}]},
   {choices:[{delta:{content:'Quote":"first","draft'}}]},
   {choices:[{delta:{content:'Quote":"second"}]} '},finish_reason:'stop'}]},'[DONE]',
  ])));
  await expect(p!.complete(request)).rejects.toMatchObject({code:'invalid_json'});
 });

 test('every supported protocol applies the same duplicate-key rejection to model content',async()=>{
  const output='{"outer":{"value":1,"value":2}}';
  for(const protocol of ['chat_completions','responses','messages','generateContent'] as const){
   const p=configuredProvider({...loadProviderConfig(env)!,protocol},transport(async()=>{
    if(protocol==='responses')return json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:output}]}]});
    if(protocol==='messages')return json({stop_reason:'end_turn',content:[{type:'text',text:output}]});
    if(protocol==='generateContent')return json({candidates:[{finishReason:'STOP',content:{parts:[{text:output}]}}]});
    return json({choices:[{finish_reason:'stop',message:{content:output}}]});
   }));
   await expect(p.complete(request)).rejects.toMatchObject({code:'invalid_json'});
  }
 });

 test('a gateway rejection of the format parameter never falls back or changes model',async()=>{
  const bodies:any[]=[];const p=createLiveProvider(env,transport(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response('unsupported response_format private-provider-response',{status:400});}));
  await expect(p!.complete(request)).rejects.toMatchObject({code:'upstream_http'});
  expect(bodies).toHaveLength(1);expect(bodies[0].response_format).toEqual({type:'json_object'});expect(bodies[0].model).toBe('test-model');
 });
});
