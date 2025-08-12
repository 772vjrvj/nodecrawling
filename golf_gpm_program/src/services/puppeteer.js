// src/services/puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');
const { spawn, execFile } = require('child_process');
const { BrowserWindow } = require('electron');

// Optional Electron deps + path/fs (빌드/개발 모두에서 안전하게 경로 계산)
const path = require('path');
const fs = require('fs');
let app = null; try { ({ app } = require('electron')); } catch { app = null; }

// ───────────────────────────────────────────────────────────────────────────────
// Watcher 실행 관련 상태 + 큐
// ───────────────────────────────────────────────────────────────────────────────
let watcherProcess = null;                // 현재 실행 중인 파이썬/EXE watcher 프로세스 참조
const restoreQueue = [];                  // { exe, pid, resolve, reject }
let processingQueue = false;              // 큐 처리 루프 동작 여부

// 안전장치
const MAX_RESTORE_QUEUE = 20;             // 큐 길이 상한(폭주 방지)
const RUN_TIMEOUT_MS = 8_000;            // 각 watcher 실행 타임아웃

// 내부 상태
let browser = null;
let page = null;

// 탭 참조 분리
let mainPage = null;        // 로그인/메인 탭
let reservationPage = null; // 예약 탭

// ───────────────────────────────────────────────────────────────────────────────
// 유틸: child process 종료 이벤트를 Promise로 대기
//  - kill()은 "종료 요청"일 뿐 → 실제 종료(close/exit)까지 기다려야 안전
// ───────────────────────────────────────────────────────────────────────────────
function onceExit(child, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (code, signal) => { if (!done) { done = true; resolve({ code, signal }); } };
        child.once('close', finish);
        child.once('exit',  finish);
        child.once('error', err => { if (!done) { done = true; reject(err); } });
        if (timeoutMs > 0) {
            setTimeout(() => { if (!done) { done = true; resolve({ code: null, signal: 'timeout' }); } }, timeoutMs);
        }
    });
}

// ───────────────────────────────────────────────────────────────────────────────
/** 유틸: 안전 종료
 *  - 1차: proc.kill() 후 종료 대기
 *  - 2차: 타임아웃이면 강제 종료(taskkill / SIGKILL)
 */
// ───────────────────────────────────────────────────────────────────────────────
async function ensureStopped(proc) {
    if (!proc || proc.killed) return;
    try {
        proc.kill(); // 정상 종료 요청
        const r1 = await onceExit(proc, 1200);
        if (r1.signal !== 'timeout') return; // 제때 종료되면 OK

        // 타임아웃 → 강제 종료
        if (process.platform === 'win32') {
            await new Promise(res => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => res()));
        } else {
            try { proc.kill('SIGKILL'); } catch {}
        }
        await onceExit(proc, 1200);
    } catch {
        // 조용히 무시
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 유틸: Promise 타임아웃 래퍼(희귀한 행 끊기)
// ───────────────────────────────────────────────────────────────────────────────
async function runWithTimeout(promise, ms) {
    let t;
    try {
        return await Promise.race([
            promise,
            new Promise((_, rej) => (t = setTimeout(() => rej(new Error('restore timeout')), ms)))
        ]);
    } finally {
        clearTimeout(t);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// (추가) 예약 페이지 안정화 유틸
// ───────────────────────────────────────────────────────────────────────────────
async function waitBookingReady(p) {
    await p.bringToFront();
    await p.waitForFunction(() => document.readyState === 'complete', { timeout: 20_000 });
    // 예약 UI 핵심 요소 존재 확인 (사이트 상황에 맞춰 key selector 사용)
    await p.waitForSelector('.dhx_cal_nav_button', { visible: true, timeout: 20_000 });
}

async function safeEvaluate(p, fn, args = [], retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await p.evaluate(fn, ...args);
        } catch (e) {
            const msg = String(e && e.message || e);
            if (/Execution context was destroyed|Cannot find context/i.test(msg) && i < retries) {
                nodeLog('♻️ evaluate 컨텍스트 복구 재시도');
                await waitBookingReady(p);
                continue;
            }
            throw e;
        }
    }
    throw new Error('safeEvaluate: retries exhausted');
}

async function ensureBookingReady(page) {
    await page.bringToFront();
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20_000 });
    await page.waitForSelector('.dhx_cal_nav_button', { visible: true, timeout: 20_000 });

    // 달력 열림 확인
    const calendarOpen = await page.$('.vfc-main-container');
    if (!calendarOpen) {
        nodeLog('📅 달력 닫힘 상태 → 열기 시도');
        try {
            await page.waitForSelector('.btn_clander', { timeout: 8_000 });
            await page.click('.btn_clander', { delay: 30 });
            await page.waitForSelector('.vfc-main-container', { visible: true, timeout: 8_000 });
        } catch (e1) {
            // ESC 후 재시도
            await page.keyboard.press('Escape').catch(() => {});
            await new Promise(r => setTimeout(r, 200)); // page.waitForTimeout 대체
            try {
                await page.click('.btn_clander', { delay: 30 });
                await page.waitForSelector('.vfc-main-container', { visible: true, timeout: 8_000 });
            } catch (e2) {
                nodeError('❌ 달력 열기 실패:', e2?.message || e2);
                throw e2; // 여기서 바로 실패시켜 원인 파악 쉽게
            }
        }
        nodeLog('✅ 달력 열림 확인');
        await page.click('.btn_clander', { delay: 30 });
        await new Promise(res => setTimeout(res, 300));
        nodeLog('✅ 달력 닫기');
    }
}

