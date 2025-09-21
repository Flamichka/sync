from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict

logger = logging.getLogger("harmonycast.state")


@dataclass
class PlaybackState:
    """Represents the host controlled playback state."""

    video_id: str = ""
    video_title: str = ""
    duration: float = 0.0
    is_playing: bool = False
    current_time: float = 0.0
    last_update: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    host_volume: int = 80

    def as_payload(self) -> Dict[str, Any]:
        return {
            "video_id": self.video_id,
            "video_title": self.video_title,
            "duration": self.duration,
            "is_playing": self.is_playing,
            "position": self.effective_position(),
            "host_volume": self.host_volume,
            "last_update": self.last_update.isoformat(),
        }

    def effective_position(self) -> float:
        if not self.is_playing:
            return self.current_time
        elapsed = (datetime.now(timezone.utc) - self.last_update).total_seconds()
        return max(0.0, min(self.current_time + elapsed, self.duration or float("inf")))

    def apply_host_update(self, payload: Dict[str, Any]) -> None:
        logger.debug("Applying host update payload=%s", {key: payload.get(key) for key in payload})
        if "video_id" in payload and payload["video_id"]:
            self.video_id = payload["video_id"]
        if "video_title" in payload:
            self.video_title = payload["video_title"]
        if "duration" in payload and payload["duration"] is not None:
            self.duration = float(payload["duration"])
        if "host_volume" in payload:
            self.host_volume = int(payload["host_volume"])
        if "position" in payload and payload["position"] is not None:
            self.current_time = max(0.0, float(payload["position"]))
            self.last_update = datetime.now(timezone.utc)
        if "is_playing" in payload:
            self.is_playing = bool(payload["is_playing"])
            self.last_update = datetime.now(timezone.utc)
        logger.debug(
            "State after update video_id=%s playing=%s position=%.2f volume=%s",
            self.video_id,
            self.is_playing,
            self.current_time,
            self.host_volume,
        )

    def reset_position(self, position: float) -> None:
        self.current_time = max(0.0, position)
        self.last_update = datetime.now(timezone.utc)


state = PlaybackState()
