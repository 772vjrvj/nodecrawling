// src/services/puppeteer.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { screen } = require('electron'); // Electron이 실행되고 있으니 screen 모듈 활용 가능

function detectChromePath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

    const platform = os.platform();
    const candidates = [];
    if (platform === 'win32') {
        candidates.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        );
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    }
    for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
    return null;
}

let browser = null;

async function ensureFreshBrowser() {
    if (browser && browser.isConnected?.()) {
        try { await browser.close(); } catch {}
    }
    browser = null;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function parseLatLonFromMapUrl(u) {
    try {
        // https://m.land.naver.com/map/<lat>:<lon>:...
        const after = (u.split('/map/')[1] || '').split('?')[0];
        const [latStr, lonStr] = after.split(':');
        const lat = Number(latStr);
        const lon = Number(lonStr);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
            return { lat: String(lat), lon: String(lon) };
        }
    } catch {}
    return { lat: null, lon: null };
}

// fin.land 검색 → (1) href에서 지도링크 추출 → (2) 클릭/새탭 감지 → (3) 모바일 UA 폴백
async function openNaver(executablePath, searchUrl) {
    await ensureFreshBrowser();

    const exe = executablePath || detectChromePath();
    if (!exe) throw new Error('Chrome 실행경로를 찾지 못했습니다.');

    // 모니터 해상도 가져오기
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    browser = await puppeteer.launch({
        headless: false,
        executablePath: exe,
        defaultViewport: null, // 브라우저 크기 강제하지 않음
        args: [
            `--window-size=${width},${height}`, // ✅ 크롬 창 자체 크기를 풀스크린 사이즈로
            '--disable-infobars',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    const pages = await browser.pages();
    const page = pages.length ? pages[0] : await browser.newPage();

    // 페이지 뷰포트도 창 크기에 맞추기
    await page.setViewport({ width, height });

    // ① 데스크톱 UA
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' });

    await page.goto('https://fin.land.naver.com', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await sleep(300);

    const resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const status = resp?.status?.() ?? null;

    // (A) 앵커 href 수집 → /map/ 우선
    let finalUrl = page.url();
    let mapUrl = null;
    try {
        await page.waitForSelector('a', { timeout: 8_000 });
        const hrefs = await page.$$eval('a', els => els.map(a => a.href).filter(Boolean));
        mapUrl = hrefs.find(h => /m\.land\.naver\.com\/map\//.test(h)) ||
            hrefs.find(h => /m\.land\.naver\.com/.test(h)) ||
            hrefs.find(h => /land\.naver\.com.*map/.test(h)) || null;
    } catch {}

    if (mapUrl) {
        await page.goto(mapUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        finalUrl = page.url();
        const { lat, lon } = finalUrl.includes('/map/') ? parseLatLonFromMapUrl(finalUrl) : { lat: null, lon: null };
        console.log('➡️ (href 직행) status:', status, 'finalUrl:', finalUrl, 'lat:', lat, 'lon:', lon);
        return { status, finalUrl, lat, lon };
    }

    // (B) 클릭/팝업
    const candidateSelectors = [
        'a[href*="m.land.naver.com"]',
        'ul li a',
        'a.link',
        '.result a',
    ];

    let clicked = false;
    for (const sel of candidateSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 4000 });

            const targetPromise = new Promise(resolve => {
                const handler = async target => {
                    try {
                        const p = await target.page();
                        if (p) {
                            browser.off('targetcreated', handler);
                            resolve(p);
                        }
                    } catch {}
                };
                browser.on('targetcreated', handler);
                setTimeout(() => resolve(null), 8000);
            });

            await page.click(sel, { delay: 60 }).catch(()=>{});
            const newPage = await targetPromise;

            if (newPage) {
                await newPage.bringToFront().catch(()=>{});
                try { await newPage.waitForLoadState?.('domcontentloaded', { timeout: 10000 }); } catch {}
                finalUrl = newPage.url();
            } else {
                try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch {}
                finalUrl = page.url();
            }
            clicked = true;
            break;
        } catch {}
    }

    if (clicked) {
        const { lat, lon } = finalUrl.includes('/map/') ? parseLatLonFromMapUrl(finalUrl) : { lat: null, lon: null };
        console.log('➡️ (클릭/팝업) status:', status, 'finalUrl:', finalUrl, 'lat:', lat, 'lon:', lon);
        if (lat && lon) return { status, finalUrl, lat, lon };
    }

    // (C) 모바일 UA 폴백
    try {
        const mobile = await browser.newPage();
        await mobile.setUserAgent('Mozilla/5.0 (Linux; Android 12; SM-G998N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Mobile Safari/537.36');
        await mobile.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' });

        const mUrl = searchUrl.replace('https://fin.land.naver.com/search', 'https://m.land.naver.com/search');
        await mobile.goto(mUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(()=>{});
        await sleep(500);

        let mhrefs = [];
        try {
            await mobile.waitForSelector('a', { timeout: 6000 });
            mhrefs = await mobile.$$eval('a', els => els.map(a => a.href).filter(Boolean));
        } catch {}
        let mmap = mhrefs.find(h => /m\.land\.naver\.com\/map\//.test(h)) || null;

        if (!mmap) {
            const mSelectors = ['a[href*="/map/"]', 'ul li a', '.list_item a', '.result a'];
            for (const sel of mSelectors) {
                try {
                    await mobile.waitForSelector(sel, { timeout: 3000 });
                    await Promise.allSettled([
                        mobile.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }),
                        mobile.click(sel, { delay: 60 })
                    ]);
                    break;
                } catch {}
            }
            mmap = mobile.url();
        }

        finalUrl = mmap || mobile.url();
        const { lat, lon } = finalUrl.includes('/map/') ? parseLatLonFromMapUrl(finalUrl) : { lat: null, lon: null };
        console.log('➡️ (모바일 폴백) status:', status, 'finalUrl:', finalUrl, 'lat:', lat, 'lon:', lon);
        return { status, finalUrl, lat, lon };
    } catch (e) {
        console.log('⚠️ 모바일 폴백 실패:', e?.message || e);
    }

    // 최종 실패
    console.log('❌ 지도 URL 파싱 실패. finalUrl=', page.url());
    return { status, finalUrl: page.url(), lat: null, lon: null };
}

async function shutdownBrowser() {
    if (!browser) return;
    try { await browser.close(); } catch {}
    browser = null;
}

module.exports = { openNaver, shutdownBrowser, detectChromePath };
