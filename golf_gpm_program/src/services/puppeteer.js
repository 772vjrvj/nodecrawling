// src/services/puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');
const { spawn } = require('child_process');

// ───────────────────────────────────────────────────────────────────────────────
// Optional Electron deps + path/fs (빌드/개발 모두에서 안전하게 경로 계산)
// ───────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
let app = null; try { ({ app } = require('electron')); } catch { app = null; }

// 시스템 Python 경로 (필요 시 .env 또는 시스템 환경변수에서 절대경로로 고정)
const PYTHON = process.env.PYTHON || 'python';

// 파이썬 watcher 스크립트의 절대 경로 계산
function getWatcherScriptPath() {
    const file = 'chrome_minimized_watcher.py';

    // 개발 경로: <project>/resources/python/...
    const devPath = path.join(__dirname, '..', '..', 'resources', 'python', file);
    if (!app || !app.isPackaged) return devPath;

    // 배포 경로 후보들
    const resourcesPath = process.resourcesPath;                 // ...\PandoP\resources
    const appRoot       = path.dirname(resourcesPath);           // ...\PandoP
    const candidates = [
        path.join(resourcesPath, 'python', file),                  // extraResources 일 때
        path.join(appRoot,       'python', file),                  // 지금처럼 extraFiles 로 앱 루트에 있을 때  👈
        path.join(resourcesPath, 'resources', 'python', file),     // 환경별 변형 대비
        path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'python', file)
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('[watcher] not found: \n' + candidates.join('\n'));
}

// ───────────────────────────────────────────────────────────────────────────────
// 내부 상태
// ───────────────────────────────────────────────────────────────────────────────
let browser = null;
let page = null;

// 탭 참조 분리
let mainPage = null;        // 로그인/메인 탭
let reservationPage = null; // 예약 탭

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
            args: [
                // '--window-size=1200,1000',
                '--window-size=800,300',
                '--window-position=0,800',
                '--disable-infobars',
                '--disable-features=AutofillServerCommunication',
                '--disable-blink-features=AutomationControlled',
            ],
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
        await page.goto('https://gpm.golfzonpark.com', { waitUntil: 'networkidle2', timeout: 60000 });

        // 입력
        await page.waitForSelector('#user_id', { timeout: 10000 });
        await page.type('#user_id', userId, { delay: 50 });

        await page.waitForSelector('#user_pw', { timeout: 10000 });
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

                    reservationPage = newPage;
                    resolve(newPage);
                } catch (error) {
                    nodeError('❌ targetcreated 처리 중 에러:', error.message);
                }
            });
        });

        // 예약 버튼 클릭 → 새 탭 생성
        nodeLog('📆 예약 버튼 클릭 시도');
        await page.waitForSelector('button.booking__btn', { timeout: 10000 });
        await page.click('button.booking__btn');

        const newPage = await newPagePromise;
        if (!newPage || newPage.isClosed()) {
            throw new Error('❌ 예약 페이지 탭 생성 실패 또는 닫힘 상태');
        }

        await newPage.bringToFront();

        // 예약 UI 로딩 확인
        await newPage
            .waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30000 })
            .then(() => nodeLog('✅ 예약 페이지 로딩 완료'))
            .catch(() => nodeLog('⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list'));

        nodeLog('🟢 예약 페이지 접근됨:', newPage.url());

        // 후킹 실패 시 대비
        setTimeout(async () => {
            if (!hookConnected) {
                try {
                    const pages = await _browser.pages();
                    const fallbackPage = pages.find(p => p.url().includes('reservation') && !p.isClosed());
                    if (fallbackPage) {
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
    await restoreChromeIfMinimized(); // 최소화 상태면 복원 시도

    if (!browser) throw new Error('브라우저가 실행되지 않았습니다.');

    // 보관 참조 우선
    if (reservationPage && !reservationPage.isClosed()) {
        const exists = await reservationPage.$('.dhx_cal_nav_button');
        if (exists) {
            nodeLog('✅ 예약 탭(보관 참조) 찾음:', reservationPage.url());
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
                return p;
            }
        }
    }

    throw new Error('❌ 예약 탭을 찾을 수 없습니다.');
}

// ───────────────────────────────────────────────────────────────────────────────
// 인증 만료 감시
// ───────────────────────────────────────────────────────────────────────────────
async function watchForAuthExpiration(mainPageParam) {
    const CHECK_INTERVAL = 5 * 1000; // 5초마다 검사

    const checkLoop = async () => {
        const targetMain = mainPageParam && !mainPageParam.isClosed() ? mainPageParam : mainPage;
        if (!targetMain || targetMain.isClosed()) return;

        try {
            const text = await targetMain.$eval('.ico_alert_p', el => el.textContent).catch(() => null);

            if (text && text.includes('인증이 만료되었습니다.')) {
                nodeLog('⚠️ 인증 만료 감지됨 (자동 감시)');

                const goBtn = await targetMain.$('.btn_golfzonpark_go');
                if (goBtn) {
                    await goBtn.click();
                    nodeLog('🔄 인증 재이동 버튼 클릭 완료');
                }

                // 기존 예약 탭 닫기
                const pages = await targetMain.browser().pages();
                for (const p of pages) {
                    if (!p.isClosed() && p.url().includes('/ui/booking')) {
                        await p.close().then(() => nodeLog('❌ 기존 예약 탭 닫음 (인증 만료 감지 후)'));
                    }
                }

                // 예약 버튼 다시 클릭 → 새 탭 후킹
                await targetMain.waitForSelector('button.booking__btn', { timeout: 10000 });

                const reOpenPromise = new Promise(resolve => {
                    targetMain.browser().once('targetcreated', async target => {
                        try {
                            const np = await target.page();
                            if (np && !np.isClosed()) {
                                attachRequestHooks(np);
                                reservationPage = np;
                                nodeLog('🔁 인증 만료 복구: 새 예약 탭 후킹 및 참조 갱신');
                                resolve(np);
                            } else {
                                resolve(null);
                            }
                        } catch {
                            resolve(null);
                        }
                    });
                });

                await targetMain.click('button.booking__btn');
                await reOpenPromise;
                nodeLog('📆 예약 탭 재실행 시도됨');
            }
        } catch (e) {
            nodeError('❌ 인증 만료 감시 중 오류:', e.message);
        }
    };

    setInterval(checkLoop, CHECK_INTERVAL);
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
// Chrome 최소화 복원 (Python watcher 실행)
// ───────────────────────────────────────────────────────────────────────────────
async function restoreChromeIfMinimized() {
    try {
        if (!browser || !browser.process || !browser.process()) {
            nodeLog('restoreChromeIfMinimized: 브라우저 프로세스 없음');
            return;
        }
        const chromePid = browser.process().pid;

        const script = getWatcherScriptPath();
        nodeLog('[watcher] script:', script);

        const py = spawn(PYTHON, [script, '--restore-once', '--pid', String(chromePid)]);

        py.stdout.on('data', data => nodeLog('[PYTHON]', data.toString().trim()));
        py.stderr.on('data', data => nodeError('[PYTHON ERROR]', data.toString().trim()));
        py.on('close', code => nodeLog(`[PYTHON] watcher 종료 (code: ${code})`));
    } catch (e) {
        nodeError('⚠️ Chrome 복원 중 오류:', e.message);
    }
}

module.exports = { initBrowser, login, getPage, findReservationTab };
