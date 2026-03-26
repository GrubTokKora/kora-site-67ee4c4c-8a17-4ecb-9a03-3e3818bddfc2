(function () {
  "use strict";

  const cfg = window.KORA_SITE_CONFIG || {};
  const voiceCfg = cfg.voice || {};
  if (!voiceCfg.enabled) return;

  const API_BASE = (cfg.apiBaseUrl || "").replace(/\/+$/, "");
  const BUSINESS_ID = cfg.businessId;
  const WS_URL = "wss://api.x.ai/v1/realtime";

  let ws = null;
  let audioContext = null;
  let mediaStream = null;
  let sourceNode = null;
  let processorNode = null;
  let muteGain = null;

  let active = false;
  let sessionUpdated = false;
  let listening = false;
  let queue = [];
  let nextPlayAt = 0;
  let idleTimer = null;
  let lastActivityAt = 0;

  function now() {
    return Date.now();
  }

  function touch() {
    lastActivityAt = now();
  }

  function createButton() {
    if (document.getElementById("kora-voice-btn")) return;
    const wrap = document.createElement("div");
    wrap.id = "kora-voice-wrap";
    wrap.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:9999;";
    const btn = document.createElement("button");
    btn.id = "kora-voice-btn";
    btn.setAttribute("aria-label", "Ask with voice");
    btn.title = "Ask with voice";
    btn.style.cssText = [
      "width:56px",
      "height:56px",
      "border:none",
      "border-radius:9999px",
      "color:white",
      "cursor:pointer",
      "font-size:20px",
      "box-shadow:0 8px 22px rgba(0,0,0,.28)",
      "background:linear-gradient(135deg,#3129a8,#7e5798)"
    ].join(";");
    btn.textContent = "🎙";
    btn.onclick = () => (active ? stopSession("user_stop") : startSession());
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  function setBtn(state) {
    const btn = document.getElementById("kora-voice-btn");
    if (!btn) return;
    if (state === "loading") {
      btn.textContent = "⏳";
      btn.style.background = "linear-gradient(135deg,#7e5798,#3129a8)";
    } else if (state === "active") {
      btn.textContent = "🎙";
      btn.style.background = "linear-gradient(135deg,#16a34a,#22c55e)";
    } else {
      btn.textContent = "🎙";
      btn.style.background = "linear-gradient(135deg,#3129a8,#7e5798)";
    }
  }

  async function getSession() {
    const p = new URLSearchParams();
    if (voiceCfg.collectionId) {
      p.set("collection_id", String(voiceCfg.collectionId));
      p.set("prefer_collection", "true");
    }
    p.set("use_web_search", voiceCfg.useWebSearch === false ? "false" : "true");
    const url = API_BASE + "/api/v1/public/voice/" + encodeURIComponent(BUSINESS_ID) + "/session?" + p.toString();
    const r = await fetch(url);
    if (!r.ok) {
      let detail = "Failed to create voice session";
      try {
        const body = await r.json();
        detail = body.detail || detail;
      } catch (_e) {}
      throw new Error(detail);
    }
    return r.json();
  }

  async function initAudio(rate) {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate || 24000 });
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    processorNode.onaudioprocess = (e) => {
      if (!listening) return;
      const inData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inData.length);
      for (let i = 0; i < inData.length; i++) {
        const s = Math.max(-1, Math.min(1, inData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const b64 = toBase64(pcm16.buffer);
      sendInput(b64);
      touch();
    };
    sourceNode.connect(processorNode);
    processorNode.connect(muteGain);
    muteGain.connect(audioContext.destination);
  }

  function connect(token, sessionConfig) {
    return new Promise((resolve, reject) => {
      sessionUpdated = false;
      ws = new WebSocket(WS_URL, ["xai-client-secret." + token]);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
        resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket failed"));
      ws.onclose = () => {
        if (active) stopSession("socket_closed");
      };
      ws.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch (_e) {
          return;
        }
        if (!msg || !msg.type) return;
        if (msg.type === "session.updated") {
          sessionUpdated = true;
          flush();
          touch();
        } else if (msg.type === "response.output_audio.delta" && msg.delta) {
          playDelta(msg.delta);
          touch();
        } else if (msg.type === "response.done" || msg.type === "response.output_audio.done") {
          touch();
        } else if (msg.type === "error") {
          console.error("[voice] xAI error", msg);
          stopSession("xai_error");
        }
      };
    });
  }

  function sendInput(b64) {
    if (!(ws && ws.readyState === WebSocket.OPEN && sessionUpdated)) {
      queue.push(b64);
      if (queue.length > 240) queue.shift();
      return;
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
  }

  function flush() {
    if (!(ws && ws.readyState === WebSocket.OPEN && sessionUpdated)) return;
    while (queue.length) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: queue.shift() }));
    }
  }

  function playDelta(base64Delta) {
    if (!audioContext) return;
    const bytes = fromBase64(base64Delta);
    const pcm16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
    const buffer = audioContext.createBuffer(1, f32.length, audioContext.sampleRate);
    buffer.copyToChannel(f32, 0);
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContext.destination);
    const t = audioContext.currentTime;
    if (!nextPlayAt || nextPlayAt < t) nextPlayAt = t;
    src.start(nextPlayAt);
    nextPlayAt += buffer.duration;
  }

  function startIdleTimer() {
    stopIdleTimer();
    const timeoutSec = Math.max(5, Number(voiceCfg.idleTimeoutSeconds || 10));
    idleTimer = window.setInterval(() => {
      if (!active) return;
      if (now() - (lastActivityAt || now()) >= timeoutSec * 1000) {
        stopSession("idle_timeout");
      }
    }, 1000);
  }

  function stopIdleTimer() {
    if (idleTimer) {
      window.clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  async function startSession() {
    if (!API_BASE || !BUSINESS_ID) {
      alert("Voice config missing.");
      return;
    }
    setBtn("loading");
    try {
      queue = [];
      nextPlayAt = 0;
      touch();
      const session = await getSession();
      const token = session.token;
      const sessionConfig = session.session_config || {};
      const rate = Number(((sessionConfig.audio || {}).input || {}).format?.rate || 24000);
      await initAudio(rate);
      listening = true;
      active = true;
      startIdleTimer();
      await connect(token, sessionConfig);
      setBtn("active");
    } catch (e) {
      console.error("[voice] failed to start", e);
      alert("Failed to start voice session. Please try again.");
      stopSession("startup_error");
    }
  }

  function stopSession(_reason) {
    active = false;
    listening = false;
    sessionUpdated = false;
    queue = [];
    nextPlayAt = 0;
    stopIdleTimer();

    if (ws) {
      try { ws.close(); } catch (_e) {}
      ws = null;
    }
    if (processorNode) {
      try { processorNode.disconnect(); } catch (_e) {}
      processorNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_e) {}
      sourceNode = null;
    }
    if (muteGain) {
      try { muteGain.disconnect(); } catch (_e) {}
      muteGain = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    setBtn("idle");
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function init() {
    createButton();
    setBtn("idle");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("beforeunload", () => {
    stopSession("unload");
    if (audioContext) {
      try { audioContext.close(); } catch (_e) {}
      audioContext = null;
    }
  });
})();

/**
 * Kora Voice Widget (business-repo POC)
 * - Fetches ephemeral token/session config from Kora backend
 * - Connects to xAI realtime websocket
 * - Streams microphone PCM16 audio
 * - Plays streamed PCM16 response audio
 * - Supports file_search (Collections Search Tool) via config.collectionId
 */
(function () {
  "use strict";

  const cfg = window.KORA_SITE_CONFIG || {};
  const voiceCfg = cfg.voice || {};
  if (!voiceCfg.enabled) return;

  const API_BASE_URL = (cfg.apiBaseUrl || "").replace(/\/+$/, "");
  const BUSINESS_ID = cfg.businessId;
  const XAI_WS_URL = "wss://api.x.ai/v1/realtime";

  let ws = null;
  let audioContext = null;
  let mediaStream = null;
  let processorNode = null;
  let mediaSourceNode = null;
  let muteGain = null;

  let sessionActive = false;
  let sessionUpdated = false;
  let isListening = false;
  let pendingAudioChunks = [];
  let nextPlaybackTime = 0;
  let idleTimer = null;
  let lastActivityAt = 0;

  function markActivity() {
    lastActivityAt = Date.now();
  }

  function ensureIdleTimer() {
    clearIdleTimer();
    const timeoutSeconds = Math.max(5, Number(voiceCfg.idleTimeoutSeconds || 10));
    idleTimer = window.setInterval(() => {
      if (!sessionActive) return;
      const idleMs = Date.now() - (lastActivityAt || Date.now());
      if (idleMs >= timeoutSeconds * 1000) {
        stopSession("idle_timeout");
      }
    }, 1000);
  }

  function clearIdleTimer() {
    if (idleTimer) {
      window.clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  function createVoiceButton() {
    if (document.getElementById("voice-widget-button")) return;

    const container = document.createElement("div");
    container.id = "voice-widget-container";
    container.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;";

    const button = document.createElement("button");
    button.id = "voice-widget-button";
    button.setAttribute("aria-label", "Ask with voice");
    button.title = "Ask with voice";
    button.style.cssText = [
      "width:56px",
      "height:56px",
      "border-radius:9999px",
      "border:none",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "color:#fff",
      "background:linear-gradient(135deg,#3129a8,#7e5798)",
      "box-shadow:0 6px 18px rgba(0,0,0,.28)",
      "transition:transform .2s ease, box-shadow .2s ease"
    ].join(";");
    button.innerHTML = '<span style="font-size:20px;line-height:1">🎙</span>';
    button.onmouseenter = () => {
      button.style.transform = "scale(1.05)";
      button.style.boxShadow = "0 10px 24px rgba(0,0,0,.35)";
    };
    button.onmouseleave = () => {
      button.style.transform = "scale(1)";
      button.style.boxShadow = "0 6px 18px rgba(0,0,0,.28)";
    };
    button.onclick = () => {
      if (sessionActive) {
        stopSession("user_stop");
      } else {
        startSession();
      }
    };

    container.appendChild(button);
    document.body.appendChild(container);
  }

  function setButtonState(kind) {
    const button = document.getElementById("voice-widget-button");
    if (!button) return;
    if (kind === "loading") {
      button.style.background = "linear-gradient(135deg,#7e5798,#3129a8)";
      button.innerHTML = '<span style="font-size:18px;line-height:1">⏳</span>';
    } else if (kind === "active") {
      button.style.background = "linear-gradient(135deg,#16a34a,#22c55e)";
      button.innerHTML = '<span style="font-size:20px;line-height:1">🎙</span>';
    } else {
      button.style.background = "linear-gradient(135deg,#3129a8,#7e5798)";
      button.innerHTML = '<span style="font-size:20px;line-height:1">🎙</span>';
    }
  }

  async function requestSession() {
    const params = new URLSearchParams();
    if (voiceCfg.collectionId) {
      params.set("collection_id", String(voiceCfg.collectionId));
      params.set("prefer_collection", "true");
    }
    params.set("use_web_search", voiceCfg.useWebSearch === false ? "false" : "true");
    const url =
      API_BASE_URL +
      "/api/v1/public/voice/" +
      encodeURIComponent(BUSINESS_ID) +
      "/session" +
      (params.toString() ? `?${params.toString()}` : "");
    const response = await fetch(url);
    if (!response.ok) {
      let detail = "Failed to create voice session";
      try {
        const body = await response.json();
        detail = body.detail || detail;
      } catch (_e) {}
      throw new Error(detail);
    }
    return response.json();
  }

  function mergeTools(baseTools) {
    const tools = Array.isArray(baseTools) ? JSON.parse(JSON.stringify(baseTools)) : [];
    const hasWeb = tools.some((t) => t && t.type === "web_search");
    const hasFile = tools.some((t) => t && t.type === "file_search");

    if (voiceCfg.useWebSearch !== false && !hasWeb) {
      tools.push({ type: "web_search" });
    }
    if (voiceCfg.collectionId && !hasFile) {
      tools.push({
        type: "file_search",
        vector_store_ids: [voiceCfg.collectionId],
        max_num_results: Number(voiceCfg.maxResults || 8)
      });
    }
    return tools;
  }

  async function initAudio(sampleRate) {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: sampleRate || 24000
      });
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    mediaSourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    muteGain = audioContext.createGain();
    muteGain.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!isListening) return;
      const channelData = event.inputBuffer.getChannelData(0);
      const int16Data = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const b64 = arrayBufferToBase64(int16Data.buffer);
      sendInputAudio(b64);
      markActivity();
    };

    mediaSourceNode.connect(processorNode);
    processorNode.connect(muteGain);
    muteGain.connect(audioContext.destination);
  }

  function connectWs(token, sessionConfig) {
    return new Promise((resolve, reject) => {
      sessionUpdated = false;
      ws = new WebSocket(XAI_WS_URL, ["xai-client-secret." + token]);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
        resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
      ws.onclose = () => {
        if (sessionActive) stopSession("socket_closed");
      };
      ws.onmessage = (event) => onWsMessage(event.data);
    });
  }

  function onWsMessage(raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      return;
    }

    if (!msg || !msg.type) return;
    if (msg.type === "session.updated") {
      sessionUpdated = true;
      flushPendingAudio();
      markActivity();
      return;
    }
    if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
      markActivity();
      return;
    }
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      playOutputAudioDelta(msg.delta);
      markActivity();
      return;
    }
    if (msg.type === "response.output_audio.done" || msg.type === "response.done") {
      markActivity();
      return;
    }
    if (msg.type === "error") {
      console.error("[Voice Widget] xAI error:", msg);
      stopSession("xai_error");
    }
  }

  function sendInputAudio(base64Chunk) {
    if (!isListening) return;
    if (ws && ws.readyState === WebSocket.OPEN && sessionUpdated) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Chunk }));
      return;
    }
    pendingAudioChunks.push(base64Chunk);
    if (pendingAudioChunks.length > 240) pendingAudioChunks.shift();
  }

  function flushPendingAudio() {
    if (!(ws && ws.readyState === WebSocket.OPEN && sessionUpdated)) return;
    while (pendingAudioChunks.length) {
      const chunk = pendingAudioChunks.shift();
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk }));
    }
  }

  function playOutputAudioDelta(base64Delta) {
    if (!audioContext) return;
    const bytes = base64ToUint8Array(base64Delta);
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    const buffer = audioContext.createBuffer(1, float32.length, audioContext.sampleRate);
    buffer.copyToChannel(float32, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const now = audioContext.currentTime;
    if (!nextPlaybackTime || nextPlaybackTime < now) nextPlaybackTime = now;
    source.start(nextPlaybackTime);
    nextPlaybackTime += buffer.duration;
  }

  async function startSession() {
    if (!BUSINESS_ID || !API_BASE_URL) {
      alert("Voice widget is not configured.");
      return;
    }
    setButtonState("loading");
    try {
      pendingAudioChunks = [];
      nextPlaybackTime = 0;
      markActivity();

      const session = await requestSession();
      const token = session.token;
      if (!token) throw new Error("Missing session token");

      const serverConfig = session.session_config || {};
      const sampleRate = Number(((serverConfig.audio || {}).input || {}).format?.rate || 24000);
      const mergedConfig = {
        ...serverConfig,
        tools: mergeTools(serverConfig.tools || []),
        turn_detection: serverConfig.turn_detection || { type: "server_vad" }
      };

      await initAudio(sampleRate);
      isListening = true;
      sessionActive = true;
      ensureIdleTimer();
      await connectWs(token, mergedConfig);

      setButtonState("active");
    } catch (err) {
      console.error("[Voice Widget] Failed to start session:", err);
      alert("Failed to start voice session. Please try again.");
      stopSession("startup_error");
    }
  }

  function stopSession(_reason) {
    sessionActive = false;
    isListening = false;
    sessionUpdated = false;
    pendingAudioChunks = [];
    nextPlaybackTime = 0;
    clearIdleTimer();

    if (ws) {
      try { ws.close(); } catch (_e) {}
      ws = null;
    }
    if (processorNode) {
      try { processorNode.disconnect(); } catch (_e) {}
      processorNode = null;
    }
    if (mediaSourceNode) {
      try { mediaSourceNode.disconnect(); } catch (_e) {}
      mediaSourceNode = null;
    }
    if (muteGain) {
      try { muteGain.disconnect(); } catch (_e) {}
      muteGain = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    setButtonState("idle");
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function init() {
    createVoiceButton();
    setButtonState("idle");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("beforeunload", () => {
    stopSession("page_unload");
    if (audioContext) {
      try { audioContext.close(); } catch (_e) {}
      audioContext = null;
    }
  });
})();

