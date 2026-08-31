"use strict";
const { contextBridge, ipcRenderer, webFrame } = require("electron");
const OpusScript = require("opusscript");
const config = require("../config/22nd-package.json");
const { version } = require("../package.json");
const { buildTree, validParents, canReorder, reorder, mergeOrder } = require("./net-tree");
const { channelName } = require("./channel-name");
const acctHeartbeat = require("./acct-heartbeat");
const { versionNote } = require("./update-guard");
const padBinds = require("./pad-binds");

const SEND = new Set(["detune", "disconnect", "net-mute", "open-external", "ov-edit", "ov-lock",
  "ov-set", "ov-state", "ov-toggle", "send-text", "theme", "tx-frame"]);
const INVOKE = new Set(["accounts-endpoint", "relay-pin", "acct", "arm-broadcast", "atc-view", "check-updates", "connect", "create-net",
  "discord-login", "do-update", "listen-all", "net-meta", "net-move", "net-remove", "net-rename", "sounds-add", "sounds-delete",
  "sounds-list", "sounds-pick", "sounds-read", "tune", "update-note"]);
const RECEIVE = new Set(["chat", "dial-hold", "gkey", "net-down", "net-error", "ov-edit-state", "ov-shown", "roster",
  "rx", "update-auto-offer", "update-available", "update-note", "update-progress"]);

const codecs = new Map();
let nextCodec = 1;
function codec(id) {
  const value = codecs.get(id);
  if (!value) throw new Error("unknown Opus codec");
  return value;
}
function asBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("audio payload must be binary");
}
function exactArrayBuffer(value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

contextBridge.exposeInMainWorld("fleetcomm", {
  config,
  version,
  autotestHost: process.env.FLEETCOMM_AUTOTEST || "",
  ipc: {
    send(channel, data) {
      if (!SEND.has(channel)) throw new Error("blocked IPC channel: " + channel);
      ipcRenderer.send(channel, data);
    },
    invoke(channel, data) {
      if (!INVOKE.has(channel)) return Promise.reject(new Error("blocked IPC channel: " + channel));
      return ipcRenderer.invoke(channel, data);
    },
    on(channel, listener) {
      if (!RECEIVE.has(channel) || typeof listener !== "function") throw new Error("blocked IPC listener: " + channel);
      const wrapped = (_event, ...args) => listener(null, ...args);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  zoom: { set(factor) { webFrame.setZoomFactor(factor); } },
  netTree: { buildTree, validParents, channelName, canReorder, reorder, mergeOrder },
  acctHeartbeat: { assess: acctHeartbeat.assess },
  updateGuard: { versionNote },
  padBinds: { padKey: padBinds.padKey, padLabel: padBinds.padLabel,
    pressedStates: padBinds.pressedStates, diffButtons: padBinds.diffButtons },
  opus: {
    applications: OpusScript.Application,
    create(sampleRate, channels, application) {
      const id = nextCodec++;
      codecs.set(id, new OpusScript(sampleRate, channels, application));
      return id;
    },
    encode(id, pcm, frameSize) { return exactArrayBuffer(codec(id).encode(asBuffer(pcm), frameSize)); },
    decode(id, frame) { return exactArrayBuffer(codec(id).decode(asBuffer(frame))); },
    ctl(id, request, value) { return codec(id).encoderCTL(request, value); },
    destroy(id) {
      const value = codecs.get(id);
      codecs.delete(id);
      if (value && typeof value.delete === "function") value.delete();
    }
  }
});
