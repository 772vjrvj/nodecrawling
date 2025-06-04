//puppeteer.js

const puppeteer = require('puppeteer');
const { attachRequestHooks } = require('../handlers/router');


let browser = null;
let page = null;

async function initBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            defaultViewport: null,
            args: [
                '--window-size=1200,1000',
                '--disable-infobars',
                '--disable-features=AutofillServerCommunication',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const pages = await browser.pages();
        page = pages.length ? pages[0] : await browser.newPage();
    }
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
async function login({ userId, password, token }) {
    const { page } = await initBrowser();

    await page.goto("https://gpm.golfzonpark.com", { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector("#user_id", { timeout: 10000 });
    await page.type("#user_id", userId, { delay: 50 });

    await page.waitForSelector("#user_pw", { timeout: 10000 });
    await page.type("#user_pw", password, { delay: 50 });

    await Promise.all([
        page.click("button[type='submit']"),
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);

    // ✅ 예약 탭 열기 전에 후킹까지 포함
    const newPagePromise = new Promise(resolve => {
        page.browser().once('targetcreated', async target => {
            const newPage = await target.page();

            // ✅ 후킹 여기서 바로 연결
            attachRequestHooks(newPage);

            nodeLog("🔌 Request hook connected (in login)");

            resolve(newPage);
        });
    });

    await page.waitForSelector('button.booking__btn', { timeout: 10000 });
    await page.click('button.booking__btn');

    const newPage = await newPagePromise;
    //당 탭(페이지)을 브라우저의 최전면으로 가져오는 함수입니다.
    await newPage.bringToFront();

// 요소가 뜰 때까지 대기 (waitForNavigation 제거)
    await newPage.waitForSelector('.dhx_cal_container.dhx_scheduler_list', { timeout: 30000 })
        .then(() => nodeLog("✅ 예약 페이지 로딩 완료"))
        .catch(() => nodeLog("⚠️ 예약 페이지 UI 로딩 실패: .dhx_cal_container.dhx_scheduler_list"));

    nodeLog("🟢 예약 페이지 접근됨:", newPage.url());
    return newPage;
}



function getPage() {
    return page;
}

module.exports = { initBrowser, login, getPage };
