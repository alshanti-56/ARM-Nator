const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
let clears = 0;
let loaded = null;
const webHandlers = {};
const ignoredMenus = [];
const fakeElectron = {
    ipcMain: { on: () => undefined, handle: () => undefined },
    app: { isPackaged: true, isReady: () => true, on: () => undefined },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 720 } }) },
    session: { defaultSession: { clearStorageData: () => { clears++; return new Promise(() => undefined); } } },
    BrowserWindow: class extends EventEmitter {
        webContents = { on: (name, handler) => { webHandlers[name] = handler; }, setWindowOpenHandler: () => undefined, setIgnoreMenuShortcuts: value => ignoredMenus.push(value) };
        setMenu() {}
        center() {}
        async loadFile(path) { loaded = path; }
    },
};
const original = Module._load;
Module._load = function(request, parent, isMain) {
    return request === 'electron' ? fakeElectron : original.call(this, request, parent, isMain);
};
const App = require(process.argv[2]).default;
Module._load = original;
App.main(fakeElectron.app, fakeElectron.BrowserWindow);
webHandlers['before-input-event']({}, { type: 'keyDown', key: 'r', meta: true });
webHandlers['before-input-event']({}, { type: 'keyUp', key: 'r', meta: true });
webHandlers['before-input-event']({}, { type: 'keyDown', key: 'c', meta: true });
assert.deepEqual(ignoredMenus, [true, false, false]);
(async () => {
    const result = await Promise.race([App.loadMainWindow().then(() => 'loaded'), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))]);
    assert.equal(result, 'loaded', 'Local file loading must not wait for session service-worker cleanup');
    assert.equal(clears, 0);
    assert.equal(require('node:path').basename(loaded), 'index.html');
})().catch(error => { console.error(error); process.exitCode = 1; });
