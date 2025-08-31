// src/services/puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');
const { spawn, execFile } = require('child_process');
const { BrowserWindow } = require('electron');

// [ADD] 공용 재시작 유틸 (쿨다운/중복 가드 포함)
const { requestRelaunch, suppress } = require('../utils/relaunch');

// Optional Electron deps + path/fs
const path = require('path');
const fs = require('fs');
let app = null; try { ({ app } = require('electron')); } catch { app = null; }

// ───────────────────────────────────────────────────────────────
// Watcher 실행 관련 상태 + 큐
// ───────────────────────────────────────────────────────────────
let watcherProcess = null;                // 현재 실행 중인 파이썬/EXE watcher 프로세스 참조
const restoreQueue = [];                  // { exe, pid, resolve, reject }
let processingQueue = false;              // 큐 처리 루프 동작 여부

// 안전장치
const MAX_RESTORE_QUEUE = 20;
const RUN_TIMEOUT_MS = 8_000;

// 내부 상태
let browser = null;
let page = null;

// 탭 참조 분리
let mainPage = null;        // 로그인/메인 탭
let reservationPage = null; // 예약 탭

// 최초 1회만 달력 스모크 체크(열기→닫기)
let didCalendarSmokeCheck = false;

// ───────────────────────────────────────────────────────────────
// 유틸
// ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

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

// ───────────────────────────────────────────────────────────────
// 예약 페이지 안정화/달력 유틸
// ───────────────────────────────────────────────────────────────
async function ensureBookingReady(p) {
    await p.bringToFront();
    await p.waitForFunction(() => document.readyState === 'complete', { timeout: 20_000 });
    await p.waitForSelector('.dhx_cal_nav_button', { visible: true, timeout: 20_000 });
}

async function ensureCalendarOpen(p) {
    await p.waitForSelector('.btn_clander', { timeout: 8_000 });
    const opened = await p.$('.vfc-main-container');
    if (!opened) {
        await p.click('.btn_clander', { delay: 30 });
        await p.waitForSelector('.vfc-main-container', { visible: true, timeout: 8_000 });
        await sleep(200);
        nodeLog('✅ 달력 열림');
    }
}

async function ensureCalendarClosed(p) {
    await p.waitForSelector('.btn_clander', { timeout: 8_000 });
    const opened = await p.$('.vfc-main-container');
    if (opened) {
        await p.click('.btn_clander', { delay: 30 });
        await sleep(300);
        nodeLog('✅ 달력 닫힘');
    }
}

async function calendarSmokeCheck(p) {
    await ensureBookingReady(p);
    await ensureCalendarOpen(p);
    await ensureCalendarClosed(p);
}

// ───────────────────────────────────────────────────────────────
// Python watcher (창 복원) 실행
// ───────────────────────────────────────────────────────────────
const WATCHER_NAME = 'chrome_minimized_watcher.exe';
let lastSweepAt = 0;
const SWEEP_COOLDOWN_MS = 5000;

function killAllWatchers() {
    return new Promise(res => {
        if (process.platform !== 'win32') return res();
        execFile('taskkill', ['/IM', WATCHER_NAME, '/T', '/F'], () => res());
    });
}

