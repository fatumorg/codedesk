const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = ch => (...a) => ipcRenderer.invoke(ch, ...a)
contextBridge.exposeInMainWorld('api', {
  ...Object.fromEntries(['start', 'stop', 'send', 'control', 'permit', 'listSessions', 'history', 'renameSession',
    'deleteSession', 'forkSession', 'listDir', 'listFiles', 'readFile', 'writeFile', 'git', 'runShell', 'cli', 'appendMemory', 'createFile',
    'writeTemp', 'fileUrl', 'openPath', 'openInEditor', 'showItem', 'openExternal', 'pickFolder', 'saveFile', 'find', 'info', 'statusLine',
    'usage', 'termStart', 'termWrite', 'termResize', 'termKill',
    'googleStatus', 'accounts', 'switchAccount', 'forgetAccount'].map(c => [c, call(c)])),
  pathFor: f => webUtils.getPathForFile(f),
  on: (ch, fn) => ipcRenderer.on(ch, (_, d) => fn(d)),
})