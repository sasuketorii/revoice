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
  startTranscription: (payload) => ipcRenderer.send('transcribe:start', payload),
  onLog: register('transcribe:log'),
  onPid: register('transcribe:pid'),
  onDone: register('transcribe:done'),
  onError: register('transcribe:error'),
  kill: (pid) => ipcRenderer.send('process:kill', pid),
  readTextFile: (targetPath) => ipcRenderer.invoke('file:readText', targetPath),
});
