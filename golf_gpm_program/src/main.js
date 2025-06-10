// src/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const fs = require('fs');
require('./utils/logger');
const { dialog } = require('electron');


const tokenManager = require('./services/tokenManager');
const { fetchStoreInfo } = require('./utils/api');
const { login } = require('./services/puppeteer');

function createWindow() {
    nodeLog("✅ createWindow 호출됨");

    const win = new BrowserWindow({
        width: 800,
        height: 730,
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

ipcMain.on('start-crawl', async (event, { userId, password, storeId, chromePath }) => {
    try {
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        await login({ userId, password, token, chromePath });
    } catch (err) {
        nodeError("❌ start-crawl 처리 중 에러:", err);

        // 렌더러로 에러 전송
        event.sender.send('crawl-error', err.message || '크롤링 도중 오류 발생');
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


ipcMain.handle('get-chrome-path', () => {
    const possiblePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];

    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
            nodeLog(`🔍 크롬 경로 자동 탐지 성공: ${chromePath}`);
            return chromePath;
        }
    }

    nodeLog("⚠️ 크롬 경로 자동 탐지 실패");
    return '';  // 없으면 빈 문자열 반환
});


ipcMain.handle('open-chrome-path-dialog', async () => {
    const result = await dialog.showOpenDialog({
        title: '크롬 실행 파일 선택',
        defaultPath: 'C:\\Program Files\\Google\\Chrome\\Application',
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        nodeLog(`📁 크롬 경로 선택됨: ${result.filePaths[0]}`);
        return result.filePaths[0];
    }

    nodeLog("❌ 크롬 경로 선택 취소됨");
    return null;
});
