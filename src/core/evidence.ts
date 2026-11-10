import type {Evidence,Revision} from '../types';
import {sourceLineIndex,type SourceLineReference} from './reviewVerification';

/** Resolve both sides against this frozen source directory, never model mappings. */
export function createEvidenceReader(revision:Revision,sourceRows:{id:string;text:string}[]) {
  const sources=new Map(sourceRows.map(s=>[s.id,s.text]));
  const scenes=new Map(revision.scenes.map(s=>[s.id,`${s.heading}\n${s.content}`]));
  const bodyFirstLine=new Map(revision.scenes.map(s=>[s.id,`${s.heading}\n`.split(/\r\n|\n|\r/u).length]));
  let lines:SourceLineReference[];
  try{lines=sourceLineIndex(sourceRows);}catch{return (_value:unknown,_expectedSceneId?:string):Evidence|undefined=>undefined;}
  const short=new Map(lines.map(line=>[line.refId,line])),canonical=new Map(lines.map(line=>[line.sourceRef,line]));
  const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
  return (value:unknown,expectedSceneId?:string):Evidence|undefined=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const e=value as Record<string,unknown>;
    if(e.sourceRef!==undefined||e.draftRef!==undefined){
      if(!text(e.sourceRef)||!text(e.draftRef))return;
      const shortPair=short.has(e.sourceRef)&&short.has(e.draftRef);
      const canonicalPair=canonical.has(e.sourceRef)&&canonical.has(e.draftRef);
      if(!shortPair&&!canonicalPair)return;
      const index=shortPair?short:canonical,source=index.get(e.sourceRef)!,draft=index.get(e.draftRef)!;
      if(!draft.sourceId.startsWith('scene:'))return;
      const sceneId=draft.sourceId.slice('scene:'.length),scene=scenes.get(sceneId),bodyLine=bodyFirstLine.get(sceneId);
      if(!scene||bodyLine===undefined||draft.line<bodyLine||sources.get(draft.sourceId)!==scene||
        expectedSceneId!==undefined&&sceneId!==expectedSceneId)return;
      const bound:Evidence={sourceId:source.sourceId,sourceQuote:source.quote,sceneId,draftQuote:draft.quote,
        sourceRef:source.sourceRef,draftRef:draft.sourceRef};
      for(const key of ['sourceId','sourceQuote','sceneId','draftQuote'] as const){
        if(e[key]!==undefined&&e[key]!==bound[key])return;
        // Canonical refs are persisted metadata, not model shorthand. Readback
        // requires their full original pair, including whitespace and speaker.
        if(canonicalPair&&e[key]!==bound[key])return;
      }
      return bound;
    }
    if(!text(e.sourceId)||!text(e.sourceQuote)||!text(e.sceneId)||!text(e.draftQuote)||
      !sources.get(e.sourceId)?.includes(e.sourceQuote)||!scenes.get(e.sceneId)?.includes(e.draftQuote)||
      expectedSceneId!==undefined&&e.sceneId!==expectedSceneId)return;
    return {sourceId:e.sourceId,sourceQuote:e.sourceQuote,sceneId:e.sceneId,draftQuote:e.draftQuote};
  };
}

export const EVIDENCE_REF_GUIDANCE='evidence 优先只给两个目录短编号 {"sourceRef":"R1","draftRef":"R23"}：sourceRef 指来源依据，draftRef 指被评论的当前场景正文原行，不能只选标题、简报或历史场景。两个编号都从本次 sourceLineIndex 精确选择，不推导、改写或猜编号；程序会绑定来源和完整原行，保存 canonical 地址。编号只证明出处，不能证明解释正确；关系跨行用多条 evidence 保留所需限定。旧四字段 sourceId/sourceQuote/sceneId/draftQuote 方式仍兼容：每条 evidence 的 sourceId、sourceQuote、sceneId、draftQuote 各只出现一次，sourceQuote 必须来自 sourceId 对应 sources.text 的逐字连续原文，draftQuote 必须来自 sceneId 对应当前场景原文；二者用途不同，不能用两个同名 draftQuote 字段覆盖这两个引用，也不能省略 sourceQuote，不能改用 text。短编号方式不要同时抄写四个字段；若提供任一字段，必须与完整原行绑定结果逐字一致。JSON 对象字段名不得重复。';
