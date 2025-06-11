//puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');

let browser = null;
let page = null;

async function initBrowser(chromePath) {
    // ✅ 1. 이전 브라우저 인스턴스가 살아있으면 종료
    if (browser && browser.isConnected()) {
        nodeLog('🔁 기존 브라우저 인스턴스 종료');
        await browser.close();
        browser = null;
        page = null;
    }

    // ✅ 2. 새 브라우저 시작
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

    // ✅ 3. 브라우저 종료 감지 시 참조 해제
    browser.on('disconnected', () => {
        nodeLog('🛑 브라우저 종료 감지: 내부 객체 초기화');
        browser = null;
        page = null;
    });

    const pages = await browser.pages();
    page = pages.length ? pages[0] : await browser.newPage();

    return { browser, page };
}

/**
 * GPM 로그인 후 예약 탭을 열고 해당 Puppeteer Page 객체를 반환
 * @param {Object} param0
 * @param {string} param0.userId
 * @param {string} param0.password
 * @param {string} param0.token
 * @returns {Promise<Page>} 예약 페이지 탭 (newPage)
 */
async function login({ userId, password, token, chromePath }) {
    try {
        const { page, browser } = await initBrowser(chromePath);

        if (!browser || !browser.isConnected()) {
            throw new Error("브라우저가 실행되지 않았습니다.");
        }
        if (!page || page.isClosed()) {
            throw new Error("페이지가 닫혀 있어 작업을 중단합니다.");
        }

        await page.goto("https://gpm.golfzonpark.com", { waitUntil: 'networkidle2', timeout: 60000 });

        await page.waitForSelector("#user_id", { timeout: 10000 });
        await page.type("#user_id", userId, { delay: 50 });

        await page.waitForSelector("#user_pw", { timeout: 10000 });
        await page.type("#user_pw", password, { delay: 50 });

        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
        ]);

        const newPagePromise = new Promise(resolve => {
            page.browser().once('targetcreated', async target => {
                const newPage = await target.page();
                if (!newPage || newPage.isClosed()) {
                    throw new Error("예약 페이지 탭이 열리지 않았습니다.");
                }

                attachRequestHooks(newPage);
                nodeLog("🔌 Request hook connected (in login)");
                resolve(newPage);
            });
        });

        await page.waitForSelector('button.booking__btn', { timeout: 10000 });
        await page.click('button.booking__btn');

        const newPage = await newPagePromise;

        await newPage.bringToFront();

        await newPage.waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30000 })
            .then(() => nodeLog("✅ 예약 페이지 로딩 완료"))
            .catch(() => nodeLog("⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list"));

        nodeLog("🟢 예약 페이지 접근됨:", newPage.url());
        return newPage;

    } catch (err) {
        nodeError("❌ login() 함수 실행 중 에러:", err);
        throw err;
    }
}

function getPage() {
    return page;
}

module.exports = { initBrowser, login, getPage };
