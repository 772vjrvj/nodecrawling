// src/server/apiServer.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { findReservationTab } = require('../services/puppeteer');
let app = null;
try {
    app = require('electron').app;
} catch (e) {
    app = null;
}

let serverInstance = null;


function getReservationLogPath() {
    const file = 'reservation-log.json';

    // 개발 환경
    const devPath = path.join(__dirname, '..', '..', 'logs', file);
    if (!app || !app.isPackaged) return devPath;

    // 배포 환경 후보 경로들
    const resourcesPath = process.resourcesPath;
    const appRoot = path.dirname(resourcesPath);

    const candidates = [
        path.join(resourcesPath, 'logs', file),
        path.join(appRoot,       'logs', file),
        path.join(resourcesPath, 'resources', 'logs', file),
        path.join(resourcesPath, 'app.asar.unpacked', 'logs', file),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    // 아무것도 없다면 fallback 경로 생성
    const fallback = candidates[0];
    const dir = path.dirname(fallback);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return fallback;
}

// ─────────────────────────────────────────────────────────
// 유틸: 현재 시간 포맷
// ─────────────────────────────────────────────────────────
function getNow() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

// ─────────────────────────────────────────────────────────
// 유틸: 예약 날짜 문자열 → 년/월로 파싱
// ─────────────────────────────────────────────────────────
function parseBookingDate(bookingDate) {
    const year = parseInt(bookingDate.slice(0, 4), 10);
    const month = parseInt(bookingDate.slice(4, 6), 10);
    return { targetYear: year, targetMonth: month };
}

// ─────────────────────────────────────────────────────────
// 로그 기록 (JSON 파일에 append)
// ─────────────────────────────────────────────────────────
function writeLog(entry) {
    const logPath = getReservationLogPath();
    nodeLog('📝 로그 기록 완료:', entry, '→ 저장 위치:', logPath);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = [];
    if (fs.existsSync(logPath)) {
        try {
            const raw = fs.readFileSync(logPath, 'utf-8');
            data = raw.trim() ? JSON.parse(raw) : [];
        } catch (e) {
            nodeError('❌ JSON 로그 파싱 실패:', e.message);
            data = [];
        }
    }

    data.push(entry);
    try {
        fs.writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8');
        nodeLog('📝 로그 기록 완료: ' + JSON.stringify(entry, null, 2));
    } catch (e) {
        nodeError('❌ JSON 로그 쓰기 실패:', e.message);
    }
}

// ─────────────────────────────────────────────────────────
// 예약 처리 재시도 (1건)
// ─────────────────────────────────────────────────────────
async function handleReservationRetry(logEntry) {
    const { bookingDate, type } = logEntry;
    nodeLog(`🔁 예약 재시도 시작 (${bookingDate}, type=${type})`);

    try {
        const page = await findReservationTab();
        nodeLog('✅ 예약 탭 페이지 확보 완료');

        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        nodeLog('🔄 페이지 새로고침 완료');

        await new Promise(resolve => setTimeout(resolve, 3000));

        const { targetYear, targetMonth } = parseBookingDate(bookingDate);
        const calendarExists = await page.$('.vfc-main-container');

        if (!calendarExists) {
            nodeLog('📅 달력 닫힘 상태 → 열기 시도');
            await page.waitForSelector('.btn_clander', { timeout: 1500 });
            await page.click('.btn_clander');
            nodeLog('🖱️ 달력 열기 버튼 클릭 완료');
        }

        await page.waitForSelector('.vfc-top-date.vfc-center', { timeout: 5000 });

        const { currentYear, currentMonth } = await page.evaluate(() => {
            const elements = document.querySelectorAll('.vfc-top-date.vfc-center a');
            return {
                currentMonth: parseInt(elements[0]?.textContent.trim().replace('월', '')),
                currentYear: parseInt(elements[1]?.textContent.trim())
            };
        });

        nodeLog(`📆 현재 달력 위치: ${currentYear}년 ${currentMonth}월 / 목표: ${targetYear}년 ${targetMonth}월`);

        const diffMonth = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
        const direction = diffMonth > 0 ? 'right' : 'left';
        const clicks = Math.abs(diffMonth);
        const selector = direction === 'right' ? '.vfc-arrow-right' : '.vfc-arrow-left';

        for (let i = 0; i < clicks; i++) {
            await page.waitForSelector(selector, { timeout: 3000 });
            await page.click(selector);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        nodeLog(`↔️ 달력 ${direction} 방향으로 ${clicks}회 이동 완료`);

        const targetDay = parseInt(bookingDate.slice(6, 8));
        const clicked = await page.evaluate((day) => {
            const weeks = document.querySelectorAll('.vfc-week');
            for (const week of weeks) {
                const dayDivs = week.querySelectorAll('.vfc-day');
                for (const div of dayDivs) {
                    const span = div.querySelector('.vfc-span-day');
                    if (span && !span.classList.contains('vfc-hide') && parseInt(span.textContent.trim()) === day) {
                        span.click();
                        return true;
                    }
                }
            }
            return false;
        }, targetDay);

        if (!clicked) {
            nodeLog(`❌ ${targetDay}일 클릭 실패`);
            logEntry.result = 'fail';
            logEntry.error = 'retry target date not found';
        } else {
            nodeLog(`✅ ${targetDay}일 클릭 완료`);
            logEntry.result = 'success';
            logEntry.error = null;
        }

    } catch (err) {
        nodeError('❌ 예약 처리 중 예외:', err.message);
        logEntry.result = 'fail';
        logEntry.error = err.message;
    } finally {
        const logPath = getReservationLogPath();
        try {
            const raw = fs.readFileSync(logPath, 'utf-8');
            const data = raw.trim() ? JSON.parse(raw) : [];
            const idx = data.findIndex(e => e.bookingDate === logEntry.bookingDate && e.requestDate === logEntry.requestDate);
            if (idx !== -1) {
                data[idx] = logEntry;
                fs.writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8');
                nodeLog('📌 로그 결과 갱신 완료:', logEntry.result);
            }
        } catch (e) {
            nodeError('❌ [재시도] 로그 갱신 실패:', e.message);
        }
    }
}


function retryFailedReservations() {
    const logPath = getReservationLogPath();
    if (!fs.existsSync(logPath)) return;

    let data = [];
    try {
        data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    } catch (e) {
        nodeError('❌ 재시도 로그 파싱 실패:', e.message);
        return;
    }

    const failEntries = data.filter(entry => entry.result !== 'success');
    if (failEntries.length === 0) {
        nodeLog('✅ 실패 로그 없음 → 재시도 생략');
        return;
    }

    nodeLog(`🔁 실패한 예약 ${failEntries.length}건 재시도 시작`);

    failEntries.forEach((entry, idx) => {
        setTimeout(() => {
            handleReservationRetry(entry);
        }, 5000 * idx);
    });
}

async function startApiServer(port = 32123) {
    await stopApiServer(); // ✅ 안전하게 기다린 후

    const app = express();

    app.get('/reseration', async (req, res) => {
        const { bookingDate, type } = req.query;

        if (!bookingDate) return res.status(400).json({ message: 'bookingDate required' });

        const delayMs = type === 'm' ? 1000 * 60 * 5 : 1000 * 60;
        const logEntry = {
            bookingDate,
            type,
            requestDate: getNow(),
            result: 'pending',
            error: null
        };

        nodeLog(`📥 예약 요청 수신 (${bookingDate}, type=${type}) → ${delayMs / 60000}분 후 실행 예정`);
        res.sendStatus(200);

        setTimeout(() => handleReservationRetry(logEntry), delayMs);
        writeLog(logEntry);
    });

    serverInstance = http.createServer(app);
    serverInstance.listen(port, () => {
        nodeLog(`🌐 API 서버 실행 중: http://localhost:${port}/reseration`);
    });

    setInterval(retryFailedReservations, 1000 * 60 * 10);
}

function stopApiServer() {
    return new Promise((resolve) => {
        if (serverInstance) {
            serverInstance.close(() => {
                nodeLog('🛑 API 서버 종료 완료');
                serverInstance = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    startApiServer,
    stopApiServer
};
