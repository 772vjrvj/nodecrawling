// src/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const fs = require('fs');
require('./utils/logger');
const { dialog } = require('electron');
const tokenManager = require('./services/tokenManager');
const { fetchStoreInfo } = require('./utils/api');
const { login, shutdownBrowser } = require('./services/puppeteer');
const { startApiServer, stopApiServer } = require('./server/apiServer');
const { requestRelaunch, blockRelaunch, unblockRelaunch } = require('./utils/relaunch');


// ─────────────────────────────────────────────────────────
// 단일 인스턴스 보장
// ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

// ─────────────────────────────────────────────────────────
// 메인 프로세스용 크롬 경로 자동 탐지
// ─────────────────────────────────────────────────────────
function detectChromePath() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            nodeLog(`🔍 [auto] 크롬 경로 탐지 성공: ${p}`);
            return p;
        }
    }
    nodeLog('⚠️ [auto] 크롬 경로 탐지 실패');
    return '';
}

// ─────────────────────────────────────────────────────────
// 부팅/재시작 시 자동 시작(자동 복구)
// ─────────────────────────────────────────────────────────
async function tryAutoStartOnBoot() {
    try {
        const storeId   = store.get('store/id');
        const userId    = store.get('login/id');
        const password  = store.get('login/password');
        const autoLogin = String(store.get('login/autoLogin') || '').toUpperCase() === 'T';

        if (!autoLogin) {
            nodeLog('⏭️ autoLogin=F → 자동 시작 생략');
            return false;
        }
        if (!storeId || !userId || !password) {
            nodeLog('⛔ autoStart 조건 부족(storeId/userId/password) → 생략');
            return false;
        }

        let chromePath = store.get('chrome/path') || '';
        if (!chromePath) chromePath = detectChromePath();
        if (!chromePath) {
            nodeLog('⛔ chromePath 없음 → 자동 시작 불가');
            return false;
        }

        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        await login({ userId, password, token, chromePath });
        startApiServer();

        nodeLog('✅ 자동 시작 완료(autoLogin=T)');
        return true;
    } catch (e) {
        nodeError('❌ 자동 시작 실패:', e);
        return false;
    }
}

function createWindow() {
    nodeLog('✅ createWindow 호출됨');
    const win = new BrowserWindow({
        width: 800,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    });
    nodeLog('📄 index.html 로드');
    win.loadFile('index.html');
}

// ─────────────────────────────────────────────────────────
// 기본 앱 수명주기
// ─────────────────────────────────────────────────────────

app.on('before-quit', () => {
    nodeLog('👋 before-quit → block relaunch');
    blockRelaunch();
});

app.on('window-all-closed', () => {
    nodeLog("🛑 모든 창 닫힘 → 앱 종료");
    blockRelaunch();                   // ✅ 창 닫고 끝낼 때도 차단
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    nodeLog('❎ 앱 종료 감지 → 토큰 갱신 중지');
    tokenManager.stop();
});

// ─────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────
ipcMain.on('save-settings', (event, { key, value }) => {
    nodeLog(`💾 [저장 요청] key: ${key}, value: ${value}`);
    store.set(key, value);
    nodeLog(`✅ 저장 완료. 현재값: ${store.get(key)}`);
});

ipcMain.on('log-from-renderer', (event, message) => {
    nodeLog(`[RENDER] ${message}`);
});

ipcMain.on('start-crawl', async (event, { userId, password, storeId, chromePath }) => {
    try {
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        await login({ userId, password, token, chromePath });
        startApiServer();
    } catch (err) {
        nodeError('❌ start-crawl 처리 중 에러:', err);
        event.sender.send('crawl-error', err.message || '크롤링 도중 오류 발생');
    }
});

ipcMain.handle('load-settings', (event, key) => {
    const value = store.get(key);
    nodeLog(`📥 [설정 불러오기 요청] key: "${key}" → value: "${value}"`);
    return value;
});

ipcMain.handle('fetch-store-info', async (event, storeId) => {
    nodeLog(`🔍 매장 정보 요청 수신 → storeId: ${storeId}`);
    try {
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();
        const data = await fetchStoreInfo(token, storeId);
        return { store: data };
    } catch (e) {
        nodeError('❌ 매장 정보 불러오기 실패:', e);
        return null;
    }
});

// 자동 탐지 결과만 반환 (중복 로직 정리)
ipcMain.handle('get-chrome-path', () => detectChromePath());

// 크롬 실행 파일 선택
ipcMain.handle('open-chrome-path-dialog', async () => {
    const result = await dialog.showOpenDialog({
        title: '크롬 실행 파일 선택',
        defaultPath: 'C:\\Program Files\\Google\\Chrome\\Application',
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        properties: ['openFile'],
    });

    if (!result.canceled && result.filePaths.length > 0) {
        nodeLog(`📁 크롬 경로 선택됨: ${result.filePaths[0]}`);
        return result.filePaths[0];
    }

    nodeLog('❌ 크롬 경로 선택 취소됨');
    return null;
});

ipcMain.handle('quit-app', async () => {
    nodeLog('🛑 전체 종료 처리 시작');
    blockRelaunch();                   // ✅ 사용자가 “종료” 버튼 눌렀을 때
    await shutdownBrowser();
    stopApiServer();
    app.quit();
});


// 렌더러가 직접 재시작 요청할 때 (옵션)
ipcMain.handle('request-relaunch', (event, reason) => {
    nodeLog(`🔁 renderer 요청으로 앱 재시작: ${reason || 'unknown'}`);
    requestRelaunch({ reason: reason || 'renderer' });
});

// ─────────────────────────────────────────────────────────
// 앱 준비 시: 창 생성 + 자동 복구 트리거
// ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
    nodeLog('🚀 앱 준비됨, 창 생성 시작');
    createWindow();

    // (옵션) 로그 tmp 정리
    try { fs.unlinkSync(path.join(__dirname, '..', 'logs', 'reservation-log.json.tmp')); } catch (_) {}

    // 자동 복구 시도 (autoLogin=T이어야 작동)
    tryAutoStartOnBoot();
});
