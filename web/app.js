(() => {
  "use strict";

  const API_ROOT = "/admin/api";
  const ROUTES = {
    overview: {
      title: "Overview",
      subtitle: "Your private bridge between Pebble and Umbrel.",
      load: loadOverview,
    },
    devices: {
      title: "Devices",
      subtitle: "Scoped credentials for every Pebble client.",
      load: loadDevices,
    },
    backends: {
      title: "AI backends",
      subtitle: "Private providers behind stable, public model aliases.",
      load: loadBackends,
    },
    speech: {
      title: "Speech to text",
      subtitle: "Private asynchronous transcription on Umbrel.",
      load: loadSpeech,
    },
    recordings: {
      title: "Recordings",
      subtitle: "Audio and transcripts received from your Pebble devices.",
      load: loadRecordings,
    },
    organizer: {
      title: "Notes & reminders",
      subtitle: "Useful, local tools for voice-first assistants.",
      load: loadOrganizer,
    },
  };

  const BACKEND_PRESETS = {
    openclaw: {
      name: "OpenClaw",
      baseUrl: "http://openclaw_gateway_1:18789",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
      healthPath: "/readyz",
      authType: "none",
    },
    hermes: {
      name: "Hermes Agent",
      baseUrl: "http://hermes-agent_web_1:8642",
      chatPath: "/p/pebble/v1/chat/completions",
      modelsPath: "/p/pebble/v1/models",
      healthPath: "/health",
      authType: "bearer",
    },
    generic: {
      name: "OpenAI-compatible backend",
      baseUrl: "",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
      healthPath: "/healthz",
      authType: "bearer",
    },
  };

  const state = {
    route: "overview",
    devices: [],
    backends: [],
    aliases: [],
    recordings: [],
    notes: [],
    reminders: [],
    selectedRecording: null,
    pollTimer: null,
    publicBaseUrl: "",
    publicWebhookUrl: "",
  };

  class ApiError extends Error {
    constructor(message, status = 0, details = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.details = details;
    }
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function node(tag, options = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") {
        element.className = String(value);
      } else if (key === "text") {
        element.textContent = String(value);
      } else if (key === "dataset") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          element.dataset[dataKey] = String(dataValue);
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in element && !key.startsWith("aria")) {
        try {
          element[key] = value;
        } catch {
          element.setAttribute(key, String(value));
        }
      } else {
        element.setAttribute(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  function plainText(value, fallback = "—") {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return fallback;
  }

  function first(object, keys, fallback = undefined) {
    if (!object || typeof object !== "object") return fallback;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null) return value;
    }
    return fallback;
  }

  function nested(object, path, fallback = undefined) {
    const value = path.split(".").reduce((current, key) => {
      if (current && typeof current === "object") return current[key];
      return undefined;
    }, object);
    return value === undefined || value === null ? fallback : value;
  }

  function listFrom(payload, keys = []) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    const candidates = ["items", "data", ...keys];
    for (const key of candidates) {
      if (Array.isArray(payload[key])) return payload[key];
      if (payload[key] && Array.isArray(payload[key].items)) return payload[key].items;
    }
    return [];
  }

  function objectFrom(payload, keys = []) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    for (const key of keys) {
      if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
        return payload[key];
      }
    }
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  }

  function apiMessage(payload, fallback) {
    const error = payload && typeof payload === "object" ? payload.error : null;
    if (typeof error === "string" && error) return error;
    if (error && typeof error.message === "string" && error.message) return error.message;
    if (payload && typeof payload.message === "string" && payload.message) return payload.message;
    return fallback;
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 15000);
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    const method = options.method || "GET";
    if (method !== "GET" && method !== "HEAD") headers.set("X-Pebble-Admin", "1");
    const requestOptions = {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      signal: controller.signal,
    };

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(`${API_ROOT}${path}`, requestOptions);
      setConnection(response.status < 500 ? "connected" : "degraded");
      const contentType = response.headers.get("content-type") || "";
      let payload = null;
      if (response.status !== 204) {
        if (contentType.includes("application/json")) {
          payload = await response.json().catch(() => null);
        } else {
          const body = await response.text().catch(() => "");
          payload = body ? { message: body.slice(0, 500) } : null;
        }
      }
      if (!response.ok) {
        throw new ApiError(apiMessage(payload, `Request failed (${response.status})`), response.status, payload);
      }
      return payload || {};
    } catch (error) {
      if (error instanceof ApiError) throw error;
      setConnection("offline");
      if (error && error.name === "AbortError") {
        throw new ApiError("The server took too long to respond.");
      }
      throw new ApiError("Could not reach the admin API.");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function apiWithMethodFallback(path, body, preferred = "PUT") {
    try {
      return await api(path, { method: preferred, body });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405) && preferred !== "POST") {
        return api(path, { method: "POST", body });
      }
      throw error;
    }
  }

  function setConnection(mode) {
    const wrapper = $("#connection-state");
    if (!wrapper) return;
    const dot = $(".status-dot", wrapper);
    const label = $("span:last-child", wrapper);
    dot.className = "status-dot";
    if (mode === "connected") {
      dot.classList.add("status-healthy");
      label.textContent = "Connected";
      wrapper.title = "Admin API connected";
    } else if (mode === "degraded") {
      dot.classList.add("status-degraded");
      label.textContent = "Degraded";
      wrapper.title = "The admin API responded with a server error";
    } else if (mode === "offline") {
      dot.classList.add("status-error");
      label.textContent = "Offline";
      wrapper.title = "The admin API could not be reached";
    } else {
      dot.classList.add("status-unknown");
      label.textContent = "Checking";
      wrapper.title = "Checking admin API status";
    }
  }

  function formatDate(value, options = {}) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: options.dateStyle || "medium",
        timeStyle: options.timeStyle === false ? undefined : options.timeStyle || "short",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function relativeDate(value) {
    if (!value) return "Never";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "Never";
    const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
    const absolute = Math.abs(deltaSeconds);
    let unit = "second";
    let divisor = 1;
    if (absolute >= 86400) {
      unit = "day";
      divisor = 86400;
    } else if (absolute >= 3600) {
      unit = "hour";
      divisor = 3600;
    } else if (absolute >= 60) {
      unit = "minute";
      divisor = 60;
    }
    try {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(deltaSeconds / divisor), unit);
    } catch {
      return formatDate(value);
    }
  }

  function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function formatLatency(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }

  function safeId(value) {
    return encodeURIComponent(plainText(value, ""));
  }

  function safeLocalUrl(value) {
    if (!value || typeof value !== "string") return "";
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function normalizeStatus(value, fallback = "unknown") {
    const status = plainText(value, fallback).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (["ok", "online", "healthy", "ready", "connected", "up"].includes(status)) return "healthy";
    if (["warning", "degraded", "starting", "transcribing", "received", "pending"].includes(status)) return status;
    if (["error", "failed", "offline", "down", "unhealthy", "unavailable"].includes(status)) return "error";
    if (["disabled", "inactive"].includes(status)) return "disabled";
    return status || fallback;
  }

  function statusBadge(statusValue, labelValue) {
    const raw = plainText(statusValue, "unknown").toLowerCase();
    const normalized = normalizeStatus(raw);
    const className = raw === "received"
      ? "badge-received"
      : raw === "transcribing"
        ? "badge-transcribing"
        : raw === "ready"
          ? "badge-ready"
          : normalized === "healthy"
            ? "badge-success"
            : normalized === "error"
              ? "badge-error"
              : normalized === "disabled"
                ? "badge-disabled"
                : normalized === "degraded" || normalized === "pending" || normalized === "starting"
                  ? "badge-warning"
                  : "badge-neutral";
    return node("span", { class: `badge ${className}`, text: labelValue || raw || "Unknown" });
  }

  function setBusy(button, busy, label = "Working…") {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    }
  }

  function loadingState(compact = false) {
    return node(
      "div",
      { class: `loading-state${compact ? " compact" : ""}`, ariaLabel: "Loading" },
      node("div", { class: "loading-line" }),
      node("div", { class: "loading-line" }),
      node("div", { class: "loading-line" }),
    );
  }

  function emptyState(title, message, icon = "·", compact = false) {
    return node(
      "div",
      { class: `empty-state${compact ? " compact" : ""}` },
      node("div", { class: "empty-icon", text: icon, ariaHidden: "true" }),
      node("strong", { text: title }),
      node("p", { text: message }),
    );
  }

  function errorState(error, retry, compact = false) {
    const wrapper = node(
      "div",
      { class: `error-state${compact ? " compact" : ""}` },
      node("div", { class: "empty-icon", text: "!", ariaHidden: "true" }),
      node("strong", { text: "Could not load this section" }),
      node("p", { text: error instanceof Error ? error.message : "An unexpected error occurred." }),
    );
    if (typeof retry === "function") {
      wrapper.append(node("button", { class: "button button-secondary", type: "button", text: "Try again", onclick: retry }));
    }
    return wrapper;
  }

  function toast(message, type = "info", duration = 4000) {
    const region = $("#toast-region");
    const item = node("div", { class: `toast ${type}` }, node("span", { text: plainText(message, "Done") }));
    region.append(item);
    window.setTimeout(() => item.remove(), duration);
  }

  function copyValue(control) {
    if (!control) return "";
    if (typeof control.value === "string") return control.value;
    return control.textContent || "";
  }

  function showCopiedState(button) {
    if (!button) return;
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      if (button.textContent === "Copied") button.textContent = original;
    }, 1800);
  }

  async function copyText(value, button = null, control = null) {
    const text = plainText(value, "");
    if (!text) {
      toast("Nothing to copy.", "warning");
      return;
    }
    let result;
    try {
      result = await window.PebbleClipboard.copyText({ text, control });
    } catch {
      toast("Could not prepare this value for copying.", "error", 6500);
      return;
    }
    if (result.copied) {
      showCopiedState(button);
      try { button?.focus({ preventScroll: true }); } catch { button?.focus(); }
      toast("Copied to clipboard.", "success");
    } else if (result.selected) {
      toast("Selected — press and hold, then choose Copy.", "warning", 6500);
    } else {
      toast("Could not copy automatically. Select the value and copy it manually.", "error", 6500);
    }
  }

  function showDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function goTo(route) {
    const normalized = ROUTES[route] ? route : "overview";
    if (window.location.hash !== `#${normalized}`) {
      window.location.hash = normalized;
    } else {
      routeChanged();
    }
  }

  function routeChanged() {
    const route = window.location.hash.replace(/^#/, "");
    state.route = ROUTES[route] ? route : "overview";
    if (route !== state.route) history.replaceState(null, "", `#${state.route}`);

    for (const page of $$('[data-page]')) page.hidden = page.dataset.page !== state.route;
    for (const item of $$('[data-route]')) {
      const active = item.dataset.route === state.route;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }

    const config = ROUTES[state.route];
    $("#page-title").textContent = config.title;
    $("#page-subtitle").textContent = config.subtitle;
    closeSidebar();
    stopPolling();
    Promise.resolve(config.load()).catch((error) => toast(error.message || "Could not load the page.", "error"));
    if (state.route === "recordings") startPolling();
  }

  function openSidebar() {
    document.body.classList.add("sidebar-open");
    $("#mobile-menu").setAttribute("aria-expanded", "true");
    $("#sidebar-scrim").hidden = false;
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    $("#mobile-menu").setAttribute("aria-expanded", "false");
    $("#sidebar-scrim").hidden = true;
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = window.setInterval(() => {
      if (state.route === "recordings" && document.visibilityState === "visible") loadRecordings({ quiet: true });
    }, 15000);
  }

  function stopPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function metricCard(label, value, foot, icon) {
    return node(
      "article",
      { class: "metric-card" },
      node("div", { class: "metric-top" }, node("small", { text: label }), node("span", { class: "metric-icon", text: icon, ariaHidden: "true" })),
      node("strong", { class: "metric-value", text: value }),
      node("span", { class: "metric-foot", text: foot }),
    );
  }

  function setCopyField(control, value) {
    if (!control) return;
    control.value = value || "";
    const button = document.querySelector(`[data-copy-target="${control.id}"]`);
    if (button) button.disabled = !value;
  }

  function renderConnectivity(payload) {
    const overview = objectFrom(payload, ["overview"]);
    const connectivity = objectFrom(first(overview, ["connectivity", "network"], overview));
    const publicApi = objectFrom(first(connectivity, ["publicApi", "public_api"], first(overview, ["publicApi"], {})));
    const publicBaseUrl = plainText(
      first(connectivity, ["publicBaseUrl", "public_base_url"], first(overview, ["publicBaseUrl"], "")),
      "",
    );
    const publicHostname = first(connectivity, ["publicHostname", "public_hostname", "hostname"], publicBaseUrl);
    const webhookUrl = plainText(first(publicApi, ["webhookUrl", "webhook_url"], publicBaseUrl ? `${publicBaseUrl}/webhooks/index` : ""), "");
    state.publicBaseUrl = publicBaseUrl;
    state.publicWebhookUrl = webhookUrl;
    $("#public-hostname").textContent = publicHostname ? plainText(publicHostname) : "Set your public HTTPS origin below";
    $("#public-base-url").value = publicBaseUrl;
    setCopyField($("#pebble-webhook-url"), webhookUrl);

    const cloudflare = objectFrom(first(connectivity, ["cloudflare", "tunnel"], first(overview, ["cloudflare"], {})));
    const serviceUrl = plainText(first(cloudflare, ["serviceUrl", "service_url", "publicTarget", "public_target"], "http://pebble-proxy_api_1:8080"));
    setCopyField($("#cloudflare-service-url"), serviceUrl);
    const tunnelStatus = normalizeStatus(first(cloudflare, ["status", "health"], "unknown"));
    const tunnelLabel = tunnelStatus === "healthy"
      ? "Connected"
      : tunnelStatus === "not_checked"
        ? "Not checked"
        : plainText(first(cloudflare, ["status"], "Not checked"));
    const cloudflareBadge = $("#cloudflare-badge");
    cloudflareBadge.replaceWith(statusBadge(tunnelStatus, tunnelLabel));
    const newBadge = $(".panel-header #cloudflare-badge") || $("#page-overview .panel-header .badge");
    if (newBadge) newBadge.id = "cloudflare-badge";

    const publicStatus = normalizeStatus(first(publicApi, ["status", "health"], publicBaseUrl ? "configured" : "unknown"));
    const publicLabel = publicStatus === "healthy" ? "Online" : publicStatus === "configured" ? "Configured" : "Unknown";
    const publicBadge = $("#public-api-status");
    const replacement = statusBadge(publicStatus, publicLabel);
    replacement.id = "public-api-status";
    publicBadge.replaceWith(replacement);
  }

  async function saveConnectivity(form, submitter) {
    setBusy(submitter, true, "Saving…");
    try {
      const response = await api("/connectivity", {
        method: "PUT",
        body: { publicBaseUrl: form.elements.publicBaseUrl.value },
      });
      renderConnectivity(response);
      toast("Public client URLs saved.", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(submitter, false);
    }
  }

  async function loadOverview() {
    const metrics = $("#overview-metrics");
    const activity = $("#overview-activity");
    metrics.replaceChildren(loadingState(true));
    activity.replaceChildren(loadingState(true));

    const [overviewResult, recordingsResult] = await Promise.allSettled([
      api("/overview"),
      api("/recordings?limit=4"),
    ]);

    const overview = overviewResult.status === "fulfilled" ? objectFrom(overviewResult.value, ["overview"]) : {};
    const recordings = recordingsResult.status === "fulfilled"
      ? listFrom(recordingsResult.value, ["recordings"])
      : listFrom(first(overview, ["recentRecordings", "recent_recordings"], []));

    if (overviewResult.status === "rejected" && recordingsResult.status === "rejected") {
      metrics.replaceChildren(errorState(overviewResult.reason, loadOverview, true));
      activity.replaceChildren(errorState(recordingsResult.reason, loadOverview, true));
      return;
    }

    const counts = objectFrom(first(overview, ["counts", "totals"], {}));
    const deviceCount = Number(first(counts, ["devices", "activeDevices", "active_devices"], first(overview, ["deviceCount", "devices"], 0))) || 0;
    const recordingCount = Number(first(counts, ["recordings", "voiceRecordings", "voice_recordings"], first(overview, ["recordingCount"], 0))) || 0;
    const backendCount = Number(first(counts, ["backends", "aiBackends", "ai_backends"], first(overview, ["backendCount"], 0))) || 0;
    const stt = objectFrom(first(overview, ["stt", "speechToText", "speech_to_text"], {}));
    const sttStatus = normalizeStatus(first(stt, ["status", "health"], "unknown"));

    metrics.replaceChildren(
      metricCard("Active devices", String(deviceCount), deviceCount === 1 ? "1 scoped credential" : `${deviceCount} scoped credentials`, "D"),
      metricCard("Recordings", String(recordingCount), "Retained in your private inbox", "R"),
      metricCard("AI backends", String(backendCount), backendCount ? "Available through aliases" : "Add a private provider", "AI"),
      metricCard("Local STT", sttStatus === "healthy" ? "Ready" : sttStatus === "error" ? "Error" : plainText(first(stt, ["status"], "Not set")), plainText(first(stt, ["model"], "No model configured")), "STT"),
    );

    updateRecordingCount(recordingCount);
    renderOverviewActivity(recordings);

    renderConnectivity(overview);
  }

  function renderOverviewActivity(recordings) {
    const container = $("#overview-activity");
    if (!recordings.length) {
      container.replaceChildren(emptyState("No recordings yet", "Voice uploads from Pebble Index will appear here.", "◉", true));
      return;
    }
    const items = recordings.slice(0, 4).map((recording) => {
      const transcript = recordingTranscript(recording, "local") || recordingTranscript(recording, "pebble") || "Recording received";
      const status = plainText(first(recording, ["state", "status"], "received"));
      return node(
        "div",
        { class: "activity-item" },
        node("div", { class: "activity-icon", text: "◉", ariaHidden: "true" }),
        node("div", { class: "activity-copy" }, node("strong", { text: transcript }), node("small", { text: `${plainText(first(recording, ["deviceName", "device_name", "client"], "Pebble"))} · ${relativeDate(first(recording, ["recordedAt", "recorded_at", "createdAt", "created_at"]))}` })),
        statusBadge(status),
      );
    });
    container.replaceChildren(...items);
  }

  async function loadDevices() {
    const container = $("#devices-list");
    container.replaceChildren(loadingState());
    try {
      const response = await api("/devices");
      state.devices = listFrom(response, ["devices"]);
      renderDevices();
    } catch (error) {
      container.replaceChildren(errorState(error, loadDevices));
    }
  }

  function renderDevices() {
    const query = $("#device-search").value.trim().toLowerCase();
    const devices = state.devices.filter((device) => {
      if (!query) return true;
      return [first(device, ["name", "label"]), first(device, ["tokenPrefix", "token_prefix"]), ...(Array.isArray(device.scopes) ? device.scopes : [])]
        .some((value) => plainText(value, "").toLowerCase().includes(query));
    });
    $("#device-total").textContent = `${state.devices.length} ${state.devices.length === 1 ? "device" : "devices"}`;
    const container = $("#devices-list");
    if (!devices.length) {
      container.replaceChildren(emptyState(query ? "No matching devices" : "No device tokens", query ? "Try a different search." : "Create a scoped token for your first Pebble client.", "D"));
      return;
    }

    container.replaceChildren(...devices.map((device) => {
      const id = first(device, ["id", "deviceId", "device_id"]);
      const scopes = Array.isArray(device.scopes) ? device.scopes : [];
      const scopeContainer = node("div", { class: "scope-chips" }, ...scopes.map((scope) => node("span", { class: "scope-chip", text: plainText(scope) })));
      const revoke = node("button", { class: "mini-button mini-button-danger", type: "button", text: "Revoke" });
      revoke.addEventListener("click", () => revokeDevice(id, first(device, ["name", "label"], "this device"), revoke));
      return node(
        "article",
        { class: "data-row device-row" },
        node("div", { class: "row-primary" }, node("strong", { text: plainText(first(device, ["name", "label"]), "Unnamed device") }), node("small", { text: first(device, ["tokenPrefix", "token_prefix"]) ? `Token ${plainText(first(device, ["tokenPrefix", "token_prefix"]))}…` : `Created ${relativeDate(first(device, ["createdAt", "created_at"]))}` })),
        scopeContainer,
        node("div", { class: "row-secondary" }, node("strong", { text: relativeDate(first(device, ["lastUsedAt", "last_used_at"])) }), node("small", { text: "Last used" })),
        node("div", { class: "row-actions" }, statusBadge(first(device, ["status"], first(device, ["revokedAt", "revoked_at"]) ? "disabled" : "healthy"), first(device, ["revokedAt", "revoked_at"]) ? "Revoked" : "Active"), revoke),
      );
    }));
  }

  async function revokeDevice(id, name, button) {
    if (!id) return toast("This device has no identifier.", "error");
    if (!window.confirm(`Revoke the token for ${plainText(name, "this device")}? Existing clients will immediately lose access.`)) return;
    setBusy(button, true, "Revoking…");
    try {
      await api(`/devices/${safeId(id)}`, { method: "DELETE" });
      toast("Device token revoked.", "success");
      await loadDevices();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  }

  async function createDevice(form, submitter) {
    const data = new FormData(form);
    const scopes = data.getAll("scopes").map(String);
    if (!scopes.length) {
      toast("Select at least one capability.", "warning");
      return;
    }
    const button = submitter;
    setBusy(button, true, "Creating…");
    try {
      const response = await api("/devices", {
        method: "POST",
        body: {
          name: plainText(data.get("name"), ""),
          scopes,
          rateLimit: Number(data.get("rateLimit")) || 30,
          expiresIn: plainText(data.get("expiresIn"), "never"),
        },
      });
      const result = objectFrom(response, ["device", "credential"]);
      const token = first(response, ["token", "accessToken", "access_token", "secret"], first(result, ["token", "accessToken", "access_token", "secret"], ""));
      closeDialog($("#device-dialog"));
      form.reset();
      for (const checkbox of $$('input[name="scopes"]', form)) checkbox.checked = true;
      form.elements.rateLimit.value = "30";
      if (token) {
        $("#new-device-token").value = plainText(token, "");
        const tokenWebhook = $("#token-webhook");
        if (state.publicWebhookUrl) {
          $("#new-device-webhook-url").value = state.publicWebhookUrl;
          tokenWebhook.hidden = false;
        } else {
          $("#new-device-webhook-url").value = "";
          tokenWebhook.hidden = true;
        }
        $("#token-saved").checked = false;
        $("#close-token-dialog").disabled = true;
        showDialog($("#token-dialog"));
      } else {
        toast("Device created, but the server did not return a one-time token.", "warning", 6500);
      }
      await loadDevices();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function loadBackends() {
    const backendContainer = $("#backends-list");
    const aliasContainer = $("#aliases-list");
    backendContainer.replaceChildren(loadingState(true));
    aliasContainer.replaceChildren(loadingState(true));
    const [backendResult, aliasResult] = await Promise.allSettled([api("/backends"), api("/model-aliases")]);

    if (backendResult.status === "fulfilled") {
      state.backends = listFrom(backendResult.value, ["backends", "providers"]);
      renderBackends();
    } else {
      backendContainer.replaceChildren(errorState(backendResult.reason, loadBackends));
    }

    if (aliasResult.status === "fulfilled") {
      state.aliases = listFrom(aliasResult.value, ["aliases", "modelAliases", "model_aliases"]);
      renderAliases();
    } else {
      aliasContainer.replaceChildren(errorState(aliasResult.reason, loadBackends));
    }
    populateBackendOptions();
  }

  function renderBackends() {
    const container = $("#backends-list");
    if (!state.backends.length) {
      container.replaceChildren(emptyState("No AI backends", "Add OpenClaw, Hermes, or another OpenAI-compatible service.", "AI"));
      return;
    }

    container.replaceChildren(...state.backends.map((backend) => {
      const id = first(backend, ["id", "backendId", "backend_id"]);
      const type = plainText(first(backend, ["preset", "type", "kind"], "generic"));
      const status = first(backend, ["status", "health", "healthStatus", "health_status"], first(backend, ["enabled"], true) ? "unknown" : "disabled");
      const testButton = node("button", { class: "button button-secondary", type: "button", text: "Test" });
      testButton.addEventListener("click", () => testBackend(id, testButton));
      const removeButton = node("button", { class: "button button-quiet", type: "button", text: "Remove" });
      removeButton.addEventListener("click", () => deleteBackend(id, first(backend, ["name", "label"], "backend"), removeButton));
      const baseUrl = first(backend, ["baseUrl", "base_url", "endpoint"], "Internal endpoint hidden");
      const chatPath = first(backend, ["chatPath", "chat_path"], "/v1/chat/completions");
      return node(
        "article",
        { class: "backend-card" },
        node("div", { class: "backend-card-top" }, node("div", { class: "provider-mark", text: type.slice(0, 3).toUpperCase(), ariaHidden: "true" }), statusBadge(status)),
        node("h3", { text: plainText(first(backend, ["name", "label"]), "Unnamed backend") }),
        node("p", { class: "backend-type", text: `${type} · ${first(backend, ["enabled"], true) ? "enabled" : "disabled"}` }),
        node("code", { class: "endpoint-preview", text: `${plainText(baseUrl)}${plainText(chatPath, "")}` }),
        node("div", { class: "backend-meta" }, node("span", { text: first(backend, ["hasCredential", "has_credential"]) ? "Credential saved" : "No stored credential" }), node("span", { text: first(backend, ["latencyMs", "latency_ms"]) !== undefined ? formatLatency(first(backend, ["latencyMs", "latency_ms"])) : "Not tested" })),
        node("div", { class: "backend-actions" }, testButton, removeButton),
      );
    }));
  }

  function backendName(id) {
    const match = state.backends.find((backend) => String(first(backend, ["id", "backendId", "backend_id"], "")) === String(id));
    return match ? plainText(first(match, ["name", "label"]), "Unknown backend") : "Unknown backend";
  }

  function renderAliases() {
    const container = $("#aliases-list");
    if (!state.aliases.length) {
      container.replaceChildren(emptyState("No model aliases", "Create a safe public model name after adding a backend.", "M"));
      return;
    }
    container.replaceChildren(...state.aliases.map((alias) => {
      const id = first(alias, ["id", "aliasId", "alias_id"]);
      const aliasName = first(alias, ["alias", "name", "publicModel", "public_model"]);
      const backendId = first(alias, ["backendId", "backend_id", "providerId", "provider_id"]);
      const removeButton = node("button", { class: "mini-button mini-button-danger", type: "button", text: "Remove" });
      removeButton.addEventListener("click", () => deleteAlias(id, aliasName, removeButton));
      return node(
        "article",
        { class: "data-row alias-row" },
        node("div", { class: "row-primary" }, node("strong", { text: plainText(aliasName, "Unnamed alias") }), node("small", { text: "Public model alias" })),
        node("div", { class: "row-secondary" }, node("strong", { text: backendName(backendId) }), node("small", { text: "Private backend" })),
        node("div", { class: "row-secondary" }, node("strong", { text: plainText(first(alias, ["downstreamModel", "downstream_model", "targetModel", "target_model"]), "—") }), node("small", { text: "Downstream target" })),
        node("div", { class: "row-actions" }, statusBadge(first(alias, ["enabled"], true) ? "healthy" : "disabled", first(alias, ["enabled"], true) ? "Active" : "Disabled"), removeButton),
      );
    }));
  }

  function populateBackendOptions() {
    const select = $("#alias-backend");
    select.replaceChildren();
    if (!state.backends.length) {
      select.append(node("option", { value: "", text: "Add a backend first", disabled: true, selected: true }));
      return;
    }
    select.append(...state.backends.map((backend) => node("option", {
      value: plainText(first(backend, ["id", "backendId", "backend_id"]), ""),
      text: plainText(first(backend, ["name", "label"]), "Unnamed backend"),
    })));
  }

  async function testBackend(id, button) {
    if (!id) return toast("This backend has no identifier.", "error");
    setBusy(button, true, "Testing…");
    try {
      const response = await api(`/backends/${safeId(id)}/test`, { method: "POST", body: {} , timeout: 30000 });
      const result = objectFrom(response, ["health", "result"]);
      const healthy = first(result, ["ok", "healthy"], normalizeStatus(first(result, ["status"], "unknown")) === "healthy");
      toast(healthy ? `Backend is healthy${first(result, ["latencyMs", "latency_ms"]) !== undefined ? ` (${formatLatency(first(result, ["latencyMs", "latency_ms"]))})` : ""}.` : apiMessage(result, "Backend test completed with a warning."), healthy ? "success" : "warning", 6000);
      await loadBackends();
    } catch (error) {
      toast(error.message, "error", 6000);
    } finally {
      setBusy(button, false);
    }
  }

  async function deleteBackend(id, name, button) {
    if (!id) return toast("This backend has no identifier.", "error");
    if (!window.confirm(`Remove ${plainText(name, "this backend")}? Model aliases using it may stop working.`)) return;
    setBusy(button, true, "Removing…");
    try {
      await api(`/backends/${safeId(id)}`, { method: "DELETE" });
      toast("Backend removed.", "success");
      await loadBackends();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  }

  async function deleteAlias(id, name, button) {
    if (!id) return toast("This alias has no identifier.", "error");
    if (!window.confirm(`Remove model alias ${plainText(name, "")}?`)) return;
    setBusy(button, true, "Removing…");
    try {
      await api(`/model-aliases/${safeId(id)}`, { method: "DELETE" });
      toast("Model alias removed.", "success");
      await loadBackends();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  }

  function applyBackendPreset(presetName) {
    const preset = BACKEND_PRESETS[presetName] || BACKEND_PRESETS.generic;
    const generic = presetName === "generic";
    $("#backend-name").value = preset.name;
    $("#backend-base-url").value = preset.baseUrl;
    $("#backend-chat-path").value = preset.chatPath;
    $("#backend-models-path").value = preset.modelsPath;
    $("#backend-health-path").value = preset.healthPath;
    $("#backend-auth-type").value = preset.authType;
    $("#backend-external-option").hidden = !generic;
    $("#backend-allow-external").disabled = !generic;
    if (!generic) $("#backend-allow-external").checked = false;
    updateBackendAuthFields();
  }

  function updateBackendAuthFields() {
    const type = $("#backend-auth-type").value;
    const credential = $("#backend-credential");
    credential.disabled = type === "none";
    if (type === "none") credential.value = "";
  }

  async function createBackend(form, submitter) {
    const data = new FormData(form);
    const button = submitter;
    setBusy(button, true, "Saving…");
    try {
      await api("/backends", {
        method: "POST",
        body: {
          preset: plainText(data.get("preset"), "generic"),
          name: plainText(data.get("name"), ""),
          baseUrl: plainText(data.get("baseUrl"), ""),
          chatPath: plainText(data.get("chatPath"), "/v1/chat/completions"),
          modelsPath: plainText(data.get("modelsPath"), "/v1/models"),
          healthPath: plainText(data.get("healthPath"), ""),
          credential: plainText(data.get("credential"), ""),
          allowExternal: plainText(data.get("preset"), "generic") === "generic" && data.get("allowExternal") === "on",
          enabled: data.get("enabled") === "on",
        },
      });
      closeDialog($("#backend-dialog"));
      form.reset();
      applyBackendPreset("openclaw");
      toast("AI backend saved.", "success");
      await loadBackends();
    } catch (error) {
      toast(error.message, "error", 6000);
    } finally {
      setBusy(button, false);
    }
  }

  async function createAlias(form, submitter) {
    const data = new FormData(form);
    const button = submitter;
    setBusy(button, true, "Adding…");
    try {
      await api("/model-aliases", {
        method: "POST",
        body: {
          alias: plainText(data.get("alias"), ""),
          backendId: plainText(data.get("backendId"), ""),
          downstreamModel: plainText(data.get("downstreamModel"), ""),
        },
      });
      closeDialog($("#alias-dialog"));
      form.reset();
      toast("Model alias added.", "success");
      await loadBackends();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function loadSpeech() {
    try {
      const response = await api("/stt");
      const settings = objectFrom(response, ["settings", "stt", "provider"]);
      fillSttForm(settings);
      const health = objectFrom(first(response, ["health", "providerHealth", "provider_health"], first(settings, ["health"], {})), ["health"]);
      renderSttHealth(health);
    } catch (error) {
      renderSttHealth({ status: "error", message: error.message });
      toast(error.message, "error");
    }
  }

  function fillSttForm(settings) {
    if (!settings || typeof settings !== "object") return;
    $("#stt-enabled").checked = Boolean(first(settings, ["enabled"], false));
    const mappings = [
      ["#stt-base-url", ["baseUrl", "base_url", "endpoint"]],
      ["#stt-transcription-path", ["transcriptionPath", "transcription_path"]],
      ["#stt-health-path", ["healthPath", "health_path"]],
      ["#stt-model", ["model", "modelId", "model_id"]],
      ["#stt-language", ["language"]],
    ];
    for (const [selector, keys] of mappings) {
      const value = first(settings, keys);
      if (value !== undefined && value !== null && String(value) !== "") $(selector).value = String(value);
    }
    $("#stt-credential").value = "";
    $("#stt-clear-credential").checked = false;
    $("#stt-credential").placeholder = first(settings, ["hasCredential", "has_credential"]) ? "Credential saved — leave blank to keep" : "Leave blank if LocalAI has no API key";
  }

  function renderSttHealth(health) {
    const status = normalizeStatus(first(health, ["status", "state"], first(health, ["ok", "healthy"], false) ? "healthy" : "unknown"));
    const dot = $("#stt-health-dot");
    const label = $("#stt-health-label");
    const orb = $("#stt-health-orb");
    dot.className = "status-dot";
    orb.className = "health-orb";
    if (status === "healthy") {
      dot.classList.add("status-healthy");
      orb.classList.add("healthy");
      label.textContent = "Healthy";
      $("#stt-health-title").textContent = "LocalAI is ready";
    } else if (status === "error") {
      dot.classList.add("status-error");
      orb.classList.add("error");
      label.textContent = "Unavailable";
      $("#stt-health-title").textContent = "LocalAI needs attention";
    } else if (["degraded", "starting", "pending", "received", "transcribing"].includes(status)) {
      dot.classList.add("status-degraded");
      label.textContent = "Degraded";
      $("#stt-health-title").textContent = "LocalAI is not fully ready";
    } else {
      dot.classList.add("status-unknown");
      label.textContent = "Not checked";
      $("#stt-health-title").textContent = "Waiting for a health check";
    }
    $("#stt-health-message").textContent = plainText(first(health, ["message", "detail", "error"], status === "healthy" ? "The private transcription service is accepting work." : "Save the settings and test the private connection."));
    const details = $("#stt-health-details");
    const pairs = [
      ["Last checked", formatDate(first(health, ["checkedAt", "checked_at", "lastCheckedAt", "last_checked_at"]))],
      ["Latency", formatLatency(first(health, ["latencyMs", "latency_ms"]))],
      ["Model", plainText(first(health, ["model", "modelId", "model_id"]))],
    ];
    details.replaceChildren(...pairs.map(([term, value]) => node("div", { class: "detail-pair" }, node("dt", { text: term }), node("dd", { text: value }))));
  }

  async function saveStt(form, submitter) {
    const data = new FormData(form);
    setBusy(submitter, true, "Saving…");
    try {
      const response = await apiWithMethodFallback("/stt", {
        enabled: data.get("enabled") === "on",
        provider: "localai",
        baseUrl: plainText(data.get("baseUrl"), ""),
        transcriptionPath: plainText(data.get("transcriptionPath"), "/v1/audio/transcriptions"),
        healthPath: plainText(data.get("healthPath"), "/readyz"),
        model: plainText(data.get("model"), ""),
        language: plainText(data.get("language"), ""),
        credential: plainText(data.get("credential"), ""),
        clearCredential: data.get("clearCredential") === "on",
      });
      $("#stt-credential").value = "";
      $("#stt-clear-credential").checked = false;
      toast("Speech-to-text settings saved.", "success");
      const health = objectFrom(first(response, ["health"], {}), ["health"]);
      if (Object.keys(health).length) renderSttHealth(health);
      else await loadSpeech();
    } catch (error) {
      toast(error.message, "error", 6000);
    } finally {
      setBusy(submitter, false);
    }
  }

  function sttHealthFromResponse(response) {
    const settings = objectFrom(response, ["settings", "stt", "provider"]);
    return objectFrom(first(response, ["health", "providerHealth", "provider_health"], {
      status: first(settings, ["healthStatus", "health_status", "status"], "unknown"),
      checkedAt: first(settings, ["lastHealthAt", "last_health_at"]),
      error: first(settings, ["lastError", "last_error"]),
      model: first(settings, ["model"]),
    }), ["health"]);
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function testStt(button) {
    setBusy(button, true, "Testing…");
    try {
      const initialResponse = await api("/stt");
      const initialHealth = sttHealthFromResponse(initialResponse);
      const baselineStatus = plainText(first(initialHealth, ["status", "state"], "unknown"), "unknown").toLowerCase();
      const baselineCheckedAt = plainText(first(initialHealth, ["checkedAt", "checked_at", "lastCheckedAt", "last_checked_at"]), "");

      await api("/stt/test", { method: "POST", body: {} });
      renderSttHealth({
        status: "pending",
        message: "The private LocalAI health check is running…",
        checkedAt: baselineCheckedAt || null,
        model: first(initialHealth, ["model"]),
      });

      const deadline = Date.now() + 30000;
      let latestHealth = initialHealth;
      let lastPollError = null;
      while (Date.now() < deadline) {
        await wait(1000);
        try {
          const currentResponse = await api("/stt", { timeout: 7000 });
          latestHealth = sttHealthFromResponse(currentResponse);
          lastPollError = null;
        } catch (error) {
          lastPollError = error;
          continue;
        }

        const currentStatus = plainText(first(latestHealth, ["status", "state"], "unknown"), "unknown").toLowerCase();
        const currentCheckedAt = plainText(first(latestHealth, ["checkedAt", "checked_at", "lastCheckedAt", "last_checked_at"]), "");
        const changed = currentStatus !== baselineStatus || (currentCheckedAt && currentCheckedAt !== baselineCheckedAt);
        if (!changed) continue;

        renderSttHealth(latestHealth);
        const normalized = normalizeStatus(currentStatus);
        toast(
          normalized === "healthy" ? "LocalAI is healthy." : apiMessage(latestHealth, "LocalAI is not ready."),
          normalized === "healthy" ? "success" : "warning",
          6000,
        );
        return;
      }

      renderSttHealth(latestHealth);
      toast(lastPollError ? `Health check timed out: ${lastPollError.message}` : "The health check is still pending. Try again in a moment.", "warning", 7000);
    } catch (error) {
      renderSttHealth({ status: "error", message: error.message, checkedAt: new Date().toISOString() });
      toast(error.message, "error", 6000);
    } finally {
      setBusy(button, false);
    }
  }

  function recordingTranscript(recording, source) {
    const directKeys = source === "pebble"
      ? ["pebbleTranscript", "pebble_transcript", "providedTranscript", "provided_transcript", "transcription"]
      : ["localTranscript", "local_transcript", "sttTranscript", "stt_transcript", "generatedTranscript", "generated_transcript"];
    const direct = first(recording, directKeys);
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const transcripts = Array.isArray(recording.transcripts) ? recording.transcripts : [];
    const match = transcripts.find((entry) => {
      const entrySource = plainText(first(entry, ["source", "kind", "provider"], "")).toLowerCase();
      return source === "pebble" ? entrySource.includes("pebble") || entrySource.includes("provided") : entrySource.includes("local") || entrySource.includes("stt");
    });
    return match ? plainText(first(match, ["text", "transcript", "content"]), "") : "";
  }

  function recordingAudio(recording) {
    const audio = recording && typeof recording.audio === "object" && !Array.isArray(recording.audio)
      ? recording.audio
      : null;
    const url = safeLocalUrl(audio?.url || "");
    return { hasAudio: Boolean(url), url, audio };
  }

  async function loadRecordings(options = {}) {
    const container = $("#recordings-list");
    if (!options.quiet) container.replaceChildren(loadingState());
    try {
      const response = await api("/recordings?limit=100");
      state.recordings = listFrom(response, ["recordings"]);
      renderRecordings();
      updateRecordingCount(state.recordings.length);
    } catch (error) {
      if (!options.quiet) container.replaceChildren(errorState(error, loadRecordings));
    }
  }

  function updateRecordingCount(count) {
    const numeric = Number(count) || 0;
    const nav = $("#recordings-nav-count");
    nav.textContent = numeric > 99 ? "99+" : String(numeric);
    nav.hidden = numeric === 0;
  }

  function renderRecordings() {
    const query = $("#recording-search").value.trim().toLowerCase();
    const filter = $("#recording-status").value;
    const filtered = state.recordings.filter((recording) => {
      const status = plainText(first(recording, ["state", "status"], "received")).toLowerCase();
      if (filter && status !== filter) return false;
      if (!query) return true;
      return [
        first(recording, ["deviceName", "device_name", "client"]),
        recordingTranscript(recording, "pebble"),
        recordingTranscript(recording, "local"),
        first(recording, ["id", "recordingId", "recording_id"]),
      ].some((value) => plainText(value, "").toLowerCase().includes(query));
    });
    $("#recording-total").textContent = `${state.recordings.length} ${state.recordings.length === 1 ? "recording" : "recordings"}`;
    const container = $("#recordings-list");
    if (!filtered.length) {
      container.replaceChildren(emptyState(query || filter ? "No matching recordings" : "No voice recordings", query || filter ? "Change the search or state filter." : "Authenticated webhook uploads will appear here.", "◉"));
      return;
    }

    container.replaceChildren(...filtered.map((recording) => {
      const id = first(recording, ["id", "recordingId", "recording_id"]);
      const status = first(recording, ["state", "status"], "received");
      const { hasAudio } = recordingAudio(recording);
      const transcript = recordingTranscript(recording, "local") || recordingTranscript(recording, "pebble") || "No transcript yet";
      const viewButton = node("button", { class: "mini-button", type: "button", text: "View" });
      viewButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openRecording(id);
      });
      const actions = [viewButton];
      if (hasAudio && plainText(status).toLowerCase() === "error") {
        const retryButton = node("button", { class: "mini-button", type: "button", text: "Retry" });
        retryButton.addEventListener("click", (event) => {
          event.stopPropagation();
          retryRecording(id, retryButton);
        });
        actions.unshift(retryButton);
      }
      const row = node(
        "article",
        { class: "data-row recording-row", tabindex: 0, role: "button", ariaLabel: `Open recording from ${plainText(first(recording, ["deviceName", "device_name", "client"]), "Pebble")}` },
        node("div", { class: "row-primary" }, node("strong", { text: plainText(first(recording, ["title", "deviceName", "device_name", "client"]), "Pebble recording") }), node("small", { text: formatDate(first(recording, ["recordedAt", "recorded_at", "createdAt", "created_at"])) })),
        statusBadge(status),
        node("div", { class: "recording-snippet", text: transcript }),
        node("div", { class: "row-secondary" }, node("strong", { text: hasAudio ? formatDuration(first(recording, ["durationSeconds", "duration_seconds", "duration"])) : "Transcript only" }), node("small", { text: hasAudio ? "Duration" : "No audio" })),
        node("div", { class: "row-actions" }, ...actions),
      );
      row.addEventListener("click", () => openRecording(id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openRecording(id);
        }
      });
      return row;
    }));
  }

  async function openRecording(id) {
    if (!id) return toast("This recording has no identifier.", "error");
    const dialog = $("#recording-dialog");
    const detail = $("#recording-detail");
    detail.replaceChildren(loadingState());
    showDialog(dialog);
    const cached = state.recordings.find((recording) => String(first(recording, ["id", "recordingId", "recording_id"], "")) === String(id));
    if (cached) renderRecordingDetail(cached);
    try {
      const response = await api(`/recordings/${safeId(id)}`);
      const recording = objectFrom(response, ["recording"]);
      state.selectedRecording = recording;
      renderRecordingDetail(recording);
    } catch (error) {
      if (!cached) detail.replaceChildren(errorState(error, () => openRecording(id)));
      else toast(`Showing cached details: ${error.message}`, "warning", 6000);
    }
  }

  function renderRecordingDetail(recording) {
    const detail = $("#recording-detail");
    const id = first(recording, ["id", "recordingId", "recording_id"]);
    const status = first(recording, ["state", "status"], "received");
    const { hasAudio, url: audioUrl } = recordingAudio(recording);
    const pebbleTranscript = recordingTranscript(recording, "pebble");
    const localTranscript = recordingTranscript(recording, "local");
    const closeButton = node("button", { class: "icon-button modal-close", type: "button", text: "×", ariaLabel: "Close" });
    closeButton.addEventListener("click", () => closeDialog($("#recording-dialog")));

    const recordingMeta = [
      node("span", { text: formatDate(first(recording, ["recordedAt", "recorded_at", "createdAt", "created_at"])) }),
      hasAudio ? node("span", { text: formatDuration(first(recording, ["durationSeconds", "duration_seconds", "duration"])) }) : node("span", { text: "Transcript only" }),
      node("span", { text: id ? `ID ${plainText(id)}` : "" }),
    ];
    const header = node(
      "div",
      { class: "recording-detail-head" },
      node("div", {}, statusBadge(status), node("h2", { text: plainText(first(recording, ["title", "deviceName", "device_name", "client"]), "Pebble recording") }), node("div", { class: "recording-detail-meta" }, ...recordingMeta)),
      closeButton,
    );

    const audioWrap = hasAudio
      ? node("div", { class: "audio-wrap" }, node("audio", { controls: true, preload: "metadata", src: audioUrl }))
      : null;

    const transcriptCard = (title, source, textValue) => {
      const copyButton = node("button", { class: "copy-button", type: "button", text: "Copy", disabled: !textValue });
      copyButton.addEventListener("click", () => copyText(textValue, copyButton));
      return node(
        "section",
        { class: "transcript-card" },
        node("header", {}, node("h3", { text: title }), node("div", {}, statusBadge(textValue ? "healthy" : "pending", textValue ? source : "Unavailable"), copyButton)),
        node("p", { class: textValue ? "" : "transcript-empty", text: textValue || (source === "Pebble" ? "Pebble did not include a transcript." : "Local transcription has not completed.") }),
      );
    };

    const transcriptGrid = node("div", { class: "transcript-grid" }, transcriptCard("Pebble-provided transcript", "Pebble", pebbleTranscript), transcriptCard("Locally generated transcript", "Local STT", localTranscript));
    const parts = [header];
    if (audioWrap) parts.push(audioWrap);
    parts.push(transcriptGrid);
    const errorMessage = first(recording, ["lastError", "last_error", "errorMessage", "error_message", "error"]);
    if (errorMessage) parts.push(node("div", { class: "error-detail", text: plainText(typeof errorMessage === "object" ? first(errorMessage, ["message", "code"]) : errorMessage, "Transcription failed.") }));

    const deleteButton = node("button", { class: "button button-danger", type: "button", text: "Delete recording" });
    deleteButton.addEventListener("click", () => deleteRecording(id, deleteButton));
    const secondaryActions = [];
    if (hasAudio) {
      const retryButton = node("button", { class: "button button-secondary", type: "button", text: "Retry transcription", disabled: plainText(status).toLowerCase() === "transcribing" });
      retryButton.addEventListener("click", () => retryRecording(id, retryButton, true));
      secondaryActions.push(retryButton);
    }
    secondaryActions.push(node("button", { class: "button button-primary", type: "button", text: "Close", onclick: () => closeDialog($("#recording-dialog")) }));
    parts.push(node("div", { class: "recording-actions" }, node("div", {}, deleteButton), node("div", {}, ...secondaryActions)));
    detail.replaceChildren(...parts);
  }

  async function retryRecording(id, button, refreshDetail = false) {
    if (!id) return toast("This recording has no identifier.", "error");
    setBusy(button, true, "Queuing…");
    try {
      await api(`/recordings/${safeId(id)}/retry`, { method: "POST", body: {} });
      toast("Transcription queued for retry.", "success");
      await loadRecordings({ quiet: state.route !== "recordings" });
      if (refreshDetail && $("#recording-dialog").open) await openRecording(id);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function deleteRecording(id, button) {
    if (!id) return toast("This recording has no identifier.", "error");
    if (!window.confirm("Permanently delete this audio file and all associated transcripts? This cannot be undone.")) return;
    setBusy(button, true, "Deleting…");
    try {
      await api(`/recordings/${safeId(id)}`, { method: "DELETE" });
      closeDialog($("#recording-dialog"));
      toast("Recording deleted.", "success");
      await loadRecordings();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  }

  async function loadOrganizer() {
    const notesContainer = $("#notes-list");
    const remindersContainer = $("#reminders-list");
    notesContainer.replaceChildren(loadingState(true));
    remindersContainer.replaceChildren(loadingState(true));
    const [notesResult, remindersResult, devicesResult] = await Promise.allSettled([api("/notes"), api("/reminders"), api("/devices")]);
    if (devicesResult.status === "fulfilled") {
      state.devices = listFrom(devicesResult.value, ["devices"]);
    } else {
      state.devices = [];
      toast("Could not load devices for notes and reminders.", "warning");
    }
    populateOrganizerDeviceOptions();
    if (notesResult.status === "fulfilled") {
      state.notes = listFrom(notesResult.value, ["notes"]);
      renderNotes();
    } else {
      notesContainer.replaceChildren(errorState(notesResult.reason, loadOrganizer, true));
    }
    if (remindersResult.status === "fulfilled") {
      state.reminders = listFrom(remindersResult.value, ["reminders"]);
      renderReminders();
    } else {
      remindersContainer.replaceChildren(errorState(remindersResult.reason, loadOrganizer, true));
    }
  }

  function activeDevices() {
    const now = Date.now();
    return state.devices.filter((device) => {
      if (first(device, ["revokedAt", "revoked_at"])) return false;
      const expiresAt = first(device, ["expiresAt", "expires_at"]);
      return !expiresAt || !Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() > now;
    });
  }

  function populateOrganizerDeviceOptions() {
    const devices = activeDevices();
    for (const select of [$("#note-device"), $("#reminder-device")]) {
      const previous = select.value;
      const placeholder = node("option", {
        value: "",
        text: devices.length ? "Select an active device" : "No active devices — create one first",
        disabled: true,
        selected: true,
      });
      const options = devices.map((device) => node("option", {
        value: plainText(first(device, ["id", "deviceId", "device_id"]), ""),
        text: plainText(first(device, ["name", "label"]), "Unnamed device"),
      }));
      select.replaceChildren(placeholder, ...options);
      if (previous && options.some((option) => option.value === previous)) select.value = previous;
    }
  }

  function renderNotes() {
    const container = $("#notes-list");
    if (!state.notes.length) {
      container.replaceChildren(emptyState("No notes yet", "Ask your Pebble assistant to remember something, or add a note here.", "N", true));
      return;
    }
    container.replaceChildren(...state.notes.map((noteItem) => {
      const id = first(noteItem, ["id", "noteId", "note_id"]);
      const remove = node("button", { class: "item-delete", type: "button", text: "×", ariaLabel: "Delete note", title: "Delete note" });
      remove.addEventListener("click", () => deleteOrganizerItem("notes", id, first(noteItem, ["title"], "note"), remove));
      return node(
        "article",
        { class: "note-item" },
        node("h4", { text: plainText(first(noteItem, ["title", "name"]), "Untitled note") }),
        node("p", { text: plainText(first(noteItem, ["body", "content", "text"]), "") }),
        node("div", { class: "note-meta" }, node("span", { text: relativeDate(first(noteItem, ["updatedAt", "updated_at", "createdAt", "created_at"])) }), first(noteItem, ["deviceName", "device_name"]) ? node("span", { text: `· ${plainText(first(noteItem, ["deviceName", "device_name"]))}` }) : null),
        remove,
      );
    }));
  }

  function renderReminders() {
    const container = $("#reminders-list");
    if (!state.reminders.length) {
      container.replaceChildren(emptyState("No reminders", "Create one here or through an approved MCP voice command.", "R", true));
      return;
    }
    container.replaceChildren(...state.reminders.map((reminder) => {
      const id = first(reminder, ["id", "reminderId", "reminder_id"]);
      const completed = Boolean(first(reminder, ["completed", "isCompleted", "is_completed", "completedAt", "completed_at"], false)) || plainText(first(reminder, ["status"], "")).toLowerCase() === "completed";
      const dueAt = first(reminder, ["dueAt", "due_at", "scheduledAt", "scheduled_at"]);
      const overdue = !completed && dueAt && new Date(dueAt).getTime() < Date.now();
      const check = node("button", { class: "reminder-check", type: "button", text: "✓", ariaLabel: completed ? "Mark reminder incomplete" : "Mark reminder complete" });
      check.addEventListener("click", () => toggleReminder(id, !completed, check));
      const remove = node("button", { class: "item-delete", type: "button", text: "×", ariaLabel: "Delete reminder", title: "Delete reminder" });
      remove.addEventListener("click", () => deleteOrganizerItem("reminders", id, first(reminder, ["title", "text"], "reminder"), remove));
      return node(
        "article",
        { class: `reminder-item${completed ? " completed" : ""}` },
        check,
        node("h4", { text: plainText(first(reminder, ["title", "text", "body"]), "Untitled reminder") }),
        node("div", { class: `reminder-meta${overdue ? " due-overdue" : ""}` }, node("span", { text: completed ? "Completed" : overdue ? `Overdue · ${formatDate(dueAt)}` : formatDate(dueAt) }), first(reminder, ["deviceName", "device_name"]) ? node("span", { text: `· ${plainText(first(reminder, ["deviceName", "device_name"]))}` }) : null),
        remove,
      );
    }));
  }

  async function createNote(form, submitter) {
    const data = new FormData(form);
    setBusy(submitter, true, "Saving…");
    try {
      await api("/notes", { method: "POST", body: { deviceId: plainText(data.get("deviceId"), ""), title: plainText(data.get("title"), ""), body: plainText(data.get("body"), "") } });
      closeDialog($("#note-dialog"));
      form.reset();
      toast("Note saved.", "success");
      await loadOrganizer();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(submitter, false);
    }
  }

  async function createReminder(form, submitter) {
    const data = new FormData(form);
    const dueAtValue = plainText(data.get("dueAt"), "");
    const dueDate = dueAtValue ? new Date(dueAtValue) : null;
    setBusy(submitter, true, "Saving…");
    try {
      await api("/reminders", { method: "POST", body: { deviceId: plainText(data.get("deviceId"), ""), title: plainText(data.get("title"), ""), dueAt: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate.toISOString() : dueAtValue } });
      closeDialog($("#reminder-dialog"));
      form.reset();
      toast("Reminder saved.", "success");
      await loadOrganizer();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(submitter, false);
    }
  }

  async function toggleReminder(id, completed, button) {
    if (!id) return toast("This reminder has no identifier.", "error");
    button.disabled = true;
    try {
      await apiWithMethodFallback(`/reminders/${safeId(id)}`, { completed }, "PATCH");
      await loadOrganizer();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }

  async function deleteOrganizerItem(resource, id, name, button) {
    if (!id) return toast("This item has no identifier.", "error");
    if (!window.confirm(`Delete ${plainText(name, `this ${resource === "notes" ? "note" : "reminder"}`)}?`)) return;
    button.disabled = true;
    try {
      await api(`/${resource}/${safeId(id)}`, { method: "DELETE" });
      toast(resource === "notes" ? "Note deleted." : "Reminder deleted.", "success");
      await loadOrganizer();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }

  function bindFormDialog(formSelector, handler) {
    const form = $(formSelector);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = event.submitter;
      if (submitter && submitter.value === "cancel") {
        closeDialog(form.closest("dialog"));
        return;
      }
      if (!form.reportValidity()) return;
      handler(form, submitter).catch((error) => toast(error.message || "The request failed.", "error"));
    });
  }

  function bindEvents() {
    window.addEventListener("hashchange", routeChanged);
    $("#mobile-menu").addEventListener("click", openSidebar);
    $("#sidebar-scrim").addEventListener("click", closeSidebar);
    $("#refresh-button").addEventListener("click", () => {
      const button = $("#refresh-button");
      const svg = $("svg", button);
      svg.classList.add("spin");
      Promise.resolve(ROUTES[state.route].load()).finally(() => window.setTimeout(() => svg.classList.remove("spin"), 350));
    });

    for (const button of $$('[data-go]')) button.addEventListener("click", () => goTo(button.dataset.go));
    for (const button of $$('[data-copy-target]')) {
      button.addEventListener("click", () => {
        const target = document.getElementById(button.dataset.copyTarget);
        copyText(copyValue(target), button, target);
      });
    }

    $("#device-search").addEventListener("input", renderDevices);
    $("#recording-search").addEventListener("input", renderRecordings);
    $("#recording-status").addEventListener("change", renderRecordings);

    $("#open-device-dialog").addEventListener("click", () => showDialog($("#device-dialog")));
    $("#open-backend-dialog").addEventListener("click", () => {
      $("#backend-form").reset();
      applyBackendPreset("openclaw");
      showDialog($("#backend-dialog"));
    });
    $("#open-alias-dialog").addEventListener("click", () => {
      populateBackendOptions();
      showDialog($("#alias-dialog"));
    });
    $("#open-note-dialog").addEventListener("click", () => showDialog($("#note-dialog")));
    $("#open-reminder-dialog").addEventListener("click", () => showDialog($("#reminder-dialog")));

    $("#token-saved").addEventListener("change", (event) => {
      $("#close-token-dialog").disabled = !event.target.checked;
    });
    $("#close-token-dialog").addEventListener("click", () => {
      $("#new-device-token").value = "";
      $("#new-device-webhook-url").value = "";
      $("#token-webhook").hidden = true;
      closeDialog($("#token-dialog"));
    });
    $("#token-dialog").addEventListener("cancel", (event) => {
      if (!$("#token-saved").checked) {
        event.preventDefault();
        toast("Confirm that you saved the token before closing.", "warning");
      }
    });

    for (const dialog of $$("dialog.modal")) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog && dialog.id !== "token-dialog") closeDialog(dialog);
      });
    }

    for (const radio of $$('input[name="preset"]', $("#backend-form"))) {
      radio.addEventListener("change", () => {
        if (radio.checked) applyBackendPreset(radio.value);
      });
    }
    $("#backend-auth-type").addEventListener("change", updateBackendAuthFields);
    $("#test-stt").addEventListener("click", (event) => testStt(event.currentTarget));

    bindFormDialog("#device-form", createDevice);
    bindFormDialog("#connectivity-form", saveConnectivity);
    bindFormDialog("#backend-form", createBackend);
    bindFormDialog("#alias-form", createAlias);
    bindFormDialog("#note-form", createNote);
    bindFormDialog("#reminder-form", createReminder);

    $("#stt-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      saveStt(event.currentTarget, event.submitter).catch((error) => toast(error.message, "error"));
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.route === "recordings") loadRecordings({ quiet: true });
    });
  }

  function init() {
    bindEvents();
    setConnection("checking");
    applyBackendPreset("openclaw");
    routeChanged();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
