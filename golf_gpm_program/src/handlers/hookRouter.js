//src/handlers/hookRouter.js
const { patch, del, post } = require('../utils/api');
const tokenManager = require('../services/tokenManager');
const requestStore = {};
const CRAWLING_SITE = 'GolfzonPark';

const { toIsoKstFormat, compact, convertToUtcZFormat, extractDateYYMMDD } = require('../utils/common');

function saveRequest(action, url, data) {
    requestStore[url] = { action, data };
    nodeLog(`📅 저장됨: [${action}]:data - ${requestStore[url]}`);
    nodeLog(`📅 저장됨: [${action}]:url - ${url}`);
}

async function matchAndDispatch(action, url, responseData) {
    const entry = requestStore[url];
    nodeLog(`📅 저장됨: [${action}]:entry - ${entry}`);

    const token = tokenManager.getTokenAsync();
    const storeId = tokenManager.getStoreId();

    // 🔧 delete_mobile은 요청 매칭 없이도 처리
    if (action === 'delete_mobile') {
        nodeLog(`📦 [${action}] 단독 응답 처리`);
        await dispatchAction(action, { request: null, response: responseData }, token, storeId);
        return;
    }

    // 그 외는 기존대로 request-response 매칭 필요
    if (!entry || entry.action !== action) {
        return;
    }

    nodeLog(`✅ 요청-응답 매칭됨: [${action}] - ${url}`);
    const requestData = entry.data;
    delete requestStore[url];

    await dispatchAction(action, { request: requestData, response: responseData }, token, storeId);
}

