// src/server/apiServer.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { findReservationTab } = require('../services/puppeteer'); // 안정화 포함됨
const { app } = require('electron');
const { getNow } = require('../utils/common');
const { requestRelaunch, suppress} = require('../utils/relaunch');
const { isPuppeteerAlive, hasReservationTab, isRestoreInProgress, resetBrowserState } = require('../services/puppeteer'); // [ADD]


let serverInstance = null;             //서버 인스턴스
let lastTime = '';                    //예약 마지막 시간
let counter = 0;                    //예약 순서 번호
let SERVER_START_TS = 0;            // 서버 시작 시간
const STARTUP_GRACE_MS = 60_000;    // 첫 요청이 6분 이내인지 (아직 첫요청 전이라 우선 보류)
const q = [];                         // 큐
let qRunning = false;               // 큐 진행확인
const inFlight = new Set();        // 진행 데이터 중복제거
const PURGE_DAYS = 7;               // 7일 경과 초과 데이터 제거
let retryIntervalId = null;             // 10분마다 재시도
let purgeTimeoutId = null;             // 7일 스케줄러


//region ==================== 공통 sleep ====================
// 확인 완료 2025-09-13 ksh
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
//endregion


//region ==================== 요청 처리 큐 ====================
// 확인 완료 2025-09-13 ksh
function enqueue(id, job) {
    if (inFlight.has(id)) {
        nodeLog(`⏭️ 중복 작업 스킵 (id=${id})`);
        return;
    }
    inFlight.add(id);
    q.push({ id, job });
    if (!qRunning) drain();
}
//endregion


//region ==================== 요청 처리 큐 실행 ====================
// 확인 완료 2025-09-13 ksh
async function drain() {
    qRunning = true;
    try {
        while (q.length) {
            const { id, job } = q.shift();
            try {
                await job();
            } catch (e) {
                nodeError('❌ 큐 작업 실패:', e.message);
            } finally {
                inFlight.delete(id);
            }
        }
    } finally {
        qRunning = false;
    }
}
//endregion


//region ==================== 서버 시작 ====================
// 확인 완료 2025-09-13 ksh
async function startApiServer(port = 32123) {
    await stopApiServer();

    const expressApp = express();

    // 요청: /reseration?bookingDate=yyyymmddhhmmss&type=m|t
    expressApp.get('/reseration', async (req, res) => {
        const { bookingDate, type } = req.query;
        if (!bookingDate) return res.status(400).json({ message: 'bookingDate required' });

        const delayMs = type === 'm' ? 1000 * 60 * 5 : 1000 * 60;
        const logEntry = {
            id: generateId(),
            bookingDate: bookingDate,
            type: type,
            channel: type === 'm' ? '모바일' : '전화',
            requestDate: getNow(),
            requestTs: Date.now(),                  //타임스탬프(들어온 시간 나중에 7일 마다 데이터 제거에 사용
            scheduledTs: Date.now() + delayMs,      // 실제 실행 예정 시각
            endDate: '',
            result: 'pending',
            error: null,
            retryCnt: 0,
        };

        nodeLog(`📥 예약 요청 수신 (id=${logEntry.id}, bookingDate=${bookingDate}, type=${type}) → ${delayMs / 60000}분 후 실행 예정`);
        res.sendStatus(200);

        //요청 데이터 json에 넣기
        writeLog(logEntry);

        // ─────────────────────────────────────────────────────
        // 헬스체크 완화: 브라우저 세션만 확인 + 시작 그레이스
        //     + watcher 복원 진행/지연 재확인 로직
        // ─────────────────────────────────────────────────────
        enqueue('__health__', async () => {
            const withinGrace = SERVER_START_TS && (Date.now() - SERVER_START_TS) < STARTUP_GRACE_MS; // [CHG]

            const alive = await isBrowserAliveQuick(2500);
            if (!alive) {

                //복원 큐에 있는지 확인 있따면 보류
                if (isRestoreInProgress()) {
                    nodeLog('🔧 watcher 복원 진행 중 → 재시작 보류');
                    return;
                }

                // 지연 재확인
                await sleep(1500);

                //한번더 브라우저 확인
                if (await isBrowserAliveQuick(1000)) {             // [ADD]
                    nodeLog('✅ 지연 재확인: 브라우저 alive → 재시작 취소');
                    return;
                }

                //첫 요청이 6분 이내인지 (아직 첫요청 전이라 우선 보류)
                if (withinGrace) {
                    nodeLog('⏳ STARTUP GRACE: 브라우저 미활성인데 재시작 보류(초기화 중일 수 있음)');
                    return;
                }
                nodeError('🧨 브라우저 꺼짐 감지 → 앱 재시작 요청');
                resetBrowserState();
                requestRelaunch({ reason: '브라우저 꺼짐 감지 → 앱 재시작 요청' })
                suppress(30 * 1000);
                
                return;
            }

            // 브라우저는 살아있지만 예약탭이 없으면 경고만 (재시작 X)
            try {
                const hasTab = await hasReservationTab().catch(() => false);
                if (!hasTab) {
                    nodeLog('⚠️ 예약 탭 미발견 (브라우저는 alive). 초기 로그인/탭 오픈 대기 상태일 수 있음.');
                    resetBrowserState();
                    requestRelaunch({ reason: '예약 탭 미발견 재시작' })
                    suppress(30 * 1000);
                }
            } catch (e) {
                nodeError('❌ 예약 탭 상태 확인 오류:', e.message);
                resetBrowserState();
                requestRelaunch({ reason: '예약 탭 상태 확인 오류 재시작' })
                suppress(30 * 1000);

            }
        });

        // 직렬 큐에 예약: "예약 예정시각" 기준 실행
        enqueue(logEntry.id, async () => {
            const remaining = logEntry.scheduledTs - Date.now();
            if (remaining > 0) await sleep(remaining);
            await handleReservationRetry(logEntry);
        });
    });

    //서버 시작 관련
    serverInstance = http.createServer(expressApp);
    serverInstance.listen(port, () => {
        SERVER_START_TS = Date.now(); // 실제 리슨 시작 시각 기록
        nodeLog(`🌐 API 서버 실행 중: http://localhost:${port}/reseration`);
    });

    // (옵션) 이전 비정상 종료로 남아있을 수도 있는 .tmp를 정리
    try { fs.unlinkSync(getReservationLogPath() + '.tmp'); } catch (_) {}

    // 10분마다 실패/지연 예약 재시도
    retryIntervalId = setInterval(retryFailedReservations, 1000 * 60 * 10);

    // 매일 7일 경과 로그 자동 정리 (자정+5분, 즉시 1회 포함)
    scheduleDailyPurge(PURGE_DAYS);
}
//endregion


