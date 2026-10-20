import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

test('only the main app frame can register or control browser guests', () => {
  const handlers = new Map();
  const main = {mainFrame: {}};
  const owner = {webContents: main, isDestroyed: () => false};
  const guest = {id: 2};
  let registrations = 0;
  let opens = 0;
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(
    fs.readFileSync('apps/electron-backend/src/app/events/browser.events.ts', 'utf8'),
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}},
  ).outputText)(exports, (name) => {
    if (name === 'electron') return {
      BrowserWindow: {fromWebContents: () => owner},
      ipcMain: {handle: (key, callback) => handlers.set(key, callback), on() {return undefined;}},
      webContents: {fromId: (id) => id === 2 ? guest : null},
    };
    if (name === '../app') return {__esModule: true, default: {mainWindow: owner}};
    if (name === '../services/browser-view.service') return {
      browserGuestRegistry: {register: () => registrations++},
      browserViewService: {open: () => opens++},
    };
    if (name === '@arm-nator/shared/interfaces') return {BROWSER_VIEW_OPEN: 'open'};
    throw Error(name);
  });
  exports.default.bootstrapBrowserEvents();
  const register = handlers.get('BROWSER:REGISTER_GUEST');
  assert.throws(() => register({sender: guest, senderFrame: main.mainFrame}, 2, 'browser'), /authorized/);
  assert.throws(() => register({sender: main, senderFrame: {}}, 2, 'browser'), /authorized/);
  assert.throws(() => register({sender: main, senderFrame: main.mainFrame}, 99, 'browser'), /authorized/);
  register({sender: main, senderFrame: main.mainFrame}, 2, 'browser');
  assert.equal(registrations, 1);
  assert.throws(() => handlers.get('open')({sender: guest}, 'browser'), /not available/);
  handlers.get('open')({sender: main}, 'browser');
  assert.equal(opens, 1);
});
