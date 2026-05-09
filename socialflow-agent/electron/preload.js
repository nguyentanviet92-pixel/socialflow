const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  start: () => ipcRenderer.invoke('start-agent'),
  stop: () => ipcRenderer.invoke('stop-agent'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  onLog: (callback) => {
    ipcRenderer.on('log', (_, entry) => callback(entry))
  },
  onStatus: (callback) => {
    ipcRenderer.on('status', (_, status) => callback(status))
  },
  onSetup: (callback) => {
    ipcRenderer.on('setup-progress', (_, msg) => callback(msg))
  },
})

// SaaS login — hits API /auth/login, stores JWT + user locally so the
// poller can filter jobs for the correct owner. Without this the agent
// would either run for no one (single-user embed) or against the wrong
// user's campaigns.
//
// Channel names below are intentionally flat (no `auth:*` prefix) because
// that's what `ipcMain.handle()` registers in electron/main.js. A mismatch
// here makes invoke() reject with "no handler registered", which crashes
// the renderer's init() silently and leaves the UI body blank.
contextBridge.exposeInMainWorld('auth', {
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  logout: () => ipcRenderer.invoke('logout'),
  me: () => ipcRenderer.invoke('get-user'),
})
