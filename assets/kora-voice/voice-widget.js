/* Static-site voice widget (minimal UI + xAI realtime event loop). */
(function () {
  var INACTIVITY_TIMEOUT_MS = 15000;
  var VISITOR_VOICE_UNAVAILABLE =
    "Voice assistant isn't available right now. Please try again later.";

  function friendlyError(raw) {
    var text = (raw || "").toString();
    var lower = text.toLowerCase();
    if (
      lower.indexOf("microphone permission") !== -1 ||
      lower.indexOf("notallowederror") !== -1 ||
      (lower.indexOf("permission") !== -1 && lower.indexOf("denied") !== -1)
    ) {
      return "Microphone permission is required to use the voice assistant.";
    }
    if (
      lower.indexOf("failed to create voice session") !== -1 ||
      lower.indexOf("monthly voice") !== -1 ||
      lower.indexOf("quota") !== -1 ||
      lower.indexOf("\"detail\"") !== -1 ||
      lower.indexOf(" 429") !== -1 ||
      lower.indexOf("429 ") !== -1 ||
      lower.indexOf("status 429") !== -1 ||
      lower.indexOf(" 401") !== -1 ||
      lower.indexOf(" 403") !== -1 ||
      lower.indexOf(" 500") !== -1 ||
      lower.indexOf(" 502") !== -1 ||
      lower.indexOf(" 503") !== -1
    ) {
      return VISITOR_VOICE_UNAVAILABLE;
    }
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
    if (text.indexOf("{") !== -1 && (lower.indexOf("detail") !== -1 || lower.indexOf("\"error\"") !== -1)) {
      return VISITOR_VOICE_UNAVAILABLE;
    }
    return text.trim() ? text : VISITOR_VOICE_UNAVAILABLE;
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

  function icon(name) {
    var map = {
      mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="kora-voice-icon"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path><path d="M12 19v3"></path><path d="M8 22h8"></path></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="kora-voice-icon"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>',
      spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="kora-voice-icon"><path d="M21 12a9 9 0 1 1-9-9"></path></svg>',
      listening: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="kora-voice-icon"><path d="M12 3v6"></path><path d="M8 6v12"></path><path d="M16 8v8"></path><path d="M4 10v4"></path><path d="M20 10v4"></path></svg>',
      speaking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="kora-voice-icon"><polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18 6a8 8 0 0 1 0 12"></path></svg>',
      thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="kora-voice-icon"><path d="M12 2a8 8 0 0 0-5 14.2V20l3-1 3 1v-3.8A8 8 0 1 0 12 2z"></path><path d="M9.5 10a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"></path><circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none"></circle></svg>',
      error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="kora-voice-icon"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><circle cx="12" cy="16.8" r="0.8" fill="currentColor" stroke="none"></circle></svg>',
      idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="kora-voice-icon"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M12 19v3"></path></svg>',
    };
    return map[name] || map.idle;
  }

  function resolvePrimaryColor() {
    try {
      var root = window.getComputedStyle(document.documentElement);
      var candidates = [
        root.getPropertyValue("--kora-voice-primary"),
        root.getPropertyValue("--primary-color"),
        root.getPropertyValue("--color-primary"),
        root.getPropertyValue("--theme-primary"),
      ];
      for (var i = 0; i < candidates.length; i++) {
        var v = (candidates[i] || "").trim();
        if (v) return v;
      }
    } catch (e) {}
    return "#dc2626";
  }

  function appendBubble(container, sender, text) {
    container.appendChild(el("div", { class: "kora-voice-bubble " + sender, text: text || "" }));
    container.scrollTop = container.scrollHeight;
  }

  function extractEmail(text) {
    var m = (text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0].trim() : "";
  }

  function extractPhone(text) {
    var m = (text || "").match(/(?:\+?\d[\d\s\-().]{6,}\d)/);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  }

  function isFallbackAnswer(text) {
    var t = (text || "").toLowerCase();
    return t.indexOf("i don't have that information on hand right now") !== -1;
  }

  function isSubmissionPhrase(text) {
    return /thanks[,.' ]+i[' ]?m submitting your inquiry now\.?/i.test(text || "");
  }

  function looksLikeYes(text) {
    return /\b(yes|yeah|yep|correct|confirm|sure|submit|go ahead)\b/i.test(text || "");
  }

  function looksLikeNo(text) {
    return /\b(no|nope|cancel|stop|don't submit|do not submit)\b/i.test(text || "");
  }

  function resetInquiryState(state) {
    state.inquiry = {
      active: false,
      submitting: false,
      submitted: false,
      step: "name",
      name: "",
      email: "",
      phone: "",
      inquiry: "",
    };
  }

  function submitCollectedInquiry(state) {
    if (!window.KoraVoiceClient || !window.KoraVoiceClient.submitVoiceInquiry) return Promise.resolve();
    var s = state.inquiry || {};
    if (s.submitting || s.submitted) return Promise.resolve();
    if (!state.koraSessionId) {
      appendBubble(state.bodyEl, "agent", "I couldn't submit right now because the session id is missing. Please try again.");
      return Promise.resolve();
    }
    s.submitting = true;
    return window.KoraVoiceClient.submitVoiceInquiry({
      business_id: state.businessId,
      kora_session_id: state.koraSessionId,
      form_type: "voice_inquiry",
      submitter_email: s.email || null,
      form_data: {
        name: s.name,
        email: s.email || null,
        phone: s.phone || null,
        inquiry: s.inquiry,
        source: "voice_widget",
      },
    }).then(function () {
      s.submitted = true;
      s.active = false;
      appendBubble(state.bodyEl, "agent", "Thank you. I've submitted your inquiry and our team will get back to you soon.");
    }).catch(function () {
      appendBubble(state.bodyEl, "agent", "I couldn't submit your inquiry right now. Please try again later.");
    }).finally(function () {
      s.submitting = false;
    });
  }

  function handleInquiryCapture(state, userText) {
    var s = state.inquiry || {};
    if (!s.active) return;
    var text = (userText || "").trim();
    if (!text) return;

    if (s.step === "name") {
      s.name = text;
      s.step = "contact";
      return;
    }

    if (s.step === "contact") {
      var email = extractEmail(text);
      var phone = extractPhone(text);
      s.email = email || s.email;
      s.phone = phone || s.phone;
      s.step = "inquiry";
      return;
    }

    if (s.step === "inquiry") {
      s.inquiry = text;
      s.step = "confirm";
      return;
    }

    if (s.step === "confirm") {
      if (looksLikeYes(text)) {
        submitCollectedInquiry(state);
        return;
      }
      if (looksLikeNo(text)) {
        s.active = false;
        return;
      }
    }
  }

  function setStatus(state, kind, text) {
    state.statusKind = kind || "idle";
    state.statusText = text || "Idle";
    state.statusEl.style.display = state.statusKind === "idle" ? "none" : "inline-flex";
    state.statusEl.className = "kora-voice-status " + state.statusKind;
    state.statusTextEl.textContent = state.statusText;
    state.statusIconEl.innerHTML = icon(state.statusKind === "listening" ? "listening" : state.statusKind === "speaking" ? "speaking" : state.statusKind === "thinking" ? "thinking" : state.statusKind === "error" ? "error" : state.statusKind === "connecting" ? "spinner" : "idle");
  }

  function setIntro(state, mode) {
    state.introEl.style.display = "flex";
    if (mode === "connecting") {
      state.introEl.style.display = "flex";
      state.introDotEl.style.display = "block";
      state.introTitleEl.textContent = "Connecting...";
      state.introSubtitleEl.textContent = "Preparing your voice assistant";
    } else if (mode === "ready") {
      state.introEl.style.display = "none";
    } else {
      state.introEl.style.display = "flex";
      state.introDotEl.style.display = "none";
      state.introTitleEl.textContent = "Tap to start";
      state.introSubtitleEl.textContent = "Your assistant is ready when you are";
    }
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
    setStatus(state, "connecting", "Connecting");
    setIntro(state, "connecting");

    try {
      var bootstrap = await window.KoraVoiceClient.createVoiceSession({
        business_id: state.businessId,
        locale: "auto",
        page_context: { url: window.location.href, title: document.title },
      });
      state.bootstrap = bootstrap;
      state.koraSessionId = (bootstrap && bootstrap.kora_session_id) || "";

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
        setStatus(state, "error", "Connection issue");
        state.errorEl.textContent = friendlyError("Connection error.");
      };

      ws.onclose = function () {
        cleanup(state);
      };

      ws.onmessage = function (ev) {
        // Any realtime message from server counts as activity.
        resetInactivityTimer(state);
        var event;
        try {
          event = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        handleEvent(state, event);
      };
    } catch (e) {
      setStatus(state, "error", "Connection issue");
      state.errorEl.textContent = friendlyError(e && e.message);
      cleanup(state);
    }
  }

  function cleanup(state) {
    if (state.inactivityTimer) {
      clearTimeout(state.inactivityTimer);
      state.inactivityTimer = null;
    }
    var koraSessionId = state.koraSessionId;
    state.koraSessionId = "";
    if (koraSessionId && window.KoraVoiceClient && window.KoraVoiceClient.closeVoiceSession) {
      window.KoraVoiceClient.closeVoiceSession({
        business_id: state.businessId,
        kora_session_id: koraSessionId,
      }).catch(function () {});
    }
    try { if (state.ws) state.ws.close(); } catch (e) {}
    state.ws = null;
    state.sessionReady = false;
    resetInquiryState(state);
    setStatus(state, "idle", "Idle");
    setIntro(state, "idle");
    stopMic(state);
  }

  function stopMic(state) {
    try { if (state.proc) state.proc.disconnect(); } catch (e) {}
    state.proc = null;
    try { if (state.micStream) state.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    state.micStream = null;
    try { if (state.audioCtx) state.audioCtx.close(); } catch (e) {}
    state.audioCtx = null;
    state.nextPlayTime = 0;
  }

  async function startMic(state, inputRate) {
    var ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: inputRate || 24000 });
    state.audioCtx = ctx;
    if (ctx.state === "suspended") try { await ctx.resume(); } catch (e) {}
    var stream = state.micStream;
    if (!stream) throw new Error("Microphone permission is required.");
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
      // User audio chunks count as activity.
      resetInactivityTimer(state);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64FromInt16LE(pcm16) }));
    };

    src.connect(proc);
  }

  function resetInactivityTimer(state) {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    state.inactivityTimer = setTimeout(function () {
      if (typeof state.closePanel === "function") state.closePanel();
    }, INACTIVITY_TIMEOUT_MS);
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
    // Schedule sequentially to prevent overlapping chunks (which sounds like double speech).
    var now = ctx.currentTime || 0;
    var startAt = Math.max(now, state.nextPlayTime || 0);
    try {
      src.start(startAt);
    } catch (e) {
      // Fallback to immediate start if scheduling fails.
      try { src.start(); } catch (e2) {}
      startAt = now;
    }
    state.nextPlayTime = startAt + buf.duration;
  }

  function handleEvent(state, event) {
    if (!event || !event.type) return;

    if (event.type === "session.updated") {
      state.sessionReady = true;
      setStatus(state, "listening", "Listening");
      setIntro(state, "ready");
      // Start inactivity countdown only when session is live.
      resetInactivityTimer(state);

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
      setStatus(state, "thinking", "Thinking");
      var userText = event.transcript || "";
      appendBubble(state.bodyEl, "user", userText);
      handleInquiryCapture(state, userText);
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
        var agentText = state.assistantDraft.trim();
        appendBubble(state.bodyEl, "agent", agentText);
        if (!state.inquiry.active && !state.inquiry.submitted && isFallbackAnswer(agentText)) {
          state.inquiry.active = true;
          state.inquiry.step = "name";
          return;
        }
        if (state.inquiry.active && agentText.indexOf("What is the best email or phone number to reach you?") !== -1) {
          state.inquiry.step = "contact";
          return;
        }
        if (state.inquiry.active && agentText.indexOf("Please tell me your question or inquiry.") !== -1) {
          state.inquiry.step = "inquiry";
          return;
        }
        if (state.inquiry.active && agentText.indexOf("I have everything I need. Would you like me to submit this to our team?") !== -1) {
          state.inquiry.step = "confirm";
          return;
        }
        if (state.inquiry.active && isSubmissionPhrase(agentText)) {
          submitCollectedInquiry(state);
        }
      }
      state.assistantDraft = "";
      state.streamingEl.textContent = "";
      setStatus(state, "listening", "Listening");
      return;
    }

    if (event.type === "response.output_audio.delta") {
      var b64 = pickOutputAudioBase64(event);
      if (b64) {
        setStatus(state, "speaking", "Speaking");
        playPCM16(state, b64, state.outputRate || 24000);
      }
      return;
    }

    if (event.type === "error") {
      setStatus(state, "error", "Error");
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

    var fab = el("button", { class: "kora-voice-fab", "aria-label": "Open voice assistant", "aria-pressed": "false" });
    fab.innerHTML = icon("mic");
    fab.style.backgroundColor = resolvePrimaryColor();
    var headerLeft = el("div", {}, [
      el("div", { class: "kora-voice-title", text: "Voice Assistant" }),
      el("div", { class: "kora-voice-subtitle", text: "Powered by Kora" }),
    ]);
    var closeBtn = el("button", { class: "kora-voice-btn", type: "button", "aria-label": "Close voice assistant" });
    closeBtn.innerHTML = icon("close");
    var header = el("div", { class: "kora-voice-header" }, [headerLeft, closeBtn]);
    var body = el("div", { class: "kora-voice-body" });
    var introDot = el("div", { class: "kora-voice-connecting-dot" });
    var introTitle = el("div", { class: "kora-voice-intro-title", text: "Tap to start" });
    var introSubtitle = el("div", { class: "kora-voice-intro-subtitle", text: "Your assistant is ready when you are" });
    var intro = el("div", { class: "kora-voice-intro" }, [introDot, introTitle, introSubtitle]);
    introDot.style.display = "none";
    body.appendChild(intro);
    var streaming = el("div", { class: "kora-voice-bubble agent", text: "" });
    streaming.style.display = "none";
    body.appendChild(streaming);
    var statusIcon = el("span", { class: "kora-voice-status-icon" });
    statusIcon.innerHTML = icon("idle");
    var statusText = el("span", { text: "Idle" });
    var footer = el("div", { class: "kora-voice-footer" }, [
      el("div", { class: "kora-voice-status idle" }, [statusIcon, statusText]),
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
      koraSessionId: "",
      sessionReady: false,
      greeted: false,
      assistantDraft: "",
      outputRate: 24000,
      statusKind: "idle",
      statusText: "Idle",
      nextPlayTime: 0,
      inactivityTimer: null,
      closePanel: null,
      bodyEl: body,
      introEl: intro,
      introDotEl: introDot,
      introTitleEl: introTitle,
      introSubtitleEl: introSubtitle,
      streamingEl: streaming,
      statusEl: footer.querySelector(".kora-voice-status"),
      statusIconEl: statusIcon,
      statusTextEl: statusText,
      errorEl: errorEl,
    };
    resetInquiryState(state);

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

    async function open() {
      panel.classList.add("open");
      fab.setAttribute("aria-pressed", "true");
      setIntro(state, "connecting");
      try {
        state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        setStatus(state, "error", "Microphone required");
        state.errorEl.textContent = friendlyError("Microphone permission is required to start voice assistant.");
        cleanup(state);
        return;
      }
      startWidget(state);
    }

    function close() {
      panel.classList.remove("open");
      fab.setAttribute("aria-pressed", "false");
      cleanup(state);
    }
    state.closePanel = close;

    fab.addEventListener("click", function () {
      if (panel.classList.contains("open")) close();
      else void open();
    });

    closeBtn.addEventListener("click", function () {
      close();
    });

    footer.querySelector("button.primary").addEventListener("click", function () {
      close();
    });

    window.addEventListener("beforeunload", function () {
      if (!state.koraSessionId || !window.KoraVoiceClient || !window.KoraVoiceClient.closeVoiceSession) return;
      try {
        window.KoraVoiceClient.closeVoiceSession({
          business_id: state.businessId,
          kora_session_id: state.koraSessionId,
        });
      } catch (e) {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

