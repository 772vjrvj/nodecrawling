# chrome_minimized_watcher.py
# ─────────────────────────────────────────────────────────────────────────────
# 목적:
#   - 크롬(크로미움) 창이 최소화되어 있으면 복원합니다.
#   - 단발 실행(--single-check)로 "한 번만 검사하고 바로 종료"가 가능합니다.
#   - PID 기준으로 특정 브라우저 창만 복원할 수도 있고, PID 없이 전체 Chrome 창을 복원할 수도 있습니다.
#
# 왜 필요?
#   - Puppeteer의 browser.process().pid (메인 프로세스 PID)와 실제 "보이는 창"의 PID가 다를 수 있습니다.
#     그래서 PID 기준으로 못 찾는 경우가 생김 → JS에서 code 101을 감지하여 "전체 Chrome 대상으로 fallback" 하게 설계했습니다.
#
# 옵션 요약:
#   --single-check          : 즉시 1회 검사 후 종료(권장: JS에서 이 모드로 호출)
#   --exit-if-not-found     : --pid가 주어졌는데 해당 PID 창을 못 찾으면 "종료코드 101"로 즉시 종료
#   --timeout N             : 루프 모드에서 최대 실행 시간(초). single-check 모드에선 사실상 무시
#   --pid <number>          : 특정 Chrome 프로세스(PID)의 창만 대상으로 함
#
# 종료 코드:
#   0   : 정상 종료(복원했거나 복원 대상이 없거나, 전체 대상 검사 종료)
#   101 : --pid로 지정된 창을 찾지 못해 즉시 종료(상위 JS에서 fallback 트리거 용도)
#
# 외부 모듈:
#   pip install pywin32
#   (Windows 전용. win32gui/win32con/win32process 사용)
# ─────────────────────────────────────────────────────────────────────────────

import win32gui
import win32con
import win32process
import time
import argparse
import sys

# ─────────────────────────────────────────────────────────────────────────────
# Chrome 창 판별 함수
#   - 기본적으로 "보이는 창(visible)"이면서 제목에 "Chrome/Google/Chromium" 이 포함되면 Chrome으로 간주
#   - 필요시 클래스명으로 더 엄격히 체크 가능: win32gui.GetClassName(hwnd) == "Chrome_WidgetWin_1"
# ─────────────────────────────────────────────────────────────────────────────
def is_chrome_window(hwnd):
    if win32gui.IsWindowVisible(hwnd):
        title = win32gui.GetWindowText(hwnd) or ""
        # 엄격 모드 예시:
        # cls = win32gui.GetClassName(hwnd) or ""
        # return cls == "Chrome_WidgetWin_1"
        return ("Chrome" in title) or ("Google" in title) or ("Chromium" in title)
    return False

# ─────────────────────────────────────────────────────────────────────────────
# 특정 PID의 Chrome 창만 수집
#   - EnumWindows로 전체 최상위 창을 순회 → 해당 hwnd가 chrome 창인지 확인 → hwnd의 PID 조회 → target_pid와 일치하면 수집
# ─────────────────────────────────────────────────────────────────────────────
def get_chrome_hwnd_by_pid(target_pid):
    chrome_hwnds = []
    def callback(hwnd, _):
        if is_chrome_window(hwnd):
            try:
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                if pid == target_pid:
                    chrome_hwnds.append(hwnd)
            except:
                # PID 조회 실패 케이스는 무시
                pass
    win32gui.EnumWindows(callback, None)
    return chrome_hwnds

# ─────────────────────────────────────────────────────────────────────────────
# 모든 Chrome 창 수집 (PID 무시)
# ─────────────────────────────────────────────────────────────────────────────
def get_all_chrome_hwnd():
    chrome_hwnds = []
    def callback(hwnd, _):
        if is_chrome_window(hwnd):
            chrome_hwnds.append(hwnd)
    win32gui.EnumWindows(callback, None)
    return chrome_hwnds

# ─────────────────────────────────────────────────────────────────────────────
# 최소화 여부 확인
#   - IsIconic(hwnd) == True → 최소화된 상태
# ─────────────────────────────────────────────────────────────────────────────
def is_minimized(hwnd):
    return win32gui.IsIconic(hwnd)

# ─────────────────────────────────────────────────────────────────────────────
# 창 복원 + 전경으로 올리기
#   - ShowWindow(hwnd, SW_RESTORE) → 최소화 해제
#   - SetForegroundWindow(hwnd)    → 전경 포커스(실패할 수 있으므로 예외는 무시)
# ─────────────────────────────────────────────────────────────────────────────
def restore_and_activate(hwnd):
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except:
        # 포그라운드 실패는 치명적이지 않음 → 조용히 무시
        pass

