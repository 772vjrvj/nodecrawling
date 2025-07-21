// src/services/puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');

let browser = null;
let page = null;

// ✅ 브라우저 초기화 함수
async function initBrowser(chromePath) {
    // 🔁 기존 브라우저가 있다면 완전히 종료
    if (browser) {
        try {
            if (browser.process()) {
                nodeLog('🔪 기존 브라우저 프로세스 강제 종료');
                browser.process().kill('SIGKILL'); // 🧨 완전한 프로세스 종료
            } else if (browser.isConnected()) {
                nodeLog('🔁 기존 브라우저 인스턴스 종료');
                await browser.close();
            }
        } catch (e) {
            nodeError('⚠️ 브라우저 종료 중 오류:', e.message);
        }

        browser = null;
        page = null;
    }

    try {
        // 🆕 새 브라우저 인스턴스 생성
        browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            defaultViewport: null,
            args: [
                '--window-size=1200,1000',
                '--disable-infobars',
                '--disable-features=AutofillServerCommunication',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        nodeLog('🚀 새 브라우저 인스턴스 실행됨');

        // 🛑 브라우저 종료 감지 시 내부 객체 초기화
        browser.on('disconnected', () => {
            nodeLog('🛑 브라우저 종료 감지: 내부 객체 초기화');
            browser = null;
            page = null;
        });

        const pages = await browser.pages();
        page = pages.length ? pages[0] : await browser.newPage();

        if (!page) throw new Error("❌ 페이지 생성 실패");

        nodeLog('📄 페이지 객체 획득 완료');

        await watchForAuthExpiration(page);

        return { browser, page };
    } catch (err) {
        nodeError('❌ 브라우저 생성 중 에러:', err.message);
        throw err;
    }
}

// ✅ 로그인 및 예약 페이지 진입 처리
async function login({ userId, password, token, chromePath }) {
    try {
        let result = await initBrowser(chromePath);
        const _browser = result.browser;
        page = result.page;

        // ✅ 브라우저 및 페이지 정상 상태 확인
        if (!_browser || !_browser.isConnected()) {
            throw new Error("❌ 브라우저가 실행되지 않았습니다.");
        }

        if (!page || page.isClosed()) {
            throw new Error("❌ 페이지가 닫혀 있어 작업을 중단합니다.");
        }

        nodeLog('🌐 로그인 페이지 접속 시도');
        await page.goto("https://gpm.golfzonpark.com", { waitUntil: 'networkidle2', timeout: 60000 });

        // 🧑‍💻 로그인 정보 입력
        await page.waitForSelector("#user_id", { timeout: 10000 });
        await page.type("#user_id", userId, { delay: 50 });

        await page.waitForSelector("#user_pw", { timeout: 10000 });
        await page.type("#user_pw", password, { delay: 50 });

        // 🚪 로그인 후 이동
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
        ]);

        nodeLog("🔐 로그인 완료");

        let hookConnected = false;

        // 🧭 새 탭(target) 감지하여 후킹
        const newPagePromise = new Promise(resolve => {
            page.browser().once('targetcreated', async target => {
                try {
                    const newPage = await target.page();
                    if (!newPage || newPage.isClosed()) {
                        throw new Error("❌ 예약 페이지 탭이 열리지 않았습니다.");
                    }

                    attachRequestHooks(newPage);
                    hookConnected = true;
                    nodeLog("🔌 Request hook connected (in login)");
                    resolve(newPage);
                } catch (error) {
                    nodeError("❌ targetcreated 처리 중 에러:", error.message);
                }
            });
        });

        // 📅 예약 버튼 클릭
        nodeLog('📆 예약 버튼 클릭 시도');
        await page.waitForSelector('button.booking__btn', { timeout: 10000 });
        await page.click('button.booking__btn');

        const newPage = await newPagePromise;

        if (!newPage || newPage.isClosed()) {
            throw new Error("❌ 예약 페이지 탭 생성 실패 또는 닫힘 상태");
        }

        await newPage.bringToFront();

        // 📆 예약 UI 로딩 확인
        await newPage.waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30000 })
            .then(() => nodeLog("✅ 예약 페이지 로딩 완료"))
            .catch(() => nodeLog("⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list"));

        nodeLog("🟢 예약 페이지 접근됨:", newPage.url());

        // ⛑️ fallback hook (후킹 실패시 대비)
        setTimeout(async () => {
            if (!hookConnected) {
                try {
                    const pages = await _browser.pages();
                    const fallbackPage = pages.find(p => p.url().includes('reservation') && !p.isClosed());
                    if (fallbackPage) {
                        attachRequestHooks(fallbackPage);
                        nodeLog("🔁 fallback hook connected (reservation page)");
                    }
                } catch (e) {
                    nodeError('❌ fallback hook 처리 중 에러:', e.message);
                }
            }
        }, 5000);

        return newPage;

    } catch (err) {
        nodeError("❌ login() 함수 실행 중 에러:", err.message);
        throw err;
    }
}

// ✅ 현재 예약 탭 찾기
async function findReservationTab() {
    if (!browser) throw new Error("브라우저가 실행되지 않았습니다.");

    const pages = await browser.pages();
    for (const p of pages) {
        if (p.isClosed()) continue;
        const url = p.url();
        if (url.includes('/ui/booking')) {
            const exists = await p.$('.dhx_cal_nav_button');
            if (exists) {
                nodeLog('✅ 예약 탭 찾음:', url);
                return p;
            }
        }
    }

    throw new Error("❌ 예약 탭을 찾을 수 없습니다.");
}

async function watchForAuthExpiration(mainPage) {
    const CHECK_INTERVAL = 10 * 1000; // 10초마다 검사

    const checkLoop = async () => {
        if (!mainPage || mainPage.isClosed()) return;

        try {
            const url = mainPage.url();
            // if (!url.includes('golfzonpark.com')) return;

            const text = await mainPage.$eval('.ico_alert_p', el => el.textContent).catch(() => null);

            if (text && text.includes('인증이 만료되었습니다.')) {
                nodeLog('⚠️ 인증 만료 감지됨 (자동 감시)');

                const goBtn = await mainPage.$('.btn_golfzonpark_go');
                if (goBtn) {
                    await goBtn.click();
                    nodeLog('🔄 인증 재이동 버튼 클릭 완료');
                }

                // 기존 예약 탭 닫기
                const pages = await mainPage.browser().pages();
                for (const p of pages) {
                    if (!p.isClosed() && p.url().includes('/ui/booking')) {
                        await p.close().then(() => nodeLog("❌ 기존 예약 탭 닫음 (인증 만료 감지 후)"));
                    }
                }

                // 예약 버튼 다시 클릭
                await mainPage.waitForSelector('button.booking__btn', { timeout: 10000 });
                await mainPage.click('button.booking__btn');
                nodeLog("📆 예약 탭 재실행 시도됨");
            }
        } catch (e) {
            nodeError('❌ 인증 만료 감시 중 오류:', e.message);
        }
    };

    setInterval(checkLoop, CHECK_INTERVAL);
}


// ✅ 현재 페이지 객체 반환
function getPage() {
    return page;
}

module.exports = { initBrowser, login, getPage, findReservationTab };
