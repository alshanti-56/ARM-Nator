import assert from 'node:assert/strict';
import test from 'node:test';
import { SourcePlaybackConfirmation, type SourceConfirmationInput } from './source-playback-confirmation';
const input=(atMs:number,extra:Partial<SourceConfirmationInput>={}):SourceConfirmationInput=>({generation:'g1',atMs,positionSeconds:atMs/1000,playing:true,stalled:false,seeking:false,presentedFrames:atMs/50,...extra});
function confirm(wall=6000,media=6,frames=120,extra:Partial<SourceConfirmationInput>={}) {
 const c=new SourcePlaybackConfirmation(); let result=false;
 for(let at=0;at<wall;at+=250) result=c.observe(input(at,{positionSeconds:at/wall*media,presentedFrames:at/wall*frames,...extra}));
 return c.observe(input(wall,{positionSeconds:media,presentedFrames:frames,...extra}));
}
test('requires six wall seconds and six media seconds plus real frames',()=>{
 assert.equal(confirm(5999,6),false);assert.equal(confirm(6000,6),true);assert.equal(confirm(6000,6,0),false);assert.equal(confirm(6000,0),false);
});
test('clock jumps, repeated frame counter, gaps and invalid values cannot verify',()=>{
 const c=new SourcePlaybackConfirmation(); c.observe(input(0));
 assert.equal(c.observe(input(10,{positionSeconds:6})),false);
 assert.equal(c.observe(input(6010,{positionSeconds:12})),false);
 assert.equal(confirm(6000,6,10,{presentedFrames:10}),false);
 assert.equal(c.observe(input(7000,{positionSeconds:NaN})),false);
});
test('seeking, stall, counter reset and generation change restart confirmation',()=>{
 for(const extra of [{seeking:true},{stalled:true},{generation:'g2'},{presentedFrames:0}]) {
  const c=new SourcePlaybackConfirmation(); for(let at=0;at<=5000;at+=250)c.observe(input(at));
  assert.equal(c.observe(input(5250,extra)),false);assert.equal(c.observe(input(6000)),false);
 }
});
test('audio-only needs positive decoded audio evidence; playing alone cannot verify',()=>{
 assert.equal(confirm(6000,6,0,{audioOnly:true,audioReady:true}),true);
 assert.equal(confirm(6000,6,0,{audioOnly:true}),false);
 assert.equal(confirm(6000,6,120,{playing:false}),false);
});
