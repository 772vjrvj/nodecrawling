// src/main/windowManager.js
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let _mainWindow = null;


//region ==================== 일렉트론 메인 윈도우 ====================
//  - 기본 show:false + skipTaskbar:true → 트레이 앱 스타일
//  - 닫기/최소화 시 종료 대신 숨김
// 확인 완료 2025-09-13 ksh
function createWindow() {
    nodeLog('✅ createWindow 호출됨');
    _mainWindow = new BrowserWindow({
        width: 980,              // 창 너비
        height: 760,             // 창 높이
        show: true,              // 처음에는 보이지 않음 (트레이 앱처럼 동작)
        autoHideMenuBar: true,   // 메뉴바 자동 숨김 -> 일렉트론 File Edit View
        skipTaskbar: false,      // 작업표시줄에 표시 안 함 (트레이 전용) -> 화면 맨 바닥에 윈도우 옆에 실행하면 나오는 애들
        webPreferences: {
            // 메인↔렌더러 브리지 // __dirname = 현재 실행 중인 JS 파일(main.js)의 디렉터리 경로. 빌드시에도 잘찾음
            // === 신규 === windowManager 위치 기준으로 상위 폴더의 preload.js를 바라보도록 보정
            preload: path.join(__dirname, '..', 'preload.js'),
            //UI 쪽 코드와 Node API를 샌드박스로 격리해서 안전하게 연결하는 옵션
            contextIsolation: true, // 보안 강화 (렌더러와 분리)
        },
    });

    nodeLog('📄 index.html 로드');
    _mainWindow.loadFile('index.html'); // UI 시작점 로드

    // 닫기(X) 누르면 앱 종료 대신 트레이로 숨김
    _mainWindow.on('close', (e) => {
        if (!app.isQuitting) {   // quitApp() 호출했을 때만 실제 종료
            e.preventDefault(); // 닫기 막음
            hideToTray();       // 창 숨기고 트레이에만 남김
        }
    });

    // 최소화(_) 누르면 최소화 대신 트레이로 숨김
    _mainWindow.on('minimize', (e) => {
        e.preventDefault(); // 최소화 막음
        hideToTray();       // 창 숨김
    });
}
//endregion


//region ==================== 일렉트론 윈도우 화면 나타나기 ====================
// 확인 완료 2025-09-13 ksh
function showMainWindow() {
    if (!_mainWindow) return;              // 창 객체가 없으면 종료
    _mainWindow.setSkipTaskbar(false);     // 작업표시줄에 다시 보이도록 설정
    _mainWindow.show();                    // 창을 화면에 표시
    _mainWindow.focus();                   // 창에 포커스(최상단 활성화)
}
//endregion


//region ==================== 외부에서 메인윈도우 참조 필요 시 ====================
// 확인 완료 2025-09-13 ksh
function getMainWindow() { return _mainWindow; }
//endregion


//region ==================== 일렉트론 트레이 생성(윈도우 우측 하단 아이콘) ====================
// 확인 완료 2025-09-13 ksh
function createTray() {
    // 운영/개발 모드에 따라 경로만 다르게 설정
    const trayPath = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'icons', '판도P-ICON.ico')   // 운영 빌드
        // === fix === windowManager가 src/main/에 있으므로, 개발 모드는 프로젝트 루트의 assets로 두 단계 올라가야 함
        : path.join(__dirname, '..', '..', 'assets', 'icons', '판도P-ICON.ico');  // 개발 모드


    let img = nativeImage.createFromPath(trayPath);

    // 파일이 없거나 비어있을 경우 → 투명 아이콘 fallback
    if (img.isEmpty()) {
        nodeError(`🚨 Tray icon not found: ${trayPath}`);
        img = nativeImage.createEmpty();
    } else {
        nodeLog(`🖼️ Tray icon loaded: ${trayPath}`);
    }

    // 로컬 변수에 두면 GC(가비지 컬렉션) 돼서 아이콘이 사라질 수 있음.
    // 그래서 global에 붙여서 프로세스가 끝날 때까지 유지.
    try {
        global.__tray__ = new Tray(img);
    } catch (e) {
        nodeError('❌ Tray creation failed. Showing window.', e);
        return;
    }

    // 마우스를 올렸을 때 보이는 짧은 설명 텍스트(툴팁) "PandoP"
    global.__tray__.setToolTip('PandoP');

    // === 신규 === 콜백 주입: 런처에서 global.__onQuit__/__onShow__를 세팅하면 사용, 없으면 기본 동작
    const _onShow = (typeof global.__onShow__ === 'function')
        ? global.__onShow__ : showMainWindow;
    const _onQuit = (typeof global.__onQuit__ === 'function')
        ? global.__onQuit__
        : async () => { try { app.isQuitting = true; app.quit(); } catch (_) {} };

    // 우클릭 메뉴들
    const menu = Menu.buildFromTemplate([
        //창열기
        { label: '열기   ', click: () => _onShow() },
        //구분선
        { type: 'separator' },
        //창닫기
        { label: '종료   ', click: async () => await _onQuit() },
    ]);

    //트레이 아이콘의 우클릭 메뉴로 등록.
    global.__tray__.setContextMenu(menu);

    //트래이 아이콘 좌클릭했을 때
    global.__tray__.on('click', () => _onShow());
}
//endregion


//region ==================== 일레트론 윈도우 화면 트레이로 숨기기 ====================
// 확인 완료 2025-09-13 ksh
function hideToTray() {
    if (!_mainWindow) return;              // 창 객체가 없으면 종료
    _mainWindow.hide();                    // 창을 화면에서 숨김
    _mainWindow.setSkipTaskbar(true);      // 작업표시줄에서도 숨김
}
//endregion


module.exports = { createTray, createWindow, showMainWindow, hideToTray, getMainWindow };
