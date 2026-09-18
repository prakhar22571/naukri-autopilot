import { contextBridge, ipcRenderer } from 'electron'
import type { AutopilotAPI } from '../shared/types'

const api: AutopilotAPI = {
  snapshot: () => ipcRenderer.invoke('autopilot:snapshot'),
  saveSettings: (settings) => ipcRenderer.invoke('autopilot:saveSettings', settings),
  importResume: () => ipcRenderer.invoke('autopilot:importResume'),
  start: (workflow) => ipcRenderer.invoke('autopilot:start', workflow),
  stop: () => ipcRenderer.invoke('autopilot:stop'),
  disconnect: () => ipcRenderer.invoke('autopilot:disconnect'),
  openDataFolder: () => ipcRenderer.invoke('autopilot:openDataFolder'),
  openJob: (id) => ipcRenderer.invoke('autopilot:openJob', id),
  screenshot: (id) => ipcRenderer.invoke('autopilot:screenshot', id),
  onChange: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('autopilot:changed', listener)
    return () => ipcRenderer.removeListener('autopilot:changed', listener)
  },
}
contextBridge.exposeInMainWorld('autopilot', api)
