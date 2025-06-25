//src/services/tokenManager.js
const { fetchTokenFromApi } = require('../utils/api');

const TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2OTBkN2VhNzUwZmY5YTY2ODllOWFmMyIsInJvbGUiOiJzaW5nbGVDcmF3bGVyIiwiZXhwIjo0ODk4ODQ0MDc3fQ.aEUYvIzMhqW6O2h6hQTG8IfzJNhpvll4fOdN7udz1yc"
let cachedToken = null;
let refreshInterval = null;
let storeId = null;

/**
 * 토큰 갱신
 */
async function refreshToken(currentStoreId) {
    if (!currentStoreId) return;
    try {
        const token = await fetchTokenFromApi(currentStoreId);
        if (!token) throw new Error("null token");
        cachedToken = token;
        nodeLog("✅ 토큰 갱신 완료");
    } catch (e) {
        nodeLog("❌ 토큰 갱신 실패, fallback 사용");
        if (process.env.NODE_ENV === 'production') {
            throw new Error("❌ 프로덕션에서 fallback 토큰 사용 불가");
        }
        cachedToken = TEST_TOKEN;
    }
}

/**
 * 갱신 루프 시작
 */
async function start(storeIdParam) {
    if (storeId === storeIdParam && refreshInterval && cachedToken) return;

    stop();
    storeId = storeIdParam;

    await refreshToken(storeId);

    refreshInterval = setInterval(() => refreshToken(storeId), 60 * 60 * 1000);
}

/**
 * 갱신 중단
 */
function stop() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        nodeLog("🛑 자동 갱신 종료됨");
    }
}

function getStoreId() {
    return storeId;
}

function getToken() {
    return cachedToken;
}

/**
 * 토큰이 생길 때까지 기다림 (최대 5초)
 */
async function getTokenAsync(retries = 10, interval = 500) {
    for (let i = 0; i < retries; i++) {
        if (cachedToken) return cachedToken;
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    nodeLog("⚠️ getTokenAsync: 토큰 획득 실패");
    if (process.env.NODE_ENV === 'production') {
        throw new Error("⚠️ 프로덕션에서 fallback 금지");
    }
    return TEST_TOKEN;
}

module.exports = {
    start,
    stop,
    getToken,
    getTokenAsync,
    getStoreId,
};
