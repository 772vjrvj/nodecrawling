// src/server/apiServer.js
const express = require('express');
const http = require('http');
const { findReservationTab } = require('../services/puppeteer');

function parseBookingDate(bookingDate) {
    const year = parseInt(bookingDate.slice(0, 4), 10); // 더 명확하게
    const month = parseInt(bookingDate.slice(4, 6), 10);
    return { targetYear: year, targetMonth: month };
}

function startApiServer(port = 32123) {
    const app = express();

    app.get('/reseration', async (req, res) => {
        const { bookingDate } = req.query;

        if (!bookingDate) {
            nodeLog('❌ [API] bookingDate 누락');
            return res.status(400).json({ status: 'error', message: 'bookingDate 쿼리가 필요합니다' });
        }

        nodeLog(`📥 예약 요청 수신 (bookingDate: ${bookingDate}) → 5분 뒤 실행 예정`);

        // ✅ 요청 수신 즉시 응답 (A는 이걸로 종료됨)
        res.sendStatus(200);

        // 🕔 5분 후 후킹 실행
        setTimeout(async () => {
            try {
                const page = await findReservationTab();
                const { targetYear, targetMonth } = parseBookingDate(bookingDate);


                // 1. 달력 열려 있는지 확인
                const calendarExists = await page.$('.vfc-main-container');

                if (!calendarExists) {
                    await page.waitForSelector('.btn_clander', { timeout: 1500 });
                    await page.click('.btn_clander');
                    nodeLog('🖱️ .btn_clander 클릭 완료 (달력 열림)');
                } else {
                    nodeLog('✅ 이미 달력 열려 있음 → 클릭 생략');
                }

                // 2. 년월 요소 로딩 대기
                await page.waitForSelector('.vfc-top-date.vfc-center', { timeout: 1000 });

                // 3. 현재 년/월 추출
                const { currentYear, currentMonth } = await page.evaluate(() => {
                    const elements = document.querySelectorAll('.vfc-top-date.vfc-center a');
                    const monthText = elements[0]?.textContent.trim().replace('월', '');
                    const yearText = elements[1]?.textContent.trim();
                    return {
                        currentMonth: parseInt(monthText),
                        currentYear: parseInt(yearText)
                    };
                });

                nodeLog(`📅 현재 달력: ${currentYear}년 ${currentMonth}월 / 목표: ${targetYear}년 ${targetMonth}월`);

                // 4. 이동 횟수 계산
                const diffMonth = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
                const direction = diffMonth > 0 ? 'right' : 'left';
                const clicks = Math.abs(diffMonth);

                const selector = direction === 'right'
                    ? '.vfc-arrow-right'
                    : '.vfc-arrow-left';

                nodeLog(`↔️ ${direction.toUpperCase()} 버튼 ${clicks}회 클릭 예정`);

                for (let i = 0; i < clicks; i++) {
                    await page.waitForSelector(selector, { timeout: 3000 });
                    await page.click(selector);
                    await new Promise(resolve => setTimeout(resolve, 500)); // ← 이 부분 수정됨
                }

                // 5. 날짜(day) 클릭 처리
                const targetDay = parseInt(bookingDate.slice(6, 8)); // 01~31

                nodeLog(`📍 클릭 대상 일자: ${targetDay}일`);

                const clicked = await page.evaluate((day) => {
                    const weeks = document.querySelectorAll('.vfc-week');

                    for (const week of weeks) {
                        const dayDivs = week.querySelectorAll('.vfc-day');
                        for (const div of dayDivs) {
                            const span = div.querySelector('.vfc-span-day');
                            if (!span) continue;

                            const isHidden = span.classList.contains('vfc-hide');
                            const value = parseInt(span.textContent.trim());

                            if (!isHidden && value === day) {
                                span.click();
                                return true; // ✅ 클릭 완료
                            }
                        }
                    }

                    return false; // ❌ 못 찾음
                }, targetDay);

                if (!clicked) {
                    nodeLog(`❌ ${targetDay}일자 클릭 실패: 해당 날짜를 찾을 수 없습니다.`);
                }else{
                    nodeLog(`✅ ${targetDay}일자 클릭 완료`);

                    const eventIds = await page.evaluate(() => {
                        const result = [];

                        // 1. 예약 영역 기준
                        const cols = document.querySelectorAll('.dhx_timeline_data_col > div'); // 9개의 자식 div

                        cols.forEach(col => {
                            const children = col.children;
                            for (let child of children) {
                                const eventId = child.getAttribute('event_id');
                                if (eventId) {
                                    result.push(eventId);
                                }
                            }
                        });
                        return result;
                    });
                    nodeLog(`📋 예약 이벤트 ID 수집 완료 (${eventIds.length}개):`);
                    nodeLog(`📋 예약 이벤트 ID ${eventIds}`);
                }
            } catch (err) {
                nodeError('❌ 예약 달력 처리 실패:', err.message);
            }
        }, 1000 * 60 * 5); // ⏱️ 5분 뒤 실행
    });

    http.createServer(app).listen(port, () => {
        nodeLog(`🌐 [API] 서버 실행: http://localhost:${port}/reseration`);
    });
}

module.exports = { startApiServer };
