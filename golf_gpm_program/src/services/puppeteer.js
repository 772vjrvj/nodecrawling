// src/services/puppeteer.js
const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');
const { spawn, execFile } = require('child_process');
const { BrowserWindow, app } = require('electron');
const { requestRelaunch, suppress } = require('../utils/relaunch');
const path = require('path');
const fs = require('fs');


let browser = null;
let page = null;
let mainPage = null;                    // 로그인/메인 탭
let reservationPage = null;             // 예약 탭
let didCalendarSmokeCheck = false;   // 최초 1회만 달력 스모크 체크(열기→닫기)
let authInterval = null;                //인증 만료 확인 interval
let watcherCaps = null; // { singleCheck: boolean }
let watcherProcess = null;                // 현재 실행 중인 파이썬/EXE watcher 프로세스 참조
let processingQueue = false;              // 큐 처리 루프 동작 여부
let lastSweepAt = 0;
const SWEEP_COOLDOWN_MS = 5000;
const MAX_RESTORE_QUEUE = 20;
const RUN_TIMEOUT_MS = 8_000;
const restoreQueue = [];                  // { exe, pid, resolve, reject }
const WATCHER_NAME = 'chrome_minimized_watcher.exe';


//region ==================== 시간 대기 ====================
// 확인 완료 2025-09-13 ksh
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
//endregion


//region ==================== 예약 페이지 안정화/달력 유틸 ====================
// 확인 완료 2025-09-13 ksh
async function ensureBookingReady(p) {
    // === 신규 === 페이지 핸들 유효성 가드
    if (!p || (p.isClosed && p.isClosed())) {
        throw new Error('페이지 핸들이 유효하지 않습니다.');
    }

    // === 신규 === 탭을 최전면으로 올려 포커스 확보(백그라운드 탭 UI 지연 방지)
    try { await p.bringToFront(); } catch (e) {
        nodeError('bringToFront 실패:', (e && e.message) || String(e));
    }

    // === 신규 === DOM 준비 상태 대기(complete 또는 interactive면 통과)
    await p.waitForFunction(
        () => document.readyState === 'complete' || document.readyState === 'interactive',
        { timeout: 10_000 }
    );

    // === 신규 === 달력 UI 렌더 신호 중 하나라도 보이면 OK(테마 차이 대비)
    const waitCont = p.waitForSelector('.dhx_cal_container.dhx_scheduler_list', { visible: true, timeout: 15_000 }).catch(() => null);
    const waitNav  = p.waitForSelector('.dhx_cal_nav_button',                    { visible: true, timeout: 15_000 }).catch(() => null);
    const el = await Promise.race([waitCont, waitNav]);

    // === 신규 === UI 타임아웃 처리
    if (!el) {
        throw new Error('예약 UI 로딩 타임아웃');
    }
    return true;
}
//endregion


//region ==================== 달력 작동 확인 열기 ====================
// 확인 완료 2025-09-13 ksh
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
//endregion


//region ==================== 달력 작동 확인 닫기 ====================
// 확인 완료 2025-09-13 ksh
async function ensureCalendarClosed(p) {
    await p.waitForSelector('.btn_clander', { timeout: 8_000 });
    const opened = await p.$('.vfc-main-container');
    if (opened) {
        await p.click('.btn_clander', { delay: 30 });
        await sleep(300);
        nodeLog('✅ 달력 닫힘');
    }
}
//endregion


//region ==================== 달력 작동 확인 ====================
// 확인 완료 2025-09-13 ksh
async function calendarSmokeCheck(p) {
    await ensureCalendarOpen(p);
    await ensureCalendarClosed(p);
}
//endregion


//region ==================== 내부 상태 초기화(참조 끊기) ====================
// 확인 완료 2025-09-13 ksh
function _resetBrowserState() {
    browser = null;
    page = null;
    mainPage = null;
    reservationPage = null;
}
//endregion


