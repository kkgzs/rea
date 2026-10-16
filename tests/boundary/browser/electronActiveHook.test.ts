import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { electronActiveTimelineEventSchema } from "../../../src/domain/javascript/electronActiveObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const temporary: string[] = [];

const electronModuleSource = `const { EventEmitter } = require("node:events");
const app = new EventEmitter();
app.isReady = () => true;
app.relaunch = () => undefined;
app.setAsDefaultProtocolClient = () => true;
app.setLoginItemSettings = () => undefined;
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, listener) => ipcMain.handlers.set(channel, listener);
const ipcRenderer = {
  send: () => undefined,
  sendSync: () => "ok",
  invoke: () => Promise.resolve("ok"),
  postMessage: () => undefined,
};
class WebContents extends EventEmitter {
  constructor() {
    super();
    this.id = 12;
  }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  loadDataURL() { return Promise.resolve(); }
  send() { return undefined; }
  postMessage() { return undefined; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; return undefined; }
}
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = 3;
    this.webContents = new WebContents();
    this.options = options;
    this.webContents.getLastWebPreferences = () => options.webPreferences;
    app.emit("browser-window-created", {}, this);
  }
}
const utilityProcess = {
  fork: () => {
    const child = new EventEmitter();
    child.pid = 44;
    child.postMessage = () => undefined;
    return child;
  },
};
const shell = { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve() };
const createSession = () => {
  const value = new EventEmitter();
  value.setPermissionRequestHandler = () => undefined;
  value.setPermissionCheckHandler = () => undefined;
  value.setCertificateVerifyProc = () => undefined;
  return value;
};
const session = createSession();
const customSession = createSession();
const contextBridge = {
  exposeInMainWorld: () => undefined,
  exposeInIsolatedWorld: () => undefined,
};
module.exports = {
  app,
  get BrowserWindow() { return BrowserWindow; },
  contextBridge,
  ipcMain,
  ipcRenderer,
  session: {
    defaultSession: session,
    fromPartition: () => customSession,
  },
  shell,
  utilityProcess,
};
`;

const activeCaptureSource = `(async () => {
const electron = require("electron");
const window = new electron.BrowserWindow({ webPreferences: { preload: "/approved/preload.js" } });
const channel = "x".repeat(2048);
electron.ipcMain.handle(channel, async () => ({ ok: true }));
await electron.ipcMain.handlers.get(channel)({ sender: { id: 9 }, senderFrame: { routingId: 7 } }, ...Array.from({ length: 40 }, () => ({ value: true })));
window.webContents.send("main-to-renderer", { value: true });
window.webContents.emit("render-process-gone", { reason: "crashed" });
const longEventName = "l".repeat(2048);
window.webContents.emit(longEventName);
const utility = electron.utilityProcess.fork("utility.js");
utility.emit("message", { data: { value: true } });
utility.postMessage({ value: true });
electron.session.defaultSession.emit("will-download", window.webContents, { cancel() {} });
electron.session.fromPartition("persist:custom").emit("will-download", window.webContents, { cancel() {} });
const defaultPopupDecision = window.webContents.windowOpenHandler({ url: "https://default-popup.invalid" });
window.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
const popupDecision = window.webContents.windowOpenHandler({ url: "https://popup.invalid" });
electron.shell.openExternal("https://example.invalid").catch(() => undefined);
electron.app.relaunch();
electron.contextBridge.exposeInMainWorld("api", { value: true });
window.webContents.loadURL("https://example.invalid").catch(() => undefined);
for (let index = 0; index < 6000; index++) electron.app.relaunch();
electron.ipcRenderer.send("x".repeat(9 * 1024 * 1024));
electron.app.emit("r".repeat(9 * 1024 * 1024));
const manyArguments = Array(30_000).fill(true);
for (let index = 0; index < 8; index++) electron.ipcRenderer.send("shape-budget", ...manyArguments);
try { process.dlopen({}, "/missing/native.node"); } catch {}
const firstSnapshot = globalThis.__reaElectronActiveSnapshot();
const firstIpc = firstSnapshot.events.find((event) => event.kind === "main-handler-invocation");
if (firstIpc) { firstIpc.channel = "mutated"; firstIpc.argument_shapes.push("mutated"); }
firstSnapshot.events.length = 0;
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({ snapshot, default_popup_decision: defaultPopupDecision, popup_decision: popupDecision }) + "\\n");
})();
`;

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

