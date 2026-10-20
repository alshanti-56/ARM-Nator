import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmedProgressWriter } from './confirmed-progress-writer';

const sample = (positionSeconds: number, extra = {}) => ({ positionSeconds, durationSeconds: 1000, status: 'playing' as const, seeking: false, ...extra });
test('confirmed writer rejects scrubbing, failed seek targets and late session events', async () => {
    const saved: { identity: string; positionSeconds: number }[] = [];
    let now = 1000;
    const writer = new ConfirmedProgressWriter<string>({ now: () => now, save: async (identity, progress) => { saved.push({ identity, positionSeconds: progress.positionSeconds }); } });
    const first = writer.begin('one');
    writer.observe(first, sample(10)); await writer.flush();
    writer.observe(first, sample(900, { seeking: true }));
    await writer.flush();
    assert.deepEqual(saved.map(row => row.positionSeconds), [10]);
    writer.observe(first, sample(10, { status: 'error' }));
    writer.observe(first, sample(20));
    now += 2000;
    const next = writer.begin('two');
    writer.observe(first, sample(950));
    writer.observe(next, sample(30)); await writer.flush();
    assert.deepEqual(saved, [{ identity: 'one', positionSeconds: 10 }, { identity: 'one', positionSeconds: 20 }, { identity: 'two', positionSeconds: 30 }]);
});

test('pause and confirmed completed seek flush immediately; early EOF never forces completion', async () => {
    const saved: number[] = [];
    const writer = new ConfirmedProgressWriter<string>({ save: async (_, progress) => { saved.push(progress.positionSeconds); } });
    const token = writer.begin('one');
    writer.observe(token, sample(10)); await writer.flush();
    writer.observe(token, sample(20, { status: 'paused' })); await writer.settled();
    writer.observe(token, sample(800, { seeking: true }));
    writer.observe(token, sample(500, { status: 'paused' })); await writer.settled();
    writer.observe(token, sample(510, { status: 'ended' })); await writer.settled();
    assert.deepEqual(saved, [10, 20, 500, 510]);
});

test('persistence failure is observable and does not poison cleanup or future saves', async () => {
    let failures = 0, calls = 0;
    const writer = new ConfirmedProgressWriter<string>({ save: async () => { if (++calls === 1) throw new Error('disk full'); }, onError: () => { failures++; } });
    const first = writer.begin('one'); writer.observe(first, sample(10)); await writer.flush();
    assert.equal(failures, 1);
    writer.end();
    const next = writer.begin('two'); writer.observe(next, sample(20)); await writer.flush();
    assert.equal(calls, 2);
});

test('successful version preference requires ten seconds of advancing playback and excludes seeks, stalls and old sessions', async()=>{
 let now=1000; const saved:{successfulAt?:number}[]=[];
 const writer=new ConfirmedProgressWriter<string>({now:()=>now,save:async(_id,progress)=>{saved.push(progress);}});
 const token=writer.begin('one');writer.observe(token,sample(700));
 now+=1000;writer.observe(token,sample(900,{seeking:true}));
 now+=1000;writer.observe(token,sample(900));
 now+=10000;writer.observe(token,sample(900)); // a stalled clock contributes nothing
 now+=1000;writer.observe(token,sample(901));await writer.flush();
 assert.equal(saved.at(-1)?.successfulAt,undefined);
 for(let second=0;second<9;second++){now+=1000;writer.observe(token,sample(902+second));}
 await writer.flush();assert.equal(saved.at(-1)?.successfulAt,now);
 const next=writer.begin('two');now+=1000;writer.observe(token,sample(999));writer.observe(next,sample(30));await writer.flush();
 assert.equal(saved.at(-1)?.successfulAt,undefined);
});
