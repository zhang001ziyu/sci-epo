import type { VerificationCheck, VerificationFieldTarget, VerificationQuote } from './reviewVerification';

export type InferenceDomain = 'capacity' | 'object';
export interface InferenceTarget { id:string; parentId:string; claim:string; context?:string; fieldIds:string[]; domains:InferenceDomain[] }
export interface InferenceProof {
 targetId:string;
 scope:'fact'|'option'|'attribution'|'uncertainty'|'preference'|'unrelated';
 capacity?: {claimKind?:'limit'|'observation'|'proposal'|'not_applicable'; workers:'same'|'different'|'unknown'|'not_a_limit'; basis:'explicit_limit'|'conditional'|'chosen_output'|'unknown'|'not_a_limit'; taskAndClock:'matched'|'unknown'|'not_a_limit'; parallelism:'explicit'|'unknown'|'not_needed'; evidence:VerificationQuote[]; bridgeEvidence:VerificationQuote[]};
 object?: {needs:string[]; identity:'explicit_link'|'same_mention'|'unknown'|'not_needed'; state:'shown'|'proposed'|'unknown'|'not_needed'; locationRelation:'explicit'|'unknown'|'not_needed'; claimTerms:string[]; sourceTerms:string[]; nounMatch:'faithful'|'changed'|'unknown'|'not_needed'; identityEvidence:VerificationQuote[]; actionEvidence:VerificationQuote[]; locationEvidence:VerificationQuote[]};
 missingPremises:string[]; counterexamplePossible:boolean; explanation:string;
 /** Program-owned lexical binding failures; unresolved meaning, not malformed JSON. */
 bindingIssues?:string[];
}
// Broad routing only. Keywords never establish a verdict, identity or capacity.
const capacityWords=/产能|吞吐|协作|合作|单人|多人|两人|独自|人时|瓶颈|并行|串行|完成.*(?:分钟|小时)|(?:分钟|小时).*完成|\b(?:capacity|throughput|bottleneck|parallel|serial|workers?|alone|together|teamwork|finish|complete)\b/iu;
const objectWords=/物件|物品|搬|移动|转移|存放|放置|台面|台子|工作台|育种|育婴|蛹|托盘|箱|容器|冷藏|干燥储|实验|隔离|南侧|位置|\b(?:object|tray|box|case|terrarium|bench|counter|storage|move|transfer|placed|location|install|pupae|incubator)\b/iu;
export function inferenceTargets(fields:readonly VerificationFieldTarget[]):InferenceTarget[] {
 const groups=new Map<string,InferenceTarget>();
 for(const field of fields){
  if(field.field==='suggestedSceneId'||field.field.startsWith('meaning.'))continue;
  if(capacityWords.test(field.fullClaim)){
   const id=`${field.parentId}#${field.field}`;
   const group=groups.get(id)??{id,parentId:field.parentId,claim:field.fullClaim,fieldIds:[],domains:['capacity'] as InferenceDomain[]};
   group.fieldIds.push(field.id);groups.set(id,group);
  }
  // Object identity is checked at the actual disputed clause. Unrelated true
  // quantities/state elsewhere in a long field must not mask a noun substitution.
  if(objectWords.test(field.claim)){
   const id=field.id+':object';
   groups.set(id,{id,parentId:field.parentId,claim:field.claim,context:field.fullClaim,fieldIds:[field.id],domains:['object']});
  }
 }
 return [...groups.values()];
}

