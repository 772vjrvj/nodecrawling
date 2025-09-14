// src/utils/env.js
const fs = require('fs');

function detectChromePath() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            nodeLog(`🔍 [auto] 크롬 경로 탐지 성공: ${p}`);
            return p;
        }
    }
    nodeLog('⚠️ [auto] 크롬 경로 탐지 실패');
    return '';
}

module.exports = { detectChromePath };
