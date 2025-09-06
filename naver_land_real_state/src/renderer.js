// src/renderer.js
const $ = (sel) => document.querySelector(sel);

async function start() {
    const userId = $('#login-id').value.trim();
    const password = $('#login-password').value.trim();

    $('#btn-start').disabled = true;

    const res = await window.electronAPI.login({ userId, password });
    if (!res?.ok) {
        alert(res?.message || '로그인 실패');
        $('#btn-start').disabled = false;
        return;
    }

    // ① Chrome 경로 확보(자동탐색 실패 시 파일선택 다이얼로그)
    const { path: chromePath } = await window.electronAPI.resolveChromePath();
    if (!chromePath) {
        alert('Chrome 실행 파일을 선택하지 않아 작업을 진행할 수 없습니다.');
        $('#btn-start').disabled = false;
        return;
    }

    // ② 해당 Chrome으로 네이버 /search 열기
    await window.electronAPI.openNaver(chromePath);
    $('#btn-start').disabled = false;
}

window.addEventListener('DOMContentLoaded', () => {
    $('#btn-start').addEventListener('click', start);
});
