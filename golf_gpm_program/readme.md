npm init -y
npm start
npm install electron-store
npm run build


Remove-Item -Recurse -Force .\node_modules
Remove-Item .\package-lock.json
npm install


# 버전정보
npm 11.4.1, node v22.16.0

# PowerShell 관리자 권한으로 실행한 후
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
Y

# 프로젝트 폴더로 이동
cd E:\git\nodecrawling\golf_gpm_program

# 빌드 실행
npm run build

https://fish-railway-308.notion.site/API-1c275c7d0bb28037bc7dcef7ec791595

# 버전 수정
"version": "0.9.1"
"buildVersion": "0.9.1.0"


■ 매장정보

    매장ID : 687df837ccdd3048647c8e92
    gpm 아이디 :jskzzang
    gpm 비번 : jsk$13579
    청주 용담 JS

    ceo 정보
    id:fogjin94
    pw:cns0753!

    매장 아이디 : 6823189ccaf95dcb25d42273
    매장 : 골프존파크 죽전골프앤
    경영주id : bancj1
    비번 : qwer1234

    운영 매장 아이디
    ● 매장 아이디 : 6768ee8213b5aa99057cdec1
    ● 매장명 : 시흥 대야소래산점 3층
    ● 지점 : 골프존파크_투비전NX


    운영 매장 아이디
    ● 매장 아이디 : 66bc390a667cb9fc7e12481f
    ● 매장명 : 평택 용이 쪽스크린
    ● 지점 : 골프존파크_투비전NX



■ 비밀번호 저장 경로
    C:\Users\<사용자>\AppData\Roaming\<앱이름>\config.json
    C:\Users\772vj\AppData\Roaming\PandoP\config.json

■ 한글 깨질시
    CMD : chcp 65001


노션 api
https://fish-railway-308.notion.site/API-1c275c7d0bb28037bc7dcef7ec791595


설치경로
C:\Program Files\PandoP

로그 경로
C:\Users\<사용자>\AppData\Roaming\golf-gpm-program\logs
C:\Users\<사용자>\AppData\Roaming\GPMReservation\logs

C:\Users\772vj\AppData\Roaming\PandoP\logs
C:\Users\<사용자>\AppData\Roaming\PandoP\logs

start-with-log.bat 바탕화면에 두기

설치 후 
바탕화면에 GPMReservation 생기면
바탕화면에 start-with-log.bat 두고 실해





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