//region ==================== 기존 브라우저를 안전하게 종료 ====================
// 확인 완료 2025-09-13 ksh
async function _safeShutdownExistingBrowser() {
    if (!browser) return;

    try {
        // 의도적 종료: relaunch 억제(2초)
        suppress(2_000);

        // puppeteer.launch(...)로 “직접 실행”한 브라우저인 경우
        //   - browser.process()  ⇒ ChildProcess 반환( truthy )
        //   - browser.isConnected() ⇒ CDP 연결 유지 동안 true (일반적으로 true)
        // puppeteer.connect(...)로 “기존/원격 브라우저에 접속”한 경우
        //   - browser.process()  ⇒ null (자식 프로세스 없음; 프로세스 제어 불가)
        //   - browser.isConnected() ⇒ 접속 중 true, disconnect() 후 false (브라우저 프로세스는 계속 살아 있을 수 있음)
        const proc = (browser && typeof browser.process === 'function') ? browser.process() : null;
        const isWsConnected = (typeof browser.isConnected === 'function') && browser.isConnected();

        // 1) 가능하면 먼저 우아하게 종료 (launch/connect 공통)
        if (isWsConnected) {
            nodeLog('🔁 기존 브라우저 종료 시도(browser.close)');
            try {
                await browser.close();
            } catch (e) {
                nodeError('⚠️ browser.close 실패(무시 가능):', e?.message || e);
            }
        }

        // 2) launch로 띄운 크롬 프로세스가 여전히 살아있으면, 잠깐 대기 후 강제 종료(최후 수단) - 현 프그램
        if (proc && !proc.killed) {
            // close() 이후 최대 0.8초 동안 프로세스가 스스로 종료되는지 기다림
            // - 0.8초 내 'exit' 발생 → 정상 종료(true)
            // - 0.8초 경과 → 아직 살아있음(false) → 강제 종료로 진행
            const exited = await new Promise((resolve) => {
                let settled = false;
                const timeoutId = setTimeout(() => {
                    if (!settled) { settled = true; resolve(false); } // 타임아웃: 미종료
                }, 800);

                try {
                    proc.once('exit', () => {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeoutId);
                            resolve(true); // 정상 종료
                        }
                    });
                } catch {
                    // 일부 드문 환경에서 once 등록이 실패할 수 있음 → 바로 강제 종료 경로로
                    clearTimeout(timeoutId);
                    resolve(false);
                }
            });

            if (!exited) {
                nodeLog('🔪 기존 브라우저 프로세스 강제 종료');
                try {
                    // 윈도우는 시그널 개념이 약해 SIGKILL이 무시될 수 있어 기본 kill() 권장
                    if (process.platform === 'win32') proc.kill();
                    else proc.kill('SIGKILL');
                } catch (e) {
                    nodeError('⚠️ 프로세스 강제 종료 실패:', e?.message || e);
                }
            }
        }

    } catch (e) {
        nodeError('⚠️ 기존 브라우저 종료 중 오류(무시 후 진행):', e?.message || e);
    } finally {
        // 어떤 경우든 내부 참조는 반드시 끊어 새 시작을 준비
        _resetBrowserState(); // browser/page/mainPage/reservationPage = null
    }
}
//endregion


