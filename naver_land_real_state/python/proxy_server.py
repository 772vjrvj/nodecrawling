# src/server/proxy_server.py
import sys
import os
import re
import io
import json
from typing import Optional, Dict, Any, Iterable
from urllib.parse import parse_qs, urlparse, urlencode, quote
from mitmproxy import http

# ─────────────────────────────────────────────────────────────
# PYTHONPATH: 프로젝트 루트 추가 (src/ 상단을 import 가능하게)
# ─────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from src.router.hook_router import save_request, match_and_dispatch
from src.utils.logger import init_pando_logger, log_info, log_error  # ✅ 로거

# ─────────────────────────────────────────────────────────────
# 저장 경로 (src/data/cluster_result.json) - JSON 배열 방식
# ─────────────────────────────────────────────────────────────
_BASE_DIR = os.path.dirname(os.path.dirname(__file__))   # src/
_SAVE_DIR = os.path.join(_BASE_DIR, "data")              # src/data
_SAVE_FILE = os.path.join(_SAVE_DIR, "cluster_result.json")

# 런타임 중복 체크 캐시(정규화된 URL)
_SEEN_URLS: Optional[set[str]] = None

# ─────────────────────────────────────────────────────────────
# 클러스터 관련 상수/엔드포인트
# ─────────────────────────────────────────────────────────────
# 고정 세트 (URL 파라미터용 → 콜론 포함이므로 인코딩 필요)
_RLET_SET = "APT:OPST:VL:ABYG:OBYG:JGC:JWJT:DDDGG:SGJT:HOJT:JGB:OR:SG:SMS:GJCG:GM:TJ:APTHGJ"
_TRAD_SET = "A1:B1:B2:B3"
_RLET_ENC = quote(_RLET_SET, safe="")   # "APT%3AOPST%3AVL%3A..."
_TRAD_ENC = quote(_TRAD_SET, safe="")   # "A1%3AB1%3AB2%3AB3"

# clusterList 요청 URL prefix (요청 URL이 이걸로 시작하면 바로 파싱)
_CLUSTER_PREFIX = "https://m.land.naver.com/cluster/clusterList?view=atcl&cortarNo="
_AJAX_ARTICLE_BASE = "https://m.land.naver.com/cluster/ajax/articleList"

# ─────────────────────────────────────────────────────────────
# 기존 후킹 타겟 (그대로 유지)
# ─────────────────────────────────────────────────────────────
TARGETS_REQUEST = {
    "register": re.compile(r"/rest/ui/booking/register(\?timestamp=|$)"),
    "edit": re.compile(r"/rest/ui/booking/\d+/edit(\?timestamp=|$)"),
    "edit_move": re.compile(r"/rest/ui/booking/\d+/ajax-edit(\?timestamp=|$)"),
    "delete": re.compile(r"/rest/ui/booking/\d+/delete(\?timestamp=|$)"),
    "delete_mobile": re.compile(r"/rest/ui/polling/booking/\d+\?(?=.*\btimestamp=)(?=.*\bbookingStartDt=)(?=.*\bdata=)(?=.*\bbookingNumber=)"),
    "reseration": re.compile(r"/golfzone/agent/reseration\.json$"),
    "mobile_host": re.compile(r"/rest/ui/reservation/\d+\?(?=.*\btimestamp=)(?=.*\bdata=)")
}
TARGETS_RESPONSE = TARGETS_REQUEST

# ─────────────────────────────────────────────────────────────
# 저장 유틸 (JSON 배열)
# ─────────────────────────────────────────────────────────────
def _ensure_save_path() -> None:
    try:
        os.makedirs(_SAVE_DIR, exist_ok=True)
    except Exception as e:
        log_error(f"[cluster] 디렉토리 생성 실패: {e}")

def _normalize_url(u: str) -> str:
    """
    clusterList_url 중복 판단 정확도를 위해 쿼리 파라미터 정렬하여 정규화.
    """
    try:
        p = urlparse(u)
        qs = parse_qs(p.query, keep_blank_values=True)
        q = urlencode(sorted(qs.items()), doseq=True)
        return p._replace(query=q).geturl().strip()
    except Exception:
        return u.strip()

