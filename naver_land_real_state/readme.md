# 새 폴더 생성
mkdir naver_land_real_state && cd naver_land_real_state

# Node 프로젝트 초기화
npm init -y

# Electron / Puppeteer 설치
npm install electron puppeteer --save


# package.json에 실행 스크립트 추가:
{
    "name": "my-electron-puppeteer",
    "version": "1.0.0",
    "main": "main.js",
    "scripts": {
        "start": "electron ."
    },
    "dependencies": {
    "electron": "^32.0.0",
    "puppeteer": "^23.0.0"
    }
}


■ 한글 깨질시
CMD : chcp 65001