it("retains active hook evidence within its event-retention budget", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "exercise.cjs");
  await writeFile(script, activeCaptureSource);
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly default_popup_decision: { readonly action: string };
    readonly popup_decision: { readonly action: string };
    readonly snapshot: {
      readonly hook_error: boolean;
      readonly events: readonly Record<string, unknown>[];
      readonly observed: number;
      readonly retained: number;
      readonly dropped: number;
      readonly dropped_ipc: number;
      readonly dropped_runtime: number;
      readonly retention_budget_bytes: number;
    };
  };
  const { snapshot } = result;
  expect(
    electronActiveTimelineEventSchema.array().parse(snapshot.events),
  ).toHaveLength(snapshot.retained);

  expect(snapshot.hook_error).toBe(false);
  expect(snapshot.events).toHaveLength(snapshot.retained);
  expect(snapshot.observed).toBe(snapshot.retained + snapshot.dropped);
  expect(snapshot.observed).toBeGreaterThan(5_000);
  expect(snapshot.dropped_ipc).toBeGreaterThanOrEqual(2);
  expect(snapshot.dropped_runtime).toBe(1);
  expect(snapshot.dropped).toBe(
    snapshot.dropped_ipc + snapshot.dropped_runtime,
  );
  expect(
    snapshot.events.some(
      (event) =>
        event.kind === "ipc-renderer-send" &&
        Array.isArray(event.argument_shapes) &&
        event.argument_shapes.length === 30_000,
    ),
  ).toBe(true);
  expect(
    Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  ).toBeLessThanOrEqual(snapshot.retention_budget_bytes);
  const sequences = snapshot.events.map((event) => event.sequence as number);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "window-lifecycle", event: "created" }),
      expect.objectContaining({ kind: "preload", event: "configured" }),
      expect.objectContaining({ kind: "shell-attempt", phase: "blocked" }),
      expect.objectContaining({ kind: "updater", phase: "blocked" }),
      expect.objectContaining({ kind: "native-addon" }),
      expect.objectContaining({ kind: "popup-attempt", phase: "blocked" }),
    ]),
  );
  expect(result.default_popup_decision).toEqual({ action: "deny" });
  expect(result.popup_decision).toEqual({ action: "deny" });
  expect(
    snapshot.events.filter(
      (event) => event.kind === "download" && event.phase === "blocked",
    ),
  ).toHaveLength(2);
  const ipc = snapshot.events.find(
    (event) => event.kind === "main-handler-invocation",
  );
  expect(ipc).toMatchObject({
    correlation_id: expect.stringMatching(/^capture:\d+:\d+$/u),
    direction: "renderer-to-main",
    sender: "webContents:9",
    frame: "frame:7",
  });
  expect(ipc?.channel).toBe("x".repeat(2_048));
  expect(ipc?.argument_shapes).toHaveLength(40);
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "web-contents-lifecycle",
        event: "l".repeat(2048),
      }),
    ]),
  );
});

