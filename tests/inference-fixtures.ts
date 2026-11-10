import type {InferenceTarget} from '../src/core/inferenceProof';
/** Transport fixtures only; semantic negative/positive controls live separately. */
export function neutralProofs(targets:InferenceTarget[]){
 return targets.map(t=>({targetId:t.id,scope:'unrelated',
  ...(t.domains.includes('capacity')?{capacity:{workers:'not_a_limit',basis:'not_a_limit',taskAndClock:'not_a_limit',parallelism:'not_needed',evidence:[],bridgeEvidence:[]}}:{}),
  ...(t.domains.includes('object')?{object:{needs:[],claimTerms:[],sourceTerms:[],nounMatch:'not_needed',identity:'not_needed',state:'not_needed',locationRelation:'not_needed',identityEvidence:[],actionEvidence:[],locationEvidence:[]}}:{}),
  missingPremises:[],counterexamplePossible:false,explanation:'Neutral protocol fixture; semantic correctness is tested independently.'}));
}
