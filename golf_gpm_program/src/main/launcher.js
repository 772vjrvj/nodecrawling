// src/main/launcher.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('../store');
require('../utils/logger'); // nodeLog/nodeError 글로벌 가정

const relaunch = require('../utils/relaunch'); // 중앙 재시작 유틸
const { createWindow, showMainWindow, getMainWindow, createTray } = require('./windowManager');
// ipc 라우트는 require 시점에 바인딩됨
require('./ipcRoutes');

const tokenManager = require('../services/tokenManager');
const { shutdownBrowser } = require('../services/puppeteer');
const { stopApiServer } = require('../server/apiServer');
const { detectChromePath } = require('../utils/env');
const { startApp } = require('./appService'); // IPC와 런처에서 동일 startApp 재사용


//region ==================== 앱 종료 ====================
// 확인 완료 2025-09-13 ksh
async function quitApp() {
    if (app.isQuitting) return; // 중복 호출 가드
    app.isQuitting = true;
    nodeLog('🛑 전체 종료 처리 시작');

    try { relaunch.blockRelaunch(); } catch (e) { nodeError('relaunch 차단 중 에러:', (e && e.message) || String(e)); }
    try { tokenManager.stop(); } catch (e) { nodeError('tokenManager 종료 중 에러:', (e && e.message) || String(e)); }
    try { await shutdownBrowser(); } catch (e) { nodeError('Puppeteer 종료 중 에러:', (e && e.message) || String(e)); }
    try { await stopApiServer(); } catch (e) { nodeError('API 서버 종료 중 에러:', (e && e.message) || String(e)); }

    // 트레이 dispose (windowManager에 create만 있으므로 여기서 안전 파기)
    try { if (global.__tray__) { global.__tray__.destroy(); global.__tray__ = null; } }
    catch (e) { nodeError('트레이 해제 중 에러:', (e && e.message) || String(e)); }

    app.quit(); // graceful
}
//endregion


//region ==================== 자동 시작(복구) ====================
//  - autoLogin=T 이고 storeId/userId/password/chromePath가 준비되었을 때
//  - Puppeteer 로그인
//  - API 서버 스타트
// 확인 완료 2025-09-13 ksh
async function tryAutoStartOnBoot() {
    try {
        const autoLogin = String(store.get('login/autoLogin') || '').toUpperCase() === 'T';
        if (!autoLogin) { nodeLog('⏭️ autoLogin=F → 자동 시작 생략'); return false; }

        const storeId = store.get('store/id');
        const userId = store.get('login/id');
        const password = store.get('login/password');
        if (!storeId || !userId || !password) { nodeLog('⛔ autoStart 조건 부족 → 생략'); return false; }

        let chromePath = store.get('chrome/path') || '';
        if (!chromePath) chromePath = detectChromePath();
        if (!chromePath) { nodeLog('⛔ chromePath 없음 → 자동 시작 불가'); return false; }

        await startApp(storeId, userId, password, chromePath);
        nodeLog('✅ 자동 시작 완료(autoLogin=T)');
        return true;
    } catch (e) {
        nodeError('❌ 자동 시작 실패:', (e && e.message) || String(e));
        return false;
    }
}
//endregion


//region ==================== 재시작 유틸 DI 등록 (정리 작업 통합) ====================
function wireRelaunchDI() {
    relaunch.registerCleanup(() => { try { tokenManager.stop(); } catch (e) { nodeError('tokenManager 종료 에러:', (e && e.message) || String(e)); } });
    relaunch.registerCleanup(async () => { try { await shutdownBrowser(); } catch (e) { nodeError('Puppeteer 종료 에러:', (e && e.message) || String(e)); } });
    relaunch.registerCleanup(async () => { try { await stopApiServer(); } catch (e) { nodeError('API 서버 종료 에러:', (e && e.message) || String(e)); } });
    relaunch.registerCleanup(() => { try { if (global.__tray__) { global.__tray__.destroy(); global.__tray__ = null; } } catch (e) { nodeError('트레이 해제 에러:', (e && e.message) || String(e)); } });
}
//endregion


//region ==================== 부트스트랩 (엔트리에서 호출) ====================
function bootstrap() {
    // 종료 상태 플래그 초기화
    app.isQuitting = false;

    // Electron 내장 함수
    // 앱 실행 시 “이 인스턴스가 최초 실행인지 여부” 확인.
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
        //이미 실행된 앱이 있으면 → 현재 프로세스는 바로 종료.
        app.quit();
        try { process.exit(0); } catch (_) {}
        return;
    }
    // 최초 실행 시 리스너 등록 → 재실행 시 새 인스턴스는 종료, 기존 인스턴스에서 second-instance 발동
    // 이미 실행 중 → 창만 보여주기
    app.on('second-instance', () => { showMainWindow(); });

    if (process.platform === 'win32') {
        // AppUserModelID는 윈도우가 “이 알림/아이콘은 이 프로그램 것이다”라고 연결해주는 고유 이름표예요.
        // app.setAppUserModelId(...) 자체는 윈도우에 “내 앱 이름표”를 붙여두는 것
        // 실제로 눈에 보이는 효과가 나타나는 건 알림이나 뱃지 기능을 쓸 때
        // 지금은 new Notification를 사용하지 않으니 형식상 넣은것임
        app.setAppUserModelId('com.pandop.hooking');
    }

    // 재시작 DI
    wireRelaunchDI();

    app.whenReady().then(async () => {
        nodeLog('🚀 앱 준비됨, 트레이/창 생성');
        // 트레이 콜백 주입: windowManager가 global.__onQuit__/__onShow__ 사용
        global.__onQuit__ = async () => { try { await quitApp(); } catch (e) { nodeError('tray onQuit 에러:', (e && e.message) || String(e)); } };
        global.__onShow__ = () => { try { showMainWindow(); } catch (_) {} };

        createTray();
        createWindow();

        // 임시 로그 정리 (launcher가 src/main/에 있으니 최상위 logs로 2단계 업)
        try {
            fs.unlinkSync(path.join(__dirname, '..', '..', 'logs', 'reservation-log.json.tmp'));
        } catch (e) { if (e && e.code !== 'ENOENT') nodeError('⚠️ 로그 파일 삭제 실패:', (e && e.message) || String(e)); }

        // 자동 복구
        await tryAutoStartOnBoot();
    });

    // 종료 훅
    app.on('before-quit', () => {
        app.isQuitting = true;
    });
}
//endregion

module.exports = { bootstrap };
