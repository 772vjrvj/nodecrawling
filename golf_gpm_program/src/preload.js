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


    requestRelaunch: (reason) => ipcRenderer.invoke('request-relaunch', reason),


    // === 신규 === 인증 만료 이벤트 구독/해제/1회 구독
    onAuthExpired: (handler) => {
        if (typeof handler !== 'function') return () => {};
        const listener = (event, payload) => {
            try { handler(payload); }
            catch (e) { console.error('onAuthExpired handler error:', (e && e.message) || String(e)); }
        };
        ipcRenderer.on('auth-expired', listener);
        // 호출 측에서 해제할 수 있도록 unsubscribe 반환
        return () => {
            try { ipcRenderer.removeListener('auth-expired', listener); }
            catch (e) { console.error('removeListener error:', (e && e.message) || String(e)); }
        };
    },

    // === 신규 === 필요 시 1회성 구독도 제공
    onceAuthExpired: (handler) => {
        if (typeof handler !== 'function') return;
        ipcRenderer.once('auth-expired', (event, payload) => {
            try { handler(payload); }
            catch (e) { console.error('onceAuthExpired handler error:', (e && e.message) || String(e)); }
        });
    },


    quit: () => ipcRenderer.invoke('app:quit'),

});