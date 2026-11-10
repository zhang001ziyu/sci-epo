import type { Review, ReviewSuggestionSource } from '../src/types';
import { reviewSuggestion } from './quality';

export interface RewriteContext {
 revisionId:string;
 sceneId:string;
 review:Review|undefined;
}
export interface SuggestionOrigin {
 revisionId:string;
 reviewId:string;
 targetId:string;
 sceneId:string;
 originalInstruction:string;
}
export type PreparedRewrite = {ok:true;instruction:string;reviewSource?:ReviewSuggestionSource} | {ok:false;message:string};

/** Retain provenance until the author actually edits the imported instruction. */
export class RewriteInstruction {
 private instruction='';
 private origin:SuggestionOrigin|undefined;
 get value():string{return this.instruction;}
 clear():void{this.instruction='';this.origin=undefined;}
 edit(value:string):void {
  if(value!==this.instruction)this.origin=undefined;
  this.instruction=value;
 }
 useSuggestion(context:RewriteContext,reviewId:string|undefined,targetId:string|undefined):boolean {
  const {revisionId,sceneId,review}=context;
  if(!review||review.revisionId!==revisionId||!reviewId||!targetId)return false;
  const suggestion=reviewSuggestion(review,reviewId,targetId,sceneId);
  if(!suggestion)return false;
  this.instruction=suggestion.instruction;
  this.origin={revisionId,reviewId,targetId,sceneId,originalInstruction:suggestion.instruction};
  return true;
 }
 problem(context:RewriteContext):string|undefined {
  const source=this.origin;if(!source)return;
  const current=reviewSuggestion(context.review,source.reviewId,source.targetId,source.sceneId);
  if(context.revisionId!==source.revisionId||context.review?.revisionId!==source.revisionId||context.sceneId!==source.sceneId||!current||current.instruction!==source.originalInstruction||this.instruction!==source.originalInstruction){
   return '这段修改意图来自已失效或不再适用于本场的审稿建议，尚未提交。请对照最新审稿，重新带入建议，或自行编辑后再改稿。';
  }
 }
 prepare(context:RewriteContext):PreparedRewrite {
  const message=this.problem(context);
  return message?{ok:false,message}:{ok:true,instruction:this.instruction,...(this.origin?{reviewSource:{reviewId:this.origin.reviewId,targetId:this.origin.targetId}}:{})};
 }
}