async function runWatcherOnce(exe, chromePid) {
    const now = Date.now();
    if (now - lastSweepAt > SWEEP_COOLDOWN_MS) {
        await killAllWatchers();
        lastSweepAt = now;
    }

    await ensureStopped(watcherProcess);

    const caps = await detectWatcherFeatures(exe);
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
            const fbArgs = caps.singleCheck ? ['--single-check', '--timeout', '3'] : ['--restore-once'];
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

async function drainRestoreQueue() {
    if (processingQueue) return; // 중복 루프 방지
    processingQueue = true;
    try {
        while (restoreQueue.length) {
            const { exe, pid, resolve, reject } = restoreQueue.shift();
            try {
                await runWithTimeout(runWatcherOnce(exe, pid), RUN_TIMEOUT_MS);
                resolve();
            } catch (err) {
                nodeError('restore job error:', err?.message || err);
                await killAllWatchers();
                reject(err);
            }
        }
    } finally {
        processingQueue = false;
        if (restoreQueue.length) {
            drainRestoreQueue().catch(err => nodeError('drainRestoreQueue error:', err?.message || err));
        }
    }
}

// ───────────────────────────────────────────────────────────────
// 브라우저 초기화 / 로그인 진입
// ───────────────────────────────────────────────────────────────
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
            protocolTimeout: 180_000,
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

        // [MOD] 브라우저 종료 이벤트 → 공용 재시작 유틸 호출
        browser.on('disconnected', () => {
            nodeLog('🛑 브라우저 종료 감지: 내부 객체 초기화');
            browser = null;
            page = null;
            mainPage = null;
            reservationPage = null;

            // 의도적 종료 직후 억제창이면 재시작 요청 생략
            if (Date.now() < suppressRelaunchUntil) {
                nodeLog('🔕 의도적 종료 억제창 → relaunch skip');
                return;
            }

            // 그 외엔 안전하게 앱 재시작 요청 (쿨다운/중복은 유틸이 처리)
            requestRelaunch({ reason: 'puppeteer: browser disconnected event' });
        });

        const pages = await browser.pages();
        page = pages.length ? pages[0] : await browser.newPage();
        if (!page) throw new Error('❌ 페이지 생성 실패');

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

        await page.waitForSelector('#user_id', { timeout: 10_000 });
        await page.type('#user_id', userId, { delay: 50 });

        await page.waitForSelector('#user_pw', { timeout: 10_000 });
        await page.type('#user_pw', password, { delay: 50 });

        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
        ]);

        nodeLog('🔐 로그인 완료');

        let hookConnected = false;
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
                    newPage.setDefaultTimeout(30_000);
                    newPage.setDefaultNavigationTimeout(60_000);
                    reservationPage = newPage;
                    resolve(newPage);
                } catch (error) {
                    nodeError('❌ targetcreated 처리 중 에러:', error.message);
                }
            });
        });

        nodeLog('📆 예약 버튼 클릭 시도');
        await page.waitForSelector('button.booking__btn', { timeout: 10_000 });
        await page.click('button.booking__btn');

        const newPage = await newPagePromise;
        if (!newPage || newPage.isClosed()) {
            throw new Error('❌ 예약 페이지 탭 생성 실패 또는 닫힘 상태');
        }

        await newPage.bringToFront();

        await newPage
            .waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30_000 })
            .then(() => nodeLog('✅ 예약 페이지 로딩 완료'))
            .catch(() => nodeLog('⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list'));

        nodeLog('🟢 예약 페이지 접근됨:', newPage.url());

        await ensureBookingReady(newPage);

        if (!didCalendarSmokeCheck) {
            try {
                await calendarSmokeCheck(newPage);
                didCalendarSmokeCheck = true;
                nodeLog('🧪 달력 스모크 체크 완료(열기→닫기)');
            } catch (e) {
                nodeError('❌ 달력 스모크 체크 실패(무시 가능):', e.message);
            }
        }

        return newPage;
    } catch (err) {
        nodeError('❌ login() 함수 실행 중 에러:', err.message);
        throw err;
    }
}

// ───────────────────────────────────────────────────────────────
// 예약 탭 찾기
// ───────────────────────────────────────────────────────────────
async function findReservationTab() {
    await restoreChromeIfMinimized();

    if (!browser) throw new Error('브라우저가 실행되지 않았습니다.');

    if (reservationPage && !reservationPage.isClosed()) {
        const exists = await reservationPage.$('.dhx_cal_nav_button');
        if (exists) {
            nodeLog('✅ 예약 탭(보관 참조) 찾음:', reservationPage.url());
            try { await ensureBookingReady(reservationPage); } catch (e) {}
            return reservationPage;
        }
    }

    const pages = await browser.pages();
    for (const p of pages) {
        if (p.isClosed()) continue;
        const url = p.url();
        if (url.includes('/ui/booking')) {
            const exists = await p.$('.dhx_cal_nav_button');
            if (exists) {
                nodeLog('✅ 예약 탭 찾음:', url);
                reservationPage = p;
                try { await ensureBookingReady(reservationPage); } catch (e) {}
                return p;
            }
        }
    }

    throw new Error('❌ 예약 탭을 찾을 수 없습니다.');
}

