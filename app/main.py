from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from typing import Any, Dict

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect

from app.core.config import settings
from app.core.logging_config import setup_logging
from app.services.listeners import manager
from app.services.state import state

SESSION_LOG_FILE = setup_logging()
logger = logging.getLogger("harmonycast.app")

app = FastAPI(title=settings.app_name)
app.state.session_log_file = SESSION_LOG_FILE
logger.info("Application startup. Logging to %s", SESSION_LOG_FILE)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/assets", StaticFiles(directory="frontend/assets"), name="assets")

state_lock = asyncio.Lock()


class MetadataRequest(BaseModel):
    video_id: str


@app.get("/", response_class=FileResponse)
async def read_home() -> FileResponse:
    logger.debug("Serving listener UI")
    return FileResponse("frontend/index.html")


@app.get("/host", response_class=FileResponse)
async def read_host() -> FileResponse:
    logger.debug("Serving host UI")
    return FileResponse("frontend/host.html")


@app.get("/api/session/state")
async def get_session_state() -> Dict[str, Any]:
    logger.debug("Session state requested")
    return {"state": state.as_payload()}


@app.post("/api/video/metadata")
async def fetch_video_metadata(request: MetadataRequest) -> Dict[str, Any]:
    logger.info("Fetching metadata for video_id=%s", request.video_id)
    url = f"https://noembed.com/embed?url=https://www.youtube.com/watch?v={request.video_id}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(url)
    if response.status_code != 200:
        logger.warning("Metadata lookup failed for video_id=%s status=%s", request.video_id, response.status_code)
        raise HTTPException(status_code=404, detail="Video metadata not found")
    data = response.json()
    logger.debug("Metadata retrieved for video_id=%s title=%s", request.video_id, data.get("title"))
    return {
        "video_id": request.video_id,
        "title": data.get("title"),
        "author": data.get("author_name"),
        "thumbnail": data.get("thumbnail_url"),
    }


async def _client_session(websocket: WebSocket) -> None:
    listener = await manager.connect_client(websocket)
    logger.info("Client connected id=%s ip=%s", listener.id, listener.ip)
    await websocket.send_json({"type": "hello", "payload": {"listener_id": listener.id}})
    await websocket.send_json({"type": "sync_state", "payload": state.as_payload()})
    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            payload = message.get("payload", {})
            logger.debug("Client message id=%s type=%s", listener.id, message_type)
            if message_type == "client_status":
                await manager.update_listener_metrics(
                    listener.id,
                    volume=payload.get("volume"),
                    latency_ms=payload.get("latency_ms"),
                    bitrate_kbps=payload.get("bitrate_kbps"),
                    quality_label=payload.get("quality_label"),
                    buffer_seconds=payload.get("buffer_seconds"),
                    player_time=payload.get("player_time"),
                    player_state=payload.get("player_state"),
                )
            elif message_type == "request_sync":
                logger.info("Client %s requesting resync", listener.id)
                await websocket.send_json({"type": "sync_state", "payload": state.as_payload()})
            elif message_type == "pong":
                sent_at = payload.get("sent_at")
                if sent_at:
                    latency = (datetime.now(timezone.utc).timestamp() - float(sent_at)) * 1000
                    logger.debug("Client %s reported latency %.2f ms", listener.id, latency)
                    await manager.update_listener_metrics(listener.id, latency_ms=latency)
    except WebSocketDisconnect:
        logger.info("Client %s disconnected", listener.id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error in client websocket: %s", exc)
    finally:
        await manager.disconnect(listener.id, is_host=False)


async def _host_session(websocket: WebSocket) -> None:
    host = await manager.connect_host(websocket)
    logger.info("Host connected id=%s ip=%s", host.id, host.ip)
    await websocket.send_json(
        {
            "type": "hello",
            "payload": {
                "host_id": host.id,
                "state": state.as_payload(),
                "listeners": manager.snapshot(),
            },
        }
    )
    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            payload = message.get("payload", {})
            logger.debug("Host message id=%s type=%s", host.id, message_type)

            if message_type == "update_state":
                await _handle_host_state_update(payload)
            elif message_type == "resync_all":
                logger.info("Host %s requested global resync", host.id)
                await _broadcast_state()
            elif message_type == "ping":
                await websocket.send_json(
                    {
                        "type": "pong",
                        "payload": {"sent_at": payload.get("sent_at")},
                    }
                )
    except WebSocketDisconnect:
        logger.info("Host %s disconnected", host.id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error in host websocket: %s", exc)
    finally:
        await manager.disconnect(host.id, is_host=True)


@app.websocket("/ws/client")
async def client_ws(websocket: WebSocket) -> None:
    logger.debug("Incoming websocket on /ws/client")
    await _client_session(websocket)


@app.websocket("/ws/host")
async def host_ws(websocket: WebSocket) -> None:
    logger.debug("Incoming websocket on /ws/host")
    await _host_session(websocket)


@app.websocket("/ws")
async def multiplex_ws(websocket: WebSocket) -> None:
    role = (websocket.query_params.get("role") or "").lower()
    logger.debug("Incoming websocket on /ws with role=%s", role or "client")
    if role == "host":
        await _host_session(websocket)
        return
    await _client_session(websocket)


async def _handle_host_state_update(payload: Dict[str, Any]) -> None:
    async with state_lock:
        state.apply_host_update(payload)
        snapshot = state.as_payload()
    logger.info(
        "Broadcasting host update video_id=%s playing=%s position=%.2f volume=%s",
        snapshot.get("video_id"),
        snapshot.get("is_playing"),
        snapshot.get("position"),
        snapshot.get("host_volume"),
    )
    await manager.broadcast_to_clients({"type": "sync_state", "payload": snapshot})
    await manager.broadcast_to_hosts({"type": "sync_state", "payload": snapshot})


async def _broadcast_state() -> None:
    snapshot = state.as_payload()
    logger.debug("Broadcasting sync snapshot to listeners")
    await manager.broadcast_to_clients({"type": "sync_state", "payload": snapshot})


@app.on_event("startup")
async def startup_event() -> None:
    logger.info("FastAPI startup event triggered")
    app.state.snapshot_task = asyncio.create_task(
        manager.dispatch_snapshots(settings.listener_snapshot_interval)
    )


@app.on_event("shutdown")
async def shutdown_event() -> None:
    logger.info("FastAPI shutdown event triggered")
    snapshot_task: asyncio.Task[Any] | None = getattr(app.state, "snapshot_task", None)
    if snapshot_task:
        snapshot_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await snapshot_task
    logger.info("Shutdown complete")


@app.exception_handler(Exception)
async def global_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/favicon.ico")
async def favicon() -> Response:
    return Response(status_code=204)
