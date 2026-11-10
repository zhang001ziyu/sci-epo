import type { CausalAudit, CausalCheck, CausalPressure, Evidence, Revision } from '../types';
import { FACT_SCOPE_GUIDANCE } from './writingGuidance';
import {createEvidenceReader} from './evidence';

export const CAUSALITY_GUIDANCE = `你是独立的剧情因果编辑，只核对场内已写出的事实和选择，不写综合好评。
${FACT_SCOPE_GUIDANCE}
逐场记录关键物件由谁持有、位置、可用资源、人物知道什么，以及真实的时间压力。
对每场关键选择提出一个具体、更直接的替代行动，并检查原文中什么事实使人物不能或不愿如此行动。不要默认编剧想让人物陷入困境就真的存在限制。
先区分角色想保住的结果与他选中的手段：停止某设备不等于目标一定失败。优先检查正文已经出现的资源和普通动作可否暂时达成目标；不要只比较“使用关键物件”与“放弃目标”而漏掉第三条路。
区分镜头可见状态、角色判断、作者明示的特殊世界规则和审稿者推断。角色说“只剩一种办法”或“天亮前必然失去”只证明他说了这句话；它与已写状态有张力、又缺少机制时，不能循环引用该台词宣布物理必要性已证明。反过来，也不要要求每个普通陈述都有科学实验。
“没有描写某工具/办法”“不许新增隐藏道具”不是“当前世界不存在任何替代资源”的事实证据；不要将创作约束改写成物理禁令。可提出利用已有材料的待验证替代方案；缺少阻断依据时承认缺口或不确定，不擅自编造有利或不利条件。
区分物理阻碍与情感取舍：人物完全可以带走物件但情感上选择丢弃，是成立的情感选择；不能用它证明无关的设备倒计时或取消成本确实使物件无法带走。若戏剧紧迫性依赖这个跳跃，标 gap，并指出最小修改范围。单纯沉默、平静结束或没有物理危险不构成缺陷。
重点核对：代价是否约束了当前目标；便宜的替代选择是否被正文排除；前场已取得的资源是否在后场被无故当成失去；解释是否只在结尾临时补上。
修改建议先撤回错误陈述、修正对应关系或说明人物真正的偏好。可选收益没有取到，不等于角色必须被物理阻止才能选择较少收益；已经成立的自主取舍应保留。不能为了让原先的劝阻变成必然，补造设备死锁、维修时限、全损、伤害、失能或新禁令。若问题是错误的数量或时间对应，就局部纠正对应，不把普通疲劳升级为客观不可能。提出的新剧情应明确作为作者另选方案，不能包装成已有事实的必要修复。
supported 必须用 constraintEvidence 引用直接约束该替代方案的原文，不能拿无关的情绪句或设备倒计时当证据。不知道限制就用 uncertain；必要因果环节没有建立且影响戏剧冲突用 gap，说明缺口，不能补造规则。not_applicable 仅用于本场没有需要该约束的选择，仍须引用本场动作并解释。
每场至少一个 check。evidence 优先选择 sourceRef/draftRef 目录短编号；旧格式的 sourceQuote/draftQuote 和 constraintEvidence.quote 仍必须逐字匹配来源，不能省略改写。短编号协议仅适用于 evidence；constraintEvidence 与 blockingEvidence 仍使用 {"sourceId":"来源编号","quote":"逐字连续原文"}，不要在这两个单侧引文数组中输出 sourceRef、draftRef 或 R 编号。简洁输出可验证结论和证据，不输出思维过程。不要把你提出的修改当成原稿已有内容。`;

