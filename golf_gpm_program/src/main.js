const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
require('./utils/logger');

// 외부 API 및 Puppeteer 제어 모듈
const tokenManager = require('./services/tokenManager');
const { fetchStoreInfo } = require('./utils/api');
const { login } = require('./services/puppeteer');



// 🌐 브라우저 창 생성 함수
function createWindow() {
    nodeLog(" ✅ createWindow 호출됨");

    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });

    nodeLog(" 📄 index.html 로드");
    win.loadFile('index.html');

    // 개발자 도구
    // win.webContents.openDevTools({ mode: 'detach' });
}


// 🌐 앱이 준비되면 창 생성
app.whenReady().then(() => {
    nodeLog(" 🚀 앱 준비됨, 창 생성 시작");
    createWindow();
});


// 🔒 모든 창이 닫히면 앱 종료 (Windows 대응)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        nodeLog(" 🛑 모든 창 닫힘 → 앱 종료");
        app.quit();
    }
});


// 앱 종료 시 토큰 자동 갱신 중지
app.on('will-quit', () => {
    nodeLog(" ❎ 앱 종료 감지 → 토큰 갱신 중지");
    tokenManager.stop();
});


// 🧠 설정 저장
ipcMain.on('save-settings', (event, { key, value }) => {
    nodeLog(` 💾 [설정 저장 요청] key: "${key}", value: "${value}"`);
    store.set(key, value);
});


// 🧠 설정 불러오기
ipcMain.handle('load-settings', (event, key) => {
    const value = store.get(key);
    nodeLog(` 📥 [설정 불러오기 요청] key: "${key}" → value: "${value}"`);
    return value;
});


// 🧠 렌더러 로그 수신
ipcMain.on('log-from-renderer', (event, message) => {
    nodeLog(`[RENDER] ${message}`);
});


// 🧠 크롤링 시작 요청 수신
ipcMain.on('start-crawl', async (_, { userId, password, storeId }) => {
    try {
        // 1. 토큰 준비
        await tokenManager.start(storeId);
        const token = await tokenManager.getTokenAsync();

        // 2. 로그인 및 예약 페이지 탭 열기
        const newPage = await login({ userId, password, token });

    } catch (err) {
        nodeError("❌ start-crawl 처리 중 에러:", err);
    }
});


// 🧠 매장 정보 요청
ipcMain.handle('fetch-store-info', async (event, storeId) => {
    nodeLog(` 🔍 매장 정보 요청 수신 → storeId: ${storeId}`);

    try {
        await tokenManager.start(storeId); // ✅ 토큰 갱신 시작 및 초기 토큰 확보
        const token = await tokenManager.getTokenAsync(); // ✅ 토큰 직접 획득
        const data = await fetchStoreInfo(token, storeId); // ✅ 토큰과 storeId를 함께 전달

        return { store: data };
    } catch (e) {
        nodeError("❌ 매장 정보 불러오기 실패:", e);
        return null;
    }
});