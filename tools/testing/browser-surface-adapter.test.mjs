import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import ts from "typescript";
import path from "node:path";
function compile(file, require) {
  const out = {};
  new Function(
    "exports",
    "require",
    "__dirname",
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(out, require, path.dirname(path.resolve(file)));
  return out;
}
function fixture() {
  let nativeCreated = 0;
  const messages = [];
  const children = [];
  class Contents extends EventEmitter {
    constructor(id, host) {
      super();
      this.id = id;
      this.hostWebContents = host;
      this.dead = false;
    }
    isDestroyed() {
      return this.dead;
    }
    getURL() {
      return "about:blank#arm-nator-browser";
    }
    getTitle() {
      return "Browser";
    }
    getZoomFactor() {
      return 2;
    }
    setWindowOpenHandler() {}
    setAudioMuted() {}
    isAudioMuted() {
      return false;
    }
    executeJavaScript() {
      return Promise.resolve();
    }
    stop() {}
    canGoBack() {
      return false;
    }
    canGoForward() {
      return false;
    }
    send(c, p) {
      messages.push([c, p]);
    }
    close() {
      this.dead = true;
      this.emit("destroyed");
    }
  }
  const registryModule = compile(
    "apps/electron-backend/src/app/services/browser-guest-registry.ts",
    () => {
      throw Error("unexpected runtime import");
    },
  );
  const backend = compile(
    "apps/electron-backend/src/app/services/browser-view.service.ts",
    (name) => {
      if (name === "node:path") return path;
      if (name === "./browser-guest-registry") return registryModule;
      if (name === "@arm-nator/shared/interfaces")
        return { BROWSER_VIEW_UPDATE: "BROWSER:UPDATE" };
      if (name === "./embedded-mpv-bounds.util")
        return { toNativeViewBounds: (b) => ({ ...b, width: b.width * 2 }) };
      if (name === "electron")
        return {
          WebContentsView: class {
            constructor() {
              nativeCreated++;
              this.webContents = new Contents(8);
            }
            setBounds(bounds) {
              this.bounds = bounds;
            }
            setVisible() {}
          },
          session: { fromPartition: () => ({}) },
          shell: {},
        };
      throw Error(name);
    },
  );
  const owner = new EventEmitter();
  owner.webContents = new Contents(1);
  owner.isDestroyed = () => false;
  owner.contentView = {
    addChildView: (v) => children.push(v),
    removeChildView: (v) => children.splice(children.indexOf(v), 1),
  };
  const guest = new Contents(2, owner.webContents);
  const registry = backend.browserGuestRegistry;
  registry.bind(owner);
  owner.webContents.emit("did-attach-webview", {}, guest);
  registry.register(owner, guest, "browser");
  return {
    backend,
    owner,
    guest,
    children,
    messages,
    nativeCreated: () => nativeCreated,
  };
}
test("composition adopts the registered guest, retains CSS bounds and clears destroyed ownership", () => {
  const prior = process.env.ARM_NATOR_NATIVE_COMPOSITION;
  process.env.ARM_NATOR_NATIVE_COMPOSITION = "1";
  try {
    const f = fixture();
    const service = new f.backend.BrowserViewService();
    const managed = service.createView(f.owner, "browser");
    service.activeView = managed;
    service.owner = f.owner;
    assert.equal(f.nativeCreated(), 0);
    assert.equal(managed.view.nativeView, undefined);
    assert.deepEqual(f.children, []);
    service.setBounds(f.owner, { x: 30, y: 40, width: 600, height: 400 });
    const surfaces = f.messages
      .filter(([c]) => c === "BROWSER:GUEST_SURFACES")
      .at(-1)[1];
    assert.equal(surfaces[0].bounds.width, 600);
    assert.equal(surfaces[0].visible, true);
    f.guest.close();
    assert.equal(service.activeView, null);
    assert.equal(
      f.backend.browserGuestRegistry.get(f.owner, "browser"),
      undefined,
    );
  } finally {
    if (prior === undefined) delete process.env.ARM_NATOR_NATIVE_COMPOSITION;
    else process.env.ARM_NATOR_NATIVE_COMPOSITION = prior;
  }
});

test("explicit rollback keeps the native browser view and zoom conversion", () => {
  const prior = process.env.ARM_NATOR_NATIVE_COMPOSITION;
  process.env.ARM_NATOR_NATIVE_COMPOSITION = "0";
  try {
    const f = fixture();
    const service = new f.backend.BrowserViewService();
    const managed = service.createView(f.owner, "browser");
    service.activeView = managed;
    service.owner = f.owner;
    assert.equal(f.nativeCreated(), 1);
    assert.equal(f.children.length, 1);
    service.setBounds(f.owner, { x: 30, y: 40, width: 600, height: 400 });
    assert.equal(managed.view.nativeView.bounds.width, 1200);
  } finally {
    if (prior === undefined) delete process.env.ARM_NATOR_NATIVE_COMPOSITION;
    else process.env.ARM_NATOR_NATIVE_COMPOSITION = prior;
  }
});
