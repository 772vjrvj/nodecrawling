// src/main.js
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');

const path = require('path');
const fs = require('fs');

const store = require('./store');
require('./utils/logger'); // nodeLog / nodeError 가 글로벌로 있다고 가정
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
        // 이미 실행 중 → 창만 보여주기
        showMainWindow();
    });
}

// ─────────────────────────────────────────────────────────
// 전역
// ─────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

// Windows 알림/배지용 AppUserModelID
if (process.platform === 'win32') {
    app.setAppUserModelId('com.pandop.hooking');
}

// ─────────────────────────────────────────────────────────
// 경로 유틸
// ─────────────────────────────────────────────────────────
function getAsset(relPath) {
    // 패키징: resourcesPath 기준
    if (app.isPackaged) return path.join(process.resourcesPath, relPath);
    // 개발: 프로젝트 루트(= src 상위) 기준
    return path.join(__dirname, '..', relPath);
}

// ─────────────────────────────────────────────────────────
// 크롬 경로 자동 탐지
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
// 트레이 생성
// ─────────────────────────────────────────────────────────
function createTray() {
    const candidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'assets', 'tray.ico'),                 // extraResources 배치
            path.join(process.resourcesPath, 'assets', 'icons', '판도P-ICON.ico')   // (옵션) 보조
        ]
        : [
            path.join(__dirname, '..', 'assets', 'tray.ico'),
            path.join(__dirname, '..', 'assets', 'icons', '판도P-ICON.ico')
        ];

    let img = null;
    for (const p of candidates) {
        const ni = nativeImage.createFromPath(p);
        if (!ni.isEmpty()) { img = ni; nodeLog(`🖼️ Tray icon: ${p}`); break; }
        nodeLog(`⚠️ Not found/empty: ${p}`);
    }
    if (!img) {
        const buf = Buffer.from('iVBORw0K...gg==','base64'); // 1x1 투명
        img = nativeImage.createFromBuffer(buf);
        nodeError('🚨 No tray icon. Using transparent fallback.');
    }
    try {
        global.__tray__ = new Tray(img);
    } catch (e) {
        nodeError('❌ Tray creation failed. Showing window.', e);
        showMainWindow();
        return;
    }

    global.__tray__.setToolTip('PandoP');

    const menu = Menu.buildFromTemplate([
        { label: '열기    ', click: () => showMainWindow() },
        { type: 'separator' },
        // {
        //     label: '부팅 시 창 보이기',
        //     type: 'checkbox',
        //     checked: !!store.get('ui.showOnStartup', false),
        //     click: (item) => store.set('ui.showOnStartup', item.checked),
        // },
        { type: 'separator' },
        { label: '종료    ', click: async () => await quitApp() },
    ]);
    global.__tray__.setContextMenu(menu);
    global.__tray__.on('click', () => showMainWindow());
}

// ─────────────────────────────────────────────────────────
// 메인 윈도우
//  - 기본 show:false + skipTaskbar:true → 트레이 앱 스타일
//  - 닫기/최소화 시 종료 대신 숨김
// ─────────────────────────────────────────────────────────
function createWindow() {
    nodeLog('✅ createWindow 호출됨');
    mainWindow = new BrowserWindow({
        width: 980,
        height: 760,
        show: false,             // ← 처음엔 숨김
        autoHideMenuBar: true,
        skipTaskbar: true,       // ← 작업표시줄 숨김 (트레이 전용)
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    });

    nodeLog('📄 index.html 로드');
    mainWindow.loadFile('index.html');

    // 닫기 → 숨김
    mainWindow.on('close', (e) => {
        if (!app.isQuiting) {
            e.preventDefault();
            hideToTray();
        }
    });

    // 최소화 → 숨김
    mainWindow.on('minimize', (e) => {
        e.preventDefault();
        hideToTray();
    });
}

function showMainWindow() {
    if (!mainWindow) return;
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
}

function hideToTray() {
    if (!mainWindow) return;
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
}

// ─────────────────────────────────────────────────────────
// 자동 시작(복구)
//  - autoLogin=T 이고 storeId/userId/password/chromePath가 준비되었을 때
//  - Puppeteer + API 서버 스타트
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

// ─────────────────────────────────────────────────────────
async function quitApp() {
    app.isQuiting = true;
    nodeLog('🛑 전체 종료 처리 시작');
    blockRelaunch();
    try {
        await shutdownBrowser();
    } catch (e) {
        nodeError('Puppeteer 종료 중 에러:', e);
    }
    try {
        stopApiServer();
    } catch (e) {
        nodeError('API 서버 종료 중 에러:', e);
    }
    app.quit();
}

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

ipcMain.handle('get-chrome-path', () => detectChromePath());

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
    await quitApp();
});

// 렌더러에서 "트레이로" 요청할 때
ipcMain.on('ui:hide-to-tray', () => hideToTray());

// 렌더러가 직접 재시작 요청할 때 (옵션)
ipcMain.handle('request-relaunch', (event, reason) => {
    nodeLog(`🔁 renderer 요청으로 앱 재시작: ${reason || 'unknown'}`);
    requestRelaunch({ reason: reason || 'renderer' });
});

// ─────────────────────────────────────────────────────────
// 앱 수명주기
// ─────────────────────────────────────────────────────────
app.on('before-quit', () => {
    nodeLog('👋 before-quit → block relaunch');
    blockRelaunch();
});

app.on('window-all-closed', () => {
    nodeLog('🛑 모든 창 닫힘 → 앱 종료');
    blockRelaunch();
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    nodeLog('❎ 앱 종료 감지 → 토큰 갱신 중지');
    tokenManager.stop();
});

app.whenReady().then(async () => {
    nodeLog('🚀 앱 준비됨, 트레이/창 생성');
    createTray();     // 트레이 먼저
    createWindow();   // 창 생성

    const showOnStartup = !!store.get('ui.showOnStartup', false);

    // 한 번만 실행될 초기 UI 로직
    const initUI = () => {
        // 임시 로그 정리 (있으면)
        try {
            fs.unlinkSync(path.join(__dirname, '..', 'logs', 'reservation-log.json.tmp'));
        } catch (_) {}

        // 트레이 생성 실패했거나, 사용자가 "부팅 시 창 보이기"를 켠 경우 → 창 표시
        if (!global.__tray__ || showOnStartup) {
            showMainWindow();
        } else {
            // 기본 정책: 트레이 전용 시작(창 숨김 + 작업표시줄 제외)
            hideToTray();
        }
    };

    // ready-to-show가 이미 발행됐을 가능성까지 커버
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.once('ready-to-show', initUI);
    } else {
        // 안전 폴백
        setImmediate(initUI);
    }

    // 자동 복구 시도 (autoLogin=T일 때만 동작)
    await tryAutoStartOnBoot();
});
