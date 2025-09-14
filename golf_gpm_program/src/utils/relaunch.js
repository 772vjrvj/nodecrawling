// utils/relaunch.js
// 재시작 정책 + 정리(DI) + 로거(nodeLog/nodeError 직접 사용)

const { app } = require('electron');

// 상태
let last = 0;
let suppressUntil = 0;
let blocked = false;     // 완전 종료 의도일 때 true
let inFlight = false;    // 싱글 플라이트
let cooldown = 60_000;   // 최소 재시작 간격(ms)

// 정리 핸들러 목록 (DI)
const cleanupHandlers = [];

// 정리 작업 등록
function registerCleanup(fn) { if (typeof fn === 'function') cleanupHandlers.push(fn); }

// 정책
function blockRelaunch() { blocked = true; }
function unblockRelaunch() { blocked = false; }
function setCooldown(ms) { if (typeof ms === 'number' && ms >= 0) cooldown = ms; }

// suppress(ms): 일정 시간 재시작 무시
function suppress(ms) { suppressUntil = Date.now() + (ms || 0); }

// 상태 조회(디버깅용)
function isSuppressed() { return Date.now() < suppressUntil; }
function isBlocked()    { return blocked; }
function isInFlight()   { return inFlight; }
function getCooldown()  { return cooldown; }

// 실제 재시작 요청 (정책 준수 + 정리 → relaunch → exit)
async function requestRelaunch(args) {
    args = args || {};
    const reason = args.reason || 'unknown';

    if (blocked) { nodeLog('🔕 relaunch blocked → skip: ' + reason); return; }
    const now = Date.now();
    if (now < suppressUntil) { nodeLog('🔕 relaunch suppressed → skip: ' + reason); return; }
    if (inFlight) { nodeLog('🔁 relaunch already in-flight → skip: ' + reason); return; }
    if (now - last < cooldown) { nodeLog('⏳ relaunch cooldown → skip: ' + reason); return; }

    inFlight = true;
    last = now;

    nodeLog('🔁 앱 재시작 요청: ' + reason);

    try {
        // 1) 정리 작업 선실행 (등록 순서대로)
        for (const fn of cleanupHandlers) {
            try {
                await fn(); // 동기면 즉시 통과, 비동기면 완료까지 대기
            } catch (e) {
                nodeError('cleanup 에러:', (e && e.stack) || (e && e.message) || String(e));
            }
        }

        // 2) 새 인스턴스 예약
        app.relaunch({
            args: process.argv.slice(1).concat(['--relaunch'])
        });

        // 3) 즉시 종료 (graceful 필요 시 app.quit())
        app.exit(0);
    } catch (e) {
        inFlight = false; // 실패 시 재시도 허용
        nodeError('requestRelaunch 실패:', (e && e.stack) || (e && e.message) || String(e));
    }
}

module.exports = {
    requestRelaunch,
    suppress,
    blockRelaunch,
    unblockRelaunch,
    registerCleanup,
    isSuppressed,
    isBlocked,
    isInFlight,
    setCooldown,
    getCooldown,
};