//region ==================== 서버 종료 ====================
// 확인 완료 2025-09-13 ksh
function stopApiServer() {

    // 1) 타이머 해제
    if (retryIntervalId) { clearInterval(retryIntervalId); retryIntervalId = null; }
    if (purgeTimeoutId)  { clearTimeout(purgeTimeoutId);  purgeTimeoutId  = null; }

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
//endregion


//region ==================== 파일 로그 append ====================
// 확인 완료 2025-09-13 ksh
function writeLog(entry) {
    const logPath = getReservationLogPath();
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
//endregion


//region ==================== 파일 로그 업데이트 ====================
// 확인 완료 2025-09-13 ksh
function updateLog(entry) {
    const logPath = getReservationLogPath();
    try {
        const raw = fs.readFileSync(logPath, 'utf-8');
        const data = raw.trim() ? JSON.parse(raw) : [];
        const idx = data.findIndex(e => e.id === entry.id);
        if (idx !== -1) {
            data[idx] = entry;
            fs.writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8');
            nodeLog(`📌 로그 결과 갱신 완료 :\n${JSON.stringify(entry, null, 2)}`);
        }
    } catch (e) {
        nodeError('❌ 로그 갱신 실패:', e.message);
    }
}
//endregion


//region ==================== 예약 파일 경로 ====================
// 확인 완료 2025-09-13 ksh
// C:\Users\<사용자>\AppData\Roaming\<앱이름>\logs\reservation-log.json
// C:\Users\772vj\AppData\Roaming\PandoP\logs\reservation-log.json
function getReservationLogPath() {
    const file = 'reservation-log.json';
    if (app && app.isPackaged) {
        // 운영: 항상 쓰기 가능한 userData/logs
        const dir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, file);
    }
    // 개발: 프로젝트 루트/logs
    const dir = path.join(__dirname, '..', '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, file);
}
//endregion


//region ==================== 예약 아이디 생성 ====================
// 확인 완료 2025-09-13 ksh
function generateId() {
    const now = getNow();
    if (now !== lastTime) { counter = 0; lastTime = now; }
    return `${now}-${counter++}`;
}
//endregion


//region ==================== 브라우저 얕은 체크 ====================
// 확인 완료 2025-09-13 ksh
// 얕은 헬스체크로 교체 (세션만 확인)
// 2.5초 안에 isPuppeteerAlive() 결과가 나오면 그 값을 반환하고,
// 만약 2.5초가 지나도 응답이 없으면 false를 반환합니다.
async function isBrowserAliveQuick(timeoutMs = 2500) {
    try {
        const ok = await Promise.race([
            (async () => isPuppeteerAlive())(),
            sleep(timeoutMs).then(() => false),
        ]);
        nodeLog(`🩺 isBrowserAliveQuick=${ok} (timeout=${timeoutMs}ms)`); // [ADD] 관찰 로그
        return ok;
    } catch {
        return false;
    }
}
//endregion


//region ==================== (중요) 첫 요청 안정화: 예약 탭 준비/달력 열기 ====================
// 확인 완료 2025-09-13 ksh
async function ensureBookingReady(page) {
    await page.bringToFront();
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20_000 });
    await page.waitForSelector('.dhx_cal_nav_button', { visible: true, timeout: 20_000 });

    // 달력 열림 확인 → 닫혀있으면 열기
    const calendarOpen = await page.$('.vfc-main-container');
    if (!calendarOpen) {
        nodeLog('📅 달력 닫힘 상태 → 열기 시도');
        try {
            await page.waitForSelector('.btn_clander', { timeout: 8_000 });
            await page.click('.btn_clander', { delay: 30 });
            await page.waitForSelector('.vfc-main-container', { visible: true, timeout: 8_000 });
        } catch {
            // ESC 후 재시도
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(200);
            await page.click('.btn_clander', { delay: 30 });
            await page.waitForSelector('.vfc-main-container', { visible: true, timeout: 8_000 });
        }
        nodeLog('✅ 달력 열림 확인');
    }
}
//endregion


