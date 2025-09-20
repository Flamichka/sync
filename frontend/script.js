// Minimal, deterministic state machine with precise sync.
// Notes:
// - Server is authoritative. We reconcile to server timeline.
// - We estimate server clock via ping offset: offset ~= t0 + rtt/2 - now.
// - Drift correction: seek if >150ms, nudge 0.95..1.05 if 30..150ms.

(() => {
  const qs = new URLSearchParams(window.location.search);
  const room = qs.get("room") || "default";

  const audio = document.getElementById("audio");
  const roleBadge = document.getElementById("roleBadge");
  const trackUrlInput = document.getElementById("trackUrl");
  const setTrackBtn = document.getElementById("setTrackBtn");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const seekRange = document.getElementById("seekRange");
  const volumeRange = document.getElementById("volumeRange");
  const wantHostCheckbox = document.getElementById("wantHost");
  const latencyMsEl = document.getElementById("latencyMs");
  const driftMsEl = document.getElementById("driftMs");
  const trackNameEl = document.getElementById("trackName");
  const statusText = document.getElementById("statusText");

  let ws = null;
  let reconnectAttempts = 0;
  let shouldReconnect = true;

  let isHost = false;
  let clockOffsetMs = 0; // server_time ~= Date.now() + offset
  let lastPingRTT = null;

  // Authoritative state snapshot from server
  let state = {
    track_url: "",
    paused: true,
    position_sec: 0,
    start_epoch_ms: 0,
    playback_rate: 1.0,
    volume: 1.0
  };

  let buffering = false;
  let userSeeking = false; // while dragging slider; don't fight UI

  function wsURL() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`;
  }

  function connectWS() {
    statusText.textContent = "connecting...";
    ws = new WebSocket(wsURL());
    ws.onopen = () => {
      statusText.textContent = "connected";
      reconnectAttempts = 0;
      // Say hello, optionally request host role
      sendJSON({ type: "hello", want_host: !!wantHostCheckbox.checked });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      } catch (e) {
        console.warn("bad message", e);
      }
    };
    ws.onclose = () => {
      statusText.textContent = "disconnected";
      ws = null;
      isHost = false;
      updateRoleUI();
      if (!shouldReconnect) return;
      const delay = Math.min(5000, 500 * Math.pow(2, reconnectAttempts++));
      setTimeout(connectWS, delay);
    };
    ws.onerror = () => {
      // Will close soon; rely on onclose to schedule reconnect
    };
  }

  function sendJSON(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        console.warn("send failed", e);
      }
    }
  }

  function handleMessage(msg) {
    if (msg.type === "init") {
      isHost = !!msg.is_host;
      updateRoleUI();
      applyState(msg.state);
      // On init, ensure local audio reflects volume & source
      ensureAudioSource(msg.state.track_url);
      applyVolume(msg.state.volume);
      // Try to align immediately; if playing, attempt play()
      resyncNow();
      if (!state.paused) tryPlay();
    } else if (msg.type === "state") {
      applyState(msg.state);
      ensureAudioSource(msg.state.track_url);
      applyVolume(msg.state.volume);
      // On state changes, resync
      resyncNow();
      if (!state.paused) tryPlay();
      if (msg.reason === "host_transfer") {
        // Server reassigned host; request fresh hello (checkbox may grant us host)
        sendJSON({ type: "hello", want_host: !!wantHostCheckbox.checked });
      }
    } else if (msg.type === "ping") {
      const now = Date.now();
      const rtt = now - msg.t0;
      lastPingRTT = rtt;
      latencyMsEl.textContent = rtt.toFixed(0);
      // Estimate server clock offset ~= t0 + rtt/2 - now
      clockOffsetMs = msg.t0 + rtt / 2 - now;
      // Respond
      sendJSON({ type: "pong", t0: msg.t0 });
    } else if (msg.type === "error") {
      console.warn("server error:", msg.code, msg.message);
    }
  }

  function updateRoleUI() {
    roleBadge.textContent = isHost ? "Host" : "Listener";
    roleBadge.className = "badge " + (isHost ? "host" : "listener");
    // Enable controls only for host
    playPauseBtn.disabled = !isHost;
    setTrackBtn.disabled = !isHost;
    trackUrlInput.disabled = !isHost;
    seekRange.disabled = !isHost;
    volumeRange.disabled = !isHost; // host controls shared volume
  }

  function applyState(s) {
    state = s;
    // Update button text
    playPauseBtn.textContent = state.paused ? "Play" : "Pause";
    // Update track label
    trackNameEl.textContent = state.track_url ? state.track_url.split("/").pop() : "none";
    // Update seek range max using duration if known
    if (!isNaN(audio.duration) && isFinite(audio.duration) && audio.duration > 0) {
      seekRange.max = String(audio.duration);
    }
  }

  function ensureAudioSource(url) {
    if (audio.src !== url) {
      audio.src = url || "";
      // Reset on track change
      audio.currentTime = 0;
      // Load metadata to enable seeking/length
      if (url) audio.load();
    }
    if (trackUrlInput.value !== url) {
      trackUrlInput.value = url || "";
    }
  }

  function applyVolume(v) {
    audio.volume = typeof v === "number" ? Math.max(0, Math.min(1, v)) : 1.0;
    if (Number(volumeRange.value) !== audio.volume) {
      volumeRange.value = String(audio.volume);
    }
  }

  function desiredPositionSec() {
    // Use estimated server clock to compute desired playback head.
    const serverNow = Date.now() + clockOffsetMs;
    const elapsed = Math.max(0, (serverNow - state.start_epoch_ms) / 1000);
    return state.paused ? state.position_sec : elapsed;
  }

  function resyncNow() {
    if (!audio.src) return;
    const desired = Math.max(0, desiredPositionSec());
    if (isNaN(audio.currentTime)) return;

    const driftSec = desired - audio.currentTime;
    const driftMs = driftSec * 1000;
    driftMsEl.textContent = driftMs.toFixed(0);

    // If paused, hold at desired and keep rate=1
    if (state.paused) {
      audio.playbackRate = 1.0;
      if (Math.abs(driftMs) > 50) {
        audio.currentTime = desired;
      }
      return;
    }

    // If buffering, don't fight currentTime; we'll sync on canplay/playing
    if (buffering) {
      audio.playbackRate = 1.0;
      return;
    }

    // Apply correction:
    const absDrift = Math.abs(driftSec);
    if (absDrift > 0.150) {
      // Hard seek for large drift
      audio.currentTime = desired;
      audio.playbackRate = 1.0;
    } else if (absDrift >= 0.030) {
      // Gentle nudging: map drift to small rate offset within ±0.05
      const sign = driftSec > 0 ? 1 : -1;
      const rateAdj = Math.min(0.05, absDrift / 0.30);
      const targetRate = 1.0 + sign * rateAdj;
      audio.playbackRate = clamp(targetRate, 0.95, 1.05);
    } else {
      audio.playbackRate = 1.0;
    }
  }

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  function tryPlay() {
    if (!audio.src) return;
    if (state.paused) return;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Likely autoplay blocked; user must interact
        statusText.textContent = "tap Play to start";
      });
    }
  }

  // UI events (host-only actions)
  setTrackBtn.addEventListener("click", () => {
    if (!isHost) return;
    const url = trackUrlInput.value.trim();
    if (!url) return;
    sendJSON({ type: "control", action: "set_track", track_url: url, playback_rate: 1.0 });
  });

  playPauseBtn.addEventListener("click", () => {
    if (!isHost) return;
    if (!state.track_url) return;
    if (state.paused) {
      sendJSON({ type: "control", action: "play" });
    } else {
      sendJSON({ type: "control", action: "pause" });
    }
  });

  let seekDragTimer = null;

  seekRange.addEventListener("input", () => {
    userSeeking = true;
    // Reflect slider movement locally for UX
    const v = Number(seekRange.value);
    if (!isNaN(v)) audio.currentTime = v;
    if (seekDragTimer) clearTimeout(seekDragTimer);
    seekDragTimer = setTimeout(() => (userSeeking = false), 200);
  });

  seekRange.addEventListener("change", () => {
    if (!isHost) return;
    const pos = Number(seekRange.value);
    if (!isNaN(pos) && pos >= 0) {
      sendJSON({ type: "control", action: "seek", position_sec: pos });
    }
  });

  volumeRange.addEventListener("input", () => {
    const v = Number(volumeRange.value);
    applyVolume(v);
    if (isHost) {
      sendJSON({ type: "control", action: "set_volume", volume: clamp(v, 0, 1) });
    }
  });

  wantHostCheckbox.addEventListener("change", () => {
    // If host role is open, server may grant it
    sendJSON({ type: "hello", want_host: !!wantHostCheckbox.checked });
  });

  // Audio element events for buffering awareness and metadata
  audio.addEventListener("waiting", () => {
    buffering = true;
  });
  audio.addEventListener("canplay", () => {
    buffering = false;
    resyncNow();
  });
  audio.addEventListener("playing", () => {
    buffering = false;
    resyncNow();
  });
  audio.addEventListener("loadedmetadata", () => {
    // Update seek max to track duration
    if (!isNaN(audio.duration) && isFinite(audio.duration) && audio.duration > 0) {
      seekRange.max = String(audio.duration);
    }
    resyncNow();
  });
  audio.addEventListener("timeupdate", () => {
    // Reflect current time on slider if not dragging
    if (!userSeeking && isFinite(audio.currentTime)) {
      seekRange.value = String(audio.currentTime);
    }
  });

  // Animation loop for continual drift correction and UI updates
  function tick() {
    // Only correct if we have a source and not in user seek drag
    if (audio.src && !userSeeking) {
      resyncNow();
    }
    // Keep reflecting current time
    if (!userSeeking && isFinite(audio.currentTime)) {
      seekRange.value = String(audio.currentTime);
    }
    requestAnimationFrame(tick);
  }

  // Start
  connectWS();
  requestAnimationFrame(tick);
})();