export const INFERENCE_PROOF_GUIDANCE = `先返回 inferenceProofs，再返回 fieldChecks/checks。inferenceTargets 是按完整字段分组的高风险推理，每个 id 必须恰好一份证明；词面命中不等于有问题，scope 按完整断言选 fact/option/attribution/uncertainty/preference/unrelated。先逐项填下面的前提，再给判断，不能先决定结论再补前提。所有引证仍用 sourceLineIndex 的 {refId}。
capacity 域必须给 claimKind(limit/observation/proposal/not_applicable，当前断言是否在声称产能极限；实际完成量是 observation)，再给 workers(same/different/unknown/not_a_limit)、basis(explicit_limit/conditional/chosen_output/unknown/not_a_limit)、taskAndClock(matched/unknown/not_a_limit)、parallelism(explicit/unknown/not_needed)、evidence、bridgeEvidence。比较单人和多人时 workers=different，不能因为任务相同就填 same。已选或实际交付量不是上限，basis=chosen_output。硬上限只能是正文明确的最大量/瓶颈或列明全部前提的条件推算。跨人数推算需要 bridgeEvidence 指明串行瓶颈、可并行分工或明确合作效率；单人用时引文不能兼作协作桥梁。未知时不能反推出团队必然来不及，也不能直接除人数宣称必然来得及。非产能上限陈述可用 not_a_limit，但 explanation 须解释其实际范围。人物说“我估计能做完”只证明其估计；客观必然结论仍为 fact。
object 域必须先逐字摘取 claimTerms（当前待审片段中的物件名数组），再摘取 sourceTerms（原文中的物件名数组），并填 nounMatch(faithful/changed/unknown/not_needed)。不能把“箱”的陈述悄悄改成“托盘”再批准；同一主题或实验不足以证明不同物理容器为同一物件。关键物件名称被换成另一类实体时 changed，无法判断对应时 unknown，完全无物件断言时才 not_needed。claims 的含义不能靠中文泛称掩盖原文物件类型差异。原文先有托盘、后有容器而未交代装入动作时，容器过去的位置不由托盘位置继承。然后给 needs(所依赖的 identity/completed_action/separate_locations 数组)、identity(explicit_link/same_mention/unknown/not_needed)、state(shown/proposed/unknown/not_needed)、locationRelation(explicit/unknown/not_needed)，以及 identityEvidence/actionEvidence/locationEvidence。两个不同名词是同一实物需要明确同一性或转装联系；同属一个实验、同种内容物、前后相邻段落不足以连接身份。same_mention 只用于该断言完全停留在同一处明确物件提及，不用于跨场把盘、箱自动合并。上一场提到托盘在仓库，不能据此断言下一场另一容器一直在仓库或已从仓库运来。物件位置变化必须有动作/明示状态；认领地点/提议安装≠完成。不同地点称呼不证明空间分离，缺少联系是 unknown，不能当直接反证。needs 必须列原断言实际依赖的关系，不能为通过而省略。即便整体是建议，声称已完成或必然彻底消除风险也要保留这些前提。
每份证明必须给 missingPremises(未证必要前提数组，可为空)、counterexamplePossible(布尔值)、explanation(具体反例或为何不存在相容反例)。反例保持全部明确正文事实不变，仅改变尚未知的协作分工/物件身份/地点关系/实施状态。只要这样的解释能使原确定断言为假，counterexamplePossible=true，不能 supported。普通方案、主观审美和明确指出未知的陈述，不以未执行为由否决；其夹带的事实仍需核实。更正不补新数值、搬运过程或硬限制。空证据数组表示没有依据，不得靠引用一条相邻但不相关的原句填满。
object 结构必须嵌套于 object 键内，例如 {"targetId":"片段编号:object","scope":"fact","object":{"claimTerms":["物件称呼"],"sourceTerms":["原文物件称呼"],"nounMatch":"unknown","needs":["identity"],"identity":"unknown","state":"not_needed","locationRelation":"not_needed","identityEvidence":[],"actionEvidence":[],"locationEvidence":[]},"missingPremises":["物件同一性"],"counterexamplePossible":true,"explanation":"两处物件提及没有明确联系。"}。sourceTerms 是冻结原文中的物件词项，不是引文；仅词项定位可忽略英文大小写，不能据此推导身份关系。identityEvidence/actionEvidence/locationEvidence 仍必须逐字绑定真实来源行，并分别支持所声称的关系；需要关系引文就补充，不伪造。
动作时态按待审断言核对：人物作出决定是已发生的事实，但决定明天搬箱不代表箱子已搬。若审稿只概述有原文依据的提议、计划或延期决定，scope 可为 fact，state 应为 proposed，needs 不得因此加入 completed_action。只有审稿声称物理搬运、安装或隔离已经完成，才要求 completed_action 与 shown。例：原文“明天把箱子搬到台上”，可以支持“人物计划明天搬箱”，不能支持“箱子已在台上”。同时检查计划内容本身，不能把“将测量”扩写成已经承诺完全修复或消除风险。
needs 是关系类型清单，只允许 identity、completed_action、separate_locations，或空数组。locationRelation 是对象的另一个属性名，不是关系类型，绝不能放入 needs。讨论认领一个命名台面，不需要证明两个地点分离；只有待审断言依赖地点彼此分离时才填 separate_locations。不要为了填满字段而添加原断言并不依赖的关系。
物件 target 的 claim 是实际待审片段，context 是同一字段的完整上下文。若后半句省略主语，claimTerms 可逐字引用 context 中的该主语，但必须给 explicit_link 和真实 identityEvidence 证明指代联系；不能仅因同段出现两个物件就合并。片段明确写出的物件称呼仍必须按原词核查，不能用上下文另一个物件替换后批准。
capacity 结构示例（只给需要的域，证据按实际填写）：{"targetId":"pressure:0#explanation","scope":"fact","capacity":{"claimKind":"limit","workers":"different","basis":"conditional","taskAndClock":"matched","parallelism":"unknown","evidence":[{"refId":"R1"}],"bridgeEvidence":[]},"missingPremises":["没有两人分工或串行瓶颈依据"],"counterexamplePossible":true,"explanation":"单人耗时成立，合作所需时间仍未知。"}。`;