// ⚠️ 네 코드와의 호환을 위해, ensureCalendarOpen 이름을 유지하는 얇은 래퍼 추가
async function ensureCalendarOpen(page) {
    return ensureBookingReady(page);
}

// 프로세스 이름(파일명과 같아야 함)
const WATCHER_NAME = 'chrome_minimized_watcher.exe';

// ⬇️ 추가: 너무 자주 taskkill 하지 않도록 쿨다운
let lastSweepAt = 0;
const SWEEP_COOLDOWN_MS = 5000; // 5초 안에 또 쓸지 않음

// 떠있는 watcher 프로세스를 전부 강제 종료 (Windows 전용)
function killAllWatchers() {
    return new Promise(res => {
        if (process.platform !== 'win32') return res();
        execFile('taskkill', ['/IM', WATCHER_NAME, '/T', '/F'], () => res());
    });
}

// ───────────────────────────────────────────────────────────────────────────────
/** 내부: watcher 1회 실행 로직
 *  - EXE와 PY 스크립트의 인자 호환 문제 해결
 *  - EXE: '--restore-once', '--pid'만 사용 (추가 플래그 미지원)
 *  - PY : '--single-check' 등 확장 인자 허용
 */
// ───────────────────────────────────────────────────────────────────────────────
async function runWatcherOnce(exe, chromePid) {

    // 최근에 스윕 안 했을 때만 한 번 쓸기(과도한 taskkill 비용 방지, 모든 작업은 그대로 처리됨)
    const now = Date.now();
    if (now - lastSweepAt > SWEEP_COOLDOWN_MS) {
      await killAllWatchers();
      lastSweepAt = now;
    }

    await ensureStopped(watcherProcess);

    const caps = await detectWatcherFeatures(exe);

    // 신버전(옵션 지원) vs 구버전(restore-once만)
    const args = caps.singleCheck
        ? ['--pid', String(chromePid), '--single-check', '--exit-if-not-found', '--timeout', '3']
        : ['--restore-once', '--pid', String(chromePid)];

    watcherProcess = spawn(exe, args, { windowsHide: true });
    nodeLog(`[PYTHON] started pid=${watcherProcess.pid} args=${args.join(' ')}`);
    watcherProcess.stdout.on('data', d => nodeLog('[PYTHON]', String(d).trim()));
    watcherProcess.stderr.on('data', d => nodeError('[PYTHON ERROR]', String(d).trim()));

    try {
        const { code } = await onceExit(watcherProcess, 5000);
        watcherProcess = null;

        // PID 매칭 실패 시 fallback
        if (code === 101 || (!caps.singleCheck && code === 0)) {
            // 신버전: code 101 → 전체 Chrome 대상으로 1회 더
            // 구버전: 별도 코드가 없으므로 그냥 전체 대상으로 1회 더
            const fbArgs = caps.singleCheck
                ? ['--single-check', '--timeout', '3']
                : ['--restore-once'];
            const fb = spawn(exe, fbArgs, { windowsHide: true });
            nodeLog(`[PYTHON-FB] started pid=${fb.pid} args=${fbArgs.join(' ')}`);
            fb.stdout.on('data', d => nodeLog('[PYTHON-FB]', String(d).trim()));
            fb.stderr.on('data', d => nodeError('[PYTHON-FB ERROR]', String(d).trim()));
            await onceExit(fb, 4000);
        }
    } catch (err) {
        await killAllWatchers();
        watcherProcess = null;
        throw err;
    }
}