def _load_json_array() -> list[dict]:
    """저장 파일(JSON 배열)을 로드. 없으면 빈 배열."""
    _ensure_save_path()
    if not os.path.exists(_SAVE_FILE):
        return []
    try:
        with open(_SAVE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return []
    except Exception as e:
        log_error(f"[cluster] 기존 JSON 로드 실패: {e}")
        return []

def _get_seen_set_and_data() -> tuple[set[str], list[dict]]:
    """
    파일에 저장된 JSON 배열을 로드 → (seen set, data list) 반환.
    런타임 최초 1회 전역 캐시(_SEEN_URLS)도 채운다.
    """
    global _SEEN_URLS
    data = _load_json_array()
    if _SEEN_URLS is not None:
        return _SEEN_URLS, data

    seen: set[str] = set()
    for obj in data:
        u = obj.get("clusterList_url")
        if u:
            seen.add(_normalize_url(u))
    _SEEN_URLS = seen
    log_info(f"[cluster] 기존 저장된 URL {len(seen)}개 로드")
    return seen, data

def _save_json_unique(obj: dict) -> None:
    """
    clusterList_url 기준 중복 방지하여 JSON 배열 저장.
    """
    try:
        u = obj.get("clusterList_url")
        if not u:
            log_error("[cluster] 저장 실패: clusterList_url 없음")
            return

        seen, data = _get_seen_set_and_data()
        nu = _normalize_url(u)
        if nu in seen:
            log_info("[cluster] 중복 스킵 (clusterList_url 기준)")
            return

        data.append(obj)
        with open(_SAVE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        seen.add(nu)
        log_info(f"[cluster] JSON 배열 저장됨(신규) → {_SAVE_FILE}")
    except Exception as e:
        log_error(f"[cluster] 저장 실패: {e}")

# ─────────────────────────────────────────────────────────────
# 응답 JSON 탐색 유틸 (폴백용)
# ─────────────────────────────────────────────────────────────
def _iter_strings(obj: Any) -> Iterable[str]:
    """response_json 전체를 순회하며 문자열만 yield"""
    if obj is None:
        return
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _iter_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_strings(v)

def _build_article_list_from_cluster_url(cluster_url: str) -> Optional[Dict[str, str]]:
    """
    clusterList URL에서 파라미터(lat, lon, z, btm, lft, top, rgt, cortarNo ...)를 뽑아
    ajax/articleList URL을 생성해 객체 반환.
    """
    try:
        parsed = urlparse(cluster_url)
        qs = parse_qs(parsed.query)

        def pick(name: str, alt: Optional[str] = None) -> Optional[str]:
            v = qs.get(name) or ([] if alt is None else qs.get(alt, []))
            return v[0] if v else None

        cortar_no = pick("cortarNo") or pick("pCortarNo")
        if not cortar_no:
            return None

        lat = pick("lat") or ""
        lon = pick("lon") or ""
        z   = pick("z") or ""
        btm = pick("btm") or ""
        lft = pick("lft") or ""
        top = pick("top") or ""
        rgt = pick("rgt") or ""

        # rlet/trad는 미리 인코딩된 상수 사용, 나머지는 urlencode
        other = {
            "z": z, "lat": lat, "lon": lon,
            "btm": btm, "lft": lft, "top": top, "rgt": rgt,
            "showR0": "", "totCnt": "", "cortarNo": cortar_no, "page": "1",
        }
        query_other = urlencode(other, encoding="utf-8", doseq=False)

        article_list_url = (
            f"{_AJAX_ARTICLE_BASE}"
            f"?rletTpCd={_RLET_ENC}&tradTpCd={_TRAD_ENC}&{query_other}"
        )

        return {
            "clusterList_url": cluster_url,
            "lat": lat,
            "lon": lon,
            "articleList": article_list_url
        }
    except Exception as e:
        log_error(f"[cluster] URL 파싱 실패: {e}")
        return None

# ─────────────────────────────────────────────────────────────
# 프록시 본체
# ─────────────────────────────────────────────────────────────
class ProxyLogger:
    def __init__(self):
        # 한글 깨짐 방지
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except AttributeError:
            sys.stdout = io.TextIOWrapper(sys.stdout.detach(), encoding='utf-8', errors='replace')
            sys.stderr = io.TextIOWrapper(sys.stderr.detach(), encoding='utf-8', errors='replace')

        # 로그 초기화
        init_pando_logger()
        log_info("[판도] 프록시 서버 시작")
        log_info("[판도] 프록시 서버 로딩 완료 (한글 출력 테스트)")
        log_info("[판도] 이 줄이 찍히면 최신 코드입니다!")

    def request(self, flow: http.HTTPFlow):
        url = flow.request.url
        method = flow.request.method
        content_type = flow.request.headers.get("content-type", "")

        log_info(f"[request] : {method} {url}")

        try:
            raw_text = flow.request.raw_content.decode('utf-8', errors='replace')
        except Exception as e:
            log_error(f"[request] : 본문 디코딩 실패: {e}")
            raw_text = "<디코딩 실패>"

        for action, pattern in TARGETS_REQUEST.items():
            if pattern.search(url):
                if method in ("POST", "PUT"):
                    log_info("[판도] [request] : URL 매칭됨")
                    parsed_data = None
                    try:
                        if "application/json" in content_type:
                            parsed_data = json.loads(raw_text)
                        elif "application/x-www-form-urlencoded" in content_type or "text/plain" in content_type:
                            parsed_qs = parse_qs(raw_text)
                            parsed_data = {k: v[0] if len(v) == 1 else v for k, v in parsed_qs.items()}
                        else:
                            log_info(f"⚠️ Unknown content type: {content_type}")
                    except Exception as e:
                        log_error(f"[판도] [request] : 바디 파싱 실패: {e}")
                        log_info(f"[판도] [request] : Body (Raw): {raw_text[:500]}")

                    if parsed_data is not None:
                        save_request(action, url, parsed_data)
                        log_info(f"[판도] [request] : [{method}] {url}")
                        log_info("[판도] [request] : 파싱 결과\n" + json.dumps(parsed_data, ensure_ascii=False, indent=2))
                        log_info(f"[판도] [request] : [{action}] 요청 감지됨")
                break

    def response(self, flow: http.HTTPFlow):
        url = flow.request.url
        status = flow.response.status_code
        method = flow.request.method

        log_info(f"[response] : {method} : {url} → {status}")

        # ✅ clusterList 요청 URL이면 즉시 파싱/저장 (response body와 무관)
        if url.startswith(_CLUSTER_PREFIX):
            try:
                obj = _build_article_list_from_cluster_url(url)
                if obj:
                    _save_json_unique(obj)
                    log_info("[cluster] 추출\n" + json.dumps(obj, ensure_ascii=False, indent=2))
            except Exception as e:
                log_error(f"[cluster] URL 파싱 중 오류: {e}")

        if status == 204:
            log_info("[response] : [204] 응답 무시됨: 본문 없음")
            return

        if not flow.response.content:
            log_info("[response] : 본문이 비어 있음 → 스킵")
            return

        response_json: Dict[str, Any] = {}
        try:
            response_json = flow.response.json()
            log_error(f"[response] : JSON 파싱 성공: {response_json}")
        except Exception as e:
            log_error(f"[response] : JSON 파싱 실패: {e}")
            try:
                raw_text = flow.response.content.decode("utf-8", errors="replace")
                log_info(f"[response] : 원본 응답 (일부):\n{raw_text[:300]}")
            except Exception as de:
                log_error(f"[response] : 디코딩도 실패: {de}")

        # (옵션 폴백) 응답 JSON 내부 문자열에서도 clusterList 링크가 있으면 추출
        try:
            for s in _iter_strings(response_json):
                if isinstance(s, str) and s.startswith(_CLUSTER_PREFIX):
                    obj = _build_article_list_from_cluster_url(s)
                    if obj:
                        _save_json_unique(obj)
                        log_info("[cluster] 추출(JSON 내부)\n" + json.dumps(obj, ensure_ascii=False, indent=2))
        except Exception as e:
            log_error(f"[cluster] 탐지 중 오류: {e}")

        # ───────── 기존 처리 로직 ─────────
        for action, pattern in TARGETS_RESPONSE.items():
            if pattern.search(url):
                log_info("[판도] [response] : URL 매칭됨")
                if action == "delete_mobile":
                    destroy = response_json.get("entity", {}).get("destroy")
                    if not (isinstance(destroy, list) and len(destroy) > 0):
                        return

                # ✅ reseration은 code 검사 생략
                if action != "reseration":
                    response_code = response_json.get("code")
                    if response_code == "FAIL":
                        log_info(f"[판도] [response] : 처리 중단 응답 code가 FAIL → {url}")
                        return

                log_info(f"[판도] [response] : [{action}] 수신됨")
                log_info("[판도] [response] : JSON\n" + json.dumps(response_json, ensure_ascii=False, indent=2))

                match_and_dispatch(action, url, response_json)
                break

# mitmproxy가 인식할 수 있게 addons 등록
addons = [ProxyLogger()]