it("classifies a dropped browser preload as preload configuration at capture", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-browser-preload-",
  );
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "browser-preload.cjs");
  await writeFile(
    script,
    `Object.defineProperty(process, "type", { value: "browser" });
const electron = require("electron");
new electron.BrowserWindow({ webPreferences: { preload: "p".repeat(6 * 1024 * 1024) } });
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify(snapshot) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const snapshot = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly dropped_event_families: readonly {
      readonly family: string;
      readonly count: number;
    }[];
    readonly dropped_event_roles: readonly {
      readonly role: string;
      readonly count: number;
    }[];
  };
  expect(snapshot.dropped_event_families).toContainEqual({
    family: "preload-configuration",
    count: 1,
  });
  expect(snapshot.dropped_event_roles).toContainEqual({
    role: "browser",
    count: 1,
  });
});

it("removes observed ipcMain listeners through their original function", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-removal-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-removal.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let calls = 0;
const listener = () => { calls += 1; };
ipcMain.on("repeated", listener);
ipcMain.on("repeated", listener);
ipcMain.removeListener("repeated", listener);
const repeatedAfterFirstRemoval = ipcMain.listenerCount("repeated");
ipcMain.off("repeated", listener);
ipcMain.once("pending-once", listener);
ipcMain.removeListener("pending-once", listener);
ipcMain.on("fired-once", listener);
ipcMain.once("fired-once", listener);
ipcMain.emit("fired-once", event);
ipcMain.removeListener("fired-once", listener);
ipcMain.emit("repeated", event);
ipcMain.emit("pending-once", event);
ipcMain.emit("fired-once", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  calls,
  repeated_after_first_removal: repeatedAfterFirstRemoval,
  listeners: ["repeated", "pending-once", "fired-once"].map((channel) => ipcMain.listenerCount(channel)),
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 2,
    repeated_after_first_removal: 1,
    listeners: [0, 0, 0],
    invocations: ["fired-once", "fired-once"],
  });
});

it("removes the newest matching ipcMain registration across unpatched aliases", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-aliases-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-aliases.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const order = [];
const f = () => { order.push("f"); };
const g = () => { order.push("g"); };
ipcMain.on("mixed", f);
ipcMain.on("mixed", g);
ipcMain.addListener("mixed", f);
ipcMain.removeListener("mixed", f);
ipcMain.emit("mixed", event);
let onceCalls = 0;
const fn = () => { onceCalls += 1; };
ipcMain.once("once-then-add", fn);
ipcMain.addListener("once-then-add", fn);
ipcMain.removeListener("once-then-add", fn);
ipcMain.emit("once-then-add", event);
ipcMain.emit("once-then-add", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  order,
  once_calls: onceCalls,
  listeners: ["mixed", "once-then-add"].map((channel) => ipcMain.listenerCount(channel)),
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    order: ["f", "g"],
    once_calls: 1,
    listeners: [2, 0],
    invocations: ["mixed", "mixed", "once-then-add"],
  });
});

it("records ipcMain listeners registered by a newListener callback during once", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-nested-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-nested.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let nestedCalls = 0;
ipcMain.addListener("newListener", (channel) => {
  if (channel === "outer") ipcMain.on("nested", () => { nestedCalls += 1; });
});
ipcMain.once("outer", () => undefined);
ipcMain.emit("nested", event);
ipcMain.emit("outer", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  nested_calls: nestedCalls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    nested_calls: 1,
    invocations: ["nested", "outer"],
  });
});

it("keeps removal working after many fired ipcMain once registrations", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-repeat-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-repeat.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let calls = 0;
const listener = () => { calls += 1; };
for (let index = 0; index < 200; index += 1) {
  ipcMain.once("repeated-once", listener);
  ipcMain.emit("repeated-once", event);
}
const afterOnce = ipcMain.rawListeners("repeated-once").length;
ipcMain.on("repeated-once", listener);
ipcMain.removeListener("repeated-once", listener);
ipcMain.emit("repeated-once", event);
process.stdout.write(JSON.stringify({
  calls,
  after_once: afterOnce,
  listeners: ipcMain.listenerCount("repeated-once"),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 200,
    after_once: 0,
    listeners: 0,
  });
});

it("removes the newest registration of an ipcMain listener that has its own listener property", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-wrapped-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-wrapped.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const order = [];
const f = () => { order.push("f"); };
f.listener = () => { order.push("inner"); };
const g = () => { order.push("g"); };
ipcMain.on("wrapped", f);
ipcMain.on("wrapped", g);
ipcMain.addListener("wrapped", f);
ipcMain.removeListener("wrapped", f);
ipcMain.emit("wrapped", event);
process.stdout.write(JSON.stringify({
  order,
  listeners: ipcMain.listenerCount("wrapped"),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    order: ["f", "g"],
    listeners: 2,
  });
});

it("reports original ipcMain listeners to newListener and removeListener observers", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-meta-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-meta.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const channels = new Set(["on", "removed-once", "fired-once"]);
const added = [];
const removed = [];
ipcMain.addListener("newListener", (channel, listener) => { if (channels.has(channel)) added.push([channel, listener]); });
ipcMain.addListener("removeListener", (channel, listener) => { if (channels.has(channel)) removed.push([channel, listener]); });
const onListener = () => undefined;
const removedOnce = () => undefined;
let firedCalls = 0;
const firedOnce = () => { firedCalls += 1; };
ipcMain.on("on", onListener);
ipcMain.removeListener("on", onListener);
ipcMain.once("removed-once", removedOnce);
ipcMain.removeListener("removed-once", removedOnce);
ipcMain.once("fired-once", firedOnce);
ipcMain.emit("fired-once", event);
ipcMain.emit("fired-once", event);
const expected = [["on", onListener], ["removed-once", removedOnce], ["fired-once", firedOnce]];
const same = (actual) => actual.length === expected.length &&
  actual.every(([channel, listener], index) => channel === expected[index][0] && listener === expected[index][1]);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  added_originals: same(added),
  removed_originals: same(removed),
  fired_calls: firedCalls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    added_originals: true,
    removed_originals: true,
    fired_calls: 1,
    invocations: ["fired-once"],
  });
});

it("registers and removes ipcMain once listeners through decorators installed after the hook", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-decor-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-decorators.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const seen = [];
const hookedOn = ipcMain.on;
const hookedRemoveListener = ipcMain.removeListener;
ipcMain.on = function decoratedOn(channel, listener) {
  if (channel === "decorated") seen.push("on");
  return hookedOn.call(this, channel, listener);
};
ipcMain.removeListener = function decoratedRemoveListener(channel, listener) {
  if (channel === "decorated") seen.push("removeListener");
  return hookedRemoveListener.call(this, channel, listener);
};
let calls = 0;
const listener = () => { calls += 1; };
const returned = ipcMain.once("decorated", listener);
const registered = ipcMain.listenerCount("decorated", listener);
ipcMain.emit("decorated", event);
ipcMain.emit("decorated", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  seen,
  returns_emitter: returned === ipcMain,
  registered,
  remaining: ipcMain.listenerCount("decorated"),
  calls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    seen: ["on", "removeListener"],
    returns_emitter: true,
    registered: 1,
    remaining: 0,
    calls: 1,
    invocations: ["decorated"],
  });
});

it("keeps hooked ipcMain listener semantics identical to an unhooked EventEmitter", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-diff-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-differential.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const scenario = (emitter) => {
  const log = [];
  const names = new Map();
  const named = (name) => {
    const listener = () => { log.push("call:" + name); };
    names.set(listener, name);
    return listener;
  };
  const label = (listener) => names.get(listener) ?? "unknown";
  emitter.on("newListener", (channel, listener) => {
    if (channel === "ch") log.push("new:" + label(listener));
  });
  emitter.on("removeListener", (channel, listener) => {
    if (channel === "ch") log.push("remove:" + label(listener));
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map(named);
  const state = () => {
    log.push("count:" + emitter.listenerCount("ch") + ":" + [a, b, c, d].map((listener) => emitter.listenerCount("ch", listener)).join(","));
    log.push("listeners:" + emitter.listeners("ch").map(label).join(","));
    log.push("raw:" + emitter.rawListeners("ch").map((listener) => label(listener.listener ?? listener)).join(","));
  };
  emitter.on("ch", a);
  emitter.once("ch", b);
  emitter.on("ch", c);
  emitter.addListener("ch", a);
  emitter.once("ch", d);
  emitter.prependListener("ch", c);
  emitter.prependOnceListener("ch", d);
  state();
  emitter.removeListener("ch", a);
  state();
  emitter.emit("ch", event);
  state();
  emitter.off("ch", c);
  emitter.once("ch", b);
  emitter.removeListener("ch", b);
  emitter.once("ch", d);
  state();
  emitter.emit("ch", event);
  state();
  emitter.off("ch", c);
  // An app function's own listener property is not a hook wrapper.
  const e = named("e");
  e.listener = c;
  emitter.on("ch", a);
  emitter.on("ch", c);
  emitter.prependOnceListener("ch", d);
  emitter.prependListener("ch", e);
  emitter.on("ch", a);
  state();
  emitter.removeAllListeners("ch");
  state();
  emitter.on("ch", b);
  emitter.on("ch", c);
  emitter.removeAllListeners();
  state();
  return log;
};
process.stdout.write(JSON.stringify({
  plain: scenario(new EventEmitter()),
  hooked: scenario(ipcMain),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: string[];
    hooked: string[];
  };
  expect(plain).not.toContain("new:unknown");
  expect(hooked).toEqual(plain);
});

it("keeps a replacement registered by a removeListener observer during ipcMain removeAllListeners", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-replace-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-replacement.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const scenario = (emitter) => {
  const log = [];
  const names = new Map();
  const named = (name) => {
    const listener = () => { log.push("call:" + name); };
    names.set(listener, name);
    return listener;
  };
  // A wrapper is labelled by the listener its .listener names.
  const label = (listener) =>
    names.get(listener) ??
    (names.has(listener.listener) ? "wrapper(" + names.get(listener.listener) + ")" : "unknown");
  const [a, b, c, replacement] = ["a", "b", "c", "replacement"].map(named);
  let replaced = false;
  emitter.on("removeListener", (channel, listener) => {
    if (channel !== "ch") return;
    log.push("remove:" + label(listener));
    if (replaced) return;
    replaced = true;
    emitter.on("ch", replacement);
  });
  emitter.on("ch", a);
  emitter.once("ch", b);
  emitter.on("ch", c);
  const returned = emitter.removeAllListeners("ch");
  log.push("returns_emitter:" + (returned === emitter));
  log.push("listeners:" + emitter.listeners("ch").map(label).join(","));
  emitter.emit("ch", event);
  emitter.removeAllListeners();
  log.push("cleared:" + emitter.listenerCount("ch") + ":" + emitter.listenerCount("removeListener"));
  return log;
};
const plain = scenario(new EventEmitter());
const hooked = scenario(ipcMain);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  plain,
  hooked,
  // The hooked removeListener observer records its own invocations.
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation" && item.channel === "ch").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked, invocations } = JSON.parse(execution.stdout) as {
    plain: string[];
    hooked: string[];
    invocations: string[];
  };
  expect(plain).toEqual([
    "remove:c",
    "remove:wrapper(b)",
    "remove:a",
    "returns_emitter:true",
    "listeners:replacement",
    "call:replacement",
    "remove:replacement",
    "cleared:0:0",
  ]);
  expect(hooked).toEqual(plain);
  expect(invocations).toEqual(["ch"]);
});

it("keeps ipcMain once self-removal through an on decorator that wraps the hook", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-wrap-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-wrapping-decorator.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
// Installed after the hook: wraps each listener and names it via .listener.
const decorate = (emitter) => {
  const decoratedOn = emitter.on;
  emitter.on = function wrappingOn(channel, listener) {
    const layer = function decoratedListener(...args) {
      return listener.apply(this, args);
    };
    layer.listener = listener;
    return decoratedOn.call(this, channel, layer);
  };
};
const scenario = (emitter) => {
  decorate(emitter);
  let calls = 0;
  const listener = () => { calls += 1; };
  const returned = emitter.once("decorated", listener);
  const registered = emitter.listenerCount("decorated");
  emitter.emit("decorated", event);
  const afterFirst = emitter.listenerCount("decorated");
  emitter.emit("decorated", event);
  emitter.once("decorated", listener);
  emitter.emit("decorated", event);
  return {
    returns_emitter: returned === emitter,
    registered,
    after_first: afterFirst,
    remaining: emitter.listenerCount("decorated"),
    raw: emitter.rawListeners("decorated").length,
    calls,
  };
};
const plain = scenario(new EventEmitter());
const hooked = scenario(ipcMain);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  plain,
  hooked,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked, invocations } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
    invocations: string[];
  };
  expect(plain).toEqual({
    returns_emitter: true,
    registered: 1,
    after_first: 0,
    remaining: 0,
    raw: 0,
    calls: 2,
  });
  expect(hooked).toEqual(plain);
  expect(invocations).toEqual(["decorated", "decorated"]);
});

it.each(["stable", "replaced", "readonly", "getter", "proxy"])(
  "normalizes raw ipcMain on entries before %s removal decorators",
  async (mode) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-ipc-remove-decorator-",
    );
    temporary.push(root);
    await writeElectronFixture(root);
    const script = join(root, "ipc-removal-decorator.cjs");
    await writeFile(
      script,
      `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = (emitter) => {
  const seen = [];
  const onListener = () => undefined;
  const onceListener = () => undefined;
  const nativeRemove = emitter.removeListener;
  const decorate = (name) => function removalDecorator(channel, listener) {
    if (this !== emitter) throw new Error("decorator receiver changed");
    if (channel === "ch") {
      const label = listener === onListener ? "on" :
        listener.listener === onceListener ? "once" : "unknown";
      seen.push(name + ":" + label);
      if (label === "unknown") throw new Error("unexpected recording wrapper");
    }
    return nativeRemove.call(this, channel, listener);
  };
  emitter.on("removeListener", (channel) => {
    if (${JSON.stringify(mode)} === "replaced" && channel === "ch")
      emitter.removeListener = decorate("replacement");
  });
  emitter.on("ch", onListener);
  emitter.once("ch", onceListener);
  emitter.removeListener = decorate("first");
  if (${JSON.stringify(mode)} === "readonly") Object.defineProperty(emitter, "removeListener", {
    value: emitter.removeListener, writable: false, configurable: false,
  });
  if (${JSON.stringify(mode)} === "getter") Object.defineProperty(emitter, "removeListener", {
    get() {
      if (this !== emitter) throw new Error("getter receiver changed");
      return decorate("first");
    },
  });
  if (${JSON.stringify(mode)} === "proxy") emitter.removeListener = new Proxy(emitter.removeListener, {
    get() { throw new Error("decorator metadata must not be read"); },
  });
  let failure = null;
  let returnsEmitter = false;
  try { returnsEmitter = emitter.removeAllListeners("ch") === emitter; }
  catch (cause) { failure = cause.message; }
  return { seen, returns_emitter: returnsEmitter, remaining: emitter.listenerCount("ch"), failure };
};
process.stdout.write(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }) + "\\n");
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const { plain, hooked } = JSON.parse(execution.stdout) as {
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    };
    expect(plain).toEqual({
      seen: [
        "first:once",
        `${mode === "replaced" ? "replacement" : "first"}:on`,
      ],
      returns_emitter: true,
      remaining: 0,
      failure: null,
    });
    expect(hooked).toEqual(plain);
  },
);

