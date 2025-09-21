(function () {
  "use strict";

  var elements = {
    title: document.getElementById("video-title"),
    elapsed: document.getElementById("elapsed"),
    duration: document.getElementById("duration"),
    progress: document.getElementById("progress"),
    volume: document.getElementById("volume-slider"),
    syncStatus: document.getElementById("sync-status"),
    toast: document.getElementById("error-toast"),
    resume: document.getElementById("resume-playback")
  };

  var PRIMARY_WS_URL = window.APP_CONFIG && window.APP_CONFIG.wsEndpoint ? window.APP_CONFIG.wsEndpoint : null;
  var FALLBACK_WS_URL = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws";
  var DEFAULT_VIDEO_ID = "dQw4w9WgXcQ";

  var clientState = {
    socket: null,
    listenerId: null,
    player: null,
    playerReady: false,
    pendingState: null,
    targetState: null,
    currentVideoId: null,
    lastSyncedAt: new Date().getTime(),
    userAdjustedVolume: false,
    metricsInterval: null,
    progressInterval: null,
    usingFallback: false,
    reconnectDelay: 2000,
    awaitingGesture: false,
    toastTimer: null,
    activeAlert: false
  };

  function setResumeVisibility(visible) {
    if (!elements.resume) {
      return;
    }
    if (typeof elements.resume.hidden !== "undefined") {
      elements.resume.hidden = !visible;
    } else {
      elements.resume.style.display = visible ? "inline-block" : "none";
    }
  }

  function showToast(message, timeout, type) {
    if (!elements.toast) {
      return;
    }
    if (clientState.toastTimer) {
      clearTimeout(clientState.toastTimer);
      clientState.toastTimer = null;
    }
    elements.toast.textContent = message;
    if (elements.toast.classList) {
      if (type === "alert") {
        elements.toast.classList.add("alert");
      } else {
        elements.toast.classList.remove("alert");
      }
    }
    elements.toast.style.display = "block";
    clientState.activeAlert = type === "alert";
    if (timeout > 0) {
      clientState.toastTimer = setTimeout(function () {
        hideToast();
      }, timeout);
    }
  }

  function showAlert(message) {
    showToast(message, 0, "alert");
  }

  function hideToast() {
    if (!elements.toast) {
      return;
    }
    if (clientState.toastTimer) {
      clearTimeout(clientState.toastTimer);
      clientState.toastTimer = null;
    }
    elements.toast.style.display = "none";
    if (elements.toast.classList) {
      elements.toast.classList.remove("alert");
    }
    clientState.activeAlert = false;
  }

  function updateSyncStatus(text, accent) {
    if (!elements.syncStatus) {
      return;
    }
    elements.syncStatus.textContent = text;
    elements.syncStatus.style.backgroundColor = accent ? hexWithAlpha(accent, 0.2) : "transparent";
    elements.syncStatus.style.color = accent || "inherit";
  }

  function hexWithAlpha(hex, alpha) {
    if (!hex || hex.charAt(0) !== "#") {
      return "rgba(0,0,0," + alpha + ")";
    }
    var bigint = parseInt(hex.slice(1), 16);
    var r = bigint >> 16 & 255;
    var g = bigint >> 8 & 255;
    var b = bigint & 255;
    return "rgba(" + r + "," + g + "," + b + ", " + alpha + ")";
  }

  function formatTime(seconds) {
    if (!seconds || seconds < 0 || !isFinite(seconds)) {
      seconds = 0;
    }
    var total = Math.floor(seconds);
    var hrs = Math.floor(total / 3600);
    var mins = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (hrs > 0) {
      return hrs + ":" + pad(mins) + ":" + pad(secs);
    }
    return mins + ":" + pad(secs);
  }

  function pad(value) {
    return value < 10 ? "0" + value : "" + value;
  }

  function scheduleIntervals() {
    if (!clientState.metricsInterval) {
      clientState.metricsInterval = setInterval(reportMetrics, 2500);
    }
    if (!clientState.progressInterval) {
      clientState.progressInterval = setInterval(updateProgress, 250);
    }
  }

  function enforcePermissions() {
    var player = clientState.player;
    var target = clientState.targetState;
    if (!player || !target) {
      return;
    }
    var shouldPlay = !!target.is_playing;
    var stateValue = typeof player.getPlayerState === "function" ? player.getPlayerState() : null;
    var isPlaying = stateValue === YT.PlayerState.PLAYING;
    if (shouldPlay && !isPlaying) {
      showAlert('Autoplay blocked. Tap "Tap to enable audio" to start playback.');
      clientState.awaitingGesture = true;
      setResumeVisibility(true);
    } else if (clientState.activeAlert && isPlaying) {
      hideToast();
      setResumeVisibility(false);
      clientState.awaitingGesture = false;
    }
  }

  function connectWebSocket(forceFallback) {
    var useFallback = !!forceFallback;
    var url = useFallback ? FALLBACK_WS_URL : PRIMARY_WS_URL;
    if (!url) {
      showToast("WebSocket endpoint missing.", 4000, "info");
      return;
    }
    try {
      var socket = new WebSocket(url);
      clientState.socket = socket;
      clientState.usingFallback = useFallback;

      socket.addEventListener("open", function () {
        clientState.reconnectDelay = 2000;
        updateSyncStatus(useFallback ? "Connected (compat)" : "Connected", "#4ade80");
      });

      socket.addEventListener("message", onSocketMessage);

      socket.addEventListener("close", function () {
        updateSyncStatus("Disconnected", "#f87171");
        var nextDelay = Math.min(clientState.reconnectDelay * 1.5, 8000);
        clientState.reconnectDelay = nextDelay;
        if (!useFallback && PRIMARY_WS_URL && PRIMARY_WS_URL !== FALLBACK_WS_URL) {
          setTimeout(function () { connectWebSocket(true); }, 500);
        } else {
          setTimeout(function () { connectWebSocket(useFallback); }, clientState.reconnectDelay);
        }
      });

      socket.addEventListener("error", function () {
        showToast("Connection issue detected. Retrying…", 3000, "info");
      });
    } catch (error) {
      if (!useFallback) {
        setTimeout(function () { connectWebSocket(true); }, 500);
      }
    }
  }

  function onSocketMessage(event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    switch (message.type) {
      case "hello": {
        var helloPayload = message.payload || {};
        clientState.listenerId = helloPayload.listener_id;
        scheduleIntervals();
        break;
      }
      case "sync_state":
        applySyncState(message.payload);
        break;
      default:
        break;
    }
  }

  function applySyncState(payload) {
    if (!payload) {
      return;
    }
    clientState.targetState = payload;
    clientState.lastSyncedAt = new Date().getTime();
    if (elements.title) {
      elements.title.textContent = payload.video_title || "Untitled Stream";
    }
    if (!clientState.userAdjustedVolume && typeof payload.host_volume === "number") {
      var volumeValue = Math.min(100, Math.max(0, Number(payload.host_volume)));
      if (elements.volume) {
        elements.volume.value = volumeValue;
      }
      if (clientState.playerReady) {
        setPlayerVolume(volumeValue);
      }
    }
    if (!clientState.playerReady) {
      clientState.pendingState = payload;
      return;
    }
    syncPlayer(payload);
    enforcePermissions();
  }

  function setPlayerVolume(value) {
    if (clientState.player && typeof clientState.player.setVolume === "function") {
      clientState.player.setVolume(value);
    }
  }

  function syncPlayer(payload) {
    var player = clientState.player;
    if (!player) {
      return;
    }
    var targetId = payload.video_id;
    var targetPosition = Number(payload.position || 0);
    var shouldPlay = !!payload.is_playing;

    if (targetId && targetId !== clientState.currentVideoId) {
      clientState.currentVideoId = targetId;
      if (shouldPlay) {
        player.loadVideoById({ videoId: targetId, startSeconds: targetPosition });
      } else {
        player.cueVideoById({ videoId: targetId, startSeconds: targetPosition });
      }
    } else {
      var currentTime = player.getCurrentTime ? player.getCurrentTime() : 0;
      if (isFinite(currentTime) && Math.abs(currentTime - targetPosition) > 0.6 && typeof player.seekTo === "function") {
        player.seekTo(targetPosition, true);
      }
      var playerState = player.getPlayerState ? player.getPlayerState() : null;
      if (shouldPlay && playerState !== YT.PlayerState.PLAYING) {
        attemptPlayback();
      }
      if (!shouldPlay && playerState === YT.PlayerState.PLAYING && typeof player.pauseVideo === "function") {
        player.pauseVideo();
      }
    }

    if (typeof payload.host_volume === "number" && !clientState.userAdjustedVolume) {
      setPlayerVolume(Math.min(100, Math.max(0, payload.host_volume)));
    }
  }

  function updateProgress() {
    var player = clientState.player;
    var state = clientState.targetState;
    if (!player || !state) {
      return;
    }
    var duration = player.getDuration ? player.getDuration() : Number(state.duration) || 0;
    var currentTime = player.getCurrentTime ? player.getCurrentTime() : Number(state.position) || 0;
    if (!isFinite(currentTime)) {
      currentTime = Number(state.position) || 0;
    }
    if (elements.progress) {
      if (duration > 0) {
        elements.progress.max = duration;
        elements.progress.value = Math.max(0, Math.min(duration, currentTime));
      } else {
        elements.progress.max = 1;
        elements.progress.value = 0;
      }
    }
    if (elements.elapsed) {
      elements.elapsed.textContent = formatTime(currentTime);
    }
    if (elements.duration) {
      elements.duration.textContent = duration ? formatTime(duration) : "0:00";
    }
    var diff = Math.abs(currentTime - Number(state.position || 0));
    if (diff < 0.45) {
      updateSyncStatus(clientState.usingFallback ? "In sync (compat)" : "In sync", "#4ade80");
    } else {
      updateSyncStatus("Syncing…", "#facc15");
    }
  }

  function reportMetrics() {
    var socket = clientState.socket;
    var player = clientState.player;
    var target = clientState.targetState;
    if (!socket || socket.readyState !== 1 || !player || !target) {
      return;
    }
    var currentTime = player.getCurrentTime ? player.getCurrentTime() : 0;
    var duration = player.getDuration ? player.getDuration() : Number(target.duration) || 0;
    var bufferFraction = typeof player.getVideoLoadedFraction === "function" ? player.getVideoLoadedFraction() : 0;
    var bufferSeconds = isFinite(duration) ? Math.max(0, bufferFraction * duration - currentTime) : null;
    var latencyMs = Math.round(Math.abs(currentTime - Number(target.position || 0)) * 1000);
    var volume = player.getVolume ? player.getVolume() : null;
    var bitrate = null;
    if (duration > 0 && bufferSeconds !== null) {
      bitrate = Number(((bufferFraction * duration) / Math.max(duration, 1)) * 128);
    }
    var qualityLabel = typeof player.getPlaybackQuality === "function" ? player.getPlaybackQuality() : null;

    var payload = {
      volume: volume,
      latency_ms: latencyMs,
      bitrate_kbps: bitrate,
      buffer_seconds: bufferSeconds,
      player_time: currentTime,
      player_state: mapPlayerState(player.getPlayerState ? player.getPlayerState() : null),
      quality_label: qualityLabel
    };
    try {
      socket.send(JSON.stringify({ type: "client_status", payload: payload }));
    } catch (error) {
      // ignore
    }
  }

  function mapPlayerState(value) {
    switch (value) {
      case YT.PlayerState.BUFFERING:
        return "buffering";
      case YT.PlayerState.CUED:
        return "cued";
      case YT.PlayerState.PAUSED:
        return "paused";
      case YT.PlayerState.PLAYING:
        return "playing";
      case YT.PlayerState.ENDED:
        return "ended";
      default:
        return "unstarted";
    }
  }

  function attemptPlayback() {
    if (!clientState.playerReady) {
      return;
    }
    try {
      if (clientState.player && typeof clientState.player.unMute === "function") {
        clientState.player.unMute();
      }
      if (clientState.player && typeof clientState.player.playVideo === "function") {
        clientState.player.playVideo();
      }
    } catch (error) {
      requestUserGesture();
      return;
    }
    setTimeout(function () {
      var stateValue = clientState.player && typeof clientState.player.getPlayerState === "function" ? clientState.player.getPlayerState() : null;
      if (stateValue !== YT.PlayerState.PLAYING) {
        requestUserGesture();
      } else {
        hideResumePrompt();
      }
    }, 400);
  }

  function requestUserGesture() {
    clientState.awaitingGesture = true;
    setResumeVisibility(true);
    updateSyncStatus("Awaiting tap to start audio", "#facc15");
    showAlert('Autoplay blocked. Tap "Tap to enable audio" to start playback.');
  }

  function hideResumePrompt() {
    clientState.awaitingGesture = false;
    setResumeVisibility(false);
    if (clientState.usingFallback) {
      updateSyncStatus("In sync (compat)", "#4ade80");
    }
  }

  function ensurePlayer() {
    if (clientState.player) {
      return;
    }
    clientState.player = new YT.Player("player", {
      height: "0",
      width: "0",
      videoId: clientState.targetState && clientState.targetState.video_id ? clientState.targetState.video_id : DEFAULT_VIDEO_ID,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        playsinline: 1
      },
      events: {
        onReady: function () {
          clientState.playerReady = true;
          if (elements.volume) {
            setPlayerVolume(Number(elements.volume.value));
          }
          if (clientState.pendingState) {
            syncPlayer(clientState.pendingState);
            clientState.pendingState = null;
          }
          scheduleIntervals();
          enforcePermissions();
        },
        onStateChange: function () {
          updateProgress();
          enforcePermissions();
          if (clientState.targetState && clientState.targetState.is_playing) {
            attemptPlayback();
          }
        },
        onError: function (event) {
          showToast("Player error: " + event.data, 4000, "alert");
        }
      }
    });
  }

  window.onYouTubeIframeAPIReady = function () {
    ensurePlayer();
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (elements.volume) {
      elements.volume.addEventListener("input", function () {
        clientState.userAdjustedVolume = true;
        if (clientState.playerReady) {
          setPlayerVolume(Number(elements.volume.value));
        }
      });
    }
    if (elements.resume) {
      elements.resume.addEventListener("click", function () {
        if (clientState.player && typeof clientState.player.unMute === "function") {
          clientState.player.unMute();
        }
        attemptPlayback();
      });
    }
    document.addEventListener("pointerdown", function () {
      if (clientState.awaitingGesture) {
        attemptPlayback();
      }
    });
    window.addEventListener("focus", enforcePermissions);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        enforcePermissions();
      }
    });
    connectWebSocket(false);
  });
})();

