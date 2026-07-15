import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('chaggie', {
  getXPreloadPath: () => ipcRenderer.invoke('get-x-preload-path'),
})