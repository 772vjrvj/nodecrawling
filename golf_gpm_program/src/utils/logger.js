const fs = require('fs');
const path = require('path');
const { app } = require('electron'); // remote 제거, 안전한 방식

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

function getLogFilePath() {
    const now = new Date().toISOString().substring(0, 10);

    // 사용자 데이터 경로 지정 (예: C:\Users\USER\AppData\Roaming\GPMReservation\logs)
    const userDataPath = app.getPath('userData');
    const dir = path.join(userDataPath, 'logs');

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 로그 디렉토리 생성됨:', dir);
    }

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
    const filenameWithLine = fileParts[fileParts.length - 1];
    return filenameWithLine.split(':').slice(0, 2).join(':');
}

function baseLogger(scope, ...messages) {
    const timestamp = getTimestamp();
    const caller = getCallerInfo();
    const formatted = `[${scope}] ${timestamp} ${caller} - ${messages.join(' ')}`;

    console.log(formatted);
    fs.appendFileSync(getLogFilePath(), formatted + '\n');
}

global.nodeLog = (...args) => baseLogger('Node', ...args);
global.browserLog = (...args) => baseLogger('Browser', ...args);
global.nodeError = (...args) => baseLogger('Node', '❌ ERROR:', ...args);
global.browserError = (...args) => baseLogger('Browser', '❌ ERROR:', ...args);