it("preserves native removal before mutated raw listener metadata throws", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-ipc-mutated-metadata-",
  );
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-mutated-listener-metadata.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = (emitter) => {
  const marker = new Error("application metadata failure");
  let reads = 0;
  emitter.on("removeListener", () => undefined);
  emitter.on("ch", () => undefined);
  Object.defineProperty(emitter.rawListeners("ch")[0], "listener", { get() {
    reads += 1;
    throw marker;
  }});
  let failure;
  try { emitter.removeAllListeners("ch"); } catch (cause) { failure = cause; }
  return { reads, remaining: emitter.listenerCount("ch"), error_preserved: failure === marker };
};
process.stdout.write(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(plain).toEqual({ reads: 1, remaining: 0, error_preserved: true });
  expect(hooked).toEqual(plain);
});

it("invokes handle callbacks without reading callable method properties", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-callable-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-callable-properties.cjs");
  await writeFile(
    script,
    `"use strict";
const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = async (emitter, observed) => {
  let calls = 0;
  let reads = 0;
  let correctReceiver = false;
  let arity = null;
  const listener = new Proxy(function(...args) {
    calls += 1;
    correctReceiver = this === undefined;
    arity = args.length;
  }, { get(target, key, receiver) {
    if (key === "call" || key === "apply") {
      reads += 1;
      throw new Error("callable metadata must not be read");
    }
    return Reflect.get(target, key, receiver);
  }});
  const event = { sender: { id: 9 } };
  let failure = null;
  try {
    if (observed) {
      emitter.handle("ch", listener);
      const handler = emitter.handlers.get("ch");
      await handler(event, 42);
    } else {
      await listener(event, 42);
    }
  } catch (cause) { failure = cause.message; }
  return { calls, reads, correct_receiver: correctReceiver, arity, failure };
};
(async () => {
  process.stdout.write(JSON.stringify({ plain: await scenario(new EventEmitter(), false),
    hooked: await scenario(ipcMain, true) }) + "\\n");
})();
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(plain).toEqual({
    calls: 1,
    reads: 0,
    correct_receiver: true,
    arity: 2,
    failure: null,
  });
  expect(hooked).toEqual(plain);
});

it("keeps native removal traversal when an ipcMain observer prepends a listener", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-prepend-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "ipc-prepend-during-removal.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = (emitter) => {
  const calls = [];
  const removed = [];
  const a = () => calls.push("a");
  const b = () => calls.push("b");
  const c = () => calls.push("c");
  const replacement = () => calls.push("replacement");
  const names = new Map([[a, "a"], [b, "b"], [c, "c"], [replacement, "replacement"]]);
  let inserted = false;
  emitter.on("removeListener", (channel, listener) => {
    if (channel !== "ch") return;
    removed.push(names.get(listener) ?? "unknown");
    if (!inserted) {
      inserted = true;
      emitter.prependListener("ch", replacement);
    }
  });
  emitter.on("ch", a);
  emitter.on("ch", b);
  emitter.on("ch", c);
  emitter.removeAllListeners("ch");
  const remaining = emitter.listeners("ch").map((listener) => names.get(listener));
  emitter.emit("ch", { sender: { id: 9 } });
  return { removed, remaining, calls };
};
process.stdout.write(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(hooked).toEqual(plain);
});

it.each(["accessor", "proxy"])(
  "does not evaluate %s listener metadata while classifying ipcMain wrappers",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-ipc-accessor-",
    );
    temporary.push(root);
    await writeElectronFixture(root);
    const script = join(root, "ipc-listener-accessor.cjs");
    await writeFile(
      script,
      `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 } };
