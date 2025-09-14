//src/utils/common.js
/**
 * 문자열을 ISO 8601 형식으로 변환
 * @param {string} kstStr
 * @returns {string|null}
 */
function toIsoKstFormat(kstStr) {
    try {
        const year = kstStr.slice(0, 4);
        const month = kstStr.slice(4, 6);
        const day = kstStr.slice(6, 8);
        const hour = kstStr.slice(8, 10);
        const minute = kstStr.slice(10, 12);
        const second = kstStr.slice(12, 14);

        return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
    } catch (e) {
        nodeError("❗ 날짜 변환 오류:", e);
        return null;
    }
}

function convertToUtcZFormat(inputDateStr) {
    const localDate = new Date(inputDateStr);

    // ISO 8601 Z 포맷으로 출력
    return localDate.toISOString();  // e.g. "2025-07-20T12:00:00.000Z"
}

function extractDateYYMMDD(inputDateStr) {
    const date = new Date(inputDateStr);

    const yy = String(date.getFullYear()).slice(2); // "25"
    const mm = String(date.getMonth() + 1).padStart(2, '0'); // "07"
    const dd = String(date.getDate()).padStart(2, '0'); // "20"

    return yy + mm + dd;
}

/**
 * null, 빈 문자열, 빈 배열을 제거한 객체 반환
 * @param {object} obj
 * @returns {object}
 */
function compact(obj, alwaysInclude = []) {
    return Object.fromEntries(
        Object.entries(obj).filter(([k, v]) =>
            alwaysInclude.includes(k) ||
            (
                v !== null &&
                v !== undefined &&
                v !== '' &&
                !(Array.isArray(v) && v.length === 0) &&
                !(k === 'paymentAmount' && v === 0) // ⬅️ 0이면 제거
            )
        )
    );
}


// ─────────────────────────────────────────────────────────
// 시간/ID 유틸 YYYY.MM.DD HH:MM:SS.sss
// ─────────────────────────────────────────────────────────
function getNow() {
    const now = new Date();
    const pad = (n, w = 2) => n.toString().padStart(w, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

module.exports = {
    toIsoKstFormat,
    compact,
    convertToUtcZFormat,
    extractDateYYMMDD,
    getNow
};