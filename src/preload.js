const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'log']);

contextBridge.exposeInMainWorld('lf', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