export const PRESSURE_GUIDANCE = `另外独立列出 pressures，覆盖全剧借来制造紧迫感的倒计时、资源代价和权限限制（同一压力可合并）。
不要把“操作某设备有成本”直接等同于“达到人物目标必然付这个成本”。从物件实际位置、持有关系和可用行动出发，说明触发后究竟会怎样影响它；再列出不操作该设备也能达到目标的最简单行动。
directAlternative 必须尝试绕开所谓昂贵操作，不能仅写“采取该昂贵操作”或“不要按人物原选择做”。当物件/人已在危险区外时，检查危险能否实际作用于它。引用代价本身或拒绝付费的对白，只能证明代价存在，不能证明其他路径关闭。
threatenedOutcome 写人物真正可能失去的结果，不得偷换成“必须恢复这台设备/维持自动流程”。同时检查手工替代、延期、改道和利用现有资源；只在正文确有阻断依据时排除，不为制造紧张临时补成本。使用物品与永久毁掉物品分别核对，仍能取回就不能擅自认定不可逆牺牲。
binding 只能在 blockingEvidence 中给出直接阻止绕行路径的已写事实。情感上不愿带走、离开或求助，不是倒计时能销毁手中物品的物理证据。必要的作用路径没有建立且对白/动作把该压力当成选择障碍时用 gap；情感结尾仍可成立，修改建议针对多余或误导的压力，不否定人物自愿放弃。
background 仅适用于明确的环境背景，故事没有把它当成该目标的必要阻碍；解释并引用为何如此。信息确实不足用 uncertain。完全无此类压力才返回空 pressures。各项简短、避免重复整段原文。
pressures 按 sceneId 复用对应 checks 中已核对的 evidence，不重复抄写。修改建议优先说明已有的可行选择、删除不相干的压力或前移已有铺垫；未经作者授权不要默认新造法规、权限或技术来封死漏洞。每条 suggestedFix 必须配 suggestedSceneId，明确实际编辑的单个当前场景；不能默认问题 sceneId 就是改稿目标，须用 evidence、constraintEvidence 或 blockingEvidence 引用目标场。修改须在这一场单独成立，不依赖同时修改其他场景；跨场依赖必须标明并视为尚不可执行。`;

