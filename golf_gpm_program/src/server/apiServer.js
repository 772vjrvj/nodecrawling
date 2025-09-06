// src/server/apiServer.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { findReservationTab } = require('../services/puppeteer'); // 안정화 포함됨
let app = null;
try { app = require('electron').app; } catch { app = null; }

// [ADD] 앱 재시작 공용 유틸(중복/쿨다운 가드 포함)
const { requestRelaunch } = require('../utils/relaunch');

// [ADD] 얕은 헬스체크/탭확인/복원상태 함수 import
const { isPuppeteerAlive, hasReservationTab, isRestoreInProgress } = require('../services/puppeteer'); // [ADD]

let serverInstance = null;

// 공통 sleep
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// [CHG] 서버 리슨 시작 시각 기반 그레이스
let SERVER_START_TS = 0;                  // [ADD]
const STARTUP_GRACE_MS = 60_000;          // [ADD]

// ─────────────────────────────────────────────────────────
// 로그 파일 경로
// ─────────────────────────────────────────────────────────
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
// 시간/ID 유틸 YYYY.MM.DD HH:MM:SS.sss
// ─────────────────────────────────────────────────────────
function getNow() {
    const now = new Date();
    const pad = (n, w = 2) => n.toString().padStart(w, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

let lastTime = '';
let counter = 0;
function generateId() {
    const now = getNow();
    if (now !== lastTime) { counter = 0; lastTime = now; }
    return `${now}-${counter++}`;
}

// ─────────────────────────────────────────────────────────
// 파일 로그 append/업데이트
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
// 예약 날짜 파싱
// ─────────────────────────────────────────────────────────
function parseBookingDate(bookingDate) {
    const year = parseInt(bookingDate.slice(0, 4), 10);
    const month = parseInt(bookingDate.slice(4, 6), 10);
    const day = parseInt(bookingDate.slice(6, 8), 10);
    return { targetYear: year, targetMonth: month, targetDay: day };
}

// ─────────────────────────────────────────────────────────
// (중요) 첫 요청 안정화: 예약 탭 준비/달력 열기
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
// 직렬 큐 + inFlight 가드
// ─────────────────────────────────────────────────────────
const q = [];
let qRunning = false;
const inFlight = new Set();

function enqueue(id, job) {
    if (inFlight.has(id)) {
        nodeLog(`⏭️ 중복 작업 스킵 (id=${id})`);
        return;
    }
    inFlight.add(id);
    q.push({ id, job });
    if (!qRunning) drain();
}

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

// ─────────────────────────────────────────────────────────
// 예약 처리 (단건)
// ─────────────────────────────────────────────────────────
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

        const page = await findReservationTab();
        nodeLog('✅ 예약 탭 페이지 확보 완료');

        await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
        await sleep(4000);

        await ensureBookingReady(page);
        await sleep(800);
        nodeLog('⏳ 안정화 대기 완료');

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

// ─────────────────────────────────────────────────────────
// 실패/지연 예약 재시도 스케줄러
// ─────────────────────────────────────────────────────────
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

    // [REPLACE] fail + (기한 경과) pending 모두 재시도
    const now = Date.now();
    const PENDING_GRACE_MS = 5_000; // [ADD] 예정시각 경과 허용 여유
    const inferDelayMs = (t) => (t === 'm' ? 60_000 : 60_000); // [ADD] 현행 규칙과 동일(둘 다 1분)
    const scheduledTsOf = (e) => {
        if (Number.isFinite(e?.scheduledTs)) return e.scheduledTs;
        if (Number.isFinite(e?.requestTs)) return e.requestTs + inferDelayMs(e?.type);
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
        entry.retryCnt = (entry.retryCnt ?? 0) + 1;
        nodeLog(`⏳ 재시도 예약 준비 (id=${entry.id}, bookingDate=${entry.bookingDate}, retryCnt=${entry.retryCnt}, result=${entry.result})`);
        enqueue(entry.id, async () => {
            await handleReservationRetry(entry);
        });
    });
}

