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

/**
 * null, 빈 문자열, 빈 배열을 제거한 객체 반환
 * @param {object} obj
 * @returns {object}
 */
function compact(obj) {
    return Object.fromEntries(
        Object.entries(obj).filter(
            ([_, v]) =>
                v !== null &&
                v !== undefined &&               // ✅ undefined 추가
                v !== '' &&
                !(Array.isArray(v) && v.length === 0)
        )
    );
}
module.exports = {
    toIsoKstFormat,
    compact
};