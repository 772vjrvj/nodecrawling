const fs = require('fs');
const path = require('path');

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

function getLogFilePath() {
    const now = new Date().toISOString().substring(0, 10);
    const dir = path.join(__dirname, '../../logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); // 하위 경로까지 생성
    return path.join(dir, `${now}.log`);
}

function getCallerInfo() {
    const err = new Error();
    const stackLines = err.stack?.split('\n') || [];

    const callerLine = stackLines.find(line =>
        !line.includes('logger.js') &&
        line.includes('at ')
    );

    const match = callerLine?.match(/\(([^)]+)\)/);
    if (!match) return 'unknown';

    const fullPath = match[1];
    const fileParts = fullPath.split(path.sep);
    const filenameWithLine = fileParts[fileParts.length - 1]; // "main.js:12:5"
    return filenameWithLine.split(':').slice(0, 2).join(':'); // "main.js:12"
}

function baseLogger(scope, ...messages) {
    const timestamp = getTimestamp();
    const caller = getCallerInfo();
    const formatted = `[${scope}] ${timestamp} ${caller} - ${messages.join(' ')}`;

    console.log(formatted);
    fs.appendFileSync(getLogFilePath(), formatted + '\n');
}

// ✅ 전역 등록 (다중 인자 지원 통일)
global.nodeLog = (...args) => baseLogger('Node', ...args);
global.browserLog = (...args) => baseLogger('Browser', ...args);
global.nodeError = (...args) => baseLogger('Node', '❌ ERROR:', ...args);
global.browserError = (...args) => baseLogger('Browser', '❌ ERROR:', ...args);
