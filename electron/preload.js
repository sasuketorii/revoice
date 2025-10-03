const { contextBridge, ipcRenderer } = require('electron');

const register = (channel, mapper) => (cb) => {
  const handler = (_event, payload) => {
    cb(mapper ? mapper(payload) : payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('revoice', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  enqueueJob: (payload) => ipcRenderer.invoke('jobs:enqueue', payload),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  cancelJob: (jobId) => ipcRenderer.invoke('jobs:cancel', jobId),
  onJobEvent: register('jobs:event'),
  readTextFile: (targetPath) => ipcRenderer.invoke('file:readText', targetPath),
  listHistory: (options) => ipcRenderer.invoke('history:list', options),
  getHistoryDetail: (id) => ipcRenderer.invoke('history:detail', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  deleteHistory: (ids) => ipcRenderer.invoke('history:delete', ids),
  onHistoryAdded: register('history:item-added'),
  onHistoryCleared: register('history:cleared'),
  onHistoryDeleted: register('history:deleted'),
  onHistoryPruned: register('history:pruned'),
  getRetentionPolicy: () => ipcRenderer.invoke('settings:retention:get'),
  setRetentionPolicy: (policy) => ipcRenderer.invoke('settings:retention:set', policy),
  getTranscriptionDefaults: () => ipcRenderer.invoke('settings:transcription:get'),
  setTranscriptionDefaults: (payload) => ipcRenderer.invoke('settings:transcription:set', payload),
  listTabs: () => ipcRenderer.invoke('tabs:list'),
  createTab: (payload) => ipcRenderer.invoke('tabs:create', payload),
  updateTab: (payload) => ipcRenderer.invoke('tabs:update', payload),
  deleteTab: (tabId) => ipcRenderer.invoke('tabs:delete', tabId),
  onTabEvent: register('tabs:event'),
  copyToClipboard: (text) => ipcRenderer.invoke('system:clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('system:openExternal', url),
});
