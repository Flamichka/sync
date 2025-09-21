from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


@dataclass
class Settings:
    app_name: str = "HarmonyCast"
    allowed_origins: List[str] = field(
        default_factory=lambda: ["*"]
    )  # Adjust in production
    listener_snapshot_interval: float = 3.0


settings = Settings()
