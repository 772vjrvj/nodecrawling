import win32gui
import win32con
import win32process
import time
import argparse
import sys

def is_chrome_window(hwnd):
    if win32gui.IsWindowVisible(hwnd):
        title = win32gui.GetWindowText(hwnd)
        return "Chrome" in title or "Google" in title
    return False

def get_chrome_hwnd_by_pid(target_pid):
    """특정 PID의 Chrome 창만 찾습니다."""
    chrome_hwnds = []

    def callback(hwnd, _):
        if is_chrome_window(hwnd):
            try:
                # 창의 프로세스 ID 가져오기
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                if pid == target_pid:
                    chrome_hwnds.append(hwnd)
            except:
                pass  # 프로세스 ID를 가져올 수 없는 경우 무시

    win32gui.EnumWindows(callback, None)
    return chrome_hwnds

def get_all_chrome_hwnd():
    """모든 Chrome 창을 찾습니다 (기존 함수)."""
    chrome_hwnds = []
    def callback(hwnd, _):
        if is_chrome_window(hwnd):
            chrome_hwnds.append(hwnd)
    win32gui.EnumWindows(callback, None)
    return chrome_hwnds

def is_minimized(hwnd):
    return win32gui.IsIconic(hwnd)

def restore_and_activate(hwnd):
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.SetForegroundWindow(hwnd)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Chrome 최소화 감지 및 복원')
    parser.add_argument('--restore-once', action='store_true', help='한 번만 복원 후 종료')
    parser.add_argument('--pid', type=int, help='감시할 Chrome 프로세스 ID')

    args = parser.parse_args()

    last_states = {}
    target_pid = args.pid

    print(f"Chrome 최소화 감지 시작...")
    if target_pid:
        print(f"대상 PID: {target_pid}")
    else:
        print("모든 Chrome 창 감시")

    while True:
        try:
            # PID가 지정된 경우 해당 프로세스의 창만, 아니면 모든 Chrome 창
            if target_pid:
                chrome_hwnds = get_chrome_hwnd_by_pid(target_pid)
            else:
                chrome_hwnds = get_all_chrome_hwnd()

            for hwnd in chrome_hwnds:
                minimized = is_minimized(hwnd)
                if last_states.get(hwnd) != minimized:
                    last_states[hwnd] = minimized
                    status = "minimized" if minimized else "restored"
                    print(f"PID {target_pid}: 창 {hwnd} - {status}", flush=True)

                    if minimized:
                        print(f"5초 후 창 {hwnd} 복원...", flush=True)
                        time.sleep(5)
                        restore_and_activate(hwnd)
                        print(f"창 {hwnd} 복원 완료", flush=True)

                        if args.restore_once:
                            print("한 번 복원 완료, 종료합니다.")
                            sys.exit(0)

            time.sleep(1)
        except KeyboardInterrupt:
            print("사용자에 의해 중단됨")
            break
        except Exception as e:
            print(f"오류 발생: {e}")
            time.sleep(1)