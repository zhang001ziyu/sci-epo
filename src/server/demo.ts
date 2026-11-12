import type { ModelProvider, ModelRequest } from '../types';
import { DIMENSIONS } from '../types';
import { isShortDrama } from '../core/formats';
import { SHORT_DRAMA_DEMO, isShortDramaDemo, shortDramaDemoLedger, shortDramaDemoShotList } from './shortDramaDemo';
const SCENES=[
 {id:'s1',heading:'内景 · 轨道杂务局 · 夜',content:'派普把一块写着“维修员生日”的小蛋糕塞进保温盒。七号盯着排班表。\n\n七号：她今晚休假。\n派普：休假还给我换了左膝轴承。\n\n派普屈膝，没再响。他扣好保温盒。',locked:false},
 {id:'s2',heading:'外景 · 维修通道 · 连续',content:'蛋糕盒被排风口卷向舱外。派普按下背包按钮，一道短焰把他推向盒子。他抱住蛋糕，燃料表归零。\n\n背包仅有的一次喷射已经耗尽。\n七号（通话）：回来得另想办法。',locked:false},
 {id:'s3',heading:'外景 · 舱门旁 · 连续',content:'派普再次启动喷气背包，飞回舱门。\n\n派普：因为友谊的力量，我们终于克服了困难！\n\n七号打开舱门。维修员拿着扳手出来，蛋糕被递到她手里。',locked:false}
];
const EN_SCENES=[
 {id:'s1',heading:'INT. ORBITAL ODD-JOBS OFFICE - NIGHT',content:'Pip tucks a tiny cake marked “Happy birthday, mechanic” into an insulated box. Seven studies the duty roster.\n\nSEVEN: She is off tonight.\nPIP: She replaced my left knee bearing on her day off.\n\nPip bends his knee. No squeak. He clips the box shut.',locked:false},
 {id:'s2',heading:'EXT. MAINTENANCE WALKWAY - CONTINUOUS',content:'A vent catches the cake box and pulls it out into space. Pip hits the pack button. A brief flame carries him to the box. He catches it. The fuel gauge drops to zero.\n\nThe pack has spent its only burst.\nSEVEN (COMMS): You will need another way back.',locked:false},
 {id:'s3',heading:'EXT. AIRLOCK - CONTINUOUS',content:'Pip fires the jetpack again and flies back to the airlock.\n\nPIP: With the power of friendship, we overcame every obstacle!\n\nSeven opens the hatch. The mechanic steps out, wrench in hand, and takes the cake.',locked:false}
];
const enTitle='One Last Burst · Fixed Workflow Example';
const zhTitle='最后一次喷射 · 固定流程示例';
const output=(en:boolean)=>({title:en?enTitle:zhTitle,logline:en?'Pip tries to deliver a birthday cake to the mechanic who fixed his knee, but uses up his fuel on the way. This prepared example intentionally contains a continuity problem.':'派普想把生日蛋糕送给替他修好膝盖的维修员，却在路上用光了燃料。此示例故意保留待改问题，不是模型生成。',scenes:en?EN_SCENES:SCENES});
class DemoError extends Error {override name='ModelError';}
const demoReview=(revision:{scenes:{id:string;content:string}[]},en:boolean)=>{
 const quote2=en?'The pack has spent its only burst.':'背包仅有的一次喷射已经耗尽。',quote3=en?'Pip fires the jetpack again and flies back to the airlock.':'派普再次启动喷气背包，飞回舱门。';
 const conflict=revision.scenes.find(s=>s.id==='s2')?.content.includes(quote2)&&revision.scenes.find(s=>s.id==='s3')?.content.includes(quote3);
 return JSON.stringify({assessments:DIMENSIONS.map(d=>d==='continuity'&&conflict?{dimension:d,status:'issue',issueType:'fact_conflict',explanation:'示例规则：上一场燃料已经耗尽，本场却再次喷射。',suggestedFix:'保留燃料耗尽，利用已经携带的盒盖产生反作用力回舱。',evidence:[{sourceId:'scene:s2',sourceQuote:quote2,sceneId:'s3',draftQuote:quote3}]}:{dimension:d,status:'uncertain',explanation:'这是固定流程示例，未对这一维度执行真实模型审稿。请由作者审读。',evidence:[]})});
};
export const demoProvider:ModelProvider={mode:'demo',async complete(req:ModelRequest){
 const language=req.revision?.language??req.context.brief.language??'zh-CN',en=language==='en';
 if(!['en','zh-CN'].includes(language))throw new DemoError('固定演示仅提供英文和简体中文。其他语言请使用真实模型。');
 if(req.kind==='generate')return JSON.stringify(isShortDrama(req.context.brief)?SHORT_DRAMA_DEMO[en?'en':'zh']:output(en));
 if(req.kind==='bible')throw new DemoError('示例演练不起草本集设定。请用真实模型起草，或点“按场景标题新建”后手动填写。');
 const revision=req.revision;
 if(revision&&[SHORT_DRAMA_DEMO.en.title,SHORT_DRAMA_DEMO.zh.title].includes(revision.title)){
  if(!isShortDramaDemo(revision,en?'en':'zh'))throw new DemoError('预置短剧示例只适用于未改动的固定样例；自写或已修改剧本请使用真实模型。');
  if(req.kind==='storyboard')return JSON.stringify(shortDramaDemoShotList(en?'en':'zh'));
  if(req.kind==='logic')return JSON.stringify(shortDramaDemoLedger(en?'en':'zh'));
  if(req.kind==='revise')throw new DemoError('示例演练不做整体改稿：固定样例的逻辑检查没有问题。');
  if(req.kind==='localize'){
   if(!['en','zh-CN'].includes(req.targetLanguage??''))throw new DemoError('预置短剧示例只提供英文和简体中文的逐行对齐版本。');
   return JSON.stringify(SHORT_DRAMA_DEMO[req.targetLanguage==='en'?'en':'zh']);
  }
  if(req.kind==='review')return demoReview(revision,en);
  throw new DemoError('预置短剧示例不提供改稿演示；请手动编辑或使用真实模型。');
 }
 if(req.kind==='storyboard')throw new DemoError('预置分镜表只提供给固定短剧示例；其他剧本请使用真实模型生成分镜表。');
 if(!revision||revision.title!==(en?enTitle:zhTitle))throw new DemoError('示例演练仅适用于固定样例。审读你自己的剧本请使用真实模型。');
 if(req.kind==='localize'){
  const fixed=en?EN_SCENES:SCENES;
  if(!['en','zh-CN'].includes(req.targetLanguage??'')||revision.scenes.length!==fixed.length||revision.scenes.some((s,i)=>s.id!==fixed[i]?.id||s.heading!==fixed[i]?.heading||s.content!==fixed[i]?.content))throw new DemoError('预置双语对照只适用于未改动的固定样例；自写或已修改剧本请使用真实模型。');
  return JSON.stringify(output(req.targetLanguage==='en'));
 }
 if(req.kind==='rewrite'){
  if(req.sceneId!=='s3')throw new DemoError('固定改稿示例只演示第三场；其他场景请手动编辑或使用真实模型。');
  return JSON.stringify({scene:en?{id:'s3',heading:'EXT. AIRLOCK - CONTINUOUS',content:'Pip looks at the hatch, then the cake. He unclips the lid and throws it hard into space. Slowly, he drifts back toward the door.\n\nSEVEN: No lid.\nPIP: She has a wrench. It will do.\n\nThe hatch opens. The mechanic takes the cake, holding her wrench beside the candle as a windbreak. Pip bends his knee in a small bow. Not a squeak.'}:{id:'s3',heading:'外景 · 舱门旁 · 连续',content:'派普看向舱门，再看怀里的蛋糕。他拆下保温盒盖，朝舱外使劲掷去，身体缓缓向门漂回。\n\n七号：蛋糕没盖了。\n派普：她有扳手。挡一下。\n\n舱门打开。维修员接过蛋糕，把扳手横在蜡烛旁挡风。派普屈膝行礼，膝盖安静无声。'}});
 }
 return demoReview(revision,en);
}};
