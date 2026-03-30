(function () {
  function cfg() {
    return (typeof window !== "undefined" && window.KORA_CONFIG) || {};
  }

  function apiBaseUrl() {
    var b = (cfg().apiBaseUrl || "").toString();
    return b.replace(/\/+$/, "");
  }

  function isVoiceEnabled() {
    try {
      return !!(cfg().features && cfg().features.voice && cfg().features.voice.enabled === true);
    } catch (e) {
      return false;
    }
  }

  async function createVoiceSession(opts) {
    var base = apiBaseUrl();
    if (!base) throw new Error("Missing apiBaseUrl");
    var body = {
      business_id: (opts && opts.business_id) || "",
      locale: (opts && opts.locale) || "auto",
      page_context: (opts && opts.page_context) || null,
    };
    var r = await fetch(base + "/api/v1/public/voice/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      var t = await r.text().catch(function () { return ""; });
      try {
        console.warn("[KoraVoice] session bootstrap failed", r.status, t);
      } catch (logErr) {}
      throw new Error(
        "Voice assistant isn't available right now. Please try again later.",
      );
    }
    return await r.json();
  }

  async function closeVoiceSession(opts) {
    var base = apiBaseUrl();
    if (!base) throw new Error("Missing apiBaseUrl");
    var businessId = ((opts && opts.business_id) || "").toString();
    var koraSessionId = ((opts && opts.kora_session_id) || "").toString();
    if (!businessId || !koraSessionId) return;
    await fetch(base + "/api/v1/public/voice/session/" + encodeURIComponent(koraSessionId) + "/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: businessId }),
      keepalive: true,
    });
  }

  window.KoraVoiceClient = {
    isVoiceEnabled: isVoiceEnabled,
    createVoiceSession: createVoiceSession,
    closeVoiceSession: closeVoiceSession,
  };
})();

