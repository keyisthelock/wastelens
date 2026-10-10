"""Small single-process limiter for the local pilot; API Gateway also throttles cloud traffic."""

import re
import threading
import time
from collections import defaultdict, deque


RULES = (
    ("POST", re.compile(r"^/api/auth/(?:login|register|google(?:/challenge)?)$"), 8, 300),
    ("POST", re.compile(r"^/api/communities$"), 5, 300),
    ("POST", re.compile(r"^/api/reports/[^/]+/comments$"), 8, 60),
    ("PATCH", re.compile(r"^/api/reports/[^/]+/photo-sharing$"), 12, 60),
    ("GET", re.compile(r"^/api/reports/[^/]+/photo$"), 60, 60),
    ("POST", re.compile(r"^/api/reports$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/upload-url$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/(?:confirm-upload|upload-url)$"), 8, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/(?:classify|analyze)$"), 12, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/(?:support|complaint)$"), 30, 60),
    ("POST", re.compile(r"^/api/reports/[^/]+/submit$"), 5, 3600),
    ("POST", re.compile(r"^/api/waste/guide$"), 6, 60),
    ("POST", re.compile(r"^/api/nearby-bins$"), 4, 60),
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