# ─────────────────────────────────────────────────────────────────────────────
# 단발 체크 모드:
#   - pid가 있으면 해당 pid 창만, 없으면 전체 chrome 창을 수집
#   - 최소화된 창을 모두 복원
#   - pid가 있는데 창을 하나도 못 찾으면 code 101로 종료(상위에서 fallback 시그널)
#   - 그 외에는 code 0으로 종료
# ─────────────────────────────────────────────────────────────────────────────
def single_check_flow(target_pid, exit_if_not_found):
    if target_pid:
        chrome_hwnds = get_chrome_hwnd_by_pid(target_pid)
        if not chrome_hwnds:
            print(f"[single-check] 지정 PID({target_pid}) 창을 찾지 못함.", flush=True)
            if exit_if_not_found:
                # JS에서 이 코드를 보고 "전체 chrome 대상으로 다시 한 번" 시도하도록 설계됨
                sys.exit(101)
            # exit-if-not-found를 안 준 경우는 그냥 0으로 종료
            sys.exit(0)
    else:
        chrome_hwnds = get_all_chrome_hwnd()

    restored_any = False
    for hwnd in chrome_hwnds:
        if is_minimized(hwnd):
            print(f"[single-check] 최소화 창 발견: {hwnd} → 복원", flush=True)
            # 필요시 아주 짧은 sleep으로 안정화
            # time.sleep(0.1)
            restore_and_activate(hwnd)
            restored_any = True

    if restored_any:
        print("[single-check] 복원 완료. 종료.", flush=True)
    else:
        print("[single-check] 복원할 최소화 창 없음. 종료.", flush=True)

    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# 메인
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Chrome 최소화 감지 및 복원')
    # 하위호환: --restore-once == --single-check와 동일하게 취급
    parser.add_argument('--restore-once', action='store_true', help='(하위호환) 한 번만 복원 후 종료')
    parser.add_argument('--single-check', action='store_true', help='즉시 1회 검사 후 종료')
    parser.add_argument('--pid', type=int, help='감시할 Chrome 프로세스 ID')
    parser.add_argument('--exit-if-not-found', action='store_true', help='PID 지정 시 창이 없으면 코드 101로 종료')
    parser.add_argument('--timeout', type=int, default=0, help='루프 모드 최대 동작 시간(초). 0이면 무제한')

    args = parser.parse_args()
    target_pid = args.pid

    print("Chrome 최소화 감지 시작...", flush=True)
    if target_pid:
        print(f"대상 PID: {target_pid}", flush=True)
    else:
        print("모든 Chrome 창 감시", flush=True)

    # 권장: 단발 체크 모드(= JS에서 --single-check로 호출)
    if args.single_check or args.restore_once:
        single_check_flow(target_pid, args.exit_if_not_found)

    # 여기서부터는 루프 모드(필요할 때만 사용)
    #  - 주기적으로 창 상태 변화를 감지하여 최소화 시 복원
    #  - --timeout으로 최대 동작 시간을 제한 가능
    start_ts = time.time()
    last_states = {}  # 각 hwnd의 마지막 최소화 상태 기록
    miss_count = 0    # pid 기준으로 창을 못 찾은 횟수(즉시 종료용)

    while True:
        try:
            # 1) 감시 대상 창 목록 수집
            if target_pid:
                chrome_hwnds = get_chrome_hwnd_by_pid(target_pid)
                if not chrome_hwnds:
                    miss_count += 1
                    if args.exit_if_not_found and miss_count >= 1:
                        print(f"[loop] 지정 PID({target_pid}) 창을 찾지 못함. 종료.", flush=True)
                        sys.exit(101)
                else:
                    miss_count = 0
            else:
                chrome_hwnds = get_all_chrome_hwnd()

            # 2) 상태 변화(최소화 ↔ 복원) 감지
            for hwnd in chrome_hwnds:
                minimized = is_minimized(hwnd)
                if last_states.get(hwnd) != minimized:
                    last_states[hwnd] = minimized
                    status = "minimized" if minimized else "restored"
                    print(f"[loop] 창 {hwnd} - {status}", flush=True)

                    if minimized:
                        # 너무 길게 기다리면 UX가 나빠지므로 짧게 대기 후 복원
                        time.sleep(0.3)
                        restore_and_activate(hwnd)
                        print(f"[loop] 창 {hwnd} 복원 완료", flush=True)

            # 3) 타임아웃 체크(루프 모드 한정)
            if args.timeout and (time.time() - start_ts) >= args.timeout:
                print(f"[loop] timeout {args.timeout}s 도달. 종료.", flush=True)
                sys.exit(0)

            # 4) 루프 간격(너무 빡세면 CPU 사용량이 커짐)
            time.sleep(0.3)

        except KeyboardInterrupt:
            print("사용자에 의해 중단됨", flush=True)
            break
        except Exception as e:
            # 예외는 로깅 후 잠깐 쉬고 재시도
            print(f"오류 발생: {e}", flush=True)
            time.sleep(0.5)
