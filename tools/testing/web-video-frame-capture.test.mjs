import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function setup() {
  const exports = {};
  new Function('exports', ts.transpileModule(fs.readFileSync('apps/electron-backend/src/app/services/web-video-frame-capture.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(exports);
  let now = 10000;
  const requests = [];
  const sender = { mainFrame: {}, isDestroyed: () => false, getZoomFactor: () => 1.25,
    capturePage: async rect => { requests.push(rect); return { isEmpty: () => false, resize: () => ({toJPEG: () => Buffer.from('jpeg')}) }; },
  };
  const owner = {webContents: sender, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getContentBounds: () => ({width:1000,height:800})};
  return {sender,owner,requests,event:{sender,senderFrame:sender.mainFrame},capture:exports.createWebVideoFrameCapture(()=>owner,()=>now),advance:()=>{now+=6000;}};
}
test('captures only the owning main frame and rejects invalid/outside rectangles', async () => {
  const h=setup(),rect={x:10,y:20,width:640,height:360};
  assert.equal(await h.capture({...h.event,sender:{}},rect),null);
  assert.equal(await h.capture({...h.event,senderFrame:{}},rect),null);
  for(const invalid of [null,{...rect,x:-1},{...rect,width:Infinity},{...rect,width:900}]) assert.equal(await h.capture(h.event,invalid),null);
  assert.equal(h.requests.length,0);
  assert.equal(await h.capture(h.event,rect),'data:image/jpeg;base64,anBlZw==');
  assert.deepEqual(h.requests,[{x:12,y:25,width:800,height:450}]);
  assert.equal(await h.capture(h.event,rect),null);
  h.advance();assert.ok(await h.capture(h.event,rect));
});
test('hidden windows and concurrent captures cannot create extra work', async () => {
  const h=setup(),rect={x:0,y:0,width:640,height:360};
  h.owner.isVisible=()=>false;assert.equal(await h.capture(h.event,rect),null);assert.equal(h.requests.length,0);
  h.owner.isVisible=()=>true;
  let resolve;h.sender.capturePage=()=>new Promise(r=>resolve=r);
  const pending=h.capture(h.event,rect);h.advance();assert.equal(await h.capture(h.event,rect),null);
  resolve({isEmpty:()=>true});assert.equal(await pending,null);
});
