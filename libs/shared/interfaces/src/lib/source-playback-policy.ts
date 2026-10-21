import { SOURCE_PLAYBACK_POLICY as P, sourceEvidenceKey, type SourceCheckAttempt, type SourceEvidenceKey, type SourcePlaybackObservation, type SourcePlaybackSummary, type SourcePlaybackFilter } from './source-playback-evidence';
export function classifySourceCheck(attempt: SourceCheckAttempt, selectedCount: number, exhausted: boolean): SourcePlaybackObservation | null {
 const played=attempt.samples.some(s=>s.outcome==='played');
 const failed=attempt.samples.some(s=>s.outcome==='failed');
 if(!played && !(exhausted && selectedCount>0 && attempt.samples.length===selectedCount && attempt.samples.every(s=>s.outcome==='failed')))return null;
 const {reason: _reason,...base}=attempt;
 return {...base,result:played?(failed?'mixed':'verified'):'failed',successfulAt:played?attempt.completedAt:null};
}
function ordered(items:readonly SourcePlaybackObservation[]) {
 const byId=new Map<string,SourcePlaybackObservation>();
 for(const item of items) { const current=byId.get(item.checkId);if(!current || item.completedAt>=current.completedAt)byId.set(item.checkId,item); }
 return [...byId.values()].sort((a,b)=>a.completedAt-b.completedAt || a.checkId.localeCompare(b.checkId));
}
export function retainSourceObservations(items:readonly SourcePlaybackObservation[],now:number): SourcePlaybackObservation[] {
 return ordered(items).filter(o=>o.completedAt>=now-P.historyMs).slice(-P.historyLimit);
}
export function summarizeSourceEvidence(key:SourceEvidenceKey, observations:readonly SourcePlaybackObservation[], latestAttempt:SourceCheckAttempt|null, now:number,historicalSuccessAt:number|null=null):SourcePlaybackSummary {
 const items=ordered(observations.filter(o=>sourceEvidenceKey(o.key)===sourceEvidenceKey(key)));
 const latest=items.at(-1)??null;
 const recent=items.filter(o=>o.completedAt>=now-P.unstableWindowMs && o.completedAt<=now);
 let switches=0; for(let i=1;i<recent.length;i++)if((recent[i].result==='failed')!==(recent[i-1].result==='failed'))switches++;
 const successes=[historicalSuccessAt,...items.map(o=>o.successfulAt)].filter((n):n is number=>n!==null&&Number.isFinite(n));
 return {key,result:recent.length>=3&&switches>=2?'unstable':latest?.result??'untested',latest,lastSuccessfulAt:successes.length?Math.max(...successes):null,stale:!!latest&&now-latest.completedAt>=P.freshMs,latestAttempt:latestAttempt&&sourceEvidenceKey(latestAttempt.key)===sourceEvidenceKey(key)?latestAttempt:null};
}
export function matchesSourcePlaybackFilter(summaries:readonly SourcePlaybackSummary[],filter:SourcePlaybackFilter):boolean {
 if(filter.result==='any')return true;
 return summaries.filter(s=>filter.category==='all'||s.key.category===filter.category).some(s=>filter.result==='working-recently'? !s.stale&&(s.result==='verified'||s.result==='mixed'):s.result===filter.result);
}
