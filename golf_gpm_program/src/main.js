// src/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
require('./utils/logger');

const tokenManager = require('./services/tokenManager');
const { fetchStoreInfo } = require('./utils/api');
const { login } = require('./services/puppeteer');

function createWindow() {
    nodeLog("✅ createWindow 호출됨");

    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });

    nodeLog("📄 index.html 로드");
    win.loadFile('index.html');
}

app.whenReady().then(() => {
    nodeLog("🚀 앱 준비됨, 창 생성 시작");
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        nodeLog("🛑 모든 창 닫힘 → 앱 종료");
        app.quit();
    }
});

app.on('will-quit', () => {
    nodeLog("❎ 앱 종료 감지 → 토큰 갱신 중지");
    tokenManager.stop();
});

ipcMain.on('save-settings', (event, { key, value }) => {
    nodeLog(`💾 [저장 요청] key: ${key}, value: ${value}`);
    store.set(key, value);
    nodeLog(`✅ 저장 완료. 현재값: ${store.get(key)}`);
});

ipcMain.handle('load-settings', (event, key) => {
    const value = store.get(key);
    nodeLog(`📥 [설정 불러오기 요청] key: "${key}" → value: "${value}"`);
    return value;
});

ipcMain.on('log-from-renderer', (event, message) => {
    nodeLog(`[RENDER] ${message}`);
});

ipcMain.on('start-crawl', async (_, { userId, password, storeId }) => {
    try {
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        const newPage = await login({ userId, password, token });
    } catch (err) {
        nodeError("❌ start-crawl 처리 중 에러:", err);
    }
});

ipcMain.handle('fetch-store-info', async (event, storeId) => {
    nodeLog(`🔍 매장 정보 요청 수신 → storeId: ${storeId}`);

    try {
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        const data = await fetchStoreInfo(token, storeId);
        return { store: data };
    } catch (e) {
        nodeError("❌ 매장 정보 불러오기 실패:", e);
        return null;
    }
});
