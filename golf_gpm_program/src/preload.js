//src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startCrawl: (data) => {
        console.log('📤 startCrawl 호출됨:', data);
        ipcRenderer.send('start-crawl', data);
    },

    saveSettings: (key, value) => {
        console.log(`💾 saveSettings 호출됨 → key: ${key}, value: ${value}`);
        ipcRenderer.send('save-settings', { key, value });
    },

    loadSettings: async (key) => {
        console.log(`📥 loadSettings 호출됨 → key: ${key}`);
        const result = await ipcRenderer.invoke('load-settings', key);
        console.log(`📥 loadSettings 결과 → key: ${key}, value: ${result}`);
        return result;
    },

    fetchStoreInfo: async (storeId) => {
        return await ipcRenderer.invoke('fetch-store-info', storeId);
    },

    getChromePath: async () => {
        const result = await ipcRenderer.invoke('get-chrome-path');
        console.log(`🔍 getChromePath 결과: ${result}`);
        return result;
    },

    openChromePathDialog: () => ipcRenderer.invoke('open-chrome-path-dialog'),

    // ✅ 구독 → 언구독 함수 반환(메모리릭/중복 핸들러 방지)
    onCrawlError: (callback) => {
        const handler = (_, message) => callback(message);
        ipcRenderer.on('crawl-error', handler);
        return () => ipcRenderer.removeListener('crawl-error', handler);
    },

    onAuthExpired: (callback) => {
        const handler = () => callback();
        ipcRenderer.on('auth-expired', handler);
        return () => ipcRenderer.removeListener('auth-expired', handler);
    },

    requestRelaunch: (reason) => ipcRenderer.invoke('request-relaunch', reason),

    quitApp: () => ipcRenderer.invoke('quit-app'),
});