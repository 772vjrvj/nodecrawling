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

# 프로젝트 폴더로 이동
cd E:\git\nodecrawling\golf_gpm_program

# 빌드 실행
npm run build

https://fish-railway-308.notion.site/API-1c275c7d0bb28037bc7dcef7ec791595


■ 매장정보
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


2025-06-04 수정사항