//region ==================== 예약 날짜 파싱 ====================
// 확인 완료 2025-09-13 ksh
function parseBookingDate(bookingDate) {
    const year = parseInt(bookingDate.slice(0, 4), 10);
    const month = parseInt(bookingDate.slice(4, 6), 10);
    const day = parseInt(bookingDate.slice(6, 8), 10);
    return { targetYear: year, targetMonth: month, targetDay: day };
}
//endregion


//region ==================== 예약 처리 (단건) ====================
// 확인 완료 2025-09-13 ksh
async function handleReservationRetry(logEntry) {
    try {
        const { bookingDate, retryCnt } = logEntry;

        if (retryCnt > 5) {
            logEntry.result = 'stop';
            logEntry.error = 'retry limit exceeded';
            nodeLog(`⚠️ 예약 재시도 중단 (id=${logEntry.id}) → retryCnt=${retryCnt} > 5`);
            updateLog({ ...logEntry, endDate: getNow() });
            return;
        }
        nodeLog(`🧾 예약 요청 데이터:\n${JSON.stringify(logEntry, null, 2)}`);

        //탭 확보
        const page = await findReservationTab();
        nodeLog('✅ 예약 탭 페이지 확보 완료');

        //현재 탭을 새로고침
        await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
        nodeLog('✅ 새로고침');
        await sleep(4000);

        //달력 열기
        await ensureBookingReady(page);
        await sleep(800);
        nodeLog('⏳ 안정화 대기 완료');

        //달력 위치 확인
        const { targetYear, targetMonth, targetDay } = parseBookingDate(bookingDate);
        await page.waitForSelector('.vfc-top-date.vfc-center', { timeout: 10_000 });
        const { currentYear, currentMonth } = await page.evaluate(() => {
            const els = document.querySelectorAll('.vfc-top-date.vfc-center a');
            return {
                currentMonth: parseInt(els[0]?.textContent.trim().replace('월', '')),
                currentYear: parseInt(els[1]?.textContent.trim())
            };
        });
        nodeLog(`📆 현재 달력 위치: ${currentYear}년 ${currentMonth}월 / 목표: ${targetYear}년 ${targetMonth}월`);

        //달력 이동 월 이동
        const diffMonth = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
        if (diffMonth !== 0) {
            const direction = diffMonth > 0 ? 'right' : 'left';
            const clicks = Math.abs(diffMonth);
            const selector = direction === 'right' ? '.vfc-arrow-right' : '.vfc-arrow-left';
            for (let i = 0; i < clicks; i++) {
                await page.waitForSelector(selector, { timeout: 5_000 });
                await page.click(selector);
                await sleep(350);
            }
            nodeLog(`↔️ 달력 ${direction} 방향으로 ${clicks}회 이동 완료`);
        }

        //달력 이동 일 클릭
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
        updateLog({ ...logEntry, endDate: getNow() });
    }
}
//endregion


