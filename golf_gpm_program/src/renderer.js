//src/renderer.js
// 페이지 로드 시 저장된 값 불러오기
window.onload = async () => {
    console.log("🌐 페이지 로드: 설정값 초기화 시작");

    const storeId = await window.electronAPI.loadSettings("store/id") || "-";
    const userId = await window.electronAPI.loadSettings("login/id") || "-";
    const pw = await window.electronAPI.loadSettings("login/password") || "-";
    const autoLoginFlag = await window.electronAPI.loadSettings("login/autoLogin"); // "T" | "F" | undefined

    // ✅ 크롬 경로: 자동 탐지 우선, 성공 시 저장까지
    let chromePath = await window.electronAPI.getChromePath();
    if (chromePath) {
        console.log(`🔍 자동 탐지된 크롬 경로 사용: ${chromePath}`);
        await window.electronAPI.saveSettings("chrome/path", chromePath);
    } else {
        chromePath = await window.electronAPI.loadSettings("chrome/path") || "-";
        console.log(`📦 저장된 크롬 경로 사용: ${chromePath}`);
    }

    // ✅ input에도 값 세팅
    document.getElementById("store-id").value = storeId;
    document.getElementById("login-id").value = userId;
    document.getElementById("login-password").value = pw;
    document.getElementById("chrome-path").value = chromePath;

    console.log(`📌 로드된 설정: storeId=${storeId}, userId=${userId}, pw=${'*'.repeat(pw.length)}`);

    // ✅ 매장 이름과 지점 이름 가져오기
    let storeName = "-";
    let branchName = "-";

    if (storeId !== "-") {
        const result = await window.electronAPI.fetchStoreInfo(storeId);
        if (result && result.store) {
            storeName = result.store.name || "-";
            branchName = result.store.branch || "-";
        }
    }

    // ✅ 화면에 출력
    document.getElementById("store-info").innerHTML =
        `● 매장명 : ${storeName}<br>● 지점 : ${branchName}`;
    document.getElementById("login-info").innerHTML =
        `● 아이디 : ${userId}<br>● 비밀번호 : ${'*'.repeat(pw.length)}`;
    document.getElementById("chrome-info").innerHTML =
        `● 경로 : ${chromePath}`;

    // ============================
    // ✅ 자동 로그인 체크박스 로드/저장/자동실행
    // ============================
    const autoLoginEl = document.getElementById("auto-login");

    // 1) 저장값을 체크박스에 반영
    autoLoginEl.checked = (autoLoginFlag === "T");

    // 2) 변경 시 저장
    autoLoginEl.addEventListener("change", async (e) => {
        await window.electronAPI.saveSettings("login/autoLogin", e.target.checked ? "T" : "F");
        console.log("🔄 autoLogin 저장:", e.target.checked ? "T" : "F");
    });

    // 3) 자동 로그인 켜져 있으면, 필수값이 모두 채워졌을 때 자동 실행
    const hasAll =
        (userId && userId !== "-") &&
        (pw && pw !== "-") &&
        (storeId && storeId !== "-") &&
        (chromePath && chromePath !== "-");

    if (autoLoginEl.checked && hasAll) {
        console.log("✅ 자동 로그인 활성화 → 자동 시작 예약");
        setTimeout(() => {
            const startBtn = document.querySelector('button[onclick="startAction()"]');
            if (startBtn) {
                startBtn.classList.add("pressed");
                setTimeout(() => startBtn.classList.remove("pressed"), 150);
            }
            startAction();
        }, 400);
    }
};

// 모달 열기/닫기
function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    if (id === 'store-modal') initStoreModal();
    if (id === 'login-modal') initLoginModal();
    if (id === 'chrome-modal') initChromeModal();
}
function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

// 매장 모달 초기화
function initStoreModal() {
    console.log("🔄 매장 모달 초기화 시작");
    window.electronAPI.loadSettings('store/id').then(val => {
        console.log(`📥 저장된 store/id 값: ${val}`);
        document.getElementById('store-id').value = val || '';
        document.getElementById('store-id-error').innerText = '';
    });
}

// 로그인 모달 초기화
function initLoginModal() {
    console.log("🔄 로그인 모달 초기화 시작");
    window.electronAPI.loadSettings('login/id').then(val => {
        console.log(`📥 저장된 login/id 값: ${val}`);
        document.getElementById('login-id').value = val || '';
        document.getElementById('login-id-error').innerText = '';
    });
    window.electronAPI.loadSettings('login/password').then(val => {
        console.log(`📥 저장된 login/password 값: ${'*'.repeat((val || '').length)}`);
        document.getElementById('login-password').value = val || '';
        document.getElementById('login-password-error').innerText = '';
    });
}

// 로그인 정보 저장
async function saveLoginInfo() {
    console.log("💾 로그인 정보 저장 시도");
    const id = document.getElementById("login-id").value.trim();
    const pw = document.getElementById("login-password").value.trim();

    const idError = document.getElementById("login-id-error");
    const pwError = document.getElementById("login-password-error");

    idError.innerText = "";
    pwError.innerText = "";

    let hasError = false;
    if (!id) { idError.innerText = "필수값 입니다."; hasError = true; }
    if (!pw) { pwError.innerText = "필수값 입니다."; hasError = true; }
    if (hasError) { console.log("❌ 로그인 입력 오류 있음"); return; }

    await window.electronAPI.saveSettings('login/id', id);
    await window.electronAPI.saveSettings('login/password', pw);

    console.log(`✅ 로그인 정보 저장 완료: id=${id}, pw=${'*'.repeat(pw.length)}`);
    document.getElementById("login-info").innerHTML =
        `● 아이디 : ${id}<br>● 비밀번호 : ${'*'.repeat(pw.length)}`;
    closeModal('login-modal');
}

