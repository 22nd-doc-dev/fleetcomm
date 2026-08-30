"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const SEND = new Set(["ov-lock", "ov-set"]);
const RECEIVE = new Set(["ov-config", "ov-edit", "ov-state", "ov-theme"]);
contextBridge.exposeInMainWorld("fleetcommOverlay", {
  send(channel, data) {
    if (!SEND.has(channel)) throw new Error("blocked overlay IPC channel: " + channel);
    ipcRenderer.send(channel, data);
  },
  on(channel, listener) {
    if (!RECEIVE.has(channel) || typeof listener !== "function") throw new Error("blocked overlay IPC listener: " + channel);
    const wrapped = (_event, ...args) => listener(null, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