//region ==================== 실패/지연 예약 재시도 스케줄러 ====================
// 확인 완료 2025-09-13 ksh
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

    // fail + (기한 경과) pending 모두 재시도
    const now = Date.now();
    const PENDING_GRACE_MS = 5_000; // 예정시각 경과 허용 여유
    const scheduledTsOf = (e) => {
        if (Number.isFinite(e && e.scheduledTs)) return e.scheduledTs;
        return NaN;
    };

    const retryables = data.filter((e) => {
        if (e.result === 'fail') return true; // 실패는 무조건 재시도
        if (e.result === 'pending') {
            const sched = scheduledTsOf(e);
            return Number.isFinite(sched) && now >= (sched + PENDING_GRACE_MS);
        }
        return false;
    });

    if (retryables.length === 0) {
        nodeLog('✅ 재처리 대상 없음 → 재시도 생략');
        return;
    }

    nodeLog(`🔁 재처리 대상 ${retryables.length}건 재시도 시작 (fail 또는 기한 경과 pending)`);

    retryables.forEach((entry) => {

        // === 신규 === 여기에서만 상태 갱신
        if (entry.result === 'pending') entry.result = 'fail';

        entry.retryCnt = (Number.isInteger(entry.retryCnt) ? entry.retryCnt : 0) + 1; // ?? 없이 안전 증가
        nodeLog(`⏳ 재시도 예약 준비 (id=${entry.id}, bookingDate=${entry.bookingDate}, retryCnt=${entry.retryCnt}, result=${entry.result})`);
        enqueue(entry.id, async () => {
            await handleReservationRetry(entry);
        });
    });
}
//endregion


//region ==================== 7일 제거 후 업데이트 ====================
// 확인 완료 2025-09-13 ksh
function atomicWriteJsonArray(filePath, arr) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
}
//endregion


//region ==================== 7일 경과 로그 정리 완료 ====================
// 확인 완료 2025-09-13 ksh
function purgeOldLogs(days = PURGE_DAYS) {
    const logPath = getReservationLogPath();
    if (!fs.existsSync(logPath)) return;

    let data = [];
    try {
        const raw = fs.readFileSync(logPath, 'utf-8').trim();
        data = raw ? JSON.parse(raw) : [];
    } catch (e) {
        nodeError('❌ purgeOldLogs: JSON 파싱 실패 → 정리 건너뜀:', e.message);
        return;
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = data.length;
    const kept = data.filter(e => (Number.isFinite(e && e.requestTs) ? e.requestTs : 0) >= cutoff);

    if (kept.length !== before) {
        try {
            atomicWriteJsonArray(logPath, kept);
            nodeLog(`🧹 7일 경과 로그 정리 완료: ${before - kept.length}건 삭제, ${kept.length}건 유지`);
        } catch (e) {
            nodeError('❌ purgeOldLogs: 쓰기 실패:', e.message);
        }
    } else {
        nodeLog('🧹 7일 경과 로그 없음 → 정리 생략');
    }
}
//endregion


//region ==================== 7일 경과 매일 자정 스케줄러 ====================
// 매일 자정(00:00) 한 번만 실행 — DST 드리프트 방지(매일 재계산), 즉시 실행 없음
// 확인 완료 2025-09-13 ksh
function scheduleDailyPurge(days = PURGE_DAYS) {
    if (purgeTimeoutId) { clearTimeout(purgeTimeoutId); purgeTimeoutId = null; }

    const runAtNextMidnight = () => {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
        const delay = next.getTime() - now.getTime();

        purgeTimeoutId = setTimeout(async () => {
            purgeTimeoutId = null; // 실행 완료: 활성 타이머 없음
            await enqueue('__purge__', () => purgeOldLogs(days)); // 자정에만 실행
            runAtNextMidnight(); // 다음 자정 예약
        }, delay);
    };

    runAtNextMidnight();
}
//endregion


module.exports = { startApiServer, stopApiServer };
