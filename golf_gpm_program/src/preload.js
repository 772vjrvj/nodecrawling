//src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

// contextBridge로 electronAPI라는 전역 객체를 노출
contextBridge.exposeInMainWorld('electronAPI', {
    // 크롤링 시작 요청 (추후 구현 가능)
    startCrawl: (data) => {
        console.log('📤 startCrawl 호출됨:', data);
        ipcRenderer.send('start-crawl', data);
    },

    // 설정 저장 요청
    saveSettings: (key, value) => {
        console.log(`💾 saveSettings 호출됨 → key: ${key}, value: ${value}`);
        ipcRenderer.send('save-settings', { key, value });
    },

    // 설정 불러오기 요청 (비동기)
    loadSettings: async (key) => {
        console.log(`📥 loadSettings 호출됨 → key: ${key}`);
        const result = await ipcRenderer.invoke('load-settings', key);
        console.log(`📥 loadSettings 결과 → key: ${key}, value: ${result}`);
        return result;
    },

    fetchStoreInfo: async (storeId) => {
        return await ipcRenderer.invoke('fetch-store-info', storeId);
    },

    // ✅ 추가된 부분
    getChromePath: async () => {
        const result = await ipcRenderer.invoke('get-chrome-path');
        console.log(`🔍 getChromePath 결과: ${result}`);
        return result;
    },

    openChromePathDialog: () => ipcRenderer.invoke('open-chrome-path-dialog'),


    onCrawlError: (callback) => {
        ipcRenderer.on('crawl-error', (_, message) => {
            callback(message);
        });
    },

    onAuthExpired: (callback) => {
        ipcRenderer.on('auth-expired', () => {
            callback();
        });
    },

    quitApp: () => ipcRenderer.invoke('quit-app')

});

