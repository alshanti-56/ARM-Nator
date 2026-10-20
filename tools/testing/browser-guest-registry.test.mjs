import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import ts from "typescript";
function load() {
  const out = {};
  new Function(
    "exports",
    ts.transpileModule(
      fs.readFileSync(
        "apps/electron-backend/src/app/services/browser-guest-registry.ts",
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
  )(out);
  return out;
}
function fixture() {
  const { BrowserGuestRegistry } = load();
  const contents = new EventEmitter();
  contents.id = 1;
  contents.send = (channel, payload) => messages.push({ channel, payload });
  contents.isDestroyed = () => false;
  const owner = new EventEmitter();
  owner.webContents = contents;
  owner.isDestroyed = () => false;
  const messages = [];
  const registry = new BrowserGuestRegistry("/trusted/youtube.preload.js");
  registry.bind(owner);
  return { owner, contents, messages, registry };
}
function attach(f, mode = "browser", id = 2) {
  const preferences = {
    nodeIntegration: true,
    preload: "/untrusted.js",
    webSecurity: false,
    additionalArguments: ["--untrusted"],
  };
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  f.contents.emit("will-attach-webview", event, preferences, {
    src: `about:blank#arm-nator-${mode}`,
    partition: "persist:arm-nator-browser",
  });
  assert.equal(event.prevented, undefined);
  const guest = new EventEmitter();
  guest.id = id;
  guest.hostWebContents = f.contents;
  let destroyed = false;
  guest.isDestroyed = () => destroyed;
  guest.getURL = () => `about:blank#arm-nator-${mode}`;
  guest.close = () => {
    destroyed = true;
    guest.emit("destroyed");
  };
  f.contents.emit("did-attach-webview", {}, guest);
  return { guest, preferences };
}
test("guest attachment enforces partition, initial URL, sandbox and trusted preload", () => {
  const f = fixture();
  const { preferences: p } = attach(f, "youtube");
  assert.equal(p.nodeIntegration, false);
  assert.equal(p.sandbox, true);
  assert.equal(p.webSecurity, true);
  assert.equal(p.contextIsolation, false);
  assert.equal(p.preload, "/trusted/youtube.preload.js");
  assert.deepEqual(p.additionalArguments, [
    "--arm-nator-browser-guest=youtube",
  ]);
  for (const params of [
    { src: "https://foreign.example", partition: "persist:arm-nator-browser" },
    { src: "about:blank#arm-nator-browser", partition: "persist:foreign" },
  ]) {
    const e = {
      preventDefault() {
        this.prevented = true;
      },
    };
    f.contents.emit("will-attach-webview", e, {}, params);
    assert.equal(e.prevented, true);
  }
});
test("registration rejects foreign or mismatched guests", () => {
  const f = fixture();
  const { guest } = attach(f);
  assert.throws(
    () => f.registry.register(f.owner, guest, "youtube"),
    /authorized/,
  );
  assert.throws(
    () => f.registry.register(f.owner, { ...guest, id: 7 }, "browser"),
    /authorized/,
  );
  guest.hostWebContents = {};
  assert.throws(
    () => f.registry.register(f.owner, guest, "browser"),
    /authorized/,
  );
});
test("surface retains identity through parking and clears ownership on destruction", () => {
  const f = fixture();
  const { guest } = attach(f);
  const surface = f.registry.register(f.owner, guest, "browser");
  assert.equal(f.registry.get(f.owner, "browser"), surface);
  surface.setBounds({ x: 10, y: 20, width: 600, height: 300 });
  surface.setVisible(true);
  assert.deepEqual(f.messages.at(-1).payload, [
    {
      id: 2,
      mode: "browser",
      bounds: { x: 10, y: 20, width: 600, height: 300 },
      visible: true,
    },
  ]);
  surface.setVisible(false);
  assert.equal(f.registry.get(f.owner, "browser"), surface);
  guest.close();
  assert.equal(f.registry.get(f.owner, "browser"), undefined);
  assert.deepEqual(f.messages.at(-1).payload, []);
});

test('fullscreen state follows the same guest and resets on return', () => {
  const f = fixture();
  const { guest } = attach(f, 'youtube');
  f.registry.register(f.owner, guest, 'youtube');
  f.registry.setDisplayMode(f.owner, 'youtube', 'full', true);
  assert.equal(f.messages.at(-1).payload[0].isFullscreen, true);
  f.registry.setDisplayMode(f.owner, 'youtube', 'full', false);
  assert.equal(f.messages.at(-1).payload[0].isFullscreen, false);
});
