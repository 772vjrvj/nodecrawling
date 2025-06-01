// Electron에서 애플리케이션 생성과 윈도우 관리, IPC 통신을 위한 모듈 불러오기
const { app, BrowserWindow, ipcMain } = require('electron');
// 경로 관련 유틸리티 모듈 (preload.js 경로 구성에 사용)
const path = require('path');
// 사용자 설정 저장을 위한 커스텀 모듈(store.js)
const store = require('./store');

// 브라우저 창을 생성하는 함수
function createWindow() {
    console.log("[NODE] ✅ createWindow 호출됨");

    const win = new BrowserWindow({
        width: 800,      // 창 너비
        height: 600,     // 창 높이
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // preload 스크립트 지정 (렌더러에서 Node.js 접근을 제한하면서 일부 API만 노출)
            contextIsolation: true // 보안 강화: preload에서만 Electron API 접근 가능하도록 분리
        }
    });

    // index.html 파일을 창에 로드
    console.log("[NODE] 📄 index.html 로드");
    win.loadFile('index.html');

    // 개발자 도구 열기 (브라우저 로그 확인용)
    // win.webContents.openDevTools({ mode: 'detach' }); // 또는 'undocked', 'bottom' 등
}

// 앱이 준비되면 창 생성
app.whenReady().then(() => {
    console.log("[NODE] 🚀 앱 준비됨, 창 생성 시작");
    createWindow();
});

// 렌더러에서 'save-settings' 메시지를 보내면 설정을 저장
ipcMain.on('save-settings', (event, { key, value }) => {
    console.log(`[NODE] 💾 [설정 저장 요청] key: "${key}", value: "${value}"`);
    store.set(key, value);
});

// 렌더러에서 'load-settings' 호출 시 키에 해당하는 값을 반환
ipcMain.handle('load-settings', (event, key) => {
    const value = store.get(key);
    console.log(`[NODE] 📥 [설정 불러오기 요청] key: "${key}" → value: "${value}"`);
    return value;
});

// 렌더러에서 전송된 로그 출력
ipcMain.on('log-from-renderer', (event, message) => {
    console.log(`[BROWSER] ${message}`);
});