// ───────────────────────────────────────────────────────────────────────────────
/** 큐 처리 루프
 *  - restoreQueue에 쌓인 요청을 FIFO로 하나씩 실행
 *  - 각 요청은 runWatcherOnce(exe,pid) 완료 시 resolve/reject 호출
 *  - 각 실행에 타임아웃 가드 적용
 */
// ───────────────────────────────────────────────────────────────────────────────
async function drainRestoreQueue() {
    if (processingQueue) return;        // 중복 루프 방지 (락)
    processingQueue = true;
    try {
        while (restoreQueue.length) {
            const { exe, pid, resolve, reject } = restoreQueue.shift();
            try {
                await runWithTimeout(runWatcherOnce(exe, pid), RUN_TIMEOUT_MS);
                resolve();
            } catch (err) {
                nodeError('restore job error:', err?.message || err);
                // 타임아웃/에러 시 남아있는 watcher들 전부 정리
                await killAllWatchers();
                reject(err);
            }
        }
    } finally {
        processingQueue = false;
        // 경계 타이밍 보호: 종료 직전에 push된 작업이 남아 있으면 재시작
        if (restoreQueue.length) {
            drainRestoreQueue().catch(err => nodeError('drainRestoreQueue error:', err?.message || err));
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 브라우저 초기화
// ───────────────────────────────────────────────────────────────────────────────
async function initBrowser(chromePath) {
    // 기존 브라우저 완전 종료
    if (browser) {
        try {
            if (browser.process()) {
                nodeLog('🔪 기존 브라우저 프로세스 강제 종료');
                browser.process().kill('SIGKILL');
            } else if (browser.isConnected()) {
                nodeLog('🔁 기존 브라우저 인스턴스 종료');
                await browser.close();
            }
        } catch (e) {
            nodeError('⚠️ 브라우저 종료 중 오류:', e.message);
        }
        browser = null;
        page = null;
        mainPage = null;
        reservationPage = null;
    }

    try {
        // 새 브라우저 실행
        browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            defaultViewport: null,
            protocolTimeout: 180_000, // ★ Runtime.callFunctionOn 타임아웃 완화
            args: [
                '--window-size=800,300',
                '--window-position=0,800',
                '--disable-infobars',
                '--mute-audio',
                '--disable-features=AutofillServerCommunication',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        nodeLog('🚀 새 브라우저 인스턴스 실행됨');

        // 브라우저 종료 감지 시 상태 초기화
        browser.on('disconnected', () => {
            nodeLog('🛑 브라우저 종료 감지: 내부 객체 초기화');
            browser = null;
            page = null;
            mainPage = null;
            reservationPage = null;
        });

        const pages = await browser.pages();
        page = pages.length ? pages[0] : await browser.newPage();
        if (!page) throw new Error('❌ 페이지 생성 실패');

        // 기본 타임아웃 상향
        page.setDefaultTimeout(30_000);
        page.setDefaultNavigationTimeout(60_000);

        nodeLog('📄 페이지 객체 획득 완료');
        mainPage = page;

        await watchForAuthExpiration(page);

        return { browser, page };
    } catch (err) {
        nodeError('❌ 브라우저 생성 중 에러:', err.message);
        throw err;
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 로그인 & 예약 페이지 진입
// ───────────────────────────────────────────────────────────────────────────────
async function login({ userId, password, token, chromePath }) {
    try {
        const result = await initBrowser(chromePath);
        const _browser = result.browser;
        page = result.page;

        if (!_browser || !_browser.isConnected()) {
            throw new Error('❌ 브라우저가 실행되지 않았습니다.');
        }
        if (!page || page.isClosed()) {
            throw new Error('❌ 페이지가 닫혀 있어 작업을 중단합니다.');
        }

        nodeLog('🌐 로그인 페이지 접속 시도');
        await page.goto('https://gpm.golfzonpark.com', { waitUntil: 'networkidle2', timeout: 60_000 });

        // 입력
        await page.waitForSelector('#user_id', { timeout: 10_000 });
        await page.type('#user_id', userId, { delay: 50 });

        await page.waitForSelector('#user_pw', { timeout: 10_000 });
        await page.type('#user_pw', password, { delay: 50 });

        // 제출 및 네비게이션 동시대기
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
        ]);

        nodeLog('🔐 로그인 완료');

        let hookConnected = false;

        // 새 탭(target) 후킹
        const newPagePromise = new Promise(resolve => {
            page.browser().once('targetcreated', async target => {
                try {
                    const newPage = await target.page();
                    if (!newPage || newPage.isClosed()) {
                        throw new Error('❌ 예약 페이지 탭이 열리지 않았습니다.');
                    }
                    attachRequestHooks(newPage);
                    hookConnected = true;
                    nodeLog('🔌 Request hook connected (in login)');

                    // 기본 타임아웃
                    newPage.setDefaultTimeout(30_000);
                    newPage.setDefaultNavigationTimeout(60_000);

                    reservationPage = newPage;
                    resolve(newPage);
                } catch (error) {
                    nodeError('❌ targetcreated 처리 중 에러:', error.message);
                }
            });
        });

        // 예약 버튼 클릭 → 새 탭 생성
        nodeLog('📆 예약 버튼 클릭 시도');
        await page.waitForSelector('button.booking__btn', { timeout: 10_000 });
        await page.click('button.booking__btn');

        const newPage = await newPagePromise;
        if (!newPage || newPage.isClosed()) {
            throw new Error('❌ 예약 페이지 탭 생성 실패 또는 닫힘 상태');
        }

        await newPage.bringToFront();

        // 예약 UI 로딩 확인 + 안정화
        await newPage
            .waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30_000 })
            .then(() => nodeLog('✅ 예약 페이지 로딩 완료'))
            .catch(() => nodeLog('⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list'));

        nodeLog('🟢 예약 페이지 접근됨:', newPage.url());

        // 첫 상호작용 안정화
        await waitBookingReady(newPage);
        try { await ensureCalendarOpen(newPage); } catch (e) { nodeError('달력 열기 실패(무시 가능):', e.message); }

        // 후킹 실패 시 대비
        setTimeout(async () => {
            if (!hookConnected) {
                try {
                    const pages = await _browser.pages();
                    const fallbackPage = pages.find(p => p.url().includes('reservation') || p.url().includes('/ui/booking'));
                    if (fallbackPage && !fallbackPage.isClosed()) {
                        attachRequestHooks(fallbackPage);
                        nodeLog('🔁 fallback hook connected (reservation page)');
                        reservationPage = fallbackPage;
                    }
                } catch (e) {
                    nodeError('❌ fallback hook 처리 중 에러:', e.message);
                }
            }
        }, 5000);

        return newPage;
    } catch (err) {
        nodeError('❌ login() 함수 실행 중 에러:', err.message);
        throw err;
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 예약 탭 찾기
// ───────────────────────────────────────────────────────────────────────────────
async function findReservationTab() {
    await restoreChromeIfMinimized(); // 최소화 상태면 복원 시도(큐에 들어가 순차 실행)

    if (!browser) throw new Error('브라우저가 실행되지 않았습니다.');

    // 보관 참조 우선
    if (reservationPage && !reservationPage.isClosed()) {
        const exists = await reservationPage.$('.dhx_cal_nav_button');
        if (exists) {
            nodeLog('✅ 예약 탭(보관 참조) 찾음:', reservationPage.url());
            // 첫 상호작용 안정화
            try { await waitBookingReady(reservationPage); } catch (e) {}
            try { await ensureCalendarOpen(reservationPage); } catch (e) {}
            return reservationPage;
        }
    }

    // 전체 탭 스캔
    const pages = await browser.pages();
    for (const p of pages) {
        if (p.isClosed()) continue;
        const url = p.url();
        if (url.includes('/ui/booking')) {
            const exists = await p.$('.dhx_cal_nav_button');
            if (exists) {
                nodeLog('✅ 예약 탭 찾음:', url);
                reservationPage = p;
                // 안정화
                try { await waitBookingReady(reservationPage); } catch (e) {}
                try { await ensureCalendarOpen(reservationPage); } catch (e) {}
                return p;
            }
        }
    }

    throw new Error('❌ 예약 탭을 찾을 수 없습니다.');
}

let authInterval = null;

// ───────────────────────────────────────────────────────────────────────────────
// 인증 만료 감시
// ───────────────────────────────────────────────────────────────────────────────
async function watchForAuthExpiration(mainPageParam) {
    if (authInterval) return; // ✅ 중복 감지 방지

    const CHECK_INTERVAL = 5000;
    nodeLog('✅ 인증 만료 확인 시작');

    const checkLoop = async () => {
        try {
            const browser = mainPageParam.browser?.();
            if (!browser || !browser.isConnected?.()) {
                nodeLog('❌ 인증 감시 중단: 브라우저 인스턴스 없음 또는 연결 끊김');
                return;
            }

            const pages = await browser.pages();

            for (const page of pages) {
                if (page.isClosed()) continue;

                try {
                    const el = await page.$('.ico_alert_p');
                    if (!el) continue;

                    const text = await page.evaluate(el => el.textContent.trim(), el);
                    nodeLog(`🔍 인증 메시지: ${text}`);

                    if (text.includes('인증이 만료되었습니다.')) {
                        nodeLog('⚠️ 인증 만료 감지됨');

                        clearInterval(authInterval);
                        authInterval = null;

                        await shutdownBrowser();
                        nodeLog('🛑 Puppeteer 브라우저 종료 완료');

                        const win = BrowserWindow.getAllWindows()[0];
                        if (win) {
                            win.webContents.send('auth-expired');
                            nodeLog('📤 renderer에 auth-expired 전송 완료');
                        }
                        return;
                    }
                } catch (e) {
                    nodeError('❌ 페이지 인증 감시 중 오류:', e.message);
                }
            }
        } catch (e) {
            nodeError('❌ 전체 인증 감시 루프 오류:', e.message);
        }
    };

    authInterval = setInterval(checkLoop, CHECK_INTERVAL);
}

// ───────────────────────────────────────────────────────────────────────────────
// 현재 페이지 반환 (우선순위: 예약 → 메인 → 기본)
// ───────────────────────────────────────────────────────────────────────────────
function getPage() {
    if (reservationPage && !reservationPage.isClosed()) return reservationPage;
    if (mainPage && !mainPage.isClosed()) return mainPage;
    return page;
}

// ───────────────────────────────────────────────────────────────────────────────
/** Chrome 최소화 복원 (Python watcher 실행)
 *  - 동시/연속 요청을 **모두 처리**하되, 큐에 저장하여 **겹치지 않게 순차 실행**
 *  - 각 호출은 자신의 작업이 완료될 때 resolve되는 Promise를 반환
 *  - 큐 길이 상한을 넘으면 에러로 빠르게 거절(폭주 방지)
 */
// ───────────────────────────────────────────────────────────────────────────────
async function restoreChromeIfMinimized() {
    if (!browser || !browser.process || !browser.process()) {
        nodeLog('restoreChromeIfMinimized: 브라우저 프로세스 없음');
        return;
    }

    const exe = getWatcherExePath();
    const chromePid = browser.process().pid;
    nodeLog('[watcher exe 요청]', exe);

    // 현재 호출을 큐에 등록하고 Promise 반환
    return new Promise((resolve, reject) => {
        if (restoreQueue.length >= MAX_RESTORE_QUEUE) {
            nodeError(`restoreQueue overflow (${restoreQueue.length})`);
            return reject(new Error('restore queue overflow'));
        }
        restoreQueue.push({ exe, pid: chromePid, resolve, reject });
        // 큐 처리 루프 킥
        drainRestoreQueue().catch(err => nodeError('drainRestoreQueue error:', err?.message || err));
    });
}

// ───────────────────────────────────────────────────────────────────────────────
// 파이썬 EXE 실행경로 리턴
// ───────────────────────────────────────────────────────────────────────────────
function getWatcherExePath() {
    const file = 'chrome_minimized_watcher.exe';

    // 개발 중 경로: <project>/resources/python/chrome_minimized_watcher.exe
    const devPath = path.join(__dirname, '..', '..', 'resources', 'python', file);
    if (!app || !app.isPackaged) return devPath;

    // 배포용 경로 후보들
    const resourcesPath = process.resourcesPath;                 // ...\resources
    const appRoot = path.dirname(resourcesPath);                 // ...\앱루트

    const candidates = [
        path.join(resourcesPath, 'python', file),
        path.join(appRoot,       'python', file),
        path.join(resourcesPath, 'resources', 'python', file),
        path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'python', file),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error('[watcher EXE not found]\n' + candidates.join('\n'));
}

// EXE 옵션 지원 여부 캐싱
let watcherCaps = null; // { singleCheck: boolean }

async function detectWatcherFeatures(exe) {
    if (watcherCaps) return watcherCaps;
    watcherCaps = { singleCheck: false };
    try {
        await new Promise((resolve) => {
            execFile(exe, ['--help'], (err, stdout, stderr) => {
                const out = (stdout || '') + (stderr || '');
                if (/--single-check/.test(out)) watcherCaps.singleCheck = true;
                resolve();
            });
        });
        nodeLog(`[watcher caps] singleCheck=${watcherCaps.singleCheck}`);
    } catch (e) {
        nodeError('watcher feature detect error:', e?.message || e);
    }
    return watcherCaps;
}

// ───────────────────────────────────────────────────────────────────────────────
// 브라우저 종료
//  - watcherProcess도 함께 정리
// ───────────────────────────────────────────────────────────────────────────────
async function shutdownBrowser() {
    if (browser) {
        try {
            if (browser.process()) {
                browser.process().kill('SIGKILL');
                nodeLog('🛑 Puppeteer 프로세스 강제 종료');
            } else {
                await browser.close();
                nodeLog('🛑 Puppeteer 브라우저 정상 종료');
            }
        } catch (e) {
            nodeError('❌ shutdownBrowser 오류:', e.message);
        } finally {
            browser = null;
            page = null;
            mainPage = null;
            reservationPage = null;

            if (authInterval) {
                clearInterval(authInterval);
                authInterval = null;
            }

            // ✅ watcherProcess 종료
            await ensureStopped(watcherProcess);
            watcherProcess = null;
            await killAllWatchers(); // 혹시 남은 watcher들 전부 종료
            nodeLog('🧹 watcher 프로세스 종료 완료');
        }
    }
}

module.exports = { login, findReservationTab, shutdownBrowser };