export function readCausalAudit(raw: string, revision: Revision, sourceRows: {id: string; text: string}[]): CausalAudit {
  const errors: string[] = [], checks: CausalCheck[] = [];
  const sources = new Map(sourceRows.map(s => [s.id, s.text])), scenes = new Map(revision.scenes.map(s => [s.id, `${s.heading}\n${s.content}`]));
  const readEvidence=createEvidenceReader(revision,sourceRows);
  const obj = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined;
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 30_000;
  let rows: unknown, pressureRows: unknown;
  try { const data=obj(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')));rows=data?.checks;pressureRows=data?.pressures; } catch { /* reported below */ }
  if (!Array.isArray(rows) || rows.length > 160) return {status: 'needs_review', checks, errors: ['因果专项输出不完整，不能据此判定无问题。']};
  for (const value of rows) {
    const c = obj(value);
    if (!c || !scenes.has(c.sceneId) || !['state','choice','alternative','explanation'].every(k => text(c[k])) || !['physical','emotional','both','none'].includes(c.obstacleKind) || !['supported','gap','uncertain','not_applicable'].includes(c.verdict) || !Array.isArray(c.evidence) || !c.evidence.length || !Array.isArray(c.constraintEvidence)) { errors.push('因果检查缺少场景状态、替代行动、结论或依据。'); continue; }
    const evidence:Evidence[]=c.evidence.map((v:unknown)=>readEvidence(v,c.sceneId)).filter((e:Evidence|undefined):e is Evidence=>!!e&&text(e.sourceQuote)&&text(e.draftQuote));
    const validEvidence=evidence.length===c.evidence.length;
    const validConstraints = c.constraintEvidence.every((v: unknown) => { const e = obj(v); return e && text(e.quote) && sources.get(e.sourceId)?.includes(e.quote); });
    if (!validEvidence || !validConstraints || (c.verdict === 'supported' && !c.constraintEvidence.length) || (c.verdict === 'not_applicable' && !['emotional','none'].includes(c.obstacleKind))) { errors.push(`${c.sceneId} 因果引用或限制证据不足，不能证明替代行动被排除。`); continue; }
    if (c.verdict === 'gap' && !text(c.suggestedFix)) { errors.push(`${c.sceneId} 的因果缺口没有具体修改建议。`); continue; }
    if (c.suggestedSceneId !== undefined && (!text(c.suggestedFix) || !text(c.suggestedSceneId) || !scenes.has(c.suggestedSceneId) ||
        ![...evidence, ...c.constraintEvidence].some(e => e.sceneId === c.suggestedSceneId || e.sourceId === `scene:${c.suggestedSceneId}`))) {
      errors.push(`${c.sceneId} 因果建议的实际改稿场景无效或没有对应原文依据。`); continue;
    }
    checks.push({sceneId:c.sceneId, state:c.state, choice:c.choice, obstacleKind:c.obstacleKind, alternative:c.alternative, verdict:c.verdict, explanation:c.explanation, evidence, constraintEvidence:c.constraintEvidence.map((e: {sourceId:string;quote:string})=>({sourceId:e.sourceId,quote:e.quote})), ...(text(c.suggestedFix)?{suggestedFix:c.suggestedFix}:{}), ...(text(c.suggestedSceneId)?{suggestedSceneId:c.suggestedSceneId}:{})});
  }
  for (const s of revision.scenes) if (!checks.some(c => c.sceneId === s.id)) errors.push(`因果检查未覆盖 ${s.id}。`);
  const pressures:CausalPressure[]=[];
  if(!Array.isArray(pressureRows)||pressureRows.length>80)errors.push('尚未独立核对倒计时与代价是否实际约束目标。');
  else for(const value of pressureRows){
    const p=obj(value);
    if(p&&p.evidence===undefined)p.evidence=checks.filter(c=>c.sceneId===p.sceneId).flatMap(c=>c.evidence);
    if(!p||!scenes.has(p.sceneId)||!['trigger','threatenedOutcome','currentState','directAlternative','explanation'].every(k=>text(p[k]))||!['binding','gap','uncertain','background'].includes(p.verdict)||!Array.isArray(p.evidence)||!p.evidence.length||!Array.isArray(p.blockingEvidence)){errors.push('压力核查缺少触发、影响对象、绕行路径或原文。');continue;}
    const evidence:Evidence[]=p.evidence.map((v:unknown)=>readEvidence(v,p.sceneId)).filter((e:Evidence|undefined):e is Evidence=>!!e&&text(e.sourceQuote)&&text(e.draftQuote));
    const valid=evidence.length===p.evidence.length&&p.blockingEvidence.every((v:unknown)=>{const e=obj(v);return e&&text(e.quote)&&sources.get(e.sourceId)?.includes(e.quote);});
    if(!valid||(p.verdict==='binding'&&!p.blockingEvidence.length)||(p.verdict==='gap'&&!text(p.suggestedFix))){errors.push(`${p.sceneId} 的压力核查引用、阻断依据或修补建议不足。`);continue;}
    if (p.suggestedSceneId !== undefined && (!text(p.suggestedFix) || !text(p.suggestedSceneId) || !scenes.has(p.suggestedSceneId) ||
        ![...evidence, ...p.blockingEvidence].some(e => e.sceneId === p.suggestedSceneId || e.sourceId === `scene:${p.suggestedSceneId}`))) {
      errors.push(`${p.sceneId} 压力建议的实际改稿场景无效或没有对应原文依据。`); continue;
    }
    pressures.push({sceneId:p.sceneId,trigger:p.trigger,threatenedOutcome:p.threatenedOutcome,currentState:p.currentState,directAlternative:p.directAlternative,verdict:p.verdict,explanation:p.explanation,evidence,blockingEvidence:p.blockingEvidence.map((e:{sourceId:string;quote:string})=>({sourceId:e.sourceId,quote:e.quote})),...(text(p.suggestedFix)?{suggestedFix:p.suggestedFix}:{}), ...(text(p.suggestedSceneId)?{suggestedSceneId:p.suggestedSceneId}:{})});
  }
  return {status: errors.length || [...checks,...pressures].some(c => ['gap','uncertain'].includes(c.verdict)) ? 'needs_review' : 'completed', checks, pressures, errors: [...new Set(errors)]};
}
