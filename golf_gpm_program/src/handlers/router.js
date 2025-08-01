//src/handlers/router.js
const querystring = require('querystring');
const { saveRequest, matchAndDispatch } = require('../handlers/hookRouter');

const TARGETS = {
    request: {
        register:    /\/rest\/ui\/booking\/register(\?timestamp=|$)/,
        edit:        /\/rest\/ui\/booking\/\d+\/edit(\?timestamp=|$)/,
        edit_move:   /\/rest\/ui\/booking\/\d+\/ajax-edit(\?timestamp=|$)/,
        delete:      /\/rest\/ui\/booking\/\d+\/delete(\?timestamp=|$)/,
        delete_mobile: /\/rest\/ui\/polling\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)(?=.*\bdata=)(?=.*\bbookingNumber=)/,
        detail:        /\/rest\/ui\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)/
    },
    response: {
        register:    /\/rest\/ui\/booking\/register(\?timestamp=|$)/,
        edit:        /\/rest\/ui\/booking\/\d+\/edit(\?timestamp=|$)/,
        edit_move:   /\/rest\/ui\/booking\/\d+\/ajax-edit(\?timestamp=|$)/,
        delete:      /\/rest\/ui\/booking\/\d+\/delete(\?timestamp=|$)/,
        delete_mobile: /\/rest\/ui\/polling\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)(?=.*\bdata=)(?=.*\bbookingNumber=)/,
        detail:        /\/rest\/ui\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)/
    }
};

function attachRequestHooks(page) {
    // ✅ 캐시 방지를 위한 요청 인터셉션 활성화
    page.setRequestInterception(true).catch(nodeError);

    page.on('request', (req) => {
        const url = req.url();
        const method = req.method();
        const postData = req.postData();
        const headers = {
            ...req.headers(),
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        };

        // ✅ GET 방식 요청 처리 (쿼리스트링만 추출)
        if (method === 'GET') {
            for (const action in TARGETS.request) {
                if (TARGETS.request[action].test(url)) {
                    nodeLog(`➡️ [${method}] ${url}`);
                    nodeLog(`🔍 [${action}] GET 요청 감지됨`);

                    // ❓ saveRequest 를 사용하고 싶으면, 쿼리 파싱 필요
                    const query = new URL(url).searchParams;
                    const parsed = {};
                    for (const [key, value] of query.entries()) {
                        parsed[key] = value;
                    }

                    saveRequest(action, url, parsed); // 선택 사항
                    nodeLog("📤 요청 쿼리 파싱 결과:", JSON.stringify(parsed, null, 2));

                    break;
                }
            }
        }

        // ✅ 요청 저장 및 분석 (POST/PUT only)
        if (['POST', 'PUT'].includes(method) && postData) {
            try {
                let parsedData;
                const contentType = headers['content-type'] || '';

                if (contentType.includes('application/json')) {
                    parsedData = JSON.parse(postData);
                } else if (contentType.includes('application/x-www-form-urlencoded')) {
                    parsedData = querystring.parse(postData);
                } else if (contentType.includes('text/plain')) {
                    // 간단한 key=value 문자열을 querystring으로 파싱
                    parsedData = querystring.parse(postData);
                } else {
                    throw new Error(`Unknown content type: ${contentType}`);
                }

                for (const action in TARGETS.request) {
                    if (TARGETS.request[action].test(url)) {
                        saveRequest(action, url, parsedData);
                        nodeLog(`➡️ [${method}] ${url}`);
                        nodeLog("📤 요청 파싱 결과:", JSON.stringify(parsedData, null, 2));
                        nodeLog(`🔍 [${action}] 요청 감지됨`);
                        break;
                    }
                }
            } catch (e) {
                nodeError("❌ 요청 바디 파싱 실패:");
                nodeError("   ↳ message:", e.message);
                nodeError("   ↳ stack:", e.stack);
                nodeLog("📤 요청 Body (Raw):", postData.slice(0, 500));
            }
        }

        req.continue({ headers }); // ✅ no-cache 헤더로 모든 요청 계속 진행
    });

    page.on('response', async (res) => {
        const url = res.url();
        const status = res.status();

        // ✅ 304 / 204 응답 무시
        if (status === 304 || status === 204) {
            nodeLog(`ℹ️ [${status}] 캐시 응답 무시됨: ${url}`);
            return;
        }

        try {
            const contentType = res.headers()['content-type'] || '';
            if (!contentType.includes('application/json')) return;

            let responseJson;
            try {
                responseJson = await res.json();  // ⛳ 여기를 감쌈
            } catch (e) {
                if (e.message.includes("Could not load body")) {
                    nodeLog(`⚠️ 응답 본문 없음 (무시됨): ${url}`);
                    return;  // 본문이 없으면 응답 분석 생략
                }
                throw e; // 다른 에러는 원래대로 처리
            }

            for (const action in TARGETS.response) {
                if (TARGETS.response[action].test(url)) {
                    if (action === 'delete_mobile') {
                        const destroy = responseJson?.entity?.destroy;
                        if (Array.isArray(destroy) && destroy.length > 0) {
                            nodeLog(`📦 [${action}] 응답 수신됨`);
                            nodeLog("📦 응답 JSON:", JSON.stringify(responseJson, null, 2));
                        } else {
                            return;
                        }
                    } else {
                        nodeLog(`📦 [${action}] 응답 수신됨`);
                        nodeLog("📦 응답 JSON:", JSON.stringify(responseJson, null, 2));
                    }

                    await matchAndDispatch(action, url, responseJson);
                    break;
                }
            }
        } catch (e) {
            nodeError("❌ 응답 파싱 실패:");
            nodeError("   ↳ message:", e.message);
            nodeError("   ↳ stack:", e.stack);
        }
    });

    nodeLog("🔌 Request hook connected.");
}

module.exports = { attachRequestHooks };
