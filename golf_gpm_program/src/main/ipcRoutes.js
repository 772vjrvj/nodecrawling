// src/main/ipcRoutes.js
const { ipcMain, dialog } = require('electron');

const store = require('../store');
const tokenManager = require('../services/tokenManager');
const { fetchStoreInfo } = require('../utils/api');
const { detectChromePath } = require('../utils/env');          // === 신규 ===
const { startApp } = require('./appService');                   // === 신규 ===


// 파일 최상단 (require 직후)
if (global.__ipcRoutesInit__) {
    // 이미 바인딩됨 → 다시 등록하지 않음
    // 필요 시 로그만 남겨도 됨:
    nodeLog('ℹ️ ipcRoutes already initialized');
} else {
    global.__ipcRoutesInit__ = true;

    //region ==================== 앱 시작 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.on('start-crawl', async (event, { userId, password, storeId, chromePath }) => {
        try {
            await startApp(storeId, userId, password, chromePath);
            nodeLog('✅ start-crawl 성공');
        } catch (err) {
            nodeLog('❌ start-crawl 실패:', (err && err.message) || String(err));
        }
    });
    //endregion


    //region ==================== 크롬 경로 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.handle('get-chrome-path', () => detectChromePath());
    //endregion


    //region ==================== 로그인, 매장, 자동시작, 크롬경로 등 json 저장 정보 세팅 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.on('save-settings', (event, { key, value }) => {
        nodeLog('💾 [저장 요청] key: ' + key + ', value: ' + value);
        store.set(key, value);
        nodeLog('✅ 저장 완료. 현재값: ' + store.get(key));
    });
    //endregion


    //region ==================== 로그인, 매장, 자동시작, 크롬경로 등 json 저장 정보 로드 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.handle('load-settings', (event, key) => {
        const value = store.get(key);
        nodeLog('📥 [설정 불러오기 요청] key: "' + key + '" → value: "' + value + '"');
        return value;
    });
    //endregion


    //region ==================== 매장 정보 요청 수신 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.handle('fetch-store-info', async (event, storeId) => {
        nodeLog('🔍 매장 정보 요청 수신 → storeId: ' + storeId);
        try {
            await tokenManager.start(storeId);
            const token = await tokenManager.getTokenAsync();
            const data = await fetchStoreInfo(token, storeId);
            return { store: data };
        } catch (e) {
            nodeError('❌ 매장 정보 불러오기 실패:', (e && e.message) || String(e));
            return null;
        }
    });
    //endregion


    //region ==================== 크롬 경로 선택 모달 ====================
    // 확인 완료 2025-09-13 ksh
    ipcMain.handle('open-chrome-path-dialog', async () => {
        const result = await dialog.showOpenDialog({
            title: '크롬 실행 파일 선택',
            defaultPath: 'C:\\Program Files\\Google\\Chrome\\Application',
            filters: [{ name: 'Executable', extensions: ['exe'] }],
            properties: ['openFile'],
        });
        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
            nodeLog('📁 크롬 경로 선택됨: ' + result.filePaths[0]);
            return result.filePaths[0];
        }
        nodeLog('❌ 크롬 경로 선택 취소됨');
        return null;
    });
    //endregion
}
