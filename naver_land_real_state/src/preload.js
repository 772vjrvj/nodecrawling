// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    login: (payload) => ipcRenderer.invoke('login', payload),
    resolveChromePath: () => ipcRenderer.invoke('resolve-chrome-path'),
    openNaver: (exePath) => ipcRenderer.invoke('open-naver', { exePath })
});
