/* Static-site voice widget (minimal UI + xAI realtime event loop). */
(function () {
  function friendlyError(raw) {
    var text = (raw || "").toString();
    var lower = text.toLowerCase();
    if (
      lower.indexOf("statuscode.unavailable") !== -1 ||
      lower.indexOf("grpc_status:14") !== -1 ||
      lower.indexOf("service unavailable") !== -1 ||
      lower.indexOf("aiorpcerror") !== -1
    ) {
      return "Voice service is temporarily unavailable. Please try again in a moment.";
    }
    if (lower.indexOf("network") !== -1 || lower.indexOf("connection") !== -1) {
      return "We could not connect right now. Please check your internet and try again.";
    }
    return text.trim() ? text : "Voice assistant is currently unavailable. Please try again.";
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  function appendBubble(container, sender, text) {
    container.appendChild(el("div", { class: "kora-voice-bubble " + sender, text: text || "" }));
    container.scrollTop = container.scrollHeight;
  }

  function base64FromInt16LE(pcm16) {
    var bytes = new Uint8Array(pcm16.buffer);
    var chunkSize = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function int16FromBase64PCM16(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var evenLen = bytes.byteLength - (bytes.byteLength % 2);
    return new Int16Array(bytes.buffer, bytes.byteOffset, evenLen / 2);
  }

  function pickOutputAudioBase64(ev) {
    if (typeof ev.audio === "string" && ev.audio.length) return ev.audio;
    if (typeof ev.delta === "string" && ev.delta.length) return ev.delta;
    return "";
  }

  function pickTranscriptDelta(ev) {
    if (typeof ev.delta === "string") return ev.delta;
    if (typeof ev.transcript === "string") return ev.transcript;
    return "";
  }

  async function startWidget(state) {
    state.errorEl.textContent = "";
    state.statusEl.textContent = "Connecting…";

    try {
      var bootstrap = await window.KoraVoiceClient.createVoiceSession({
        business_id: state.businessId,
        locale: "auto",
        page_context: { url: window.location.href, title: document.title },
      });
      state.bootstrap = bootstrap;

      var wsUrl = bootstrap.websocket_url;
      var secret = bootstrap.client_secret;
      if (!wsUrl || !secret) throw new Error("Voice session missing websocket_url/client_secret");

      var ws = new WebSocket(wsUrl, ["xai-client-secret." + secret]);
      state.ws = ws;
      state.greeted = false;
      state.sessionReady = false;
      state.assistantDraft = "";

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: "session.update", session: bootstrap.session || {} }));
      };

      ws.onerror = function () {
        state.statusEl.textContent = "Error";
        state.errorEl.textContent = friendlyError("Connection error.");
      };

      ws.onclose = function () {
        cleanup(state);
      };

      ws.onmessage = function (ev) {
        var event;
        try {
          event = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        handleEvent(state, event);
      };
    } catch (e) {
      state.statusEl.textContent = "Error";
      state.errorEl.textContent = friendlyError(e && e.message);
      cleanup(state);
    }
  }

  function cleanup(state) {
    try { if (state.ws) state.ws.close(); } catch (e) {}
    state.ws = null;
    state.sessionReady = false;
    state.statusEl.textContent = "Idle";
    stopMic(state);
  }

  function stopMic(state) {
    try { if (state.proc) state.proc.disconnect(); } catch (e) {}
    state.proc = null;
    try { if (state.micStream) state.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    state.micStream = null;
    try { if (state.audioCtx) state.audioCtx.close(); } catch (e) {}
    state.audioCtx = null;
  }

  async function startMic(state, inputRate) {
    var ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: inputRate || 24000 });
    state.audioCtx = ctx;
    if (ctx.state === "suspended") try { await ctx.resume(); } catch (e) {}
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.micStream = stream;
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    state.proc = proc;

    var gain = ctx.createGain();
    gain.gain.value = 0;
    proc.connect(gain);
    gain.connect(ctx.destination);

    proc.onaudioprocess = function (e) {
      if (!state.sessionReady) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      var input = e.inputBuffer.getChannelData(0);
      var pcm16 = new Int16Array(input.length);
      for (var i = 0; i < input.length; i++) {
        var s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64FromInt16LE(pcm16) }));
    };

    src.connect(proc);
  }

  function playPCM16(state, b64, outRate) {
    var ctx = state.audioCtx;
    if (!ctx) return;
    if (ctx.state === "suspended") try { ctx.resume(); } catch (e) {}
    var pcm16 = int16FromBase64PCM16(b64);
    if (!pcm16.length) return;

    var buf = ctx.createBuffer(1, pcm16.length, outRate || 24000);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < pcm16.length; i++) ch[i] = pcm16[i] / 32768.0;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  }

  function handleEvent(state, event) {
    if (!event || !event.type) return;

    if (event.type === "session.updated") {
      state.sessionReady = true;
      state.statusEl.textContent = "Listening…";

      // Start mic
      var sess = state.bootstrap && state.bootstrap.session;
      var inRate = (((sess || {}).audio || {}).input || {}).format;
      var outRate = (((sess || {}).audio || {}).output || {}).format;
      var inputRate = (inRate && inRate.rate) || 24000;
      state.outputRate = (outRate && outRate.rate) || inputRate;
      startMic(state, inputRate).catch(function () {});

      // Assistant-first greeting (official xAI flow): create user text that instructs greeting, then response.create.
      try {
        var ws = state.ws;
        if (ws && ws.readyState === WebSocket.OPEN && !state.greeted) {
          state.greeted = true;
          var g = (state.bootstrap && state.bootstrap.initial_greeting) || "";
          g = g.toString().trim();
          if (g) {
            ws.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: 'Please greet the visitor by saying exactly: "' + g + '"' }],
                },
              })
            );
          }
          ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["text", "audio"] } }));
        }
      } catch (e) {}
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      appendBubble(state.bodyEl, "user", event.transcript || "");
      return;
    }

    if (event.type === "response.output_audio_transcript.delta") {
      var piece = pickTranscriptDelta(event);
      if (!piece) return;
      state.assistantDraft = (state.assistantDraft || "") + piece;
      state.streamingEl.textContent = state.assistantDraft;
      return;
    }

    if (event.type === "response.output_audio_transcript.done" || event.type === "response.done" || event.type === "response.output_audio.done") {
      if (state.assistantDraft && state.assistantDraft.trim()) {
        appendBubble(state.bodyEl, "agent", state.assistantDraft.trim());
      }
      state.assistantDraft = "";
      state.streamingEl.textContent = "";
      return;
    }

    if (event.type === "response.output_audio.delta") {
      var b64 = pickOutputAudioBase64(event);
      if (b64) playPCM16(state, b64, state.outputRate || 24000);
      return;
    }

    if (event.type === "error") {
      state.statusEl.textContent = "Error";
      var msg = (event.error && event.error.message) || event.message || "Voice agent error";
      state.errorEl.textContent = friendlyError(msg);
      return;
    }
  }

  function init() {
    if (!window.KoraVoiceClient || !window.KoraVoiceClient.isVoiceEnabled || !window.KoraVoiceClient.createVoiceSession) return;
    if (!window.KoraVoiceClient.isVoiceEnabled()) return;

    var cfg = window.KORA_CONFIG || {};
    var businessId = (cfg.businessId || (cfg.business && cfg.business.id) || "").toString();
    // If businessId isn't present in KORA_CONFIG, the backend still accepts business_id in request body,
    // but static sites should ensure this exists in their injected config. Fallback to empty.

    var fab = el("button", { class: "kora-voice-fab", "aria-label": "Open voice assistant", "aria-pressed": "false" }, ["🎙️"]);
    var headerLeft = el("div", {}, [
      el("div", { class: "kora-voice-title", text: "Voice Assistant" }),
      el("div", { class: "kora-voice-subtitle", text: "Powered by Kora" }),
    ]);
    var closeBtn = el("button", { class: "kora-voice-btn", type: "button" }, ["Close"]);
    var header = el("div", { class: "kora-voice-header" }, [headerLeft, closeBtn]);
    var body = el("div", { class: "kora-voice-body" });
    var streaming = el("div", { class: "kora-voice-bubble agent", text: "" });
    streaming.style.display = "none";
    var footer = el("div", { class: "kora-voice-footer" }, [
      el("div", { class: "kora-voice-status", text: "Idle" }),
      el("button", { class: "kora-voice-btn primary", type: "button" }, ["End session"]),
    ]);
    var errorEl = el("div", { class: "kora-voice-error" });
    errorEl.style.display = "none";

    var panel = el("div", { class: "kora-voice-panel" }, [header, body, errorEl, footer]);

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    var state = {
      businessId: businessId,
      ws: null,
      audioCtx: null,
      micStream: null,
      proc: null,
      bootstrap: null,
      sessionReady: false,
      greeted: false,
      assistantDraft: "",
      outputRate: 24000,
      bodyEl: body,
      streamingEl: streaming,
      statusEl: footer.querySelector(".kora-voice-status"),
      errorEl: errorEl,
    };

    function showError(text) {
      if (!text) {
        errorEl.style.display = "none";
        errorEl.textContent = "";
      } else {
        errorEl.style.display = "block";
        errorEl.textContent = text;
      }
    }
    state.errorEl = { set textContent(v) { showError(v); } };

    function open() {
      panel.classList.add("open");
      fab.setAttribute("aria-pressed", "true");
      appendBubble(body, "agent", "Connecting…");
      startWidget(state);
    }

    function close() {
      panel.classList.remove("open");
      fab.setAttribute("aria-pressed", "false");
      cleanup(state);
    }

    fab.addEventListener("click", function () {
      if (panel.classList.contains("open")) close();
      else open();
    });

    closeBtn.addEventListener("click", function () {
      close();
    });

    footer.querySelector("button.primary").addEventListener("click", function () {
      close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