const scenario = (emitter) => {
  let reads = 0;
  let calls = 0;
  let listener = () => { calls += 1; };
  const inspectMetadata = () => {
    reads += 1;
    throw new Error("listener metadata must not run during registration");
  };
  if (${JSON.stringify(kind)} === "accessor") {
    Object.defineProperty(listener, "listener", { get: inspectMetadata });
  } else {
    listener = new Proxy(listener, {
      getOwnPropertyDescriptor: inspectMetadata,
      get(target, key, receiver) {
        if (key === "listener") return inspectMetadata();
        return Reflect.get(target, key, receiver);
      },
    });
  }
  let failure = null;
  let registered = 0;
  try {
    emitter.on("accessor", listener);
    emitter.emit("accessor", event);
    registered = emitter.listenerCount("accessor");
    emitter.removeAllListeners("accessor");
  } catch (cause) { failure = cause.message; }
  return { reads, calls, registered, failure };
};
process.stdout.write(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }) + "\\n");
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const { plain, hooked } = JSON.parse(execution.stdout) as {
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    };
    expect(plain).toEqual({ reads: 0, calls: 1, registered: 1, failure: null });
    expect(hooked).toEqual(plain);
  },
);

it("isolates hook and exercise from ancestor Electron packages", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ancestor-");
  temporary.push(root);
  await writeElectronFixture(root, 'module.exports = "/ambient/Electron";');
  const ambientHook = await stageHook(join(root, "producer", "scripts"));
  expect(createRequire(ambientHook)("electron")).toBe("/ambient/Electron");

  const fixture = join(root, "fixture");
  await writeElectronFixture(fixture);
  const script = join(fixture, "exercise.cjs");
  await writeFile(
    script,
    `const { BrowserWindow } = require("electron");
const window = new BrowserWindow({ webPreferences: {} });
process.stdout.write(JSON.stringify({
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
  window_open_handler: typeof window.webContents.windowOpenHandler,
}) + "\\n");
`,
  );
  const result = await runNode(script, fixture, ambientHook);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    hook_error: false,
    window_open_handler: "function",
  });
});

