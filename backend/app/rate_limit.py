"""Small single-process limiter for the local pilot; API Gateway also throttles cloud traffic."""

import re
import threading
import time
from collections import defaultdict, deque


RULES = (
    ("GET", re.compile(r"^/api/reports/[^/]+/photo$"), 60, 60),
    ("POST", re.compile(r"^/api/reports$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/upload-url$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/confirm-upload$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/(?:classify|analyze)$"), 12, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/(?:support|complaint)$"), 30, 60),
    ("POST", re.compile(r"^/api/assistant$"), 20, 60),
)


class SlidingWindowLimiter:
    def __init__(self):
        self._events = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key, limit, window_seconds, now=None):
        now = time.monotonic() if now is None else now
        with self._lock:
            events = self._events[key]
            while events and events[0] <= now - window_seconds:
                events.popleft()
            if len(events) >= limit:
                return False
            events.append(now)
            return True


limiter = SlidingWindowLimiter()