// 매장 정보 저장
async function saveStoreInfo() {
    console.log("💾 매장 정보 저장 시도");
    const storeId = document.getElementById("store-id").value.trim();
    const errorBox = document.getElementById("store-id-error");

    errorBox.innerText = "";
    if (!storeId) { errorBox.innerText = "필수값 입니다."; console.log("❌ 매장 ID가 비어 있음"); return; }

    await window.electronAPI.saveSettings('store/id', storeId);
    console.log(`✅ 매장 정보 저장 완료: storeId=${storeId}`);

    document.getElementById("store-info").innerHTML =
        `● 매장명 : ${storeId}<br>● 지점 : -`;
    closeModal('store-modal');
}

// 버튼 잠금/해제 유틸
function disableAllButtons() {
    document.querySelectorAll('button').forEach(btn => {
        btn.disabled = true;
        btn.style.backgroundColor = '#aaa';
        btn.style.cursor = 'not-allowed';
    });
}
function enableAllButtons() {
    document.querySelectorAll('button').forEach(btn => {
        btn.disabled = false;
        btn.style.backgroundColor = '';
        btn.style.cursor = '';
    });
}

// 시작 버튼 클릭 시 실행
async function startAction() {
    console.log("▶ 시작 버튼 클릭됨");

    const userId = document.getElementById("login-id").value.trim();
    const password = document.getElementById("login-password").value.trim();
    const storeId = document.getElementById("store-id").value.trim();
    const chromePath = document.getElementById("chrome-path").value.trim();

    if (!userId || !password || !storeId || !chromePath) {
        alert("아이디, 비밀번호, 매장 ID를 모두 입력하세요.");
        console.log('userId :', userId);
        console.log('password :', password);
        console.log('storeId :', storeId);
        console.log('chromePath :', chromePath);
        return;
    }

    disableAllButtons();
    console.log("🔒 모든 버튼 비활성화 완료");

    // 매장 정보 & 토큰 요청
    const result = await window.electronAPI.fetchStoreInfo(storeId);
    if (!result || !result.store) {
        alert("매장 정보를 가져오지 못했습니다.");
        enableAllButtons(); // ← 실패 시 버튼 복구
        return;
    }

    const { store } = result;
    const name = store?.name || '-';
    const branch = store?.branch || '-';

    document.getElementById("store-info").innerHTML =
        `● 매장명 : ${name}<br>● 지점 : ${branch}`;
    console.log("🟢 매장 정보 불러오기 완료:", name, branch);

    window.electronAPI.startCrawl({ userId, password, storeId, chromePath });
}

// 크롬 모달 초기화
function initChromeModal() {
    console.log("🔄 크롬 경로 모달 초기화 시작");

    window.electronAPI.getChromePath().then(async (autoPath) => {
        if (autoPath) {
            console.log(`✅ 자동 탐지된 크롬 경로 사용: ${autoPath}`);
            document.getElementById('chrome-path').value = autoPath;
            await window.electronAPI.saveSettings('chrome/path', autoPath);
        } else {
            const savedPath = await window.electronAPI.loadSettings('chrome/path');
            console.log(`📦 저장된 경로 사용: ${savedPath}`);
            document.getElementById('chrome-path').value = savedPath || '';
        }
        document.getElementById('chrome-path-error').innerText = '';
    });
}

// 경로 저장
async function saveChromePath() {
    const chromePath = document.getElementById("chrome-path").value.trim();
    const errorBox = document.getElementById("chrome-path-error");

    errorBox.innerText = "";
    if (!chromePath) { errorBox.innerText = "필수값 입니다."; return; }

    await window.electronAPI.saveSettings('chrome/path', chromePath);
    document.getElementById("chrome-info").innerHTML = `● 경로 : ${chromePath}`;
    closeModal('chrome-modal');
}

// 찾아보기 버튼 클릭 시
async function browseChromePath() {
    const selected = await window.electronAPI.openChromePathDialog();
    if (selected) {
        document.getElementById("chrome-path").value = selected;
        await window.electronAPI.saveSettings('chrome/path', selected); // ← 선택 즉시 저장
    }
}


let unsubscribeAuthExpired = null;

function showAuthExpiredNotice(payload) {
    const ttl = payload && payload.ttlMs ? Math.floor(payload.ttlMs / 1000) : null;
    const reason = (payload && payload.reason) || '인증이 만료되었습니다.';
    // TODO: 여기에 토스트/모달/배너 표시
    console.log('⚠️', reason, ttl ? `(재시작 억제 ${ttl}s)` : '');

    // 버튼을 보여주되, 메인이 이미 requestRelaunch를 호출하므로 누적 요청을 막고 싶다면 비활성화하거나
    // 눌렀을 때만 수동 재시작을 허용:
    // document.querySelector('#restartBtn').onclick = () => window.electronAPI.requestRelaunch('renderer manual restart');
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.electronAPI && typeof window.electronAPI.onAuthExpired === 'function') {
        unsubscribeAuthExpired = window.electronAPI.onAuthExpired((payload) => {
            try { showAuthExpiredNotice(payload || {}); }
            catch (e) { console.error('auth-expired UI error:', (e && e.message) || String(e)); }
        });
    }
});

window.addEventListener('beforeunload', () => {
    if (typeof unsubscribeAuthExpired === 'function') {
        try { unsubscribeAuthExpired(); } catch (e) { /* noop */ }
        unsubscribeAuthExpired = null;
    }
});
