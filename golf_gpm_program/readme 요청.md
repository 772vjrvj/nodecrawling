
2025-06-03 수정사항

■ 버전 정보를 실행파일의 속성 창에서 확인 가능하도록 
-> 수정완료

■ 다영: 전화번호가 없는 경우 phone의 값을 "" 빈 string으로 넘겨주세요.
notion API 명세서에 업데이트 해 놓았습니다.
참고 부탁 드립니다.
-> 수정완료(신규, 예약시 phone 없는 경우 공백값)

■ 재현 경로는 알수 없으나 갑자기 로그가 엄청올라옴 
-> 일렉트론으로 바꾸며 수정완료

■ 점주 카카오톡 내용 확인시 모바일 고객 예약취소로 반영됨
-> 실제로 취소 사유가 넘어오지 않아 하드코딩하기로 일전에 팀장님과 이야기 함

■ 점주,고객에게 예약 취소 메시지 발송함
-> 내용 이해 못함

■ "1번방 예약 없어지고, 5번방 예약만 남음
(1번방 상세팝업에서는 해당 문제가 발생하지않으나 1번방외다른방 선택시에서만 나타나는 문제)"
-> 수정완료

■ 5번방 예약 없어지고 1번방 시간만 조정됨
-> 수정완료


■ 2025-06-10
크롬 경로 설정 오류 수정
PandoP v9-1


■ 2025-06-11
다른 매장 로그인시 오류 수정
PandoP v9-2


■ 2025-06-23
요청 바디 파싱 실패
Unknown content type: text/plain;charset=UTF-8