// ─────────────────────────────────────────────────────────
// 서버 시작/종료
// ─────────────────────────────────────────────────────────
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
            requestTs: Date.now(),
            scheduledTs: Date.now() + delayMs,              // [ADD] 실제 실행 예정 시각
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
        // [REPLACE] 헬스체크 완화: 브라우저 세션만 확인 + 시작 그레이스
        //     + watcher 복원 진행/지연 재확인 로직
        // ─────────────────────────────────────────────────────
        enqueue('__health__', async () => {
            const withinGrace = SERVER_START_TS && (Date.now() - SERVER_START_TS) < STARTUP_GRACE_MS; // [CHG]

            const alive = await isBrowserAliveQuick(2500);
            if (!alive) {
                
                //복원 큐에 있늕 확인 있따면 보류
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
                enqueue('__restart__', async () =>
                    requestRelaunch({ reason: 'browser not alive on API request' })
                );
                return;
            }

            // 브라우저는 살아있지만 예약탭이 없으면 경고만 (재시작 X)
            try {
                const hasTab = await hasReservationTab().catch(() => false);
                if (!hasTab) {
                    nodeLog('⚠️ 예약 탭 미발견 (브라우저는 alive). 초기 로그인/탭 오픈 대기 상태일 수 있음.');
                }
            } catch (e) {
                nodeError('❌ 예약 탭 상태 확인 오류:', e.message);
            }
        });

        // 직렬 큐에 예약: "예약 예정시각" 기준 실행
        enqueue(logEntry.id, async () => {
            const remaining = (logEntry.scheduledTs ?? (logEntry.requestTs + delayMs)) - Date.now(); // [CHG]
            if (remaining > 0) await sleep(remaining);
            await handleReservationRetry(logEntry);
        });
    });

    serverInstance = http.createServer(expressApp);
    serverInstance.listen(port, () => {
        SERVER_START_TS = Date.now(); // [ADD] 실제 리슨 시작 시각 기록
        nodeLog(`🌐 API 서버 실행 중: http://localhost:${port}/reseration`);
    });

    // (옵션) 이전 비정상 종료로 남아있을 수도 있는 .tmp를 정리
    try { fs.unlinkSync(getReservationLogPath() + '.tmp'); } catch (_) {}

    // 10분마다 실패/지연 예약 재시도
    setInterval(retryFailedReservations, 1000 * 60 * 10);

    // [ADD] 매일 7일 경과 로그 자동 정리 (자정+5분, 즉시 1회 포함)
    scheduleDailyPurge(PURGE_DAYS);
}

// ─────────────────────────────────────────────────────────
// [REPLACE] 얕은 헬스체크로 교체 (세션만 확인)
// 2.5초 안에 isPuppeteerAlive() 결과가 나오면 그 값을 반환하고,
// 만약 2.5초가 지나도 응답이 없으면 false를 반환합니다.
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
// 7일 초과 로그 정리 유틸
// ─────────────────────────────────────────────────────────
const PURGE_DAYS = 7;
let purgeTimeoutId = null;
let purgeIntervalId = null;

function parseEntryTs(entry) {
    if (Number.isFinite(entry?.requestTs)) return entry.requestTs;

    const s = (entry?.endDate && String(entry.endDate).trim())
        || (entry?.requestDate && String(entry.requestDate).trim());
    if (!s) return 0;

    const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!m) return 0;

    const [, Y, Mo, D, h, mi, se, ms] = m.map(Number);
    return new Date(Y, Mo - 1, D, h, mi, se, ms).getTime();
}

function atomicWriteJsonArray(filePath, arr) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
}

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

    const kept = data.filter(entry => parseEntryTs(entry) >= cutoff);

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

function scheduleDailyPurge(days = PURGE_DAYS) {
    if (purgeTimeoutId) { clearTimeout(purgeTimeoutId); purgeTimeoutId = null; }
    if (purgeIntervalId) { clearInterval(purgeIntervalId); purgeIntervalId = null; }

    const run = () => enqueue('__purge__', async () => purgeOldLogs(days));

    run();

    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
    const delay = Math.max(0, next.getTime() - now.getTime());

    purgeTimeoutId = setTimeout(() => {
        run();
        purgeIntervalId = setInterval(run, 24 * 60 * 60 * 1000);
    }, delay);
}

// ─────────────────────────────────────────────────────────
// 서버 종료
// ─────────────────────────────────────────────────────────
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

module.exports = { startApiServer, stopApiServer };
