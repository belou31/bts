"""
Shared logging helpers for BTS automation clients.

Wrap a run with ``capture_logs`` to duplicate stdout/stderr into a
timestamped file under ``/tmp/bts`` (override via ``BTS_LOG_DIR``). The
current log file path is exposed via ``current_log_path`` so UIs can surface
it in notifications.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import os
import sys
import traceback
from pathlib import Path
from typing import Iterator, Optional

LOG_DIR = Path(os.environ.get("BTS_LOG_DIR", "/tmp/bts"))
_CURRENT_LOG_PATH: Optional[Path] = None


class _TeeStream:
    """Mirror writes to multiple file-like objects."""

    def __init__(self, *targets):
        self._targets = [t for t in targets if t is not None]

    def write(self, data: str) -> int:
        count = 0
        for target in self._targets:
            count = target.write(data)
        return count

    def flush(self) -> None:
        for target in self._targets:
            flush = getattr(target, "flush", None)
            if callable(flush):
                flush()


def _sanitize_name(name: str) -> str:
    clean = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in name.strip())
    clean = clean.strip("-_.")
    return clean or "macro"


@contextlib.contextmanager
def capture_logs(run_name: str) -> Iterator[Path]:
    """
    Redirect stdout/stderr to a timestamped log file for the duration of the block.

    Args:
        run_name: Identifier appended to the log filename.

    Yields:
        The Path to the log file.
    """

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"log-{ts}-{_sanitize_name(run_name)}.txt"
    log_path = LOG_DIR / filename

    original_stdout = sys.stdout
    original_stderr = sys.stderr

    with log_path.open("w", encoding="utf-8") as log_file:
        tee_out = _TeeStream(original_stdout, log_file)
        tee_err = _TeeStream(original_stderr, log_file)

        with contextlib.redirect_stdout(tee_out), contextlib.redirect_stderr(tee_err):
            global _CURRENT_LOG_PATH  # noqa: PLW0603
            previous_path = _CURRENT_LOG_PATH
            _CURRENT_LOG_PATH = log_path
            try:
                print(f"[BTS] Logging to {log_path}")
                yield log_path
            except Exception:
                traceback.print_exc()
                raise
            finally:
                print(f"[BTS] Log saved to {log_path}")
                _CURRENT_LOG_PATH = previous_path


def current_log_path() -> Optional[Path]:
    """Return the active log file path if ``capture_logs`` is in effect."""
    return _CURRENT_LOG_PATH


__all__ = ["capture_logs", "current_log_path"]