router.js 에 아래 추가
} else if (contentType.includes('text/plain')) {




■ 2025-06-24
안녕하세요.
매장 운영하면서 확인된 이슈가 있는데요.
PandoK에서 띄운 브라우저를 닫은 다음에 ,
PandoK에서 [시작]버튼만을 눌러 브라우저를 띄운 후에는 예약이 수집되지 않는 현상이 있습니다.
예약정보 파싱 부분 점검시 가능하시면 같이 점검해봐주시면 좋겠습니다.
쉽지 않다면, 파싱 부분 먼저 부탁 드리겠습니다.
--> 파싱 부분 수정



1.로그인 후>크롬만 닫음>시작 눌러 크롬 실행되면 예약>예약 수집안됨
2.1번 이후 크롬을 다시 닫으면 아래와같은 팝업 발생
--> 프로세스 강제 종료
-- 0.9.4 ver




2025-07-22

PandoP [완료]
(1) 달력에서 날짜 변경시, 예약 수집이 되었다 안되었다가 함
--> 판도서버 api add-missing에 memo 컬럼이 없는데 넣어서 요청하여 오류남
--> 예약이 없는 경우는 skip 처리
--> 조치 완료



AGP [판도 확인] 
(2) AGP (후킹 버전), 일반 브라우저에서 아무런 예약 정보 변경없이, 
예약 수정시 수집되지 않음 (PandoP에서는 정보수집됩니다.)
--> PandoP, AGP 모두 수집 안됨
--> 판도서버 확인필요
--> roomId 정상으로 보냈는데 못찾는다고 나옴
2025-07-22 23:40:06,930 - [판도] [api] : [PATCH] header : {'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4N2RmODM3Y2NkZDMwNDg2NDdjOGU5MiIsInJvbGUiOiJzaW5nbGVDcmF3bGVyIiwiZXhwIjo0OTA4OTUzMzQxfQ.vPFN9J0Rl-ke42oIrrQdW6NNc1RIHRaBHMHQJQVXO3k', 'Content-Type': 'application/json'}
2025-07-22 23:40:06,930 - [판도] [api] : [PATCH] https://api.dev.24golf.co.kr/stores/687df837ccdd3048647c8e92/reservation/crawl
{
"externalId": "84396671",
"roomId": "37207",
"crawlingSite": "GolfzonPark",
"name": "강현진",
"phone": "010-6543-1105",
"paymented": false,
"partySize": 3,
"startDate": "2025-07-23T09:30:00+09:00",
"endDate": "2025-07-23T12:30:00+09:00",
"externalGroupId": "35101868"
}
2025-07-22 23:40:06,983 - [판도] [api] : PATCH 응답 오류 (400): {"statusCode":400,"message":"Room not found","error":"ROOM_NOT_FOUND"}



5분후 수정확인 [완료]



작업중 오류 발생: [확인필요]
Waiting for selector `button.booking__btn` fail: waiting failed: 10000ms exceeded
--> 이유: 브라우저를 껐거나, 초기 브라우저를 끄고 시작을 눌러 다른 브라우저를 켰을경우 발생
--> PandoP는 기본적으로 처음 실행된 브라우저를 바라보고 있어서 최초실행된 브라우저를 끄면 안됨.
--> 전화예약시에도 브라우저 창을 최소화 하면 작동 하지 않으므로 화면을 띄워놔야합니다. 
--> 브라우저를 껐다면 프로그램을 종료하고 다시 실행해야 합니다.



당산 동기화오류: [확인필요]
"startDate": "2025-07-13T11:00:00+09:00",
"endDate": "2025-07-13T11:00:00+09:00"
2025-07-12 16:37:08,521 - [판도] [api] : PATCH 응답 오류 (400): {"statusCode":400,"message":"시작 시간이 종료 시간보다 빠를 수 없습니다.","error":"END_EARLIER_THAN_START"}
--> 동일 시간에 대해서 판도서버쪽 처리 확인필요








2025-07-24

.env 파일로 운영 개발 통합

금일 용담JS 매장 운영계 설치시 확인된 이슈 공유 드립니다.
(1) PandoP에서 취소한 예약ID 84498379가 판도에 API를 호출하지 않음(1번 발생, 재현경로 확인이 어려움)
--------------------
[Node] 2025-07-25 00:18:04 hookRouter.js:63 - 📦 register payload: {
"externalId": "84530254",
"roomId": "37204",
"crawlingSite": "GolfzonPark",
"name": "테스트",
"phone": "4321",
"paymented": false,
"partySize": 2,
"startDate": "2025-07-31T00:20:00+09:00",
"endDate": "2025-07-31T02:20:00+09:00"
}
[Node] 2025-07-25 00:18:04 api.js:22 - ✅ buildUrl : https://api.dev.24golf.co.kr/stores/687df837ccdd3048647c8e92/reservation/crawl
[Node] 2025-07-25 00:18:04 api.js:37 - ❌ ERROR: ❌ PATCH 응답 오류 (400): {
"statusCode": 400,
"message": "Room not found",
"error": "ROOM_NOT_FOUND"
}
-------------------- 이거는 저번에 말씀드렸는데 판도쪽에 roomID확인 부탁드립니다.





(2) 통화매니저 예약 발생 후, PandoP에서 전체 팝업이 떠있는 경우 달력이 클릭되지 않음
>> url 새로 고침하면 팝업이 없어지므로 새로 고침후 달력을 클릭해야 겠습니다.
---------------------- 새로고침 추가하였습니다.




(3) PandoP GPM에서 취소된 예약이 사라지지 않음
PandoP GPM 브라우저를 새로고침하면 사라짐
----------------------(1)번과 연관이인거 같습니다.




(4) 운영계 AGP cmd창 노출 > 삭제 필요
--------------------- 추가됨


https://gpmui.golfzonpark.com/rest/ui/reservation/14150?timestamp=1753371458653&data=0e20b159-b803-4984-95c9-17ddf61dc378


{
"entitys" : [ {
"reserveNo" : 35148678,
"shopNo" : 14150,
"usrNo" : 5753648,
"reserveStatus" : 10,
"reserveDatetime" : "20250731050000",
"reserveName" : "테스트",
"reservePhoneNumber" : "010-7141-0772",
"reserveSoftware" : 56,
"reservePeople" : 1,
"reserveRequestMessage" : "",
"registDate" : "20250725003736",
"reserveDatetimeEnd" : "20250731060000",
"usrId" : "vjrvj772",
"usrNickName" : "안녕고래772",
"roundCount3months" : 0,
"hashTag" : "일반",
"crmMemo" : "-",
"round1Month" : 0.0,
"avgRoundTime" : 0.0,
"paymentYn" : "Y",
"paymentTotAmount" : 25000,
"gameType" : 0,
"roomCount" : 1,
"gameCount" : 1,
"optionFlag" : 0,
"isSelfReserve" : 0
} ],
"code" : "OK",
"codeMessage" : "success",
"status" : "200",
"statusMessage" : "OK"
}






2025-07-28 월

금일 유선으로 공유드린 잔여 이슈 3가지 공유 드립니다.

1. 모바일 예약 수신시 > 5분뒤 PandoP GPM에서 해당 일자 캘린더를 찍지 않음
2. 운영계 청주 용담 매장에서 AGP가 실행은 되어 있으나 , AGP가 켜진 이력이 없어보이며,
   (금일(7/28일) 확인시점 PC에서 AGP 프로그램에서 [시작] 버튼이 아니라 [종료] 버튼으로 보이나 AGP 켜진 이력이 없음 )

2-1.
27일 21시32분 이후 예약들이 수집이 안된 현상

3. PandoP에서 실행한 크롬 브라우저 최소화, 종료
   1안) 최소화,종료버튼 제거 또는 비활성화
   2안) 크롬 띄울때 , 크롬브라우저 사이즈를 10x10로
   3안) 크롬 띄울때, 다중 모니터 포함 최우측 하단에 띄움
   4안) 최소화 버튼 또는 종료 버튼 클릭시, 안내 팝업 노출


2025-07-30 수
1) 용담js 실매장에서 시범운영시, 2건 예약에 대해서만 예약이 누락으로 확인됩니다.
   오늘 버전은 아닙니다만, 점검을 한번 부탁 드리겠습니다.

2) 금일 버전, 모바일 앱 예약 수락은 정상 동작으로 확인하였습니다.
3) 인증 페이지시 버튼클릭 재점검 부탁드립니다.
   브라우저에서 https://gpmui.golfzonpark.com/fc/error url을 입력해봐도 테스트 가능하지 않을까 합니다. (페이지가 뜹니다.)






2025-08-04 월

다시 잔여 이슈 정리하여 공유 드립니다.

(1) 익일 새벽6시 인증 만기 갱신 처리 실패
>> PandoP에서 띄운 브라우저를 종료하고 새로 브라우저를 띄워 시작하는 형태로 변경검토

(2) 인증 만기 후 , 재로그인시, 통화매니저&모바일수락 예약 수집 불가 현상
>> (1)번 처리 후 모니터링 예정

(3) PandoP 설치시, 크롬브라우저 재활성화를 위한 관련 모듈 설치가 필요.
>> watcher.py파일을 exe파일로 빌드하여 구동하는 형태로 변경

(4) 브라우저 활성화후 , 간헐적으로(?:총4회중성공,실패,성공,실패) 예약일자로 캘린더가 이동하지 않는 현상 점검 필요