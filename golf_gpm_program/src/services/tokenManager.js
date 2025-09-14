//src/services/tokenManager.js
const { fetchTokenFromApi } = require('../utils/api');

let cachedToken = null;
let refreshInterval = null;
let storeId = null;


//region ==================== 토큰 갱신 ====================
// 확인 완료 2025-09-13 ksh
async function refreshToken(currentStoreId) {
    if (!currentStoreId) return;
    try {
        cachedToken = await fetchTokenFromApi(currentStoreId);
        nodeLog("✅ 토큰 갱신 완료");
    } catch (e) {
        nodeLog("❌ 토큰 갱신 실패, fallback 사용");
    }
}
//endregion


//region ==================== 토큰 갱신 루프 ====================
// 확인 완료 2025-09-13 ksh
async function start(storeIdParam) {
    if (storeId === storeIdParam && refreshInterval && cachedToken) return;

    stop();
    storeId = storeIdParam;

    await refreshToken(storeId);

    refreshInterval = setInterval(() => refreshToken(storeId), 60 * 60 * 1000);
}
//endregion


//region ==================== 토큰 갱신 루프 ====================
// 확인 완료 2025-09-13 ksh
function stop() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        nodeLog("🛑 자동 갱신 종료됨");
    }
}
//endregion


//region ==================== 매장 아이디 ====================
// 확인 완료 2025-09-13 ksh
function getStoreId() {
    return storeId;
}
//endregion


//region ==================== 토큰 응답 (혹시 요청중이면 대기후 응답) ====================
// 확인 완료 2025-09-13 ksh
async function getTokenAsync(retries = 10, interval = 500) {
    for (let i = 0; i < retries; i++) {
        if (cachedToken) return cachedToken;
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    nodeLog("⚠️ getTokenAsync: 토큰 획득 실패");
    if (process.env.NODE_ENV === 'production') {
        throw new Error("⚠️ 프로덕션에서 fallback 금지");
    }
}
//endregion


module.exports = {
    start,
    stop,
    getTokenAsync,
    getStoreId,
};