it("preserves fatal process termination after recording uncaught exceptions", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-fatal-");
  temporary.push(root);
  await writeElectronFixture(
    root,
    'throw new Error("controlled Electron unavailable");',
  );
  const script = join(root, "fatal.cjs");
  await writeFile(
    script,
    'process.stdout.write(String(globalThis.__reaElectronActiveSnapshot().hook_error) + "\\n");\nthrow new Error("fatal-hook-secret");\n',
  );
  const result = await runNode(script, root);

  expect(result.code).not.toBe(0);
  expect(result.stdout.trim()).toBe("true");
  expect(result.stderr).toContain("fatal-hook-secret");
});

const writeElectronFixture = async (
  root: string,
  source = electronModuleSource,
) => {
  const directory = join(root, "node_modules", "electron");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "electron", main: "index.cjs" }),
  );
  await writeFile(join(directory, "index.cjs"), source);
};

const stageHook = async (
  root: string,
  source = fileURLToPath(
    new URL("../../../scripts/electron-active-hook.cjs", import.meta.url),
  ),
) => {
  await mkdir(root, { recursive: true });
  const hook = join(root, "electron-active-hook.cjs");
  await Promise.all([
    copyFile(source, hook),
    copyFile(
      join(dirname(source), "electron-active-hook-boundaries.cjs"),
      join(root, "electron-active-hook-boundaries.cjs"),
    ),
  ]);
  return hook;
};

const runNode = async (
  script: string,
  root: string,
  sourceHook?: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> => {
  const hook = await stageHook(root, sourceHook);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", hook, script], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
};