//region ==================== 인증 만료 브라우저 종료 (watcherProcess도 함께 정리) ====================
async function watchForAuthExpiration(mainPageParam) {
    if (authInterval) return; // ✅ 중복 감지 방지

    const CHECK_INTERVAL = 5000;
    nodeLog('✅ 인증 만료 확인 시작');

    const checkLoop = async () => {
        try {
            // === 신규 === 안전 호출(옵셔널 체이닝 제거)
            const browser = (mainPageParam && typeof mainPageParam.browser === 'function')
                ? mainPageParam.browser()
                : null;

            // === 신규 === 연결 상태 점검 (옵셔널 체이닝 제거)
            if (!browser || !(browser.isConnected && browser.isConnected())) {
                nodeLog('✅ 인증 감시: 브라우저 없음/연결 끊김 → 앱 재시작 요청');
                clearInterval(authInterval);
                authInterval = null;
                // 중앙 유틸이 쿨다운/중복 가드 처리
                requestRelaunch({ reason: 'auth watcher: browser not connected' });
                return;
            }

            const pages = await browser.pages();

            for (const page of pages) {
                // === 신규 === null 가드 + isClosed 체크
                if (!page || (page.isClosed && page.isClosed())) continue;

                try {
                    const el = await page.$('.ico_alert_p');
                    if (!el) continue;

                    // === 신규 === 안전한 텍스트 추출
                    const text = await page.evaluate(
                        (elm) => (elm && elm.textContent ? elm.textContent.trim() : ''),
                        el
                    );
                    nodeLog(`🔍 인증 메시지: ${text}`);

                    if (text.indexOf('인증이 만료되었습니다.') !== -1) {
                        nodeLog('⚠️ 인증 만료 감지됨');

                        clearInterval(authInterval);
                        authInterval = null;

                        // === 신규 === 30초간 타 모듈 재시작 요청 억제
                        suppress(30 * 1000);

                        // === 신규 === UX 알림을 먼저 발송 (즉시 토스트 등)
                        const win = BrowserWindow.getAllWindows()[0];
                        if (win && win.webContents) {
                            win.webContents.send('auth-expired');
                            nodeLog('📤 renderer에 auth-expired 전송 완료');
                        }

                        // === 핵심 변경점 ===
                        // 브라우저를 여기서 직접 종료하지 않고 중앙 재시작 정책만 호출
                        // 종료 과정에서 quitApp → shutdownBrowser()가 단 한 번 실행됨
                        requestRelaunch({ reason: 'auth watcher: auth expired' });

                        return;
                    }
                } catch (e) {
                    // === 신규 === optional chaining 미사용
                    nodeError('❌ 페이지 인증 감시 중 오류:', (e && e.message) || String(e));
                }
            }
        } catch (e) {
            nodeError('❌ 전체 인증 감시 루프 오류:', (e && e.message) || String(e));
        }
    };

    // === 신규 === 첫 체크를 즉시 한 번 실행해 UX 반응 속도 향상
    await checkLoop();
    authInterval = setInterval(checkLoop, CHECK_INTERVAL);
}
//endregion


//region ==================== 브라우저 종료 (watcherProcess도 함께 정리) ====================
// 주의 shutdownBrowser 발생하면 browser.on('disconnected' 발생하므로 재시작 우려
// 따라서 blockRelaunch();를 꼭 앞에 넣어야 함.
// 확인 완료 2025-09-13 ksh
async function shutdownBrowser() {
    if (!browser) return;

    try {
        // 의도적 종료: relaunch 억제(2초)
        suppress(2_000);

        const isWsConnected = (typeof browser.isConnected === 'function') && browser.isConnected();
        const proc = (typeof browser.process === 'function') ? browser.process() : null;

        // 1) 우아한 종료 먼저 시도
        if (isWsConnected) {
            try {
                await browser.close();
                nodeLog('🛑 Puppeteer browser.close 브라우저 정상 종료');
            } catch (e) {
                nodeError('⚠️ browser.close 실패(무시 가능):', e && e.message ? e.message : String(e));
            }
        }

        // 2) 프로세스가 남아있으면 잠시 대기 후 강제 종료
        if (proc && !proc.killed) {
            const exited = await new Promise((resolve) => {
                let settled = false;
                const to = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 800);
                try {
                    proc.once('exit', () => {
                        if (!settled) { settled = true; clearTimeout(to); resolve(true); }
                    });
                } catch (_e) {
                    clearTimeout(to);
                    resolve(false);
                }
            });

            if (!exited) {
                try {
                    if (process.platform === 'win32') proc.kill(); // 윈도우는 기본 kill 권장
                    else proc.kill('SIGKILL');
                    nodeLog('🛑 Puppeteer 프로세스 강제 종료');
                } catch (e) {
                    nodeError('❌ 프로세스 강제 종료 실패:', e && e.message ? e.message : String(e));
                }
            }
        }
    } catch (e) {
        nodeError('❌ shutdownBrowser 오류:', e && e.message ? e.message : String(e));
    } finally {

        // 3) 내부 참조 정리
        _resetBrowserState(); // browser/page/mainPage/reservationPage = null

        // 4) 주기/워처 정리 (여긴 예외 거의 안 남)

        // 인증 만화 확인 제거
        if (authInterval) {
            clearInterval(authInterval); // clearInterval 자체는 예외 안 던짐
            authInterval = null;
        }

        //브라우저 최대화 watcher
        if (typeof ensureStopped === 'function') {
            try { await ensureStopped(watcherProcess); }
            catch (e) { nodeError('⚠️ watcherProcess 정지 실패:', e && e.message ? e.message : String(e)); }
        }
        watcherProcess = null;

        // 브라우저 최대화 watcher 프로세스 종료
        if (typeof killAllWatchers === 'function') {
            try { await killAllWatchers(); nodeLog('🧹 watcher 프로세스 종료 완료'); }
            catch (e) { nodeError('⚠️ watcher 일괄 종료 실패:', e && e.message ? e.message : String(e)); }
        }
    }
}
//endregion


