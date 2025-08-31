// utils/relaunch.js
let last = 0;
let suppressUntil = 0;
let blocked = false;                 // ✅ 사용자가 끌 땐 true
const COOLDOWN = 60_000;

function blockRelaunch() {           // ✅ 재시작 전면 차단
    blocked = true;
    console.log('🔕 relaunch blocked by user-intent quit');
}
function unblockRelaunch() { blocked = false; }
function suppress(ms = 30_000) { suppressUntil = Date.now() + ms; }

function requestRelaunch({ reason = 'unknown' } = {}) {
    if (blocked) {                     // ✅ 차단되면 무시
        nodeLog(`🔕 relaunch blocked → skip: ${reason}`);
        return;
    }
    const now = Date.now();
    if (now < suppressUntil) { nodeLog(`🔕 relaunch suppressed → skip: ${reason}`); return; }
    if (now - last < COOLDOWN)  { nodeLog(`⏳ relaunch cooldown → skip: ${reason}`); return; }

    last = now;
    const { app } = require('electron');
    nodeError(`🔁 앱 재시작 요청: ${reason}`);
    try { app.relaunch(); } catch {}
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 200);
}

module.exports = { requestRelaunch, suppress, blockRelaunch, unblockRelaunch };
