from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import WebSocket

logger = logging.getLogger("harmonycast.listeners")


@dataclass
class Listener:
    id: str
    websocket: WebSocket
    ip: str
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    user_agent: Optional[str] = None
    volume: Optional[float] = None
    latency_ms: Optional[float] = None
    bitrate_kbps: Optional[float] = None
    quality_label: Optional[str] = None
    buffer_seconds: Optional[float] = None
    player_time: Optional[float] = None
    player_state: str = "unknown"
    last_report: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def summary(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "ip": self.ip,
            "connected_at": self.connected_at.isoformat(),
            "user_agent": self.user_agent,
            "volume": self.volume,
            "latency_ms": self.latency_ms,
            "bitrate_kbps": self.bitrate_kbps,
            "quality_label": self.quality_label,
            "buffer_seconds": self.buffer_seconds,
            "player_time": self.player_time,
            "player_state": self.player_state,
            "last_report": self.last_report.isoformat(),
        }


class ConnectionManager:
    def __init__(self) -> None:
        self.clients: Dict[str, Listener] = {}
        self.hosts: Dict[str, Listener] = {}
        self._lock = asyncio.Lock()

    async def connect_client(self, websocket: WebSocket) -> Listener:
        await websocket.accept()
        client_id = str(uuid.uuid4())
        listener = Listener(
            id=client_id,
            websocket=websocket,
            ip=self._ip_from_ws(websocket),
            user_agent=websocket.headers.get("user-agent"),
        )
        async with self._lock:
            self.clients[client_id] = listener
        logger.debug("Client registered id=%s ip=%s", listener.id, listener.ip)
        return listener

    async def connect_host(self, websocket: WebSocket) -> Listener:
        await websocket.accept()
        host_id = str(uuid.uuid4())
        listener = Listener(
            id=host_id,
            websocket=websocket,
            ip=self._ip_from_ws(websocket),
            user_agent=websocket.headers.get("user-agent"),
        )
        async with self._lock:
            self.hosts[host_id] = listener
        logger.debug("Host registered id=%s ip=%s", listener.id, listener.ip)
        return listener

    async def disconnect(self, listener_id: str, is_host: bool) -> None:
        async with self._lock:
            pool = self.hosts if is_host else self.clients
            listener = pool.pop(listener_id, None)
        if listener:
            try:
                await listener.websocket.close()
            except Exception:
                logger.debug("Socket already closed for id=%s", listener_id)
            logger.info("%s disconnected id=%s ip=%s", "Host" if is_host else "Client", listener_id, listener.ip)

    async def broadcast_to_clients(self, payload: Dict[str, Any]) -> None:
        await self._broadcast(self.clients, payload, is_host=False)

    async def broadcast_to_hosts(self, payload: Dict[str, Any]) -> None:
        await self._broadcast(self.hosts, payload, is_host=True)

    async def _broadcast(
        self, listeners: Dict[str, Listener], payload: Dict[str, Any], *, is_host: bool
    ) -> None:
        if not listeners:
            return
        logger.debug(
            "Broadcasting %s payload to %d %s",
            payload.get("type", "unknown"),
            len(listeners),
            "hosts" if is_host else "clients",
        )
        targets = list(listeners.items())
        for listener_id, listener in targets:
            try:
                await listener.websocket.send_json(payload)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Broadcast failed for id=%s (%s). Disconnecting. Error: %s",
                    listener_id,
                    "host" if is_host else "client",
                    exc,
                )
                await self.disconnect(listener_id, is_host=is_host)

    def snapshot(self) -> Dict[str, Any]:
        data = [listener.summary() for listener in self.clients.values()]
        logger.debug("Generated listener snapshot count=%d", len(data))
        return {"generated_at": datetime.now(timezone.utc).isoformat(), "listeners": data}

    async def update_listener_metrics(
        self,
        listener_id: str,
        *,
        volume: Optional[float] = None,
        latency_ms: Optional[float] = None,
        bitrate_kbps: Optional[float] = None,
        quality_label: Optional[str] = None,
        buffer_seconds: Optional[float] = None,
        player_time: Optional[float] = None,
        player_state: Optional[str] = None,
    ) -> None:
        async with self._lock:
            listener = self.clients.get(listener_id)
            if not listener:
                logger.debug("Metrics update ignored for disconnected client id=%s", listener_id)
                return
            if volume is not None:
                listener.volume = volume
            if latency_ms is not None:
                listener.latency_ms = latency_ms
            if bitrate_kbps is not None:
                listener.bitrate_kbps = bitrate_kbps
            if quality_label is not None:
                listener.quality_label = quality_label
            if buffer_seconds is not None:
                listener.buffer_seconds = buffer_seconds
            if player_time is not None:
                listener.player_time = player_time
            if player_state is not None:
                listener.player_state = player_state
            listener.last_report = datetime.now(timezone.utc)
        logger.debug("Metrics updated for client id=%s", listener_id)

    async def dispatch_snapshots(self, interval_seconds: float) -> None:
        logger.info("Listener snapshot task started interval=%ss", interval_seconds)
        try:
            while True:
                await asyncio.sleep(interval_seconds)
                snapshot = self.snapshot()
                payload = {"type": "listener_snapshot", "payload": snapshot}
                await self.broadcast_to_hosts(payload)
        except asyncio.CancelledError:
            logger.info("Listener snapshot task cancelled")

    def _ip_from_ws(self, websocket: WebSocket) -> str:
        client = websocket.client
        if client and client.host:
            return client.host
        forwarded = websocket.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return "unknown"


manager = ConnectionManager()