//region ==================== 브라우저 초기화 & 메인 페이지 획득 ====================
// 확인 완료 2025-09-13 ksh
async function initBrowser(chromePath) {
    // 0) 기존 브라우저가 있으면 먼저 정리
    try {
        await _safeShutdownExistingBrowser();
    } catch (e) {
        nodeError('⚠️ 기존 브라우저 정리 중 오류(무시):', (e && e.message) ? e.message : String(e)); // ✅ 무시하지만 로그는 남김
    }

    try {
        // 1) 새 브라우저 실행
        browser = await puppeteer.launch({
            headless: false,                // ❌ 헤드리스 모드 비활성화 → 실제 크롬 창 띄움
            executablePath: chromePath,     // 사용할 크롬 실행 파일 경로 (자동/수동 탐지 결과)
            defaultViewport: null,          // 기본 뷰포트 강제 적용 안 함 → 실제 창 크기 그대로 사용
            protocolTimeout: 180_000,       // Puppeteer 내부 프로토콜 요청 최대 대기시간 (ms, 여기선 3분)
            // → 브라우저와 Puppeteer 간 통신이 3분 이상 멈추면 강제로 실패 처리
            args: [
                '--window-size=800,300',    // 초기 창 크기 (width=800, height=300)
                '--window-position=0,800',  // 초기 창 위치 (x=0, y=800 → 화면 좌측 하단 근처)
                '--disable-infobars',       // "Chrome is being controlled by automated test software" 안내바 숨김
                '--mute-audio',             // 크롬 내 오디오 출력 음소거
                '--disable-features=AutofillServerCommunication', // 자동완성 서버 통신 비활성화 → 폼 입력시 불필요 통신 차단
                '--disable-blink-features=AutomationControlled',  // `navigator.webdriver` 감지 회피 (봇 탐지 우회 기본 옵션)

                // === 신규 안정성 옵션 추가 ===
                '--no-first-run',                           // 크롬 첫 실행 안내 비활성화
                '--no-default-browser-check',               // 기본 브라우저 확인 팝업 비활성화
                '--disable-background-timer-throttling',    // 백그라운드 탭 타이머 지연 방지
                '--disable-backgrounding-occluded-windows', // 가려진 창 리소스 절약 비활성화
                '--disable-renderer-backgrounding',         // 렌더러 백그라운드화 방지
            ],
        });
        nodeLog('🚀 새 브라우저 인스턴스 실행됨');

        // 2) 브라우저 종료 감지 → 상태 초기화 + 재시작 정책
        browser.on('disconnected', () => {
            // 1 이벤트 의미: Puppeteer ↔ Chrome CDP(WebSocket) 연결이 끊겼을 때 발생
            //    - 정상 종료: browser.close() 호출, 사용자가 창 닫음, 우리가 프로세스 kill
            //    - 비정상 종료: 크롬 크래시, 통신 끊김, 프로세스 강제 종료 등

            nodeLog('🛑 브라우저 종료 감지: 내부 객체 초기화');

            // 2 내부 참조 모두 끊기 (GC 가능 상태로)
            _resetBrowserState(); // browser/page/mainPage/reservationPage = null

            // 재시작 요청(차단/억제/쿨다운/중복 제어는 utils/relaunch.js에서 일괄 처리)
            try {
                requestRelaunch({ reason: 'puppeteer: browser disconnected event' });
            } catch (e) {
                nodeError('❌ requestRelaunch 호출 중 오류:', (e && e.message) ? e.message : String(e));
            }
        });

        // 3) 페이지 확보(기존 탭 있으면 0번, 없으면 새 탭)
        //    - Chrome이 시작되면 기본 탭(about:blank 등)이 이미 열려 있을 수 있음
        //    - 일부 환경에서는 launch 직후 pages() 호출 타이밍에 따라 빈 배열이 올 수도 있어 try/catch로 보강
        //    - pages[0]가 직전에 닫혀버리는 레이스를 대비하여 newPage() 재시도 분기 추가
        let pages;
        try {
            pages = await browser.pages();   // 현재 열린 모든 탭(Page) 목록을 가져옴
        } catch (e) {
            // 드문 환경에서 CDP 타이밍 이슈로 실패할 수 있으므로 안전 폴백
            nodeError('⚠️ browser.pages() 실패(무시 후 새 탭 시도):', (e && e.message) ? e.message : String(e));
            pages = [];
        }

        try {
            // pages.length > 0 이면 첫 탭 재사용 (불필요한 탭 증가 방지)
            // 0개라면 newPage()로 새 탭 생성
            page = pages.length ? pages[0] : await browser.newPage();
        } catch (e) {
            // 첫 시도가 레이스로 실패하는 드문 경우(탭이 방금 닫힘 등) → 한 번 더 시도
            nodeError('⚠️ page 생성 1차 실패, 재시도:', (e && e.message) ? e.message : String(e)); // === 신규: 레이스 대비 재시도
            page = await browser.newPage();
        }

        if (!page) throw new Error('❌ 페이지 생성 실패');

        // 기본 대기시간 설정
        page.setDefaultTimeout(30_000);           // page-level 동작(클릭/타이핑/대기 등)의 기본 타임아웃
        page.setDefaultNavigationTimeout(60_000); // 네비게이션(이동/리다이렉트/로드)의 기본 타임아웃

        nodeLog('📄 페이지 객체 획득 완료');
        mainPage = page;

        // 4) 인증 만료 감시 훅(외부 구현)
        try {
            await watchForAuthExpiration(page);
        } catch (e) {
            nodeError('⚠️ watchForAuthExpiration 예외(무시):', (e && e.message) ? e.message : String(e)); // === 신규: 전체 실패 방지
        }

        // 5) 호출자에서 필요 시 재사용하도록 반환
        return { browser, page };
    } catch (err) {
        nodeError('❌ 브라우저 생성 중 에러:', (err && err.message) ? err.message : String(err));
        // 실패 시 상태 초기화 보장
        _resetBrowserState();
        throw err;
    }
}
//endregion