let authInterval = null;

// ───────────────────────────────────────────────────────────────
// 인증 만료 감시
// ───────────────────────────────────────────────────────────────
async function watchForAuthExpiration(mainPageParam) {
    if (authInterval) return; // ✅ 중복 감지 방지

    const CHECK_INTERVAL = 5000;
    nodeLog('✅ 인증 만료 확인 시작');

    const checkLoop = async () => {
        try {
            const browser = mainPageParam.browser?.();
            if (!browser || !browser.isConnected?.()) {
                nodeLog('❌ 인증 감시: 브라우저 없음/연결 끊김 → 앱 재시작 요청');
                clearInterval(authInterval);
                authInterval = null;
                // 공용 유틸이 쿨다운/중복 가드 처리
                requestRelaunch({ reason: 'auth watcher: browser not connected' });
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

                        // [KEEP] 인증 만료는 "풀 리런치 X" → 렌더러가 재로그인 루틴 실행
                        // 의도적 종료 직후 'disconnected' 훅에서의 재시작 요청을 잠깐 억제
                        suppressRelaunchUntil = Date.now() + 30_000; // 30초 억제

                        // 인증 만료 감지 분기에서
                        suppress(30_000);          // 30초간 다른 곳의 재시작 요청 무시
                        await shutdownBrowser();
                        // renderer로 'auth-expired' 보내서 UX 처리 → renderer가 requestRelaunch 하더라도
                        // main이 block 상태면 당연히 무시됨(사용자 종료 중이라면)
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

// ───────────────────────────────────────────────────────────────
// 현재 페이지 반환 (우선순위: 예약 → 메인 → 기본)
// ───────────────────────────────────────────────────────────────
function getPage() {
    if (reservationPage && !reservationPage.isClosed()) return reservationPage;
    if (mainPage && !mainPage.isClosed()) return mainPage;
    return page;
}

// ───────────────────────────────────────────────────────────────
// Chrome 최소화 복원 (Python watcher 실행)
// ───────────────────────────────────────────────────────────────
async function restoreChromeIfMinimized() {
    if (!browser || !browser.process || !browser.process()) {
        nodeLog('restoreChromeIfMinimized: 브라우저 프로세스 없음');
        return;
    }

    const exe = getWatcherExePath();
    const chromePid = browser.process().pid;
    nodeLog('[watcher exe 요청]', exe);

    return new Promise((resolve, reject) => {
        if (restoreQueue.length >= MAX_RESTORE_QUEUE) {
            nodeError(`restoreQueue overflow (${restoreQueue.length})`);
            return reject(new Error('restore queue overflow'));
        }
        restoreQueue.push({ exe, pid: chromePid, resolve, reject });
        drainRestoreQueue().catch(err => nodeError('drainRestoreQueue error:', err?.message || err));
    });
}

function getWatcherExePath() {
    const file = 'chrome_minimized_watcher.exe';

    const devPath = path.join(__dirname, '..', '..', 'resources', 'python', file);
    if (!app || !app.isPackaged) return devPath;

    const resourcesPath = process.resourcesPath;
    const appRoot = path.dirname(resourcesPath);

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

// ───────────────────────────────────────────────────────────────
// 브라우저 종료 (watcherProcess도 함께 정리)
// ───────────────────────────────────────────────────────────────
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

            await ensureStopped(watcherProcess);
            watcherProcess = null;
            await killAllWatchers();
            nodeLog('🧹 watcher 프로세스 종료 완료');
        }
    }
}

// ───────────────────────────────────────────────────────────────
// [ADD] 재시작 억제창 (의도적 종료 직후 재시작 루프 방지)
//   - 값이 0이 아니고, 현재시각 < suppressRelaunchUntil 이면
//     브라우저 disconnected 이벤트에서 재시작 요청을 생략
// ───────────────────────────────────────────────────────────────
let suppressRelaunchUntil = 0;

module.exports = { login, findReservationTab, shutdownBrowser };
