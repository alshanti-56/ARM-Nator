import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySourceCheck, summarizeSourceEvidence, matchesSourcePlaybackFilter, retainSourceObservations } from './source-playback-policy';
import { sourceEvidenceKey, type SourceCheckAttempt, type SourceSampleEvidence } from './source-playback-evidence';
const key = { sourceId: 'source', revision: 'r1', category: 'live' as const };
const sample = (outcome: SourceSampleEvidence['outcome']): SourceSampleEvidence => ({ itemId: '1', title: 'Channel', outcome, elapsedMs: 100, reason: null, engine: 'html5', audioOnly: false });
function attempt(outcomes: SourceSampleEvidence['outcome'][], at = 1000, id = String(at)): SourceCheckAttempt {
 return { checkId: id, key, origin: 'manual', startedAt: at-100, completedAt: at, samples: outcomes.map(sample), reason: null };
}
test('classifies first success, mixed attempts and exhaustive failure honestly', () => {
 assert.equal(classifySourceCheck(attempt(['played']), 3, false)?.result, 'verified');
 assert.equal(classifySourceCheck(attempt(['failed','played']), 3, false)?.result, 'mixed');
 assert.equal(classifySourceCheck(attempt(['failed','failed']), 2, true)?.result, 'failed');
 assert.equal(classifySourceCheck(attempt(['failed']), 3, false), null);
 assert.equal(classifySourceCheck(attempt(['failed','cancelled']), 2, true), null);
 assert.equal(classifySourceCheck(attempt(['inconclusive','failed']), 2, true), null);
 assert.equal(classifySourceCheck(attempt(['inconclusive','played']), 3, false)?.result, 'verified');
 assert.equal(classifySourceCheck(attempt([]), 0, true), null);
});
test('latest result survives inconclusive checks and becomes stale at 24h', () => {
 const success = classifySourceCheck(attempt(['played']), 1, true)!;
 const incomplete = attempt(['cancelled'], 2000);
 assert.equal(summarizeSourceEvidence(key,[success],incomplete,2001).result,'verified');
 assert.equal(summarizeSourceEvidence(key,[success],incomplete,86_401_000).stale,true);
 assert.equal(summarizeSourceEvidence(key,[],incomplete,3000).result,'untested');
});
test('unstable needs three distinct observations and two transitions within seven days', () => {
 const observations = [classifySourceCheck(attempt(['played'],1000),1,true)!,classifySourceCheck(attempt(['failed'],2000),1,true)!,classifySourceCheck(attempt(['played'],3000),1,true)!];
 assert.equal(summarizeSourceEvidence(key,observations,null,3001).result,'unstable');
 assert.equal(summarizeSourceEvidence(key,observations.slice(1),null,3001).result,'verified');
 assert.equal(summarizeSourceEvidence(key,[observations[0],observations[1],observations[0]],null,3001).result,'failed');
 assert.equal(summarizeSourceEvidence(key,observations,null,7*86400000+3001).result,'verified');
 assert.equal(summarizeSourceEvidence({...key,revision:'other'},observations,null,3001).result,'untested');
});
test('sorts observations, keeps historical success and bounds retained history', () => {
 const success=classifySourceCheck(attempt(['played'],1000),1,true)!;
 const failed=classifySourceCheck(attempt(['failed'],2000),1,true)!;
 assert.equal(summarizeSourceEvidence(key,[failed,success],null,3000).latest?.checkId,'2000');
 assert.equal(summarizeSourceEvidence(key,[failed],null,3000,1000).lastSuccessfulAt,1000);
 const many=Array.from({length:25},(_,i)=>classifySourceCheck(attempt(['played'],1000+i),1,true)!);
 assert.equal(retainSourceObservations(many,2000).length,20);
 assert.equal(retainSourceObservations(many,31*86400000).length,0);
});
test('filters selected categories and excludes stale and unstable from working recently', () => {
 const live=summarizeSourceEvidence(key,[classifySourceCheck(attempt(['played']),1,true)!],null,1001);
 const movies={...live,key:{...key,category:'movies' as const},result:'failed' as const};
 assert.equal(matchesSourcePlaybackFilter([live,movies],{category:'all',result:'verified'}),true);
 assert.equal(matchesSourcePlaybackFilter([live,movies],{category:'movies',result:'verified'}),false);
 assert.equal(matchesSourcePlaybackFilter([{...live,stale:true}],{category:'all',result:'working-recently'}),false);
 assert.equal(matchesSourcePlaybackFilter([{...live,result:'unstable'}],{category:'all',result:'working-recently'}),false);
 assert.notEqual(sourceEvidenceKey({...key,sourceId:'a:b',revision:'c'}),sourceEvidenceKey({...key,sourceId:'a',revision:'b:c'}));
});
