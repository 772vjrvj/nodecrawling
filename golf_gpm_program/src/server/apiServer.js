// src/server/apiServer.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { findReservationTab } = require('../services/puppeteer');

let serverInstance = null;

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
    const logPath = path.join(__dirname, '..', '..', 'logs', 'reservation-log.json');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = [];
    if (fs.existsSync(logPath)) {
        try {
            data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        } catch (e) {
            console.error('❌ JSON 로그 파싱 실패:', e.message);
        }
    }

    data.push(entry);
    try {
        fs.writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log('📝 로그 기록 완료:', entry);
    } catch (e) {
        console.error('❌ JSON 로그 쓰기 실패:', e.message);
    }
}

// ─────────────────────────────────────────────────────────
// 예약 처리 재시도 (1건)
// ─────────────────────────────────────────────────────────
async function handleReservationRetry(logEntry) {
    const { bookingDate, type } = logEntry;
    console.log(`🔁 예약 재시도 시작 (${bookingDate}, type=${type})`);

    try {
        const page = await findReservationTab();
        console.log('✅ 예약 탭 페이지 확보 완료');

        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        console.log('🔄 페이지 새로고침 완료');

        await new Promise(resolve => setTimeout(resolve, 3000));

        const { targetYear, targetMonth } = parseBookingDate(bookingDate);
        const calendarExists = await page.$('.vfc-main-container');

        if (!calendarExists) {
            console.log('📅 달력 닫힘 상태 → 열기 시도');
            await page.waitForSelector('.btn_clander', { timeout: 1500 });
            await page.click('.btn_clander');
            console.log('🖱️ 달력 열기 버튼 클릭 완료');
        }

        await page.waitForSelector('.vfc-top-date.vfc-center', { timeout: 5000 });

        const { currentYear, currentMonth } = await page.evaluate(() => {
            const elements = document.querySelectorAll('.vfc-top-date.vfc-center a');
            return {
                currentMonth: parseInt(elements[0]?.textContent.trim().replace('월', '')),
                currentYear: parseInt(elements[1]?.textContent.trim())
            };
        });

        console.log(`📆 현재 달력 위치: ${currentYear}년 ${currentMonth}월 / 목표: ${targetYear}년 ${targetMonth}월`);

        const diffMonth = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
        const direction = diffMonth > 0 ? 'right' : 'left';
        const clicks = Math.abs(diffMonth);
        const selector = direction === 'right' ? '.vfc-arrow-right' : '.vfc-arrow-left';

        for (let i = 0; i < clicks; i++) {
            await page.waitForSelector(selector, { timeout: 3000 });
            await page.click(selector);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        console.log(`↔️ 달력 ${direction} 방향으로 ${clicks}회 이동 완료`);

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
            console.log(`❌ ${targetDay}일 클릭 실패`);
            logEntry.result = 'fail';
            logEntry.error = 'retry target date not found';
        } else {
            console.log(`✅ ${targetDay}일 클릭 완료`);
            logEntry.result = 'success';
            logEntry.error = null;
        }

    } catch (err) {
        console.error('❌ 예약 처리 중 예외:', err.message);
        logEntry.result = 'fail';
        logEntry.error = err.message;
    } finally {
        // 결과 갱신
        const logPath = path.join(__dirname, '..', '..', 'logs', 'reservation-log.json');
        try {
            const data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
            const idx = data.findIndex(e => e.bookingDate === logEntry.bookingDate && e.requestDate === logEntry.requestDate);
            if (idx !== -1) {
                data[idx] = logEntry;
                fs.writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8');
                console.log('📌 로그 결과 갱신 완료:', logEntry.result);
            }
        } catch (e) {
            console.error('❌ [재시도] 로그 갱신 실패:', e.message);
        }
    }
}

// ─────────────────────────────────────────────────────────
// 실패 로그 전체 재시도
// ─────────────────────────────────────────────────────────
function retryFailedReservations() {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'reservation-log.json');
    if (!fs.existsSync(logPath)) return;

    let data = [];
    try {
        data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    } catch (e) {
        console.error('❌ 재시도 로그 파싱 실패:', e.message);
        return;
    }

    const failEntries = data.filter(entry => entry.result !== 'success');
    if (failEntries.length === 0) {
        console.log('✅ 실패 로그 없음 → 재시도 생략');
        return;
    }

    console.log(`🔁 실패한 예약 ${failEntries.length}건 재시도 시작`);

    failEntries.forEach((entry, idx) => {
        setTimeout(() => {
            handleReservationRetry(entry);
        }, 5000 * idx); // 5초 간격 순차 재시도
    });
}

// ─────────────────────────────────────────────────────────
// API 서버 실행
// ─────────────────────────────────────────────────────────
async function startApiServer(port = 32123) {

    await stopApiServer(); // ✅ 안전하게 기다린 후

    const app = express();

    // 예약 API
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

        console.log(`📥 예약 요청 수신 (${bookingDate}, type=${type}) → ${delayMs / 60000}분 후 실행 예정`);
        res.sendStatus(200);

        setTimeout(() => handleReservationRetry(logEntry), delayMs);
        writeLog(logEntry);
    });

    serverInstance = http.createServer(app);
    serverInstance.listen(port, () => {
        console.log(`🌐 API 서버 실행 중: http://localhost:${port}/reseration`);
    });

    // 10분마다 실패 예약 재시도
    setInterval(retryFailedReservations, 1000 * 60 * 10);
}

// ─────────────────────────────────────────────────────────
// API 서버 종료
// ─────────────────────────────────────────────────────────
function stopApiServer() {
    return new Promise((resolve) => {
        if (serverInstance) {
            serverInstance.close(() => {
                console.log('🛑 API 서버 종료 완료');
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
