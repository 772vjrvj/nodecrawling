// src/main/appService.js
const tokenManager = require('../services/tokenManager');
const { login, shutdownBrowser } = require('../services/puppeteer'); // === 신규 === rollback용
const { startApiServer } = require('../server/apiServer');

// === 신규 === 동시 시작 방지 플래그
let __starting = false;

//region ==================== 앱 시작 ====================
// 확인 완료 2025-09-13 ksh
async function startApp(storeId, userId, password, chromePath) {
    if (__starting) {
        nodeLog('⏳ startApp 이미 진행 중 → 요청 무시');
        return;
    }
    __starting = true;

    let step = 'init';

    try {
        // (선택) 빠른 사전 검증
        if (!storeId || !userId || !password) {
            throw new Error('필수 인자 누락(storeId/userId/password)');
        }

        step = 'tokenManager.start';
        await tokenManager.start(storeId);

        step = 'login';

        // === 신규 === 로그인 3회 재시도
        let loginError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                nodeLog(`🔑 login 시도 ${attempt}/3`);
                await login({ userId, password, chromePath });
                loginError = null;
                break; // 성공하면 루프 종료
            } catch (e) {
                loginError = e;
                nodeError(`❌ login 실패(${attempt}/3):`, (e && e.message) || String(e));
                if (attempt < 3) {
                    await new Promise(res => setTimeout(res, 3000)); // === 신규 === 재시도 전 대기
                }
            }
        }
        if (loginError) throw loginError; // 3회 실패 시 에러 처리


        step = 'apiServer.start';
        await startApiServer();

        nodeLog('✅ startApp 정상 시작됨');
    } catch (e) {
        nodeError('❌ startApp 실패(' + step + '):', (e && e.message) || String(e));

        // === 신규 === 롤백: 단계별 정리
        try {
            if (step === 'login' || step === 'apiServer.start') {
                // 로그인 시도 이후 실패 구간 → 브라우저 정리
                await shutdownBrowser();
            }
        } catch (e2) {
            nodeError('rollback: shutdownBrowser 에러:', (e2 && e2.message) || String(e2));
        }
        try {
            if (step !== 'init') {
                // tokenManager.start 이후면 정리
                tokenManager.stop();
            }
        } catch (e3) {
            nodeError('rollback: tokenManager.stop 에러:', (e3 && e3.message) || String(e3));
        }

        throw e; // 원인 전달(상위에서 필요시 처리)
    } finally {
        __starting = false;
    }
}
//endregion

module.exports = { startApp };
