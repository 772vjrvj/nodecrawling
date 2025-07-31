import win32gui
import win32con
import time

def is_chrome_window(hwnd):
    if win32gui.IsWindowVisible(hwnd):
        title = win32gui.GetWindowText(hwnd)
        return "Chrome" in title or "Google" in title
    return False

def get_chrome_hwnd():
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
    last_states = {}
    while True:
        chrome_hwnds = get_chrome_hwnd()
        for hwnd in chrome_hwnds:
            minimized = is_minimized(hwnd)
            if last_states.get(hwnd) != minimized:
                last_states[hwnd] = minimized
                print(f"{hwnd}:{'minimized' if minimized else 'restored'}", flush=True)
                if minimized:
                    time.sleep(5)
                    restore_and_activate(hwnd)
        time.sleep(1)