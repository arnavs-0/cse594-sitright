import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  sendNotification: (title: string, body: string) =>
    ipcRenderer.invoke('send-notification', title, body),
  showOverlay: (status: string) =>
    ipcRenderer.invoke('overlay-show', status),
  hideOverlay: () =>
    ipcRenderer.invoke('overlay-hide'),
  platform: process.platform,
})
