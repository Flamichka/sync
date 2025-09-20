import asyncio
import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator

# ---------------------------
# Utility time helpers
# ---------------------------

def now_ms() -> int:
    # Server's "wall clock" epoch ms (aligned with JS Date.now()).
    return int(time.time() * 1000)


# ---------------------------
# Token bucket rate limiter
# ---------------------------

class TokenBucket:
    """
    Simple token bucket to rate-limit control messages per client.
    capacity: max tokens
    fill_rate: tokens per second
    """
    def __init__(self, capacity: float = 10.0, fill_rate: float = 5.0):
        self.capacity = capacity
        self.tokens = capacity
        self.fill_rate = fill_rate
        self.last_refill = time.monotonic()

    def consume(self, cost: float = 1.0) -> bool:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.last_refill = now
        self.tokens = min(self.capacity, self.tokens + elapsed * self.fill_rate)
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False


# ---------------------------
# Pydantic models (v2)
# ---------------------------

ALLOWED_MEDIA_EXT = {".mp3", ".ogg", ".wav"}
URL_RE = re.compile(r"^(https?://|/media/|/static/|/)[^\s]+$", re.IGNORECASE)

class RoomState(BaseModel):
    track_url: str = ""
    paused: bool = True
    position_sec: float = 0.0
    start_epoch_ms: int = 0
    playback_rate: float = 1.0
    volume: float = 1.0

    def dump(self) -> Dict[str, Any]:
        return self.model_dump()


class HelloMsg(BaseModel):
    type: Literal["hello"] = "hello"
    want_host: bool = False
    name: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if v == "":
            return None
        if len(v) > 40:
            raise ValueError("name too long")
        if not re.match(r"^[\w .\-]{1,40}$", v):
            raise ValueError("invalid characters in name")
        return v


