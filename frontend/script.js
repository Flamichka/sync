// Minimal, deterministic state machine with precise sync.
// Notes:
// - Server is authoritative. We reconcile to server timeline.
// - We estimate server clock via ping offset: offset ~= t0 + rtt/2 - now.
// - Drift correction: seek if >150ms, nudge 0.95..1.05 if 30..150ms.

(() => {
  const qs = new URLSearchParams(window.location.search);
  const room = qs.get("room") || "default";

  const audio = document.getElementById("audio");
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
  const hostUI = window.location.pathname === "/host";
  const clientsListEl = document.getElementById("clientsList");
  const clientsHeaderEl = document.querySelector(".clients h2");

  // Determine display name (query ?name= overrides; persist in localStorage)
  const queryName = qs.get("name");
  let displayName = (queryName || localStorage.getItem("displayName") || "").trim();
  if (!displayName) {
    displayName = `User-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("displayName", displayName);
  } else {
    localStorage.setItem("displayName", displayName);
  }

  let ws = null;
  let reconnectAttempts = 0;
  let shouldReconnect = true;

  let clockOffsetMs = 0; // server_time ~= Date.now() + offset
  let lastPingRTT = null;
  let myClientId = null;
  // Sync tuning (PI controller with slew limit). Designed to avoid audible artifacts.
  const CTRL = {
    TICK_MS: 200,            // control loop interval
    DEAD_BAND_MS: 25,        // ignore tiny drift within this band
    HARD_SEEK_LIMIT_MS: 1500,// only hard-seek if drift exceeds this (unless explicit seek)
    KP: 0.10,                // proportional gain (per second of drift)
    KI: 0.02,                // integral gain (per second accumulated)
    MAX_RATE_NUDGE: 0.015,   // +/- 1.5% max rate offset
    MAX_RATE_SLEW: 0.004     // limit change per tick (e.g., 0.4% per 200ms)
  };
  let driftInt = 0;            // integral of drift (leaky)
  let clockCalibrated = false; // set true after first ping
  let basePlaybackRate = 1.0;  // server-advised base rate
  let lastAppliedRate = 1.0;
  let lastStateReason = null;  // last server reason (play/pause/seek/...)

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
    const url = new URL(`${proto}//${location.host}/ws`);
    url.searchParams.set("room", room);
    if (hostUI) url.searchParams.set("force_host", "1");
    return url.toString();
  }

  function connectWS() {
    statusText.textContent = "connecting...";
    ws = new WebSocket(wsURL());
    ws.onopen = () => {
      statusText.textContent = "connected";
      reconnectAttempts = 0;
      // Say hello, optionally request host role
      sendJSON({ type: "hello", want_host: !!(wantHostCheckbox && wantHostCheckbox.checked), name: displayName });
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
      if (msg.client_id) myClientId = msg.client_id;
      applyState(msg.state);
      // On init, ensure local audio reflects volume & source
      ensureAudioSource(msg.state.track_url);
      applyVolume(msg.state.volume);
      // Align to exact time and start smoothly
      performJumpAlign("init");
      if (!state.paused) tryPlay();
    } else if (msg.type === "state") {
      lastStateReason = msg.reason || null;
      applyState(msg.state);
      ensureAudioSource(msg.state.track_url);
      applyVolume(msg.state.volume);
      // On state changes, align once for explicit seeks/track change/play
      if (lastStateReason === "seek" || lastStateReason === "set_track" || lastStateReason === "play") {
        performJumpAlign(lastStateReason);
      }
      if (!state.paused) tryPlay();
    } else if (msg.type === "clients") {
      renderClients(msg.clients || []);
    } else if (msg.type === "ping") {
      const now = Date.now();
      const rtt = now - msg.t0;
      lastPingRTT = rtt;
      latencyMsEl.textContent = rtt.toFixed(0);
      // Estimate server clock offset ~= t0 + rtt/2 - now
      clockOffsetMs = msg.t0 + rtt / 2 - now;
      clockCalibrated = true;
      // Respond
      sendJSON({ type: "pong", t0: msg.t0 });
    } else if (msg.type === "error") {
      console.warn("server error:", msg.code, msg.message);
    }
  }

  // Controls are enabled on /host, hidden on base page via CSS
  function setControlsEnabled() {
    const enabled = !!hostUI;
    playPauseBtn.disabled = !enabled;
    setTrackBtn.disabled = !enabled;
    trackUrlInput.disabled = !enabled;
    seekRange.disabled = !enabled;
    volumeRange.disabled = !enabled;
  }

  function applyState(s) {
    state = s;
    basePlaybackRate = typeof s.playback_rate === "number" ? s.playback_rate : 1.0;
    // Reset integrator modestly when state changes
    driftInt *= 0.5;
    lastAppliedRate = basePlaybackRate;
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
    // Display only; control logic runs in control loop
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

  // Smoothly apply playbackRate changes to avoid sudden jumps
  function setPlaybackRate(target) {
    // Limit rate to sane bounds even after base rate applied
    target = clamp(target, 0.5, 2.0);
    // Apply small smoothing: move 30% towards target per tick
    const smoothed = lastAppliedRate + (target - lastAppliedRate) * 0.3;
    if (Math.abs(smoothed - audio.playbackRate) > 0.001) {
      audio.playbackRate = smoothed;
    }
    lastAppliedRate = smoothed;
  }

  // Align once (used for init/explicit seek/play). Does not pause playback.
  function performJumpAlign(reason) {
    if (!audio.src) return;
    const desired = Math.max(0, desiredPositionSec());
    // For explicit seek/track/play reasons or large divergence, snap once
    const driftMs = (desired - (audio.currentTime || 0)) * 1000;
    const bigJump = Math.abs(driftMs) > CTRL.DEAD_BAND_MS;
    if (reason === "seek" || reason === "set_track" || reason === "play" || reason === "init" || Math.abs(driftMs) > CTRL.HARD_SEEK_LIMIT_MS) {
      if (bigJump) {
        audio.currentTime = desired;
      }
    }
  }

  // UI events (host-only actions)
  setTrackBtn.addEventListener("click", () => {
    if (!hostUI) return;
    const url = trackUrlInput.value.trim();
    if (!url) return;
    sendJSON({ type: "control", action: "set_track", track_url: url, playback_rate: 1.0 });
  });

  playPauseBtn.addEventListener("click", () => {
    if (!hostUI) return;
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
    if (!hostUI) return;
    const pos = Number(seekRange.value);
    if (!isNaN(pos) && pos >= 0) {
      sendJSON({ type: "control", action: "seek", position_sec: pos });
    }
  });

  volumeRange.addEventListener("input", () => {
    const v = Number(volumeRange.value);
    applyVolume(v);
    if (hostUI) {
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

  // Animation loop for UI updates (not control)
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
  setControlsEnabled();
  connectWS();
  requestAnimationFrame(tick);

  // Control loop: smooth PI controller with slew limit; avoids audible jumps.
  setInterval(() => {
    if (!audio.src || state.paused || buffering || !clockCalibrated) {
      setPlaybackRate(basePlaybackRate);
      return;
    }
    const desired = Math.max(0, desiredPositionSec());
    const drift = desired - audio.currentTime; // seconds
    const driftMs = drift * 1000;
    if (Math.abs(driftMs) > CTRL.HARD_SEEK_LIMIT_MS) {
      // Extremely large error: jump once but keep playing
      audio.currentTime = desired;
      setPlaybackRate(basePlaybackRate);
      // Reset integrator to avoid wind-up
      driftInt = 0;
      return;
    }
    // Dead-band: if close enough, converge rate back to base
    if (Math.abs(driftMs) <= CTRL.DEAD_BAND_MS) {
      driftInt *= 0.9; // decay integrator
      targetRateTowards(basePlaybackRate);
      return;
    }
    // PI controller
    driftInt = driftInt * 0.98 + drift * (CTRL.TICK_MS / 1000); // leaky integral
    let offset = CTRL.KP * drift + CTRL.KI * driftInt; // in rate (fraction)
    offset = clamp(offset, -CTRL.MAX_RATE_NUDGE, CTRL.MAX_RATE_NUDGE);
    const target = basePlaybackRate * (1 + offset);
    targetRateTowards(target);
  }, CTRL.TICK_MS);

  function targetRateTowards(target) {
    // Slew limit: cap change per tick for smoothness
    const delta = target - lastAppliedRate;
    const step = clamp(delta, -CTRL.MAX_RATE_SLEW, CTRL.MAX_RATE_SLEW);
    setPlaybackRate(lastAppliedRate + step);
  }

  function renderClients(list) {
    if (!clientsListEl || !hostUI) return;
    clientsListEl.innerHTML = "";
    for (const c of list) {
      const li = document.createElement("li");
      const label = c.name && String(c.name).trim() ? c.name : (c.short || (c.id ? String(c.id).slice(0, 6) : "client"));
      const ip = c.ip ? String(c.ip) : "";
      const parts = [label];
      if (ip) parts.push(ip);
      if (myClientId && c.id === myClientId) parts.push("You");
      if (c.is_host) parts.push("Host");
      li.textContent = parts.join(" · ");
      clientsListEl.appendChild(li);
    }
    if (clientsHeaderEl) {
      clientsHeaderEl.textContent = `Listeners (${list.length})`;
    }
  }
})();
