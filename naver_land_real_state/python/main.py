# main.py
# -*- coding: utf-8 -*-
"""
city_latlon.json  +  cluster_result.json  →  naver_land_real_state_data.json

- 매칭 키: (lat, lon) 문자열 일치 우선
- 예외 케이스: 문자열 일치 실패 시, 소수점 미세 오차 허용(옵션)
- 출력: 실행 중인 main.py 파일과 같은 폴더에 저장 (UTF-8, ensure_ascii=False, indent=2)
- 출력 레코드 필드 순서:
  clusterList_url, 시도, 시군구, lat, lon, articleList
"""

from __future__ import annotations
from pathlib import Path
import json
from typing import Dict, List, Tuple, Any, Optional

# ========================= 설정 =========================
CITY_FILE = "city_latlon.json"
CLUSTER_FILE = "cluster_result.json"
OUTPUT_FILE = "naver_land_real_state_data.json"

# 문자열 일치 실패 시 float 비교 허용 여부/허용 오차
ALLOW_FLOAT_TOLERANCE = True
FLOAT_TOLERANCE = 1e-6  # 0.000001 이내면 동일로 간주
# ========================================================


def _norm_str(v: Any) -> str:
    """lat/lon을 문자열로 표준화 (공백 제거). None → ''"""
    if v is None:
        return ""
    return str(v).strip()


def _key(lat: Any, lon: Any) -> Tuple[str, str]:
    """정확 문자열 매칭용 키 생성"""
    return _norm_str(lat), _norm_str(lon)


def _float_equal(a: str, b: str, tol: float) -> bool:
    """문자열 숫자를 float으로 변환해 오차 허용 비교 (실패 시 False)"""
    try:
        return abs(float(a) - float(b)) <= tol
    except Exception:
        return False


def load_json_list(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path.name} 최상위 구조는 list여야 합니다.")
    return data


def build_city_index(city_rows: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """
    (lat, lon) → city_row 인덱스.
    동일 좌표 중복 시 마지막 레코드가 우선(원하면 경고/처리 변경).
    """
    idx: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in city_rows:
        lat, lon = _key(row.get("lat"), row.get("lon"))
        if not lat or not lon:
            # 좌표 없으면 스킵
            continue
        idx[(lat, lon)] = row
    return idx


def find_city_for_cluster(
        city_index: Dict[Tuple[str, str], Dict[str, Any]],
        cluster_lat: str,
        cluster_lon: str,
        allow_tol: bool = True,
        tol: float = 1e-6,
) -> Optional[Dict[str, Any]]:
    """
    1) 문자열 정확 매칭
    2) (옵션) 미세 오차 허용 매칭
    """
    k = (_norm_str(cluster_lat), _norm_str(cluster_lon))
    hit = city_index.get(k)
    if hit is not None:
        return hit

    if not allow_tol:
        return None

    # 오차 허용 탐색 (건수가 아주 많지 않다는 가정에서 선형 탐색)
    # 대량 데이터면 별도 버킷/그리드 인덱스를 고려
    for (lat_s, lon_s), row in city_index.items():
        if _float_equal(lat_s, k[0], tol) and _float_equal(lon_s, k[1], tol):
            return row
    return None


def merge_records(
        city_row: Dict[str, Any],
        cluster_row: Dict[str, Any],
) -> Dict[str, Any]:
    """
    요구한 필드 순서로 병합한 dict 생성.
    - clusterList_url (from cluster)
    - 시도, 시군구 (from city)
    - lat, lon (동일값, cluster 기준으로 정규화된 문자열 사용)
    - articleList (from cluster)
    """
    clusterList_url = cluster_row.get("clusterList_url")
    articleList = cluster_row.get("articleList")
    lat = _norm_str(cluster_row.get("lat"))
    lon = _norm_str(cluster_row.get("lon"))

    # 딕셔너리 삽입 순서를 이용해 원하는 키 순서 보장 (Python 3.7+)
    merged = {
        "clusterList_url": clusterList_url,
        "시도": city_row.get("시도"),
        "시군구": city_row.get("시군구"),
        "lat": lat,
        "lon": lon,
        "articleList": articleList,
    }
    return merged


def main():
    base_dir = Path(__file__).resolve().parent  # main.py와 같은 폴더 기준
    city_path = base_dir / CITY_FILE
    cluster_path = base_dir / CLUSTER_FILE
    out_path = base_dir / OUTPUT_FILE

    # 파일 로드
    city_rows = load_json_list(city_path)
    cluster_rows = load_json_list(cluster_path)

    # 인덱스 준비
    city_index = build_city_index(city_rows)

    merged_list: List[Dict[str, Any]] = []
    no_match_count = 0

    for c in cluster_rows:
        clat, clon = _norm_str(c.get("lat")), _norm_str(c.get("lon"))
        if not clat or not clon:
            # 좌표가 없으면 매칭 불가
            no_match_count += 1
            continue

        city = find_city_for_cluster(
            city_index, clat, clon,
            allow_tol=ALLOW_FLOAT_TOLERANCE,
            tol=FLOAT_TOLERANCE,
        )
        if city is None:
            no_match_count += 1
            continue

        merged_list.append(merge_records(city, c))

    # 저장
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(merged_list, f, ensure_ascii=False, indent=2)

    # 요약 로그
    total = len(cluster_rows)
    matched = len(merged_list)
    print(f"[완료] 병합 결과 저장: {out_path.name}")
    print(f" - cluster rows: {total}")
    print(f" - matched rows : {matched}")
    print(f" - unmatched rows: {no_match_count}")


if __name__ == "__main__":
    main()
