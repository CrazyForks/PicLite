/* eslint-disable @typescript-eslint/no-require-imports -- Electron preload is intentionally CommonJS. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picLite", {
  platform: process.platform,
  readClipboardImage: () => ipcRenderer.invoke("clipboard:read-image"),
  selectImages: () => ipcRenderer.invoke("dialog:select-images"),
  selectFolder: (kind) => ipcRenderer.invoke("dialog:select-folder", kind),
  exportImages: (payload) => ipcRenderer.invoke("export:images", payload),
  startWatcher: (settings) => ipcRenderer.invoke("watcher:start", settings),
  stopWatcher: () => ipcRenderer.invoke("watcher:stop"),
  getWatcherState: () => ipcRenderer.invoke("watcher:state"),
  onWatcherEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("watcher:event", listener);
    return () => ipcRenderer.removeListener("watcher:event", listener);
  },
});
