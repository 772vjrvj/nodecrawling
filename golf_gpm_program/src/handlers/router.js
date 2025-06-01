const querystring = require('querystring');
const { saveRequest, matchAndDispatch } = require('../handlers/hookRouter');

const TARGETS = {
    request: {
        register:    /\/rest\/ui\/booking\/register(\?timestamp=|$)/,
        edit:        /\/rest\/ui\/booking\/\d+\/edit(\?timestamp=|$)/,
        edit_move:   /\/rest\/ui\/booking\/\d+\/ajax-edit(\?timestamp=|$)/,
        delete:      /\/rest\/ui\/booking\/\d+\/delete(\?timestamp=|$)/,
        delete_mobile: /\/rest\/ui\/polling\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)(?=.*\bdata=)(?=.*\bbookingNumber=)/
    },
    response: {
        register:    /\/rest\/ui\/booking\/register(\?timestamp=|$)/,
        edit:        /\/rest\/ui\/booking\/\d+\/edit(\?timestamp=|$)/,
        edit_move:   /\/rest\/ui\/booking\/\d+\/ajax-edit(\?timestamp=|$)/,
        delete:      /\/rest\/ui\/booking\/\d+\/delete(\?timestamp=|$)/,
        delete_mobile: /\/rest\/ui\/polling\/booking\/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)(?=.*\bdata=)(?=.*\bbookingNumber=)/
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

        // ✅ 요청 저장 및 분석 (POST/PUT only)
        if (['POST', 'PUT'].includes(method) && postData) {
            try {
                let parsedData;
                const contentType = headers['content-type'] || '';

                if (contentType.includes('application/json')) {
                    parsedData = JSON.parse(postData);
                } else if (contentType.includes('application/x-www-form-urlencoded')) {
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

            const responseJson = await res.json();

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