const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const one=(v:unknown,values:string[])=>typeof v==='string'&&values.includes(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=20&&v.every(s=>typeof s==='string'&&!!s.trim()&&s.length<=3000);
export function parseInferenceProofs(value:unknown,targets:InferenceTarget[],bind:(value:unknown)=>VerificationQuote[]|undefined,sourceTermExists?:(term:string)=>boolean):{proofs:InferenceProof[];errors:string[]} {
 const errors:string[]=[],proofs:InferenceProof[]=[];
 if(!Array.isArray(value)||value.length>200)return {proofs,errors:['缺少有界的推理前提核对 inferenceProofs。']};
 for(const target of targets){
  const rows=value.filter(p=>record(p)&&p.targetId===target.id),p=rows[0];
  let valid=rows.length===1&&record(p)&&one(p.scope,['fact','option','attribution','uncertainty','preference','unrelated'])&&strings(p.missingPremises)&&typeof p.counterexamplePossible==='boolean'&&typeof p.explanation==='string'&&!!p.explanation.trim()&&p.explanation.length<=6000;
  let capacity:InferenceProof['capacity'],object:InferenceProof['object'];
  const bindingIssues:string[]=[];
  if(valid&&target.domains.includes('capacity')){
   const c=p.capacity,e=record(c)&&bind(c.evidence),b=record(c)&&bind(c.bridgeEvidence);
   valid=record(c)&&one(c.workers,['same','different','unknown','not_a_limit'])&&one(c.basis,['explicit_limit','conditional','chosen_output','unknown','not_a_limit'])&&one(c.taskAndClock,['matched','unknown','not_a_limit'])&&one(c.parallelism,['explicit','unknown','not_needed'])&&(c.claimKind===undefined||one(c.claimKind,['limit','observation','proposal','not_applicable']))&&!!e&&!!b;
   if(valid)capacity={...(c.claimKind?{claimKind:c.claimKind}:{}),workers:c.workers,basis:c.basis,taskAndClock:c.taskAndClock,parallelism:c.parallelism,evidence:e as VerificationQuote[],bridgeEvidence:b as VerificationQuote[]};
  }
  if(valid&&target.domains.includes('object')){
   const flatKeys=['needs','identity','state','locationRelation','claimTerms','sourceTerms','nounMatch','identityEvidence','actionEvidence','locationEvidence'];
   const ambiguous=p.object!==undefined&&flatKeys.some(k=>p[k]!==undefined);
   const o=p.object===undefined?p:p.object,i=record(o)&&bind(o.identityEvidence),a=record(o)&&bind(o.actionEvidence),l=record(o)&&bind(o.locationEvidence);
   valid=!ambiguous&&record(o)&&Array.isArray(o.needs)&&o.needs.length<=3&&new Set(o.needs).size===o.needs.length&&o.needs.every((s:unknown)=>typeof s==='string'&&!!s.trim()&&s.length<=100)&&one(o.identity,['explicit_link','same_mention','unknown','not_needed'])&&one(o.state,['shown','proposed','unknown','not_needed'])&&one(o.locationRelation,['explicit','unknown','not_needed'])&&strings(o.claimTerms)&&strings(o.sourceTerms)&&one(o.nounMatch,['faithful','changed','unknown','not_needed'])&&!!i&&!!a&&!!l;
   if(valid){
    // A segmented clause may omit its subject. Context is lexical grounding,
    // never an automatic identity bridge: inherited terms still need an explicit
    // cited link, and the disputed claim remains the original narrow clause.
    for(const term of o.claimTerms)if(!target.claim.includes(term)&&!(target.context?.includes(term)&&o.identity==='explicit_link'&&(i as VerificationQuote[]).length))bindingIssues.push('待审称呼未能在当前片段定位，或上下文指代缺少明确联系：'+term);
    // These are lexical noun annotations, not quotations. Actual proof evidence
    // remains exactly line-bound. A term elsewhere never supplies an identity link.
    if(sourceTermExists)for(const term of o.sourceTerms)if(!sourceTermExists(term))bindingIssues.push('物件称呼未能在冻结原文定位：'+term);
   }
   if(valid&&['faithful','changed'].includes(o.nounMatch)&&(!o.claimTerms.length||!o.sourceTerms.length))valid=false;
   if(valid)object={needs:o.needs,identity:o.identity,state:o.state,locationRelation:o.locationRelation,claimTerms:o.claimTerms,sourceTerms:o.sourceTerms,nounMatch:o.nounMatch,identityEvidence:i as VerificationQuote[],actionEvidence:a as VerificationQuote[],locationEvidence:l as VerificationQuote[]};
  }
  if(!valid){errors.push(`${target.id} 推理前提缺失、重复、取值或引文无效。`);continue;}
  if(p.bindingIssues!==undefined&&!strings(p.bindingIssues)){errors.push(`${target.id} 词项定位记录无效。`);continue;}
  const bindings=[...new Set([...bindingIssues,...(p.bindingIssues??[])])];
  proofs.push({targetId:target.id,scope:p.scope,...(capacity?{capacity}:{}),...(object?{object}:{}),missingPremises:p.missingPremises,counterexamplePossible:p.counterexamplePossible,explanation:p.explanation,...(bindings.length?{bindingIssues:bindings}:{})});
 }
 if(value.some(p=>!record(p)||!targets.some(t=>t.id===p.targetId)))errors.push('推理前提包含未知字段编号。');
 return {proofs,errors};
}

export function inferenceGaps(p:InferenceProof):string[] {
 const gaps=[...p.missingPremises,...(p.bindingIssues??[])];
 if(p.counterexamplePossible)gaps.push('存在与明确原文相容、却使原断言不成立的解释');
 // An explicitly qualified uncertainty is not an assertion of capacity/identity.
 if(['uncertainty','preference','unrelated','attribution'].includes(p.scope))return gaps;
 const c=p.capacity;
 if(c&&c.basis!=='not_a_limit'&&(!c.claimKind||c.claimKind==='limit')){
  if(p.scope==='fact'&&['chosen_output','unknown'].includes(c.basis))gaps.push('方案/结果或未知量不足以证明产能上限');
  if(c.basis==='conditional'&&c.taskAndClock!=='matched')gaps.push('任务与时钟未对应');
  if(['different','unknown'].includes(c.workers)&&c.basis==='conditional'&&(c.parallelism!=='explicit'||!c.bridgeEvidence.length))gaps.push('跨人数推算缺少分工效率或串行瓶颈证据');
  if(['explicit_limit','conditional'].includes(c.basis)&&!c.evidence.length)gaps.push('产能限制缺少原文依据');
 }
 const o=p.object;
 if(o){
  for(const need of o.needs)if(!['identity','completed_action','separate_locations'].includes(need))gaps.push('尚未核实的前提类型：'+need);
  if(['changed','unknown'].includes(o.nounMatch))gaps.push('待审物件称呼与原文实体未可靠对应');
  if(o.needs.includes('identity')&&(!['explicit_link','same_mention'].includes(o.identity)||!o.identityEvidence.length))gaps.push('物件同一性未建立');
  if(o.needs.includes('completed_action')&&(o.state!=='shown'||!o.actionEvidence.length))gaps.push('位置/安装的完成状态未建立');
  if(o.needs.includes('separate_locations')&&(o.locationRelation!=='explicit'||!o.locationEvidence.length))gaps.push('地点空间分离未建立');
 }
 return [...new Set(gaps)];
}

/** Proofs only restrict claims; they never promote a rejected review or authorize a correction. */
export function constrainInference(checks:VerificationCheck[],fields:VerificationFieldTarget[],targets:InferenceTarget[],proofs:InferenceProof[]):VerificationCheck[] {
 return checks.map(check=>{
  const matching=targets.filter(t=>t.fieldIds.includes(check.targetId)).flatMap(t=>proofs.filter(p=>p.targetId===t.id));
  const rejected=matching.filter(p=>inferenceGaps(p).length);
  if(!rejected.length||!['supported','contradicted'].includes(check.verdict))return check;
  const field=fields.find(f=>f.id===check.targetId)!;
  return {...check,verdict:'unsupported',claimQuote:field.claim,explanation:`完整字段的推理前提未成立：${[...new Set(rejected.flatMap(inferenceGaps))].join('；')}。不能据此确认当前断言；模型的前提说明另存供对照。`,
   correction:'保留原文已展示的行为；协作产能、物件关联或实施状态未证部分仍为未知，不据此添加剧情限制或搬运情节。',counterEvidence:[]};
 });
}
