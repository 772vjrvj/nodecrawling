// 모달 열기
function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    modal.classList.add('show');  // 모달 표시
    document.body.style.overflow = 'hidden';  // 배경 스크롤 방지

    if (id === 'store-modal') initStoreModal();
    if (id === 'login-modal') initLoginModal();
}

// 모달 닫기
function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('show');  // 모달 숨김
        document.body.style.overflow = '';  // 스크롤 다시 허용
    }
}

// 매장 모달 초기화
function initStoreModal() {
    console.log("🔄 매장 모달 초기화 시작");
    window.electronAPI.loadSettings('store/id').then(val => {
        console.log(`📥 저장된 store/id 값: ${val}`);
        document.getElementById('store-id').value = val || '';  // 저장된 값 세팅
        document.getElementById('store-id-error').innerText = '';  // 에러 초기화
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

    if (!id) {
        idError.innerText = "필수값 입니다.";
        hasError = true;
    }

    if (!pw) {
        pwError.innerText = "필수값 입니다.";
        hasError = true;
    }

    if (hasError) {
        console.log("❌ 로그인 입력 오류 있음");
        return;
    }

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

    if (!storeId) {
        errorBox.innerText = "필수값 입니다.";
        console.log("❌ 매장 ID가 비어 있음");
        return;
    }

    await window.electronAPI.saveSettings('store/id', storeId);
    console.log(`✅ 매장 정보 저장 완료: storeId=${storeId}`);

    document.getElementById("store-info").innerHTML =
        `● 매장명 : ${storeId}<br>● 지점 : -`;
    closeModal('store-modal');
}

// 시작 버튼 클릭 시 실행 (향후 puppeteer 실행 IPC 요청 연결 가능)
async function startAction() {
    console.log("▶ 시작 버튼 클릭됨");

    const userId = document.getElementById("login-id").value.trim();
    const password = document.getElementById("login-password").value.trim();
    const storeId = document.getElementById("store-id").value.trim();

    if (!userId || !password || !storeId) {
        alert("아이디, 비밀번호, 매장 ID를 모두 입력하세요.");
        console.log('userId :', userId)
        console.log('password :', password)
        console.log('storeId :', storeId)

        return;
    }

    // ✅ 매장 정보 & 토큰 요청
    const result = await window.electronAPI.fetchStoreInfo(storeId);
    if (!result || !result.store) {
        alert("매장 정보를 가져오지 못했습니다.");
        return;
    }

    const { token, store } = result;
    const name = store?.name || '-';
    const branch = store?.branch || '-';

    // ✅ index.html에 뿌리기
    document.getElementById("store-info").innerHTML =
        `● 매장명 : ${name}<br>● 지점 : ${branch}`;

    console.log("🟢 매장 정보 불러오기 완료:", name, branch);

    // ✅ puppeteer 실행
    window.electronAPI.startCrawl({ userId, password, storeId });
}

// 페이지 로드 시 저장된 값 불러오기
window.onload = async () => {
    console.log("🌐 페이지 로드: 설정값 초기화 시작");

    const storeId = await window.electronAPI.loadSettings("store/id") || "-";
    const userId = await window.electronAPI.loadSettings("login/id") || "-";
    const pw = await window.electronAPI.loadSettings("login/password") || "-";

    // ✅ input에도 값 세팅
    document.getElementById("store-id").value = storeId;
    document.getElementById("login-id").value = userId;
    document.getElementById("login-password").value = pw;


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
};