//region ==================== 로그인 ====================
// 확인 완료 2025-09-13 ksh
async function login({ userId, password, chromePath }) {
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

        // === 신규 === 예약 탭 생성 감지(안전 보강)
        let hookConnected = false;

        //타겟(예약탭) 등에 이벤트 걸기
        const newPagePromise = new Promise((resolve, reject) => {
            const browser = _browser; // page.browser() 동일하지만 의도 명시
            if (!browser || !(browser.isConnected && browser.isConnected())) {
                return reject(new Error('브라우저 연결 상태가 유효하지 않습니다.'));
            }

            let timer = setTimeout(() => {
                try { browser.removeListener('targetcreated', onTargetCreated); } catch (_) {}
                reject(new Error('예약 페이지 탭 생성 타임아웃(15s)'));
            }, 15 * 1000);

            function cleanup() {
                try { browser.removeListener('targetcreated', onTargetCreated); } catch (_) {}
                if (timer) { clearTimeout(timer); timer = null; }
            }

            async function onTargetCreated(target) {
                try {
                    if (!target) return;

                    // === 신규 === page 타입만 처리 (service_worker 등 스킵)
                    if (typeof target.type === 'function' && target.type() !== 'page') return;

                    // === 신규 === 이 로그인 페이지가 연 팝업만 허용
                    if (typeof target.opener === 'function') {
                        const opener = target.opener();
                        if (!opener || (page && typeof page.target === 'function' && opener !== page.target())) {
                            return; // 내가 연 팝업이 아니면 스킵
                        }
                    }

                    const newPage = await target.page();
                    if (!newPage || (newPage.isClosed && newPage.isClosed())) return;

                    attachRequestHooks(newPage);
                    hookConnected = true;
                    nodeLog('🔌 Request hook connected (in login)');

                    //  이 페이지의 기본 대기 타임아웃(모든 wait류) 30초 설정
                    if (newPage.setDefaultTimeout) newPage.setDefaultTimeout(30_000);
                    //  이 페이지의 기본 네비게이션 타임아웃(로드/리다이렉트) 60초 설정
                    if (newPage.setDefaultNavigationTimeout) newPage.setDefaultNavigationTimeout(60_000);

                    reservationPage = newPage;

                    cleanup();
                    resolve(newPage);
                } catch (error) {
                    nodeError('❌ targetcreated 처리 중 에러:', (error && error.message) || String(error));
                    // 실패해도 리스너 유지 → 다음 targetcreated를 계속 대기
                }
            }

            // === 신규 === 첫 타겟이 예약 탭이 아닐 수도 있으므로 on 등록, 성공 시에만 제거
            browser.on('targetcreated', onTargetCreated);
        });


        nodeLog('📆 예약 버튼 클릭 시도');
        await page.waitForSelector('button.booking__btn', { timeout: 10_000 });
        await page.click('button.booking__btn');
        const newPage = await newPagePromise;
        if (!newPage || newPage.isClosed()) {
            throw new Error('❌ 예약 페이지 탭 생성 실패 또는 닫힘 상태');
        }

        //그 페이지(탭)를 화면 최전면으로 올려 포커스
        nodeLog('🟢 예약 페이지 접근됨:', newPage.url());

        //예약 준비확인
        await ensureBookingReady(newPage);

        //달력확인
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
//endregion


//region ==================== 로그인 ====================
// 확인 완료 2025-09-13 ksh
// 얕은 헬스체크 & 예약탭 존재 여부 체크
// 내가 띄운 Puppeteer 브라우저 세션 자체가 살아있는가?”**만 확인합니다.
// ───────────────────────────────────────────────────────────────
function isPuppeteerAlive() { // [ADD]
    return !!(browser && browser.isConnected && browser.isConnected());
}
//endregion


//region ==================== 복원 진행 여부 노출 (apiServer가 재시작 판단 방어용) ====================
// 확인 완료 2025-09-13 ksh
function isRestoreInProgress() {
    return restoreQueue.length > 0;
}
//endregion


//region ==================== 예약탭 확인 간단 ====================
// 확인 완료 2025-09-13 ksh
async function hasReservationTab() { // [ADD]
    if (!browser || !browser.isConnected()) return false;
    const pages = await browser.pages();
    return pages.some(p => !p.isClosed() && p.url().includes('/ui/booking'));
}
//endregion


//region ==================== 예약탭 확인 상세 ====================
// 확인 완료 2025-09-13 ksh
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
//endregion


//region ==================== Chrome 최소화 복원 (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
async function restoreChromeIfMinimized() {
    if (!browser || !browser.process || !browser.process()) {
        nodeLog('restoreChromeIfMinimized: 브라우저 프로세스 없음');
        return;
    }

    const watcherExePath = getWatcherExePath();
    const chromePid = browser.process().pid;
    nodeLog('[watcher exe 요청]', watcherExePath);

    return new Promise((resolve, reject) => {
        if (restoreQueue.length >= MAX_RESTORE_QUEUE) {
            nodeError(`restoreQueue overflow (${restoreQueue.length})`);
            return reject(new Error('restore queue overflow'));
        }
        restoreQueue.push({ watcherExePath, chromePid, resolve, reject });
        drainRestoreQueue().catch(err => nodeError('drainRestoreQueue error:', err?.message || err));
    });
}
//endregion


//region ==================== chrome_minimized_watcher 경로 (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
function getWatcherExePath() {
    const devPath = path.join(__dirname, '..', '..', 'resources', 'python', WATCHER_NAME);
    if (!app || !app.isPackaged) return devPath;

    const resourcesPath = process.resourcesPath;
    const appRoot = path.dirname(resourcesPath);

    const candidates = [
        path.join(resourcesPath, 'python', WATCHER_NAME),
        path.join(appRoot,       'python', WATCHER_NAME),
        path.join(resourcesPath, 'resources', 'python', WATCHER_NAME),
        path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'python', WATCHER_NAME),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error('[watcher EXE not found]\n' + candidates.join('\n'));
}
//endregion


//region ==================== drainRestoreQueue 실행 (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
async function drainRestoreQueue() {
    if (processingQueue) return; // 중복 루프 방지
    processingQueue = true;
    try {
        while (restoreQueue.length) {
            const { watcherExePath, chromePid, resolve, reject } = restoreQueue.shift();
            try {
                await runWithTimeout(runWatcherOnce(watcherExePath, chromePid), RUN_TIMEOUT_MS);
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
//endregion


//region ==================== Python watcher 종료 (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
function killAllWatchers() {
    return new Promise(res => {
        if (process.platform !== 'win32') return res();
        execFile('taskkill', ['/IM', WATCHER_NAME, '/T', '/F'], () => res());
    });
}
//endregion


//region ==================== onceExit (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
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
//endregion


//region ==================== ensureStopped 종료확인 (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
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
//endregion


//region ==================== detectWatcherFeatures (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
async function detectWatcherFeatures(watcherExePath) {
    if (watcherCaps) return watcherCaps;
    watcherCaps = { singleCheck: false };
    try {
        await new Promise((resolve) => {
            execFile(watcherExePath, ['--help'], (err, stdout, stderr) => {
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
//endregion


//region ==================== runWatcherOnce (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
async function runWatcherOnce(watcherExePath, chromePid) {
    const now = Date.now();
    if (now - lastSweepAt > SWEEP_COOLDOWN_MS) {
        await killAllWatchers();
        lastSweepAt = now;
    }

    await ensureStopped(watcherProcess);

    const caps = await detectWatcherFeatures(watcherExePath);
    const args = caps.singleCheck
        ? ['--pid', String(chromePid), '--single-check', '--exit-if-not-found', '--timeout', '3']
        : ['--restore-once', '--pid', String(chromePid)];

    watcherProcess = spawn(watcherExePath, args, { windowsHide: true });
    nodeLog(`[PYTHON] started pid=${watcherProcess.pid} args=${args.join(' ')}`);
    watcherProcess.stdout.on('data', d => nodeLog('[PYTHON]', String(d).trim()));
    watcherProcess.stderr.on('data', d => nodeError('[PYTHON ERROR]', String(d).trim()));

    try {
        const { code } = await onceExit(watcherProcess, 5000);
        watcherProcess = null;

        // PID 매칭 실패 시 fallback
        if (code === 101 || (!caps.singleCheck && code === 0)) {
            const fbArgs = caps.singleCheck ? ['--single-check', '--timeout', '3'] : ['--restore-once'];
            const fb = spawn(watcherExePath, fbArgs, { windowsHide: true });
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
//endregion


//region ==================== runWithTimeout (Python watcher 실행) ====================
// 확인 완료 2025-09-13 ksh
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
//endregion


module.exports = {
    login,
    findReservationTab,
    shutdownBrowser,
    isPuppeteerAlive,     // [ADD]
    hasReservationTab,    // [ADD]
    isRestoreInProgress   // [ADD]
};
