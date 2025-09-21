(function () {
  "use strict";

  var elements = {
    title: document.getElementById("host-video-title"),
    elapsed: document.getElementById("host-elapsed"),
    duration: document.getElementById("host-duration"),
    videoId: document.getElementById("video-id"),
    playbackStatus: document.getElementById("playback-status"),
    latency: document.getElementById("host-latency"),
    seekSlider: document.getElementById("seek-slider"),
    volumeSlider: document.getElementById("host-volume-slider"),
    videoInput: document.getElementById("video-url"),
    loadButton: document.getElementById("load-video"),
    playButton: document.getElementById("play-btn"),
    pauseButton: document.getElementById("pause-btn"),
    resyncButton: document.getElementById("resync-btn"),
    listenerBody: document.getElementById("listener-body"),
    toast: document.getElementById("error-toast"),
    wsStatus: document.getElementById("ws-status")
  };

  var PRIMARY_WS_URL = window.APP_CONFIG && window.APP_CONFIG.wsEndpoint ? window.APP_CONFIG.wsEndpoint : null;
  var FALLBACK_WS_URL = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws?role=host";
  var METADATA_URL = window.APP_CONFIG && window.APP_CONFIG.metadataEndpoint ? window.APP_CONFIG.metadataEndpoint : null;
  var DEFAULT_VIDEO_ID = "dQw4w9WgXcQ";
  var PROGRESS_SYNC_INTERVAL = 1000;

  var hostState = {
    socket: null,
    hostId: null,
    player: null,
    playerReady: false,
    currentVideoId: null,
    pendingState: null,
    remoteState: null,
    isSeeking: false,
    duration: 0,
    latencyInterval: null,
    progressInterval: null,
    pendingMetadata: {},
    lastSyncAt: 0,
    usingFallback: false,
    reconnectDelay: 2000,
    toastTimer: null,
    activeAlert: false
  };

  function showToast(message, timeout, type) {
    if (!elements.toast) {
      return;
    }
    if (hostState.toastTimer) {
      clearTimeout(hostState.toastTimer);
      hostState.toastTimer = null;
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
    hostState.activeAlert = type === "alert";
    if (timeout > 0) {
      hostState.toastTimer = setTimeout(function () {
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
    if (hostState.toastTimer) {
      clearTimeout(hostState.toastTimer);
      hostState.toastTimer = null;
    }
    elements.toast.style.display = "none";
    if (elements.toast.classList) {
      elements.toast.classList.remove("alert");
    }
    hostState.activeAlert = false;
  }

  function updateWsStatus(label, accent) {
    if (!elements.wsStatus) {
      return;
    }
    elements.wsStatus.textContent = label;
    elements.wsStatus.style.color = accent || "inherit";
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

  function enforcePermissions() {
    if (!hostState.player || typeof hostState.player.getPlayerState !== "function") {
      return;
    }
    var state = hostState.player.getPlayerState();
    if (state !== YT.PlayerState.PLAYING) {
      showAlert("Autoplay may be blocked. Press Play, then interact with the page if needed.");
    } else if (hostState.activeAlert) {
      hideToast();
    }
  }

  function connectWebSocket(forceFallback) {
    var useFallback = !!forceFallback;
    var url = useFallback ? FALLBACK_WS_URL : PRIMARY_WS_URL;
    if (!url) {
      showToast("Missing host WebSocket endpoint.", 3000, "alert");
      return;
    }
    updateWsStatus("Connecting…", "#facc15");
    try {
      var socket = new WebSocket(url);
      hostState.socket = socket;
      hostState.usingFallback = useFallback;

      socket.addEventListener("open", function () {
        hostState.reconnectDelay = 2000;
        updateWsStatus(useFallback ? "Connected (compat)" : "Connected", "#4ade80");
        if (!hostState.latencyInterval) {
          hostState.latencyInterval = setInterval(sendPing, 5000);
        }
      });

      socket.addEventListener("message", onSocketMessage);

      socket.addEventListener("close", function () {
        updateWsStatus("Disconnected", "#f87171");
        if (hostState.latencyInterval) {
          clearInterval(hostState.latencyInterval);
          hostState.latencyInterval = null;
        }
        var nextDelay = Math.min(hostState.reconnectDelay * 1.5, 8000);
        hostState.reconnectDelay = nextDelay;
        if (!useFallback && PRIMARY_WS_URL && PRIMARY_WS_URL !== FALLBACK_WS_URL) {
          setTimeout(function () { connectWebSocket(true); }, 500);
        } else {
          setTimeout(function () { connectWebSocket(useFallback); }, hostState.reconnectDelay);
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
        var payload = message.payload || {};
        hostState.hostId = payload.host_id;
        renderListenerTable(payload);
        applyRemoteState(payload.state || null);
        break;
      }
      case "sync_state":
        applyRemoteState(message.payload);
        break;
      case "listener_snapshot":
        renderListenerTable(message.payload);
        break;
      case "pong":
        handlePong(message.payload);
        break;
      default:
        break;
    }
  }

  function handlePong(payload) {
    if (!payload || typeof payload.sent_at === "undefined") {
      return;
    }
    var roundTrip = performance.now() - Number(payload.sent_at);
    elements.latency.textContent = Math.round(roundTrip) + " ms";
  }

  function applyRemoteState(state) {
    if (!state) {
      return;
    }
    hostState.remoteState = state;
    elements.title.textContent = state.video_title || "No video selected";
    elements.videoId.textContent = state.video_id || "-";
    elements.playbackStatus.textContent = state.is_playing ? "Playing" : "Paused";
    if (typeof state.duration === "number" && state.duration > 0) {
      hostState.duration = state.duration;
    }
    elements.duration.textContent = formatTime(hostState.duration);

    if (!hostState.playerReady) {
      hostState.pendingState = state;
      return;
    }

    var player = hostState.player;
    var targetId = state.video_id || DEFAULT_VIDEO_ID;
    var targetPosition = Number(state.position || 0);
    var shouldPlay = !!state.is_playing;

    if (targetId && targetId !== hostState.currentVideoId) {
      hostState.currentVideoId = targetId;
      if (elements.videoInput) {
        elements.videoInput.value = targetId;
      }
      cueVideo(targetId, targetPosition, shouldPlay);
    } else {
      var diff = Math.abs((player.getCurrentTime ? player.getCurrentTime() : 0) - targetPosition);
      if (diff > 0.45 && typeof player.seekTo === "function") {
        player.seekTo(targetPosition, true);
      }
      var stateValue = player.getPlayerState ? player.getPlayerState() : null;
      if (shouldPlay && stateValue !== YT.PlayerState.PLAYING && typeof player.playVideo === "function") {
        player.playVideo();
      }
      if (!shouldPlay && stateValue === YT.PlayerState.PLAYING && typeof player.pauseVideo === "function") {
        player.pauseVideo();
      }
    }

    if (!hostState.isSeeking) {
      updateSeekSlider(targetPosition);
    }

    if (typeof state.host_volume === "number") {
      var volumeValue = Math.max(0, Math.min(100, Number(state.host_volume)));
      if (elements.volumeSlider) {
        elements.volumeSlider.value = volumeValue;
      }
      if (typeof player.setVolume === "function") {
        player.setVolume(volumeValue);
      }
      if (typeof player.unMute === "function") {
        player.unMute();
      }
    }
  }

  function renderListenerTable(payload) {
    var listeners = payload && payload.listeners ? payload.listeners : [];
    if (!elements.listenerBody) {
      return;
    }
    if (!listeners.length) {
      elements.listenerBody.innerHTML = '<tr><td colspan="9">No listeners connected yet.</td></tr>';
      return;
    }
    var rows = [];
    for (var i = 0; i < listeners.length; i += 1) {
      var listener = listeners[i];
      var status = listener.player_state || "unknown";
      var latency = listener.latency_ms != null ? Math.round(listener.latency_ms) + " ms" : "—";
      var volume = listener.volume != null ? Math.round(listener.volume) + "%" : "—";
      var playerTime = listener.player_time != null ? formatTime(listener.player_time) : "—";
      var buffer = listener.buffer_seconds != null ? listener.buffer_seconds.toFixed(1) + " s" : "—";
      var quality = listener.quality_label || "—";
      var lastReport = listener.last_report ? new Date(listener.last_report).toLocaleTimeString() : "—";
      var ip = listener.ip || "—";
      rows.push('<tr>' +
        '<td>' + sanitize(listener.id) + '</td>' +
        '<td>' + sanitize(ip) + '</td>' +
        '<td>' + sanitize(status) + '</td>' +
        '<td>' + sanitize(playerTime) + '</td>' +
        '<td>' + sanitize(volume) + '</td>' +
        '<td>' + sanitize(latency) + '</td>' +
        '<td>' + sanitize(buffer) + '</td>' +
        '<td>' + sanitize(quality) + '</td>' +
        '<td>' + sanitize(lastReport) + '</td>' +
        '</tr>');
    }
    elements.listenerBody.innerHTML = rows.join("\n");
  }

  function sanitize(value) {
    if (value == null) {
      return "";
    }
    return String(value).replace(/[&<>\"]/g, function (ch) {
      var map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
      return map[ch] || ch;
    });
  }

  function ensurePlayer() {
    if (hostState.player) {
      return;
    }
    hostState.player = new YT.Player("host-player", {
      height: "0",
      width: "0",
      videoId: hostState.remoteState && hostState.remoteState.video_id ? hostState.remoteState.video_id : DEFAULT_VIDEO_ID,
      playerVars: { autoplay: 0, controls: 0, playsinline: 1 },
      events: {
        onReady: function () {
          hostState.playerReady = true;
          if (elements.volumeSlider && typeof hostState.player.setVolume === "function") {
            hostState.player.setVolume(Number(elements.volumeSlider.value));
          }
          if (typeof hostState.player.unMute === "function") {
            hostState.player.unMute();
          }
          hostState.progressInterval = setInterval(updateProgress, 250);
          if (hostState.pendingState) {
            var pending = hostState.pendingState;
            hostState.pendingState = null;
            applyRemoteState(pending);
          }
        },
        onStateChange: function () {
          updateProgress();
          enforcePermissions();
        },
        onError: function (event) {
          showAlert("Player error: " + event.data);
        }
      }
    });
  }

  function updateProgress() {
    if (!hostState.playerReady) {
      return;
    }
    var current = hostState.player.getCurrentTime ? hostState.player.getCurrentTime() : 0;
    var duration = hostState.player.getDuration ? hostState.player.getDuration() : hostState.duration;
    if (!hostState.isSeeking) {
      updateSeekSlider(current);
    }
    if (elements.elapsed) {
      elements.elapsed.textContent = formatTime(current);
    }
    if (elements.duration) {
      elements.duration.textContent = formatTime(duration);
    }
    hostState.duration = duration;
    var stateValue = hostState.player.getPlayerState ? hostState.player.getPlayerState() : null;
    if (!hostState.isSeeking && hostState.socket && hostState.socket.readyState === 1 && stateValue === YT.PlayerState.PLAYING) {
      var now = performance.now();
      if (now - hostState.lastSyncAt > PROGRESS_SYNC_INTERVAL) {
        pushState({});
      }
    }
  }

  function updateSeekSlider(position) {
    if (!elements.seekSlider) {
      return;
    }
    var duration = hostState.duration || (hostState.player && hostState.player.getDuration ? hostState.player.getDuration() : 0);
    if (!duration) {
      return;
    }
    var ratio = Math.max(0, Math.min(1, position / duration));
    elements.seekSlider.value = Math.round(ratio * 1000);
  }

  function extractVideoId(value) {
    if (!value) {
      return null;
    }
    var trimmed = value.replace(/^\s+|\s+$/g, "");
    if (/^[\w-]{11}$/.test(trimmed)) {
      return trimmed;
    }
    var urlMatch = trimmed.match(/[?&]v=([\w-]{11})/);
    if (urlMatch) {
      return urlMatch[1];
    }
    var shareMatch = trimmed.match(/youtu\.be\/([\w-]{11})/);
    if (shareMatch) {
      return shareMatch[1];
    }
    return null;
  }

  function loadVideo() {
    var value = elements.videoInput ? elements.videoInput.value : "";
    var videoId = extractVideoId(value);
    if (!videoId) {
      showAlert("Please provide a valid YouTube URL or video ID.");
      return;
    }
    hostState.currentVideoId = videoId;
    if (METADATA_URL) {
      fetch(METADATA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId })
      }).then(function (res) {
        if (!res.ok) {
          showToast("Metadata lookup failed (" + res.status + ")", 4000, "alert");
          return null;
        }
        return res.json();
      }).then(function (data) {
        if (!data) {
          return;
        }
        hostState.pendingMetadata[videoId] = data;
        if (data.title) {
          elements.title.textContent = data.title;
        }
      }).catch(function () {
        showToast("Unable to fetch video metadata.", 4000, "alert");
      });
    }
    cueVideo(videoId, 0, false);
    setTimeout(function () {
      pushState({
        video_id: videoId,
        video_title: hostState.pendingMetadata[videoId] ? hostState.pendingMetadata[videoId].title : undefined,
        position: 0,
        duration: hostState.player && typeof hostState.player.getDuration === "function" ? hostState.player.getDuration() : hostState.duration,
        is_playing: false,
        host_volume: Number(elements.volumeSlider.value)
      });
    }, 500);
    setTimeout(function () {
      pushState({});
    }, 1500);
  }

  function cueVideo(videoId, position, shouldPlay) {
    if (!hostState.playerReady) {
      hostState.pendingState = {
        video_id: videoId,
        position: position,
        is_playing: shouldPlay,
        host_volume: Number(elements.volumeSlider.value),
        video_title: elements.title.textContent
      };
      return;
    }
    if (shouldPlay && typeof hostState.player.loadVideoById === "function") {
      hostState.player.loadVideoById({ videoId: videoId, startSeconds: position });
    } else if (typeof hostState.player.cueVideoById === "function") {
      hostState.player.cueVideoById({ videoId: videoId, startSeconds: position });
    }
  }

  function pushState(partial) {
    if (!hostState.socket || hostState.socket.readyState !== 1) {
      return;
    }
    var payload = {
      video_id: hostState.currentVideoId || (hostState.remoteState && hostState.remoteState.video_id) || DEFAULT_VIDEO_ID,
      is_playing: hostState.player && typeof hostState.player.getPlayerState === "function" ? hostState.player.getPlayerState() === YT.PlayerState.PLAYING : false,
      position: hostState.player && typeof hostState.player.getCurrentTime === "function" ? hostState.player.getCurrentTime() : 0,
      duration: hostState.player && typeof hostState.player.getDuration === "function" ? hostState.player.getDuration() : hostState.duration,
      host_volume: Number(elements.volumeSlider.value),
      video_title: elements.title.textContent
    };
    if (partial) {
      for (var key in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, key)) {
          payload[key] = partial[key];
        }
      }
    }
    hostState.lastSyncAt = performance.now();
    try {
      hostState.socket.send(JSON.stringify({ type: "update_state", payload: payload }));
    } catch (error) {
      // ignore
    }
  }

  function sendPing() {
    if (!hostState.socket || hostState.socket.readyState !== 1) {
      return;
    }
    try {
      hostState.socket.send(JSON.stringify({ type: "ping", payload: { sent_at: performance.now() } }));
    } catch (error) {
      // ignore
    }
  }

  function setupControls() {
    if (elements.loadButton) {
      elements.loadButton.addEventListener("click", loadVideo);
    }
    if (elements.playButton) {
      elements.playButton.addEventListener("click", function () {
        if (!hostState.playerReady) {
          return;
        }
        if (typeof hostState.player.unMute === "function") {
          hostState.player.unMute();
        }
        if (typeof hostState.player.playVideo === "function") {
          hostState.player.playVideo();
        }
        pushState({ is_playing: true });
        setTimeout(function () { pushState({}); }, 750);
      });
    }
    if (elements.pauseButton) {
      elements.pauseButton.addEventListener("click", function () {
        if (!hostState.playerReady) {
          return;
        }
        if (typeof hostState.player.pauseVideo === "function") {
          hostState.player.pauseVideo();
        }
        pushState({ is_playing: false });
      });
    }
    if (elements.resyncButton) {
      elements.resyncButton.addEventListener("click", function () {
        if (hostState.socket && hostState.socket.readyState === 1) {
          hostState.socket.send(JSON.stringify({ type: "resync_all" }));
        }
        pushState({});
      });
    }
    if (elements.volumeSlider) {
      elements.volumeSlider.addEventListener("input", function () {
        if (hostState.playerReady && typeof hostState.player.setVolume === "function") {
          var value = Number(elements.volumeSlider.value);
          hostState.player.setVolume(value);
          if (typeof hostState.player.unMute === "function") {
            hostState.player.unMute();
          }
          pushState({ host_volume: value });
        }
      });
    }
    if (elements.seekSlider) {
      elements.seekSlider.addEventListener("mousedown", function () { hostState.isSeeking = true; });
      elements.seekSlider.addEventListener("touchstart", function () { hostState.isSeeking = true; });
      elements.seekSlider.addEventListener("mouseup", commitSeek);
      elements.seekSlider.addEventListener("touchend", commitSeek);
      elements.seekSlider.addEventListener("change", commitSeek);
    }
  }

  function commitSeek() {
    if (!hostState.playerReady) {
      hostState.isSeeking = false;
      return;
    }
    var ratio = Number(elements.seekSlider.value) / 1000;
    var duration = hostState.player.getDuration ? hostState.player.getDuration() : hostState.duration;
    var position = ratio * duration;
    if (typeof hostState.player.seekTo === "function") {
      hostState.player.seekTo(position, true);
    }
    hostState.isSeeking = false;
    pushState({ position: position });
  }

  window.onYouTubeIframeAPIReady = function () {
    ensurePlayer();
  };

  document.addEventListener("DOMContentLoaded", function () {
    setupControls();
    connectWebSocket(false);
    enforcePermissions();
    window.addEventListener("focus", enforcePermissions);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        enforcePermissions();
      }
    });
  });
})();
