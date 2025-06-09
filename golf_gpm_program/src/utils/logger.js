const fs = require('fs');
const path = require('path');
const { app } = require('electron'); // 안전한 방식으로 app 접근

// ✅ 한국 시간(KST)으로 타임스탬프 생성
function getTimestamp() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
    return kst.toISOString().replace('T', ' ').substring(0, 19);
}

// ✅ 로그 파일 경로: 사용자 앱 데이터 하위 logs 폴더에 yyyy-MM-dd.log
function getLogFilePath() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
    const dateStr = kst.toISOString().substring(0, 10);

    const userDataPath = app.getPath('userData');
    const dir = path.join(userDataPath, 'logs');

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 로그 디렉토리 생성됨:', dir);
    }

    return path.join(dir, `${dateStr}.log`);
}

// ✅ 로그 호출한 위치(파일명:줄번호)를 추적
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

// ✅ 로그 포맷 구성 및 파일 기록
function baseLogger(scope, ...messages) {
    const timestamp = getTimestamp();
    const caller = getCallerInfo();
    const formatted = `[${scope}] ${timestamp} ${caller} - ${messages.join(' ')}`;

    console.log(formatted);
    fs.appendFileSync(getLogFilePath(), formatted + '\n');
}

// ✅ 글로벌 로그 함수 등록a
global.nodeLog = (...args) => baseLogger('Node', ...args);
global.browserLog = (...args) => baseLogger('Browser', ...args);
global.nodeError = (...args) => baseLogger('Node', '❌ ERROR:', ...args);
global.browserError = (...args) => baseLogger('Browser', '❌ ERROR:', ...args);
