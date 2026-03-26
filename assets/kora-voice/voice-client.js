/* Static-site voice client helpers (xAI realtime via Kora backend bootstrap). */
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
      throw new Error("Failed to create voice session: " + r.status + " " + t);
    }
    return await r.json();
  }

  window.KoraVoiceClient = {
    isVoiceEnabled: isVoiceEnabled,
    createVoiceSession: createVoiceSession,
  };
})();

/* Static-site voice client helpers (xAI realtime via Kora backend bootstrap). */
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
      throw new Error("Failed to create voice session: " + r.status + " " + t);
    }
    return await r.json();
  }

  window.KoraVoiceClient = {
    isVoiceEnabled: isVoiceEnabled,
    createVoiceSession: createVoiceSession,
  };
})();

