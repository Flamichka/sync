# Music Sync (FastAPI + WebSocket)

Minimal, production-ready synchronized audio playback across clients. One host controls play/pause/seek/track; the server broadcasts authoritative state; clients align their audio precisely with drift correction.

## Setup

- Requirements: Python ≥ 3.10
- Create and activate a virtual environment (examples):
  - Windows (PowerShell): `python -m venv .venv; .\\.venv\\Scripts\\Activate.ps1`
  - macOS/Linux: `python -m venv .venv && source .venv/bin/activate`
- Install dependencies: `pip install -r requirements.txt`

## Run

- Start the server (from the project root):
  - Dev: `uvicorn backend.app:app --reload`
  - Prod-ish: `uvicorn backend.app:app --host 0.0.0.0 --port 8000`
- Open http://localhost:8000

## Using it

- Open the URL on multiple devices (same LAN or public URL if deployed).
- The first connection is the host. Others are listeners.
- As host:
  - Enter a track URL (e.g. `https://.../song.mp3` or same-origin `/media/song.mp3`) and click "Set Track".
  - Press Play/Pause; drag Seek; adjust Volume (shared).
- Listeners can check "I am the host" to request host if none exists; the server assigns host on first arrival or when current host disconnects.

## Audio sourcing

- Use URLs you are allowed to share. Supported: `.mp3`, `.ogg`, `.wav`.
- Same-origin files: place under `backend/media` and access via `/media/yourfile.mp3`.
- Cross-origin URLs must allow CORS and proper `Content-Type`. Over HTTPS pages, audio must also be HTTPS (no mixed content).

## How it works

- Server stores room state (track URL, paused/playing, position, start epoch, volume).
- On play: sets `start_epoch_ms = Date.now() - position*1000` and broadcasts.
- Clients calculate desired position from server time and correct drift:
  - Seek if |drift| > 150ms.
  - Nudge playbackRate within 0.95–1.05 if 30–150ms.
- Heartbeats every 5s measure RTT and estimate server clock offset.
- Late joiners receive an immediate init snapshot.

## Troubleshooting

- WebSocket blocked by firewall: allow TCP port 8000 on host machine.
- Mixed content: if site is HTTPS, audio must be HTTPS too.
- CORS: dev is permissive (`*`). Lock down in production.
- MIME types: ensure server/media host returns correct `Content-Type` (e.g., `audio/mpeg` for mp3).
- Autoplay restrictions: browsers may require user interaction to begin playback; click Play if prompted.
- If drift stays high: check network stability and ensure the audio asset is seekable (supports range requests).

## Security notes

- Basic input validation restricts track URLs to allowed extensions and reasonable length.
- Messages are size-limited and control messages are rate-limited per client.
- No open relay: only the host can issue state-changing controls; others are ignored.

## Deploy

- Behind a reverse proxy (Caddy/Nginx) with HTTPS + WSS.
- Uvicorn workers via process manager (systemd, Supervisor, Docker).
