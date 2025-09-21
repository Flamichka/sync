from __future__ import annotations

import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

LOG_DIR_ENV = "HARMONYCAST_LOG_DIR"
DEFAULT_LOG_DIR = Path("logs")
DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
DEFAULT_BACKUP_COUNT = 3


def setup_logging(
    *,
    log_dir: Optional[Path] = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    backup_count: int = DEFAULT_BACKUP_COUNT,
) -> Path:
    """Initialise application logging with rotating file handlers."""

    resolved_dir = log_dir or Path(os.environ.get(LOG_DIR_ENV, DEFAULT_LOG_DIR))
    resolved_dir.mkdir(parents=True, exist_ok=True)

    log_file = resolved_dir / f"session-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"

    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.INFO)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.setLevel(logging.INFO)

    root_logger = logging.getLogger()
    # Avoid duplicate handlers on reload
    _remove_existing_session_handlers(root_logger)
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(file_handler)

    # keep any pre-existing console handlers (uvicorn) but ensure at least one
    if not any(isinstance(handler, logging.StreamHandler) for handler in root_logger.handlers):
        root_logger.addHandler(console_handler)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("websockets").setLevel(logging.WARNING)

    logging.getLogger(__name__).info("Logging initialised. Session file: %s", log_file)

    return log_file


def _remove_existing_session_handlers(root_logger: logging.Logger) -> None:
    for handler in list(root_logger.handlers):
        if isinstance(handler, RotatingFileHandler) and handler.baseFilename:
            handler.close()
            root_logger.removeHandler(handler)