async function dispatchAction(action, combinedData, token, storeId) {
    const { request, response } = combinedData;

    try {
        switch (action) {
            case 'register': {
                const entities = response?.entitys || response?.entity || [];
                for (const entity of entities) {
                    const payload = compact({
                        externalId: String(entity.bookingNumber?.[0]),
                        roomId: String(entity.machineNumber),
                        crawlingSite: CRAWLING_SITE,
                        name: String(request.bookingName),
                        phone: String(request.cellNumber || ''),
                        requests: request.bookingMemo,
                        paymented: request.paymentYn === 'Y',
                        partySize: parseInt(request.bookingCnt || 1),
                        paymentAmount: parseInt(request.paymentTotAmount || 0),
                        startDate: toIsoKstFormat(request.bookingStartDt),
                        endDate: toIsoKstFormat(request.bookingEndDt),
                        externalGroupId: request.reserveNo ? String(request.reserveNo) : undefined,
                    }, ['phone']);
                    nodeLog("📦 register payload:", JSON.stringify(payload, null, 2));
                    await patch(token, storeId, payload, null);
                }
                break;
            }

            case 'edit': {
                const reserveNo = request?.reserveNo;
                const bookingNumber = request?.bookingNumber;
                const machineNumber = request?.machineNumber || [];
                const entities = response?.entitys || [];

                // 모바일에서 2개 이상으로 수정하는 경우는 기존에 모든 예약이 사라진다.
                if (reserveNo && Array.isArray(machineNumber) && machineNumber.length > 0) {
                    const payload = {
                        crawlingSite: CRAWLING_SITE,
                        reason: '모바일 예약 변경 취소',
                        externalGroupId: String(reserveNo),
                    };
                    nodeLog("📦 delete 고객 payload:", JSON.stringify(payload, null, 2));
                    await del(token, storeId, payload, 'g');
                }
                // 웹에서 예약수가 2이상 이면 무조건 새로운 예약번호를 채번하기 때문에 기존에 예약은 무조건 지워야 한다.
                else if (entities.length > 0)
                {
                    const payload = {
                        crawlingSite: CRAWLING_SITE,
                        reason: '수정 취소',
                        externalId: String(bookingNumber),
                    };
                    nodeLog("📦 delete 운영자 payload:", JSON.stringify(payload, null, 2));
                    await del(token, storeId, payload, null);
                }

                if (entities.length > 0) {
                    for (const entity of entities) {
                        const payload = compact({
                            externalId: String(entity.bookingNumber?.[0]),
                            roomId: String(entity.machineNumber),
                            crawlingSite: CRAWLING_SITE,
                            name: String(request.bookingName),
                            phone: String(request.cellNumber || ''),
                            requests: request.bookingMemo,
                            paymented: request.paymentYn === 'Y',
                            partySize: parseInt(request.bookingCnt || 1),
                            paymentAmount: parseInt(request.paymentTotAmount || 0),
                            startDate: toIsoKstFormat(request.bookingStartDt),
                            endDate: toIsoKstFormat(request.bookingEndDt),
                            externalGroupId: reserveNo ? String(reserveNo) : undefined,
                        }, ['phone']);
                        nodeLog("📦 edit payload:", JSON.stringify(payload, null, 2));
                        await patch(token, storeId, payload, null);
                    }
                } else {
                    const payload = compact({
                        externalId: String(bookingNumber),
                        roomId: String(request.machineNumber),
                        crawlingSite: CRAWLING_SITE,
                        name: String(request.bookingName),
                        phone: String(request.cellNumber || ''),
                        requests: request.bookingMemo,
                        paymented: request.paymentYn === 'Y',
                        partySize: parseInt(request.bookingCnt || 1),
                        paymentAmount: parseInt(request.paymentTotAmount || 0),
                        startDate: toIsoKstFormat(request.bookingStartDt),
                        endDate: toIsoKstFormat(request.bookingEndDt),
                        externalGroupId: reserveNo ? String(reserveNo) : undefined,
                    }, ['phone']);
                    nodeLog("📦 edit payload:", JSON.stringify(payload, null, 2));
                    await patch(token, storeId, payload, null);
                }
                break;
            }

            case 'edit_move': {
                const payload = compact({
                    externalId: String(request.bookingNumber),
                    roomId: String(request.machineNumber),
                    startDate: toIsoKstFormat(request.bookingStartDt),
                    endDate: toIsoKstFormat(request.bookingEndDt),
                    crawlingSite: CRAWLING_SITE,
                });
                nodeLog("📦 edit_move payload:", JSON.stringify(payload, null, 2));
                await patch(token, storeId, payload,  'm');
                break;
            }

            case 'delete': {
                const reserveNo = request['reservation.reserveNo'];
                if (reserveNo) {
                    const payload = {
                        crawlingSite: CRAWLING_SITE,
                        reason: '모바일 고객 예약을 운영자가 취소',
                        externalGroupId: String(reserveNo),
                    };
                    nodeLog("📦 delete 고객:", JSON.stringify(payload, null, 2));
                    await del(token, storeId, payload, 'g');
                } else {
                    const bookingNums = Array.isArray(request.bookingNums) ? request.bookingNums : [request.bookingNums];
                    for (const num of bookingNums) {
                        const payload = {
                            crawlingSite: CRAWLING_SITE,
                            reason: '운영자 취소',
                            externalId: String(num),
                        };
                        nodeLog("📦 delete 운영자:", JSON.stringify(payload, null, 2));
                        await del(token, storeId, payload, null);
                    }
                }
                break;
            }

            case 'delete_mobile': {
                const destroyed = response?.entity?.destroy?.[0];
                const reserveNo = destroyed?.reserveNo;
                if (reserveNo) {
                    const payload = {
                        crawlingSite: CRAWLING_SITE,
                        reason: '모바일 고객 예약 취소',
                        externalGroupId: String(reserveNo),
                    };
                    nodeLog("📦 delete 모바일 고객:", JSON.stringify(payload, null, 2));
                    await del(token, storeId, payload, 'g');
                }
                break;
            }

            case 'detail': {
                const entities = response?.entitys || [];
                const date = entities.length > 0 ? extractDateYYMMDD(entities[0].bookingStartDate) : null;
                const reservations = entities.map((entity) => compact({
                    externalId: String(entity.bookingNumber),
                    externalGroupId: entity.reserveNo ? String(entity.reserveNo) : undefined,
                    name: String(entity.bookingName),
                    phone: String(entity.cellNumber || ''),
                    partySize: parseInt(entity.bookingCnt || 1),
                    startDate: convertToUtcZFormat(entity.bookingStartDate),
                    endDate: convertToUtcZFormat(entity.bookingEndDate),
                    roomId: String(entity.machineNumber),
                    paymented: entity.paymentYn === 'Y',
                    paymentAmount: parseInt(entity.paymentTotAmount || 0),
                    crawlingSite: CRAWLING_SITE
                }, ['phone']));

                const payload = { reservations };

                //nodeLog("📦 detail 예약 전체 payload:", JSON.stringify(payload, null, 2));
                nodeLog("📦 detail 예약 전체 payload:", payload);
                nodeLog("📦 detail 예약 date:", date);

                // ✅ 예약이 하나도 없으면 skip
                if (reservations.length === 0) {
                    nodeLog("📦 detail 예약 정보 없음, post() 호출 생략");
                    break;
                }

                // ✅ 서버로 한번에 배열 전송
                await post(token, storeId, payload, 'p', date);
                break;
            }

            default:
                nodeLog(`⚠️ 알 수 없는 액션: ${action}`);
                return;
        }
    } catch (e) {
        nodeError(`❌ dispatch 처리 실패 [${action}] - ${e.message}`);
    }
}

module.exports = {
    saveRequest,
    matchAndDispatch,
};