class ControlMsg(BaseModel):
    type: Literal["control"] = "control"
    action: str  # play | pause | seek | set_track | set_volume
    position_sec: Optional[float] = None
    track_url: Optional[str] = None
    volume: Optional[float] = None
    playback_rate: Optional[float] = None

    @field_validator("action")
    @classmethod
    def action_valid(cls, v: str) -> str:
        if v not in {"play", "pause", "seek", "set_track", "set_volume"}:
            raise ValueError("invalid action")
        return v

    @field_validator("volume")
    @classmethod
    def volume_range(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return v
        if not (0.0 <= v <= 1.0):
            raise ValueError("volume must be 0.0-1.0")
        return v

    @field_validator("track_url")
    @classmethod
    def track_url_allowed(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if len(v) > 2048 or not URL_RE.match(v):
            raise ValueError("invalid URL")
        lowered = v.lower()
        if not any(lowered.endswith(ext) for ext in ALLOWED_MEDIA_EXT):
            raise ValueError("only .mp3/.ogg/.wav allowed")
        return v


class PongMsg(BaseModel):
    type: Literal["pong"] = "pong"
    t0: int


# Server→Client messages are emitted as dicts for efficiency.


# ---------------------------
# Client and Room management
# ---------------------------

class Client:
    def __init__(self, ws: WebSocket, is_host: bool):
        self.id = uuid.uuid4().hex
        self.ws = ws
        self.is_host = is_host
        self.last_pong_ms = now_ms()
        self.rate = TokenBucket()
        # For client list: remember remote address
        try:
            self.peer_host = getattr(ws.client, "host", None)
            self.peer_port = getattr(ws.client, "port", None)
        except Exception:
            self.peer_host = None
            self.peer_port = None
        # Display name (can be overridden by hello)
        self.name: str = f"Guest-{self.id[:6]}"

    def to_role_str(self) -> str:
        return "host" if self.is_host else "listener"


class Room:
    def __init__(self, name: str):
        self.name = name
        self.state = RoomState()
        self.clients: Dict[str, Client] = {}
        self.order: List[str] = []  # preserve join order
        self.host_id: Optional[str] = None
        self.lock = asyncio.Lock()

    def _current_position(self) -> float:
        # Compute current position based on paused/start_epoch_ms.
        if self.state.paused:
            return max(0.0, float(self.state.position_sec))
        # Elapsed since start in seconds:
        elapsed = (now_ms() - self.state.start_epoch_ms) / 1000.0
        return max(0.0, float(elapsed))

    async def add_client(self, ws: WebSocket) -> Client:
        async with self.lock:
            is_host = self.host_id is None
            client = Client(ws, is_host)
            self.clients[client.id] = client
            self.order.append(client.id)
            if is_host:
                self.host_id = client.id
            return client

    async def remove_client(self, client_id: str) -> Optional[str]:
        new_host_id: Optional[str] = None
        async with self.lock:
            client = self.clients.pop(client_id, None)
            if client_id in self.order:
                self.order.remove(client_id)
            if client and client_id == self.host_id:
                self.host_id = None
                # Assign new host if available:
                for cid in self.order:
                    if cid in self.clients:
                        self.clients[cid].is_host = True
                        self.host_id = cid
                        new_host_id = cid
                        break
        return new_host_id

    async def broadcast(self, obj: Dict[str, Any]) -> None:
        # Broadcast JSON to all clients; drop on failure.
        data = json.dumps(obj, separators=(",", ":"))
        dead: List[str] = []
        for cid, c in list(self.clients.items()):
            try:
                await c.ws.send_text(data)
            except Exception:
                dead.append(cid)
        for cid in dead:
            await self.remove_client(cid)

    def _assign_host_if_none(self) -> Optional[str]:
        if self.host_id is not None:
            return None
        for cid in self.order:
            if cid in self.clients:
                self.clients[cid].is_host = True
                self.host_id = cid
                return cid
        return None

    async def maybe_assign_host(self) -> Optional[str]:
        async with self.lock:
            return self._assign_host_if_none()

    async def send_init(self, client: Client) -> None:
        init_msg = {
            "type": "init",
            "is_host": client.is_host,
            "client_id": client.id,
            "state": self.state.dump(),
        }
        await client.ws.send_text(json.dumps(init_msg, separators=(",", ":")))

    async def broadcast_state(self, reason: str) -> None:
        msg = {"type": "state", "reason": reason, "state": self.state.dump()}
        await self.broadcast(msg)

    def clients_snapshot(self) -> List[Dict[str, Any]]:
        # Provide a stable ordered list of clients with minimal info
        out: List[Dict[str, Any]] = []
        for cid in self.order:
            c = self.clients.get(cid)
            if not c:
                continue
            out.append({
                "id": c.id,
                "short": c.id[:6],
                "is_host": c.is_host,
                "ip": c.peer_host,
                "name": c.name,
            })
        return out

    async def broadcast_clients(self) -> None:
        await self.broadcast({"type": "clients", "clients": self.clients_snapshot()})


class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {"default": Room("default")}
        self.heartbeat_task: Optional[asyncio.Task] = None
        self.stopping = asyncio.Event()

    def get_room(self, name: str) -> Room:
        if not name or name.strip() == "":
            name = "default"
        # Hook for future multi-room: simple in-memory dict.
        room = self.rooms.get(name)
        if room is None:
            room = Room(name)
            self.rooms[name] = room
        return room

    async def start(self):
        if self.heartbeat_task is None:
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self):
        self.stopping.set()
        if self.heartbeat_task:
            await self.heartbeat_task

    async def _heartbeat_loop(self):
        # Ping clients every 5s, drop stale (>20s)
        while not self.stopping.is_set():
            t0 = now_ms()
            to_drop: List[tuple[Room, str]] = []
            for room in list(self.rooms.values()):
                for cid, c in list(room.clients.items()):
                    try:
                        await c.ws.send_text(json.dumps({"type": "ping", "t0": t0}))
                    except Exception:
                        to_drop.append((room, cid))
                        continue
                    if t0 - c.last_pong_ms > 20000:
                        to_drop.append((room, cid))
            for room, cid in to_drop:
                await room.remove_client(cid)
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass


manager = RoomManager()
app = FastAPI(title="Music Sync Server", version="1.0.0")

# Permissive CORS for development; restrict in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files: frontend under /static, optional media under /media
app.mount("/static", StaticFiles(directory="frontend"), name="static")
app.mount("/media", StaticFiles(directory="backend/media"), name="media")


@app.on_event("startup")
async def on_startup():
    await manager.start()


@app.on_event("shutdown")
async def on_shutdown():
    await manager.stop()


@app.get("/")
async def index():
    # Serve the minimal frontend
    return FileResponse("frontend/index.html")

@app.get("/host")
async def host_page():
    # Full host UI with controls
    return FileResponse("frontend/host.html")


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    # Optional room query (?room=name) for future multi-room support
    room_name = websocket.query_params.get("room", "default")
    await websocket.accept()
    room = manager.get_room(room_name)

    client = await room.add_client(websocket)
    # If client indicates force host via query (?force_host=1 or role=host), assign now
    force_host = websocket.query_params.get("force_host")
    role = websocket.query_params.get("role")
    if (force_host and force_host != "0") or (role and role.lower() == "host"):
        async with room.lock:
            if room.host_id and room.host_id in room.clients:
                room.clients[room.host_id].is_host = False
            room.host_id = client.id
            client.is_host = True
        try:
            await room.broadcast_state("host_transfer")
        except Exception:
            pass
        try:
            await room.broadcast_clients()
        except Exception:
            pass
    try:
        # Immediately init (late-join catch-up)
        await room.send_init(client)
        # Send updated clients list to everyone
        await room.broadcast_clients()

        # Main receive loop
        while True:
            data_str = await websocket.receive_text()
            if len(data_str) > 4096:
                await websocket.send_text(json.dumps({"type": "error", "code": "too_large", "message": "message too large"}))
                continue

            try:
                data = json.loads(data_str)
                msg_type = data.get("type")
            except Exception:
                await websocket.send_text(json.dumps({"type": "error", "code": "bad_json", "message": "unable to parse json"}))
                continue

            if msg_type == "hello":
                try:
                    hello = HelloMsg.model_validate(data)
                except ValidationError as e:
                    await websocket.send_text(json.dumps({"type": "error", "code": "bad_hello", "message": str(e)}))
                    continue

                # If no host and client wants host, assign
                if hello.want_host:
                    async with room.lock:
                        if room.host_id is None:
                            client.is_host = True
                            room.host_id = client.id
                            # Notify this client they are host via a fresh init
                            await room.send_init(client)
                            # Update clients list
                            await room.broadcast_clients()
                # Update name if provided
                if hello.name:
                    client.name = hello.name
                    await room.broadcast_clients()

            elif msg_type == "pong":
                try:
                    pong = PongMsg.model_validate(data)
                except ValidationError:
                    # Ignore malformed pongs
                    continue
                client.last_pong_ms = now_ms()

            elif msg_type == "control":
                # Validate and rate-limit:
                try:
                    ctrl = ControlMsg.model_validate(data)
                except ValidationError as e:
                    await websocket.send_text(json.dumps({"type": "error", "code": "bad_control", "message": str(e)}))
                    continue

                if not client.is_host:
                    await websocket.send_text(json.dumps({"type": "error", "code": "not_host", "message": "only host may control playback"}))
                    continue

                if not client.rate.consume(1.0):
                    await websocket.send_text(json.dumps({"type": "error", "code": "rate_limited", "message": "too many requests"}))
                    continue

                reason = ctrl.action
                # Apply action on authoritative state:
                if ctrl.action == "play":
                    # Unpause: set start_epoch_ms so that now corresponds to current position
                    room.state.paused = False
                    # Ensure start_epoch reflects current position offset
                    room.state.start_epoch_ms = now_ms() - int(room.state.position_sec * 1000.0)

                elif ctrl.action == "pause":
                    # Freeze position at this instant
                    room.state.position_sec = room._current_position()
                    room.state.paused = True

                elif ctrl.action == "seek":
                    if ctrl.position_sec is None or ctrl.position_sec < 0:
                        await websocket.send_text(json.dumps({"type": "error", "code": "bad_seek", "message": "position_sec required and >= 0"}))
                        continue
                    room.state.position_sec = float(ctrl.position_sec)
                    if room.state.paused:
                        # Keep paused; start time not used when paused
                        pass
                    else:
                        # Adjust start so desired position == ctrl.position_sec at now
                        room.state.start_epoch_ms = now_ms() - int(room.state.position_sec * 1000.0)

                elif ctrl.action == "set_track":
                    if not ctrl.track_url:
                        await websocket.send_text(json.dumps({"type": "error", "code": "bad_track", "message": "track_url required"}))
                        continue
                    room.state.track_url = ctrl.track_url
                    room.state.position_sec = 0.0
                    room.state.paused = True
                    room.state.start_epoch_ms = now_ms()  # not used when paused
                    # Optionally accept playback_rate from host (clamped)
                    if ctrl.playback_rate is not None:
                        pr = max(0.5, min(2.0, float(ctrl.playback_rate)))
                        room.state.playback_rate = pr

                elif ctrl.action == "set_volume":
                    if ctrl.volume is None:
                        await websocket.send_text(json.dumps({"type": "error", "code": "bad_volume", "message": "volume required"}))
                        continue
                    room.state.volume = float(ctrl.volume)

                # Broadcast updated state to all
                await room.broadcast_state(reason)

            else:
                await websocket.send_text(json.dumps({"type": "error", "code": "unknown_type", "message": f"unknown type {msg_type}"}))

    except WebSocketDisconnect:
        pass
    except Exception:
        # Best-effort error response; connection might be gone
        try:
            await websocket.send_text(json.dumps({"type": "error", "code": "server_error", "message": "unexpected server error"}))
        except Exception:
            pass
    finally:
        # Clean up and host reassignment if needed
        new_host_id = await room.remove_client(client.id)
        if new_host_id:
            # Inform new host with fresh init and broadcast host_transfer
            new_host = room.clients.get(new_host_id)
            if new_host:
                try:
                    await room.send_init(new_host)
                except Exception:
                    pass
            try:
                await room.broadcast_state("host_transfer")
            except Exception:
                pass
        # Broadcast updated clients after any disconnect
        try:
            await room.broadcast_clients()
        except Exception:
            pass
