// src/utils/api.js
const axios = require('axios');


const BASE_URL = 'https://api.dev.24golf.co.kr'; //개발환경
//const BASE_URL = 'https://api.24golf.co.kr'; //운영환경

/**
 * ✅ 파라미터 타입에 따라 URL 조립
 * - paramType: 'm' → fields
 * - paramType: 'g' → group
 * - 그 외 → 기본 crawl
 */
function buildUrl(storeId, paramType = null) {
    if (!storeId) throw new Error("❌ storeId is not set");

    let path = 'crawl';
    if (paramType === 'm') path = 'crawl/fields';
    else if (paramType === 'g') path = 'crawl/group';

    return `${BASE_URL}/stores/${storeId}/reservation/${path}`;
}

/**
 * ✅ 공통 응답 핸들링
 */
async function handleResponse(promise, methodName) {
    try {
        const res = await promise;
        nodeLog(`✅ ${methodName} 판도서버 ${res.status} : 성공`);
        return res.data;
    } catch (err) {
        if (err.response) {
            nodeError(`❌ ${methodName} 응답 오류 (${err.response.status}):`, err.response.data);
        } else if (err.request) {
            nodeError(`❌ ${methodName} 요청 실패 (No response):`, err.message);
        } else {
            nodeError(`❌ ${methodName} 실행 오류:`, err.message);
        }
        throw err;
    }
}

/**
 * POST 요청
 */
async function post(token, storeId, data, paramType = null) {
    const url = buildUrl(storeId, paramType);
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
    return handleResponse(axios.post(url, data, { headers }), 'POST');
}

/**
 * PUT 요청
 */
async function put(token, storeId, data, paramType = null) {
    const url = buildUrl(storeId, paramType);
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
    return handleResponse(axios.put(url, data, { headers }), 'PUT');
}

/**
 * PATCH 요청
 */
async function patch(token, storeId, data, paramType = null) {
    const url = buildUrl(storeId, paramType);
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
    return handleResponse(axios.patch(url, data, { headers }), 'PATCH');
}

/**
 * DELETE 요청
 */
async function del(token, storeId, data, paramType = null) {
    const url = buildUrl(storeId, paramType);
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
    return handleResponse(axios.delete(url, { headers, data }), 'DELETE');
}

/**
 * ✅ API 서버로부터 토큰 직접 발급 요청 (캐싱 없음)
 */
async function fetchTokenFromApi(storeId) {
    const url = `${BASE_URL}/auth/token/stores/${storeId}/role/singleCrawler`;
    nodeLog(`🔑 토큰 요청: ${url}`);

    try {
        const res = await axios.get(url, { timeout: 3000 });
        if (res.status === 200) {
            const token = res.data?.token || res.data;
            nodeLog("✅ 토큰 발급 성공");
            return token;
        } else {
            nodeLog("⚠️ 토큰 발급 응답 오류:", res.status);
        }
    } catch (err) {
        nodeError("❌ 토큰 요청 실패:", err.message);
    }

    nodeLog("⚠️ fallback 토큰 반환");
    return null;
}

/**
 * ✅ 매장 정보 조회
 */
async function fetchStoreInfo(token, storeId) {
    const url = `${BASE_URL}/stores/${storeId}`;
    try {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return res.data;
    } catch (err) {
        nodeError("❌ 매장 정보 요청 실패:", err.message);
        return null;
    }
}

module.exports = {
    post,
    put,
    patch,
    del,
    fetchTokenFromApi,
    fetchStoreInfo,
};
