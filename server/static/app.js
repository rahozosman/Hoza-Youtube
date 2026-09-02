/* Hoza YT - dashboard
 *
 * One page, eleven views. Job state arrives over server-sent events, so the
 * interface updates as work progresses without polling the backend.
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const state = {
    view: "dashboard",
    settings: null,
    schema: null,
    analysis: null,
    kind: "video",
    selection: null,
    jobs: [],
    stats: {},
    queueFilter: "all",
    servers: [],
    connected: false,
    events: null,
  };

  // ------------------------------------------------------------------ api --

  async function api(path, options = {}) {
    const config = { headers: {}, ...options };
    if (config.body !== undefined && typeof config.body !== "string") {
      config.headers["Content-Type"] = "application/json";
      config.body = JSON.stringify(config.body);
    }
    const response = await fetch(`/api/${path}`, config);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error((payload && payload.error) || `Request failed (${response.status})`);
      error.code = (payload && payload.code) || "error";
      error.hint = payload && payload.hint;
      error.retryable = Boolean(payload && payload.retryable);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  // --------------------------------------------------------------- format --

  function bytes(value) {
    if (!value && value !== 0) return null;
    if (value === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let number = Number(value);
    let index = 0;
    while (number >= 1024 && index < units.length - 1) {
      number /= 1024;
      index += 1;
    }
    return index === 0 ? `${Math.round(number)} B` : `${number.toFixed(1)} ${units[index]}`;
  }

  function duration(seconds) {
    if (!seconds && seconds !== 0) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function when(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} d ago`;
    return date.toLocaleDateString();
  }

  function clock(timestamp) {
    if (!timestamp) return "";
    return new Date(timestamp * 1000).toLocaleString();
  }

  // --------------------------------------------------------------- toasts --

  function toast(title, message, kind = "") {
    const node = el("div", `toast ${kind}`);
    node.appendChild(el("strong", null, title));
    if (message) node.appendChild(el("p", null, message));
    $("toasts").appendChild(node);
    setTimeout(() => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 240);
    }, kind === "err" ? 7000 : 4200);
  }

  function reportError(error) {
    toast(error.message || "Something went wrong", error.hint || "", "err");
  }

  // ---------------------------------------------------------------- modal --

  function openModal(title, bodyNode, buttons = []) {
    $("modal-title").textContent = title;
    const body = $("modal-body");
    body.textContent = "";
    body.appendChild(bodyNode);
    const foot = $("modal-foot");
    foot.textContent = "";
    for (const button of buttons) {
      const node = el("button", `btn ${button.cls || "ghost"} sm`, button.label);
      node.onclick = button.onClick;
      foot.appendChild(node);
    }
    $("modal").hidden = false;
  }

  function closeModal() {
    $("modal").hidden = true;
  }

  // -------------------------------------------------------------- routing --

  const TITLES = {
    dashboard: ["Dashboard", "Overview of downloads, servers and storage"],
    download: ["Download", "Paste a link, analyse it, and choose a quality"],
    video: ["Video", "Video output settings and the streams this media offers"],
    audio: ["Audio", "Audio output settings and the streams this media offers"],
    queue: ["Queue", "Active, waiting and finished jobs"],
    history: ["History", "Everything that finished, with filters and search"],
    servers: ["Servers", "Health, failover and remote workers"],
    settings: ["Settings", "Shared with the browser extension"],
    diagnostics: ["Diagnostics", "Real checks against every component"],
    logs: ["Logs", "Structured records from the backend"],
    about: ["About", "Version and project information"],
  };

  function go(view) {
    if (!TITLES[view]) view = "dashboard";
    state.view = view;
    for (const node of document.querySelectorAll(".view")) {
      node.classList.toggle("active", node.id === `view-${view}`);
    }
    for (const node of document.querySelectorAll(".nav-item")) {
      node.classList.toggle("active", node.dataset.view === view);
    }
    const [title, sub] = TITLES[view];
    $("page-title").textContent = title;
    $("page-sub").textContent = sub;
    $("sidebar").classList.remove("open");
    $("scrim").hidden = true;
    if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);

    if (view === "history") loadHistory();
    if (view === "servers") loadServers();
    if (view === "logs") loadLogs();
    if (view === "about") loadAbout();
    if (view === "video" || view === "audio") renderStreamLists();
    if (view === "dashboard") loadSystemPanel();
  }

  // ------------------------------------------------------------- settings --

  function readPath(object, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), object);
  }

  function optionList(select, values, labels = null) {
    select.textContent = "";
    for (const value of values) {
      const option = el("option", null, labels ? labels[value] || String(value) : String(value));
      option.value = String(value);
      select.appendChild(option);
    }
  }

  const LABELS = {
    presets: { best: "Best Quality", recommended: "Recommended", compatibility: "Best Compatibility", saver: "Data Saver", custom: "Custom" },
    video_codecs: { auto: "Automatic", avc1: "AVC (H.264)", vp9: "VP9", av01: "AV1" },
    sample_rates: { original: "Original", 44100: "44.1 kHz", 48000: "48 kHz" },
    channels: { original: "Original", stereo: "Stereo", mono: "Mono" },
    subtitle_modes: { off: "Do not download", download: "Separate file", embed: "Embed", both: "Both" },
    themes: { dark: "Dark", light: "Light", system: "System" },
    queue_behaviour: { fifo: "First in, first out", lifo: "Newest first", "smallest-first": "Smallest first" },
    duplicate_policies: { rename: "Add a number", skip: "Skip", replace: "Replace" },
    audio_formats: { m4a: "M4A (AAC)", mp3: "MP3", opus: "Opus", flac: "FLAC", wav: "WAV", vorbis: "Vorbis" },
    containers: { mp4: "MP4", mkv: "MKV", webm: "WebM" },
  };

  function populateChoices() {
    const options = state.schema.options;
    const resolutions = options.resolutions.map(String);

    optionList($("v-container"), options.containers, LABELS.containers);
    optionList($("v-codec"), options.video_codecs, LABELS.video_codecs);
    optionList($("v-res"), resolutions);
    optionList($("v-fps"), ["original"], { original: "Original (no re-encoding)" });
    optionList($("a-format"), options.audio_formats, LABELS.audio_formats);
    optionList($("a-rate"), options.sample_rates, LABELS.sample_rates);
    optionList($("a-channels"), options.channels, LABELS.channels);
    optionList($("s-quality"), resolutions);
    optionList($("s-preset"), options.presets, LABELS.presets);
    optionList($("s-submode"), options.subtitle_modes, LABELS.subtitle_modes);
    optionList($("s-subfmt"), options.subtitle_formats);
    optionList($("s-dup"), options.duplicate_policies, LABELS.duplicate_policies);
    optionList($("s-queue"), options.queue_behaviour, LABELS.queue_behaviour);
    optionList($("s-theme"), options.themes, LABELS.themes);
    $("template-tokens").textContent = `Tokens: ${options.filename_tokens.join(" ")}`;

    if (!options.audio_formats.length) {
      $("a-format").innerHTML = "<option>ffmpeg not available</option>";
      $("a-format").disabled = true;
    }
    updateBitrateChoices();
  }

  function updateBitrateChoices() {
    const format = state.settings.audio.format;
    const rates = state.schema.options.audio_bitrates[format] || [];
    const select = $("a-bitrate");
    if (!rates.length) {
      select.innerHTML = "<option>Not applicable</option>";
      select.disabled = true;
      $("a-bitrate-help").textContent = `${format.toUpperCase()} is lossless, so no bitrate applies.`;
      return;
    }
    select.disabled = false;
    optionList(select, rates.map((r) => String(r)));
    const current = String(state.settings.audio.bitrate);
    select.value = rates.map(String).includes(current) ? current : String(rates[rates.length - 2] || rates[0]);
    $("a-bitrate-help").textContent = `Values available for ${format.toUpperCase()}.`;
  }

  function applySettingsToInputs() {
    for (const node of document.querySelectorAll("[data-cfg]")) {
      const value = readPath(state.settings, node.dataset.cfg);
      if (value === undefined) continue;
      if (node.type === "checkbox") node.checked = Boolean(value);
      else node.value = String(value);
    }
    applyInterface();
    updateTemplatePreview();
  }

  function applyInterface() {
    const ui = state.settings.interface;
    const theme = ui.theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : ui.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.animations = String(ui.animations);
    document.documentElement.dataset.compact = String(ui.compact);
  }

  function updateTemplatePreview() {
    const template = state.settings.filename.template || "";
    const sample = template
      .replace(/\{title\}/g, "How Lenses Bend Light")
      .replace(/\{quality\}/g, "1080")
      .replace(/\{channel\}|\{uploader\}/g, "Optics Lab")
      .replace(/\{id\}/g, "abc123")
      .replace(/\{codec\}/g, "avc1")
      .replace(/\{resolution\}/g, "1920x1080")
      .replace(/\{fps\}/g, "30")
      .replace(/\{date\}/g, "2026-09-02")
      .replace(/\{duration\}/g, "635")
      .replace(/\{ext\}/g, state.settings.video.container || "mp4");
    $("template-preview").textContent = sample ? `Example: ${sample}` : "";
  }

  let saveTimer = null;
  const pending = {};

  function queueSave(path, value) {
    const [section, key] = path.split(".");
    pending[section] = pending[section] || {};
    pending[section][key] = value;
    $("save-state").textContent = "Saving";
    $("save-state").className = "pill busy";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 420);
  }

  async function flushSave() {
    const payload = JSON.parse(JSON.stringify(pending));
    for (const key of Object.keys(pending)) delete pending[key];
    if (!Object.keys(payload).length) return;
    try {
      const result = await api("settings", { method: "PUT", body: payload });
      state.settings = result.settings;
      state.schema = result.schema;
      applyInterface();
      updateTemplatePreview();
      $("save-state").textContent = "Saved";
      $("save-state").className = "pill ok";
      if (payload.audio && payload.audio.format) updateBitrateChoices();
    } catch (error) {
      $("save-state").textContent = "Not saved";
      $("save-state").className = "pill err";
      reportError(error);
      await loadSettings();
    }
  }

  function bindSettingInputs() {
    for (const node of document.querySelectorAll("[data-cfg]")) {
      const path = node.dataset.cfg;
      const handler = () => {
        let value;
        if (node.type === "checkbox") value = node.checked;
        else if (node.type === "number") value = Number(node.value);
        else value = node.value;
        const [section, key] = path.split(".");
        if (typeof readPath(state.settings, path) === "number") value = Number(value);
        state.settings[section][key] = value;
        if (path === "interface.theme" || path.startsWith("interface.")) applyInterface();
        if (path === "filename.template") updateTemplatePreview();
        queueSave(path, value);
      };
      node.addEventListener(node.tagName === "SELECT" || node.type === "checkbox" ? "change" : "input", handler);
    }
  }

  async function loadSettings() {
    const result = await api("settings");
    state.settings = result.settings;
    state.schema = result.schema;
    populateChoices();
    applySettingsToInputs();
  }

  // -------------------------------------------------------------- analysis --

  function setAnalyzeState(node) {
    const host = $("analyze-state");
    host.textContent = "";
    if (node) host.appendChild(node);
  }

  function busyNode(text) {
    const row = el("div", "row");
    row.appendChild(el("span", "spinner"));
    row.appendChild(el("span", "muted", text));
    return row;
  }

  function errorNode(error) {
    const box = el("div", "job-error");
    box.appendChild(el("strong", null, error.message));
    if (error.hint) box.appendChild(el("div", "hint", error.hint));
    if (error.retryable) {
      const retry = el("button", "btn ghost sm", "Try again");
      retry.style.marginTop = "9px";
      retry.onclick = () => analyze(currentUrl(), true);
      box.appendChild(retry);
    }
    return box;
  }

  function currentUrl() {
    return ($("url-input-2").value || $("url-input").value || "").trim();
  }

  async function analyze(url, refresh = false) {
    url = (url || "").trim();
    if (!url) {
      toast("Paste a link first", "The address bar is empty.", "warn");
      return;
    }
    $("url-input").value = url;
    $("url-input-2").value = url;
    go("download");
    $("media-panel").hidden = true;
    setAnalyzeState(busyNode("Analysing the link and reading available formats"));
    for (const button of [$("analyze-btn"), $("analyze-btn-2")]) button.disabled = true;
    try {
      const analysis = await api("analyze", { method: "POST", body: { url, refresh } });
      state.analysis = analysis;
      state.selection = null;
      setAnalyzeState(null);
      renderMedia();
      renderStreamLists();
      if (state.settings.general.auto_download) {
        const preset = analysis.presets.find((p) => p.id === state.settings.general.default_preset)
          || analysis.presets[0];
        if (preset) {
          choosePreset(preset);
          startDownload();
        }
      }
    } catch (error) {
      state.analysis = null;
      setAnalyzeState(errorNode(error));
    } finally {
      for (const button of [$("analyze-btn"), $("analyze-btn-2")]) button.disabled = false;
    }
  }

  function renderMedia() {
    const media = state.analysis;
    $("media-panel").hidden = false;
    $("m-thumb").src = media.thumbnail || "";
    $("m-thumb").alt = media.title || "";
    $("m-title").textContent = media.title;
    $("m-desc").textContent = media.description || "";

    const meta = $("m-meta");
    meta.textContent = "";
    const chips = [];
    if (media.uploader) chips.push(media.uploader);
    if (media.duration_string || media.duration) chips.push(media.duration_string || duration(media.duration));
    if (media.view_count) chips.push(`${media.view_count.toLocaleString()} views`);
    if (media.extractor) chips.push(media.extractor);
    if (media.cached) chips.push("cached result");
    for (const chip of chips) meta.appendChild(el("span", "pill", chip));

    const facts = $("m-facts");
    facts.textContent = "";
    const rows = [
      ["Video streams", `${media.video.length} across ${media.heights.length} resolution(s)`],
      ["Audio streams", String(media.audio.length)],
      ["Subtitles", media.subtitles.length ? `${media.subtitles.length} track(s)` : "none offered"],
      ["Chapters", media.chapters ? String(media.chapters) : "none"],
      ["HDR", media.video.some((v) => v.hdr) ? "available" : "not offered"],
      ["Upload date", media.upload_date
        ? `${media.upload_date.slice(0, 4)}-${media.upload_date.slice(4, 6)}-${media.upload_date.slice(6, 8)}`
        : "unknown"],
    ];
    for (const [key, value] of rows) {
      facts.appendChild(el("dt", null, key));
      facts.appendChild(el("dd", null, value));
    }

    $("m-open-source").onclick = () => window.open(media.webpage_url, "_blank", "noopener");
    renderSubtitles();
    renderPresets();
    renderQualities();
  }

  function renderSubtitles() {
    const media = state.analysis;
    const card = $("subs-card");
    if (!media.subtitles.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $("sub-mode").value = state.settings.subtitles.mode;
    const select = $("sub-lang");
    select.textContent = "";
    for (const track of media.subtitles) {
      const option = el("option", null,
        `${track.name} (${track.language})${track.auto_generated ? " - automatic" : ""}`);
      option.value = track.language;
      select.appendChild(option);
    }
    const preferred = state.settings.subtitles.languages.split(",")[0].trim();
    if ([...select.options].some((o) => o.value === preferred)) select.value = preferred;

    const list = $("sub-list");
    list.textContent = "";
    const manual = media.subtitles.filter((t) => !t.auto_generated).length;
    const auto = media.subtitles.length - manual;
    if (manual) list.appendChild(el("span", "pill ok", `${manual} written track(s)`));
    if (auto) list.appendChild(el("span", "pill", `${auto} automatic track(s)`));
  }

  function renderPresets() {
    const host = $("preset-opts");
    host.textContent = "";
    if (state.kind === "audio") {
      const tiers = state.analysis.audio_tiers || [];
      if (!tiers.length) {
        host.appendChild(emptyNode("No audio streams", "This media does not offer a separate audio track."));
        return;
      }
      for (const tier of tiers) {
        host.appendChild(optionCard({
          title: tier.label,
          detail: [tier.codec, tier.abr ? `${Math.round(tier.abr)} kbps` : null,
            tier.asr ? `${(tier.asr / 1000).toFixed(1)} kHz` : null, tier.channel_label]
            .filter(Boolean).join(" / "),
          size: tier.size_human,
          estimated: tier.size_estimated,
          note: tier.note,
          onClick: () => chooseAudio(tier),
          selected: state.selection && state.selection.audioId === tier.format_id,
        }));
      }
      return;
    }
    const presets = state.analysis.presets || [];
    if (!presets.length) {
      host.appendChild(emptyNode("No presets available", "Choose a quality from the list below."));
      return;
    }
    for (const preset of presets) {
      host.appendChild(optionCard({
        title: preset.label,
        detail: preset.summary,
        size: preset.size_human,
        estimated: preset.size_estimated,
        note: preset.reason,
        tag: preset.id === "recommended" ? "Suggested" : null,
        recommended: preset.id === "recommended",
        onClick: () => choosePreset(preset),
        selected: state.selection && state.selection.presetId === preset.id,
      }));
    }
  }

  function optionCard(spec) {
    const node = el("button", `opt${spec.selected ? " selected" : ""}${spec.recommended ? " recommended" : ""}`);
    const title = el("div", "t");
    title.appendChild(document.createTextNode(spec.title));
    if (spec.tag) title.appendChild(el("span", `tag${spec.tagKind ? " " + spec.tagKind : ""}`, spec.tag));
    node.appendChild(title);
    if (spec.detail) node.appendChild(el("div", "d", spec.detail));
    if (spec.size) {
      node.appendChild(el("div", "s", `${spec.estimated ? "about " : ""}${spec.size}`));
    } else {
      node.appendChild(el("div", "s muted", "size not reported"));
    }
    if (spec.note) node.appendChild(el("div", "d", spec.note));
    node.onclick = spec.onClick;
    return node;
  }

  function emptyNode(title, message) {
    const node = el("div", "empty");
    node.appendChild(el("h3", null, title));
    node.appendChild(el("p", null, message));
    return node;
  }

  function renderQualities() {
    const host = $("quality-opts");
    host.textContent = "";
    const media = state.analysis;
    if (state.kind === "audio") {
      $("custom-title").textContent = "All audio streams";
      $("custom-count").textContent = `${media.audio.length} stream(s)`;
      for (const stream of media.audio) {
        host.appendChild(optionCard({
          title: stream.abr ? `${Math.round(stream.abr)} kbps` : "Audio",
          detail: [stream.codec, stream.ext, stream.asr ? `${(stream.asr / 1000).toFixed(1)} kHz` : null,
            stream.channel_label].filter(Boolean).join(" / "),
          size: stream.filesize_human,
          estimated: stream.filesize_estimated,
          tag: stream.drc ? "DRC" : null,
          onClick: () => chooseAudio(stream),
          selected: state.selection && state.selection.audioId === stream.format_id,
        }));
      }
      return;
    }
    $("custom-title").textContent = "All video qualities";
    $("custom-count").textContent = `${media.video.length} stream(s)`;
    for (const stream of media.video) {
      host.appendChild(optionCard({
        title: stream.label,
        detail: [stream.codec, stream.fps ? `${Math.round(stream.fps)} FPS` : null,
          (stream.ext || "").toUpperCase(), stream.muxed ? "includes audio" : null]
          .filter(Boolean).join(" / "),
        size: stream.filesize_human,
        estimated: stream.filesize_estimated,
        tag: stream.hdr ? (stream.dynamic_range || "HDR") : null,
        tagKind: stream.hdr ? "hdr" : null,
        onClick: () => chooseVideo(stream),
        selected: state.selection && state.selection.videoId === stream.format_id,
      }));
    }
  }

  function choosePreset(preset) {
    state.selection = {
      kind: "video",
      preset: preset.id,
      presetId: preset.id,
      videoId: preset.video_format_id,
      audioId: preset.audio_format_id,
      summary: preset.summary,
      size: preset.size_human,
      estimated: preset.size_estimated,
    };
    renderPresets();
    renderQualities();
    updateSelectionSummary();
  }

  function chooseVideo(stream) {
    const audio = stream.muxed ? null : bestAudioStream();
    const parts = [stream.label, stream.codec, stream.fps ? `${Math.round(stream.fps)} FPS` : null,
      state.settings.video.container.toUpperCase()].filter(Boolean);
    const size = (stream.filesize || 0) + ((audio && audio.filesize) || 0);
    state.selection = {
      kind: "video",
      preset: "custom",
      presetId: null,
      videoId: stream.format_id,
      audioId: audio ? audio.format_id : null,
      summary: parts.join(" / "),
      size: size ? bytes(size) : null,
      estimated: stream.filesize_estimated || (audio && audio.filesize_estimated),
    };
    renderPresets();
    renderQualities();
    updateSelectionSummary();
  }

  function chooseAudio(stream) {
    state.selection = {
      kind: "audio",
      preset: "custom",
      presetId: stream.id || null,
      videoId: null,
      audioId: stream.format_id,
      summary: [stream.codec, stream.abr ? `${Math.round(stream.abr)} kbps` : null,
        `to ${state.settings.audio.format.toUpperCase()}`].filter(Boolean).join(" / "),
      size: stream.size_human || stream.filesize_human,
      estimated: stream.size_estimated || stream.filesize_estimated,
    };
    renderPresets();
    renderQualities();
    updateSelectionSummary();
  }

  function bestAudioStream() {
    const list = (state.analysis.audio || []).filter((a) => !a.drc);
    if (!list.length) return null;
    return list.reduce((best, item) => ((item.abr || 0) > (best.abr || 0) ? item : best), list[0]);
  }

  function updateSelectionSummary() {
    const host = $("selection-summary");
    host.textContent = "";
    if (!state.selection) {
      host.className = "muted";
      host.textContent = "Choose a quality above.";
      $("start-btn").disabled = true;
      return;
    }
    host.className = "";
    const line = el("div", "row wrap");
    line.appendChild(el("span", "pill busy", state.selection.kind === "audio" ? "Audio" : "Video"));
    line.appendChild(el("strong", null, state.selection.summary));
    if (state.selection.size) {
      line.appendChild(el("span", "muted",
        `${state.selection.estimated ? "about " : ""}${state.selection.size}`));
    }
    host.appendChild(line);
    if (state.selection.kind === "video" && state.selection.audioId) {
      host.appendChild(el("div", "muted", "Video and audio will be merged with ffmpeg."));
    }
    $("start-btn").disabled = false;
  }

  async function startDownload() {
    if (!state.analysis || !state.selection) return;
    const button = $("start-btn");
    button.disabled = true;
    try {
      const body = {
        url: state.analysis.webpage_url,
        selection: {
          kind: state.selection.kind,
          preset: state.selection.preset,
          video_format_id: state.selection.videoId,
          audio_format_id: state.selection.audioId,
          container: state.settings.video.container,
          prefer_hdr: state.settings.video.prefer_hdr,
        },
      };
      if (!$("subs-card").hidden) {
        body.subtitle_mode = $("sub-mode").value;
        const language = $("sub-lang").value;
        if (language && body.subtitle_mode !== "off") {
          await api("settings", { method: "PUT", body: { subtitles: { languages: language } } });
        }
      }
      const job = await api("jobs", { method: "POST", body });
      toast("Added to the queue", job.title || state.analysis.title, "ok");
      go("queue");
    } catch (error) {
      reportError(error);
    } finally {
      button.disabled = false;
    }
  }

  // -------------------------------------------------- video / audio views --

  function renderStreamLists() {
    const media = state.analysis;
    for (const [host, pill, kind] of [
      ["video-streams", "video-src-pill", "video"],
      ["audio-streams", "audio-src-pill", "audio"],
    ]) {
      const node = $(host);
      node.textContent = "";
      if (!media) {
        $(pill).textContent = "No analysis yet";
        $(pill).className = "pill";
        const empty = emptyNode("Nothing analysed yet",
          "Paste a link on the Download page to see the streams this media offers.");
        const button = el("button", "btn ghost sm", "Go to Download");
        button.style.marginTop = "12px";
        button.onclick = () => go("download");
        empty.appendChild(button);
        node.appendChild(empty);
        continue;
      }
      const streams = kind === "video" ? media.video : media.audio;
      $(pill).textContent = `${media.title.slice(0, 46)}${media.title.length > 46 ? "..." : ""}`;
      $(pill).className = "pill ok";
      if (!streams.length) {
        node.appendChild(emptyNode(`No ${kind} streams`, `This media offers no ${kind} track.`));
        continue;
      }
      const grid = el("div", "opts");
      for (const stream of streams) {
        grid.appendChild(optionCard(kind === "video" ? {
          title: stream.label,
          detail: [stream.codec, stream.fps ? `${Math.round(stream.fps)} FPS` : null,
            (stream.ext || "").toUpperCase(), stream.muxed ? "includes audio" : "video only"]
            .filter(Boolean).join(" / "),
          size: stream.filesize_human,
          estimated: stream.filesize_estimated,
          tag: stream.hdr ? (stream.dynamic_range || "HDR") : null,
          tagKind: stream.hdr ? "hdr" : null,
          onClick: () => { state.kind = "video"; syncKindSeg(); chooseVideo(stream); go("download"); },
        } : {
          title: stream.abr ? `${Math.round(stream.abr)} kbps` : "Audio",
          detail: [stream.codec, stream.ext, stream.asr ? `${(stream.asr / 1000).toFixed(1)} kHz` : null,
            stream.channel_label].filter(Boolean).join(" / "),
          size: stream.filesize_human,
          estimated: stream.filesize_estimated,
          tag: stream.drc ? "DRC" : null,
          onClick: () => { state.kind = "audio"; syncKindSeg(); chooseAudio(stream); go("download"); },
        }));
      }
      node.appendChild(grid);
    }
  }

  function syncKindSeg() {
    for (const button of document.querySelectorAll("#kind-seg button")) {
      button.classList.toggle("active", button.dataset.kind === state.kind);
    }
  }

  // ------------------------------------------------------------------ jobs --

  const STATUS_KIND = {
    completed: "ok", failed: "err", cancelled: "err",
    downloading: "busy", processing: "warn", analyzing: "busy",
    finalizing: "warn", queued: "", paused: "warn",
  };

  const STATUS_TEXT = {
    queued: "Waiting", analyzing: "Analyzing", downloading: "Downloading",
    processing: "Processing", finalizing: "Finalizing", completed: "Completed",
    failed: "Failed", cancelled: "Cancelled", paused: "Paused",
  };

  function jobNode(job, compact = false) {
    const node = el("div", "job clickable");
    const thumb = job.thumbnail
      ? Object.assign(el("img", "job-thumb"), { src: job.thumbnail, alt: "", loading: "lazy" })
      : el("div", "job-thumb placeholder", job.kind === "audio" ? "♪" : "▶");
    node.appendChild(thumb);

    const body = el("div", "job-body");
    body.appendChild(el("div", "job-title truncate", job.title || job.url));

    const line = el("div", "job-line");
    line.appendChild(el("span", `pill ${STATUS_KIND[job.status] || ""}`, STATUS_TEXT[job.status] || job.status));
    if (job.quality_label) line.appendChild(el("span", "pill", job.quality_label));
    if (job.server && job.server !== "local") line.appendChild(el("span", "pill", job.server));

    const actions = el("div", "job-actions");
    const add = (label, handler, cls = "ghost") => {
      const button = el("button", `btn ${cls} sm`, label);
      button.onclick = (event) => { event.stopPropagation(); handler(); };
      actions.appendChild(button);
    };
    if (["downloading", "analyzing", "queued"].includes(job.status)) {
      add("Pause", () => jobAction(job.id, "pause"));
      add("Cancel", () => jobAction(job.id, "cancel"));
    } else if (job.status === "paused") {
      add("Resume", () => jobAction(job.id, "resume"));
      add("Cancel", () => jobAction(job.id, "cancel"));
    } else if (job.status === "completed") {
      if (!compact) {
        add("Open", () => openFile(job.filepath));
        add("Show", () => revealFile(job.filepath));
      }
      add("Remove", () => removeJob(job.id));
    } else {
      add("Retry", () => jobAction(job.id, "retry"));
      add("Remove", () => removeJob(job.id));
    }
    line.appendChild(actions);
    body.appendChild(line);

    const active = ["downloading", "processing", "analyzing", "finalizing"].includes(job.status);
    const bar = el("div", `bar ${job.status}${active && !job.progress ? " indeterminate" : ""}`);
    const fill = el("i");
    fill.style.width = `${job.status === "completed" ? 100 : job.progress || 0}%`;
    bar.appendChild(fill);
    body.appendChild(bar);

    const facts = el("div", "job-facts");
    const parts = [];
    if (job.status === "downloading") {
      if (job.total) parts.push(`${bytes(job.downloaded)} of ${bytes(job.total)}`);
      if (job.speed) parts.push(`${bytes(job.speed)}/s`);
      if (job.eta != null) parts.push(`${duration(job.eta)} left`);
      parts.push(`${Math.round(job.progress || 0)}%`);
    } else if (job.status === "processing") {
      parts.push(job.detail || "Processing with ffmpeg");
    } else if (job.status === "completed") {
      if (job.filesize) parts.push(bytes(job.filesize));
      if (job.filename) parts.push(job.filename);
      if (job.finished_at) parts.push(when(job.finished_at));
    } else if (job.status === "queued") {
      parts.push("waiting for a worker slot");
    }
    for (const part of parts) facts.appendChild(el("span", null, part));
    body.appendChild(facts);

    if (job.error && job.status !== "cancelled") {
      const box = el("div", "job-error");
      box.appendChild(el("strong", null, job.error));
      if (job.error_hint) box.appendChild(el("div", "hint", job.error_hint));
      body.appendChild(box);
    }

    node.appendChild(body);
    node.onclick = () => showJobDetails(job);
    return node;
  }

  async function jobAction(id, action) {
    try {
      await api(`jobs/${id}/${action}`, { method: "POST" });
      if (action === "retry") toast("Retrying", "The job was queued again.");
    } catch (error) {
      reportError(error);
    }
    refreshJobs();
  }

  async function removeJob(id) {
    try {
      await api(`jobs/${id}`, { method: "DELETE" });
      toast("Removed from the list", "The downloaded file was left in place.");
    } catch (error) {
      reportError(error);
    }
    refreshJobs();
  }

  async function openFile(path) {
    try {
      await api("system/open-file", { method: "POST", body: { path } });
    } catch (error) {
      reportError(error);
    }
  }

  async function revealFile(path) {
    try {
      await api("system/reveal", { method: "POST", body: { path } });
    } catch (error) {
      reportError(error);
    }
  }

  function showJobDetails(job) {
    const list = el("dl", "kv");
    const rows = [
      ["Job ID", job.id],
      ["Status", STATUS_TEXT[job.status] || job.status],
      ["Source", job.url],
      ["Type", job.kind],
      ["Requested", job.quality_label || "-"],
      ["Format selector", job.format_selector || "-"],
      ["Actual format", job.actual_format || "not yet known"],
      ["Server", job.server || "local"],
      ["Attempts", String(job.attempts || 0)],
      ["Created", clock(job.created_at)],
      ["Started", job.started_at ? clock(job.started_at) : "not started"],
      ["Finished", job.finished_at ? clock(job.finished_at) : "not finished"],
      ["Processing time", job.processing_ms ? `${(job.processing_ms / 1000).toFixed(1)} s` : "-"],
      ["Downloaded", job.downloaded ? bytes(job.downloaded) : "-"],
      ["Output file", job.filepath || "not written yet"],
      ["File size", job.filesize ? bytes(job.filesize) : "-"],
    ];
    if (job.error) rows.push(["Error", job.error]);
    if (job.error_hint) rows.push(["Suggestion", job.error_hint]);
    for (const [key, value] of rows) {
      list.appendChild(el("dt", null, key));
      list.appendChild(el("dd", null, String(value)));
    }
    const buttons = [];
    if (job.status === "completed" && job.filepath) {
      buttons.push({ label: "Open file", cls: "", onClick: () => { openFile(job.filepath); closeModal(); } });
      buttons.push({ label: "Show in folder", onClick: () => { revealFile(job.filepath); closeModal(); } });
      buttons.push({ label: "Copy path", onClick: () => copyText(job.filepath) });
      buttons.push({ label: "Download again", onClick: () => { jobAction(job.id, "retry"); closeModal(); } });
    }
    if (["failed", "cancelled"].includes(job.status)) {
      buttons.push({ label: "Retry", cls: "", onClick: () => { jobAction(job.id, "retry"); closeModal(); } });
    }
    buttons.push({ label: "Close", onClick: closeModal });
    openModal(job.title || "Job details", list, buttons);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "The path is on your clipboard.", "ok");
    } catch {
      toast("Could not copy", "Your browser blocked clipboard access.", "warn");
    }
  }

  function renderJobs() {
    const filter = state.queueFilter;
    const list = state.jobs.filter((job) => {
      if (filter === "all") return true;
      if (filter === "active") return ["queued", "analyzing", "downloading", "processing", "finalizing", "paused"].includes(job.status);
      if (filter === "completed") return job.status === "completed";
      if (filter === "failed") return ["failed", "cancelled"].includes(job.status);
      return true;
    });
    const host = $("job-list");
    host.textContent = "";
    if (!list.length) {
      host.appendChild(emptyNode("Nothing here",
        filter === "all" ? "Downloads you start will appear here." : "No jobs match this filter."));
    } else {
      for (const job of list) host.appendChild(jobNode(job));
    }

    const recent = $("recent-jobs");
    recent.textContent = "";
    const latest = state.jobs.slice(0, 4);
    if (!latest.length) {
      recent.appendChild(emptyNode("No downloads yet", "Paste a link above to start."));
    } else {
      for (const job of latest) recent.appendChild(jobNode(job, true));
    }

    const stats = state.stats || {};
    $("stat-active").textContent = stats.active || 0;
    $("stat-queued").textContent = stats.queued || 0;
    $("stat-completed").textContent = stats.completed || 0;
    $("stat-failed").textContent = stats.failed || 0;
    $("stat-speed").textContent = stats.total_speed_human ? `${stats.total_speed_human} total` : "idle";
    const activeCount = (stats.active || 0) + (stats.queued || 0);
    $("nav-queue-count").textContent = activeCount ? String(activeCount) : "";
  }

  async function refreshJobs() {
    try {
      const result = await api("jobs?limit=100");
      state.jobs = result.jobs;
      state.stats = result.stats;
      renderJobs();
    } catch (error) {
      // A failed refresh is not worth a toast; the connection pill shows it.
    }
  }

  // ---------------------------------------------------------------- events --

  function connectEvents() {
    if (state.events) state.events.close();
    const source = new EventSource("/api/events");
    state.events = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      source.close();
      setTimeout(connectEvents, 3000);
    };
    source.onmessage = (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      handleEvent(payload);
    };
  }

  function handleEvent(payload) {
    const { event, data } = payload;
    if (event === "snapshot") {
      state.jobs = data.jobs;
      state.stats = data.stats;
      renderJobs();
      return;
    }
    if (event === "job:created" || event === "job:updated" || event === "job:progress") {
      const index = state.jobs.findIndex((job) => job.id === data.id);
      if (index >= 0) state.jobs[index] = data;
      else state.jobs.unshift(data);
      if (event === "job:updated" && data.status === "completed") {
        toast("Download complete", data.filename || data.title || "", "ok");
      }
      if (event === "job:updated" && data.status === "failed") {
        toast("Download failed", data.error || "", "err");
      }
      recomputeStats();
      renderJobs();
      return;
    }
    if (event === "job:removed" || event === "jobs:cleared") {
      refreshJobs();
      return;
    }
    if (event === "settings:changed") {
      state.settings = data.settings;
      applySettingsToInputs();
      return;
    }
    if (event === "extension:handoff") {
      toast("Link received from the extension", data.title || data.url);
      analyze(data.url);
    }
  }

  function recomputeStats() {
    const counts = {};
    let speed = 0;
    for (const job of state.jobs) {
      counts[job.status] = (counts[job.status] || 0) + 1;
      if (job.status === "downloading" && job.speed) speed += job.speed;
    }
    state.stats = {
      ...state.stats,
      counts,
      active: (counts.downloading || 0) + (counts.processing || 0) + (counts.analyzing || 0) + (counts.finalizing || 0),
      queued: counts.queued || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      total_speed: speed,
      total_speed_human: speed ? `${bytes(speed)}/s` : null,
    };
  }

  function setConnected(connected) {
    state.connected = connected;
    const pill = $("backend-pill");
    pill.className = `pill ${connected ? "ok" : "err"}`;
    pill.textContent = "";
    pill.appendChild(el("span", "dot"));
    pill.appendChild(document.createTextNode(connected ? " Connected" : " Offline"));
  }

  // --------------------------------------------------------------- history --

  let historyTimer = null;

  async function loadHistory() {
    const params = new URLSearchParams();
    const search = $("hist-search").value.trim();
    if (search) params.set("search", search);
    if ($("hist-kind").value) params.set("kind", $("hist-kind").value);
    if ($("hist-status").value) params.set("status", $("hist-status").value);
    params.set("sort", $("hist-sort").value);
    params.set("limit", "100");
    try {
      const result = await api(`history?${params}`);
      const body = $("history-body");
      body.textContent = "";
      $("h-total").textContent = result.stats.total;
      $("h-completed").textContent = result.stats.completed;
      $("h-failed").textContent = result.stats.failed;
      $("h-bytes").textContent = bytes(result.stats.bytes) || "0 B";
      if (!result.entries.length) {
        const row = el("tr");
        const cell = el("td", "muted", "No records match these filters.");
        cell.colSpan = 7;
        cell.style.textAlign = "center";
        cell.style.padding = "30px";
        row.appendChild(cell);
        body.appendChild(row);
        return;
      }
      for (const entry of result.entries) {
        const row = el("tr");
        const title = el("td");
        title.appendChild(el("div", "truncate", entry.title || entry.url));
        title.style.maxWidth = "300px";
        if (entry.uploader) title.appendChild(el("div", "muted truncate", entry.uploader));
        row.appendChild(title);
        row.appendChild(el("td", null, entry.kind));
        row.appendChild(el("td", null, entry.quality || "-"));
        row.appendChild(el("td", null, bytes(entry.filesize) || "-"));
        const status = el("td");
        status.appendChild(el("span", `pill ${STATUS_KIND[entry.status] || ""}`,
          STATUS_TEXT[entry.status] || entry.status));
        row.appendChild(status);
        row.appendChild(el("td", "muted", when(entry.created_at)));
        const actions = el("td");
        const group = el("div", "row");
        if (entry.status === "completed" && entry.exists) {
          const open = el("button", "btn ghost sm", "Open");
          open.onclick = () => openFile(entry.filepath);
          const show = el("button", "btn ghost sm", "Show");
          show.onclick = () => revealFile(entry.filepath);
          group.appendChild(open);
          group.appendChild(show);
        } else if (entry.status === "completed") {
          group.appendChild(el("span", "muted", "file moved"));
        }
        const remove = el("button", "btn ghost sm", "×");
        remove.title = "Remove this record";
        remove.onclick = async () => {
          await api(`history/${entry.id}`, { method: "DELETE" });
          loadHistory();
        };
        group.appendChild(remove);
        actions.appendChild(group);
        row.appendChild(actions);
        body.appendChild(row);
      }
    } catch (error) {
      reportError(error);
    }
  }

  // --------------------------------------------------------------- servers --

  function serverNode(server) {
    const node = el("div", "job");
    node.style.gridTemplateColumns = "1fr";
    const head = el("div", "job-line");
    head.appendChild(el("strong", null, server.name));
    const kind = server.status === "online" ? "ok"
      : server.status === "degraded" ? "warn"
      : server.status === "offline" ? "err" : "";
    head.appendChild(el("span", `pill ${kind}`, server.status));
    if (server.is_local) head.appendChild(el("span", "pill", "this machine"));
    head.appendChild(el("span", "pill", server.role));
    if (!server.accepting_jobs && !server.is_local) {
      head.appendChild(el("span", "pill err", `cooling down ${server.cooldown_remaining}s`));
    }
    if (!server.is_local) {
      const actions = el("div", "job-actions");
      const remove = el("button", "btn danger sm", "Remove");
      remove.onclick = async () => {
        try {
          await api(`servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
          toast("Server removed", server.name);
          loadServers();
        } catch (error) {
          reportError(error);
        }
      };
      actions.appendChild(remove);
      head.appendChild(actions);
    }
    node.appendChild(head);
    node.appendChild(el("div", "muted mono", server.url));

    const metrics = server.metrics || {};
    const facts = el("div", "job-facts");
    const parts = [];
    if (server.latency_ms != null) parts.push(`${server.latency_ms} ms`);
    if (metrics.cpu_percent != null) parts.push(`CPU ${metrics.cpu_percent}%`);
    if (metrics.memory_percent != null) parts.push(`RAM ${metrics.memory_percent}%`);
    if (metrics.disk_free != null) parts.push(`${bytes(metrics.disk_free)} free`);
    if (metrics.active_jobs != null) parts.push(`${metrics.active_jobs} active`);
    if (metrics.queue_length != null) parts.push(`${metrics.queue_length} queued`);
    if (server.last_check) parts.push(`checked ${when(server.last_check)}`);
    for (const part of parts) facts.appendChild(el("span", null, part));
    node.appendChild(facts);

    if (server.error) {
      const box = el("div", "job-error");
      box.appendChild(el("strong", null, "Last check failed"));
      box.appendChild(el("div", "hint", server.error));
      node.appendChild(box);
    }
    return node;
  }

  async function loadServers(check = false) {
    try {
      const result = check
        ? await api("servers/check", { method: "POST" })
        : await api("servers");
      state.servers = result.servers;
      const host = $("server-list");
      host.textContent = "";
      for (const server of result.servers) host.appendChild(serverNode(server));
      const healthy = result.servers.filter((s) => s.accepting_jobs).length;
      $("nav-server-count").textContent = `${healthy}/${result.servers.length}`;
    } catch (error) {
      reportError(error);
    }
  }

  // ----------------------------------------------------------- diagnostics --

  async function runDiagnostics() {
    const button = $("run-diag-btn");
    button.disabled = true;
    $("diag-overall").className = "pill busy";
    $("diag-overall").textContent = "Running";
    try {
      const result = await api("diagnostics/run", { method: "POST" });
      const host = $("diag-results");
      host.hidden = false;
      host.textContent = "";
      const groups = {};
      for (const check of result.checks) {
        groups[check.group] = groups[check.group] || [];
        groups[check.group].push(check);
      }
      const names = { processing: "Processing", storage: "Storage", network: "Network", servers: "Servers", extension: "Extension" };
      for (const [group, checks] of Object.entries(groups)) {
        const header = el("div", "card-head");
        header.style.padding = "16px 18px 0";
        header.appendChild(el("h2", null, names[group] || group));
        host.appendChild(header);
        for (const check of checks) {
          const row = el("div", "check");
          const mark = { pass: "✓", warn: "!", fail: "×", unknown: "?" }[check.status];
          row.appendChild(el("div", `check-icon ${check.status}`, mark));
          const body = el("div");
          body.appendChild(el("div", "check-name", check.name));
          body.appendChild(el("div", "check-msg", check.message));
          if (check.hint) body.appendChild(el("div", "check-hint", check.hint));
          if (check.path) body.appendChild(el("div", "check-hint mono", check.path));
          row.appendChild(body);
          host.appendChild(row);
        }
      }
      const overall = $("diag-overall");
      overall.className = `pill ${result.overall === "pass" ? "ok" : result.overall === "warn" ? "warn" : "err"}`;
      overall.textContent = `${result.counts.pass} passed, ${result.counts.warn} warnings, ${result.counts.fail} failed`;
    } catch (error) {
      reportError(error);
      $("diag-overall").className = "pill err";
      $("diag-overall").textContent = "Failed to run";
    } finally {
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------------ logs --

  async function loadLogs() {
    const params = new URLSearchParams();
    if ($("log-search").value.trim()) params.set("search", $("log-search").value.trim());
    if ($("log-category").value) params.set("category", $("log-category").value);
    if ($("log-level").value) params.set("level", $("log-level").value);
    params.set("limit", "200");
    try {
      const result = await api(`logs?${params}`);
      if ($("log-category").options.length <= 1) {
        for (const category of result.categories) {
          const option = el("option", null, category);
          option.value = category;
          $("log-category").appendChild(option);
        }
        for (const level of result.levels) {
          const option = el("option", null, level);
          option.value = level;
          $("log-level").appendChild(option);
        }
      }
      const host = $("log-list");
      host.textContent = "";
      if (!result.entries.length) {
        host.appendChild(emptyNode("No log records", "Nothing matches these filters."));
        return;
      }
      for (const entry of result.entries) {
        const row = el("div", "log-row");
        row.appendChild(el("div", "log-time", new Date(entry.ts * 1000).toLocaleTimeString()));
        row.appendChild(el("div", `log-level ${entry.level}`, entry.level));
        row.appendChild(el("div", "log-cat", entry.category));
        const message = el("div", "log-msg");
        message.appendChild(document.createTextNode(entry.message));
        if (entry.detail) message.appendChild(el("div", "log-detail", entry.detail));
        row.appendChild(message);
        host.appendChild(row);
      }
    } catch (error) {
      reportError(error);
    }
  }

  // ----------------------------------------------------------------- about --

  async function loadAbout() {
    try {
      const info = await api("about");
      const host = $("about-kv");
      host.textContent = "";
      const rows = [
        ["Application", info.app],
        ["Version", info.version],
        ["Developer", info.developer],
        ["Contact", info.contact],
        ["Extractor", info.yt_dlp],
        ["ffmpeg", `${info.ffmpeg || "not found"} (${info.ffmpeg_source})`],
        ["Python", info.python],
        ["Platform", info.platform],
        ["Database", info.database],
        ["Uptime", duration(info.uptime_seconds)],
        ["Use", info.license],
      ];
      for (const [key, value] of rows) {
        host.appendChild(el("dt", null, key));
        host.appendChild(el("dd", null, String(value)));
      }
      $("brand-version").textContent = `version ${info.version}`;
    } catch (error) {
      reportError(error);
    }
  }

  async function loadSystemPanel() {
    try {
      const health = await api("health");
      const host = $("system-kv");
      host.textContent = "";
      const metrics = health.metrics || {};
      const rows = [
        ["Download folder", state.settings ? state.settings.general.download_dir : ""],
        ["Free disk", bytes(metrics.disk_free) || "unknown"],
        ["Processor", metrics.cpu_percent != null ? `${metrics.cpu_percent}% in use` : "unknown"],
        ["Memory", metrics.memory_percent != null ? `${metrics.memory_percent}% in use` : "unknown"],
        ["ffmpeg", health.ffmpeg ? "available" : "not found"],
        ["Worker slots", String(health.queue.concurrency)],
        ["Uptime", duration(health.uptime_seconds)],
      ];
      for (const [key, value] of rows) {
        host.appendChild(el("dt", null, key));
        host.appendChild(el("dd", null, String(value)));
      }
      const stats = await api("history");
      $("stat-bytes").textContent = stats.stats.bytes
        ? `${bytes(stats.stats.bytes)} downloaded` : "no downloads yet";
    } catch (error) {
      // The connection pill already reports an unreachable backend.
    }
  }

  // ------------------------------------------------------------- extension --

  async function checkExtension() {
    try {
      const status = await api("extension/status");
      const pill = $("ext-pill");
      pill.textContent = "";
      pill.appendChild(el("span", "dot"));
      if (!status.seen) {
        pill.className = "pill";
        pill.appendChild(document.createTextNode(" Extension not detected"));
        pill.title = "Open the extension popup and choose Open Dashboard.";
      } else if (status.connected) {
        pill.className = "pill ok";
        pill.appendChild(document.createTextNode(` Extension ${status.version || ""}`.trimEnd()));
        pill.title = "The browser extension is talking to this backend.";
      } else {
        pill.className = "pill warn";
        pill.appendChild(document.createTextNode(" Extension idle"));
        pill.title = `Last seen ${status.age_seconds}s ago.`;
      }
    } catch {
      // Backend offline; the connection pill covers it.
    }
  }

  async function checkHandoff() {
    try {
      const result = await api("extension/handoff");
      if (result.handoff && result.handoff.url) analyze(result.handoff.url);
    } catch {
      // Nothing waiting.
    }
  }

  // ------------------------------------------------------------------ wire --

  function wire() {
    for (const node of document.querySelectorAll(".nav-item")) {
      node.onclick = () => go(node.dataset.view);
    }
    for (const node of document.querySelectorAll("[data-goto]")) {
      node.onclick = () => go(node.dataset.goto);
    }
    $("menu-btn").onclick = () => {
      $("sidebar").classList.add("open");
      $("scrim").hidden = false;
    };
    $("scrim").onclick = () => {
      $("sidebar").classList.remove("open");
      $("scrim").hidden = true;
    };
    $("modal-close").onclick = closeModal;
    $("modal").onclick = (event) => { if (event.target === $("modal")) closeModal(); };
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
    });

    $("theme-btn").onclick = () => {
      const order = ["dark", "light", "system"];
      const next = order[(order.indexOf(state.settings.interface.theme) + 1) % order.length];
      state.settings.interface.theme = next;
      $("s-theme").value = next;
      applyInterface();
      queueSave("interface.theme", next);
      toast(`Theme: ${LABELS.themes[next]}`, "");
    };

    $("analyze-btn").onclick = () => analyze($("url-input").value);
    $("analyze-btn-2").onclick = () => analyze($("url-input-2").value);
    $("reanalyze-btn").onclick = () => analyze(currentUrl(), true);
    $("paste-btn").onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) analyze(text);
        else toast("Clipboard is empty", "Copy a link first.", "warn");
      } catch {
        toast("Clipboard unavailable", "Your browser blocked it. Paste into the field instead.", "warn");
      }
    };
    for (const input of [$("url-input"), $("url-input-2")]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") analyze(input.value);
      });
      input.addEventListener("paste", () => {
        setTimeout(() => {
          if (state.settings && state.settings.general.auto_analyze && input.value.trim()) {
            analyze(input.value);
          }
        }, 60);
      });
    }

    for (const button of document.querySelectorAll("#kind-seg button")) {
      button.onclick = () => {
        state.kind = button.dataset.kind;
        syncKindSeg();
        state.selection = null;
        renderPresets();
        renderQualities();
        updateSelectionSummary();
      };
    }
    $("start-btn").onclick = startDownload;

    for (const button of document.querySelectorAll("#queue-filter button")) {
      button.onclick = () => {
        state.queueFilter = button.dataset.filter;
        for (const other of document.querySelectorAll("#queue-filter button")) {
          other.classList.toggle("active", other === button);
        }
        renderJobs();
      };
    }
    $("pause-all-btn").onclick = async () => {
      const result = await api("jobs/pause-all", { method: "POST" });
      toast("Paused", `${result.paused} job(s) paused.`);
      refreshJobs();
    };
    $("resume-all-btn").onclick = async () => {
      const result = await api("jobs/resume-all", { method: "POST" });
      toast("Resumed", `${result.resumed} job(s) resumed.`);
      refreshJobs();
    };
    $("clear-jobs-btn").onclick = async () => {
      const result = await api("jobs/clear", { method: "POST" });
      toast("Cleared", `${result.removed} finished job(s) removed from the list.`);
      refreshJobs();
    };

    for (const id of ["hist-kind", "hist-status", "hist-sort"]) {
      $(id).onchange = loadHistory;
    }
    $("hist-search").oninput = () => {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(loadHistory, 280);
    };
    $("clear-history-btn").onclick = () => {
      const body = el("div");
      body.appendChild(el("p", null,
        "This removes every history record. Your downloaded files are not touched."));
      openModal("Clear history", body, [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Clear history",
          cls: "danger",
          onClick: async () => {
            const result = await api("history/clear", { method: "POST" });
            toast("History cleared", `${result.removed} record(s) removed.`);
            closeModal();
            loadHistory();
          },
        },
      ]);
    };

    $("check-servers-btn").onclick = () => loadServers(true);
    $("add-server-btn").onclick = async () => {
      const name = $("srv-name").value.trim();
      const url = $("srv-url").value.trim();
      if (!name || !url) {
        toast("Name and address are required", "", "warn");
        return;
      }
      try {
        await api("servers", { method: "POST", body: { name, url, role: $("srv-role").value } });
        toast("Server added", `${name} was registered and checked.`, "ok");
        $("srv-name").value = "";
        $("srv-url").value = "";
        loadServers();
      } catch (error) {
        reportError(error);
      }
    };

    $("browse-btn").onclick = async () => {
      $("browse-btn").disabled = true;
      try {
        const result = await api("system/pick-folder", { method: "POST" });
        if (result.path) {
          $("s-dir").value = result.path;
          state.settings.general.download_dir = result.path;
          queueSave("general.download_dir", result.path);
          toast("Folder chosen", result.path, "ok");
        }
      } catch (error) {
        reportError(error);
      } finally {
        $("browse-btn").disabled = false;
      }
    };
    const openFolder = async () => {
      try {
        await api("system/open-folder", { method: "POST", body: {} });
      } catch (error) {
        reportError(error);
      }
    };
    $("open-folder-btn").onclick = openFolder;
    $("open-folder-btn-2").onclick = openFolder;

    $("cleanup-btn").onclick = async () => {
      const result = await api("maintenance/cleanup", { method: "POST" });
      toast("Cleanup finished",
        `${result.temp_files_removed} temporary file(s) and ${result.cache_entries_removed} cached analysis result(s) removed.`, "ok");
    };
    $("cache-btn").onclick = async () => {
      const result = await api("maintenance/cache-clear", { method: "POST" });
      toast("Cache cleared", `${result.removed} entries removed.`, "ok");
    };
    $("reset-btn").onclick = () => {
      const body = el("div");
      body.appendChild(el("p", null,
        "Every setting returns to its default. Your download folder is kept, and no files are deleted."));
      openModal("Reset all settings", body, [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Reset everything",
          cls: "danger",
          onClick: async () => {
            const result = await api("settings/reset", { method: "POST" });
            state.settings = result.settings;
            state.schema = result.schema;
            populateChoices();
            applySettingsToInputs();
            closeModal();
            toast("Settings reset", "Defaults restored.", "ok");
          },
        },
      ]);
    };

    $("run-diag-btn").onclick = runDiagnostics;

    let logTimer = null;
    $("log-search").oninput = () => {
      clearTimeout(logTimer);
      logTimer = setTimeout(loadLogs, 280);
    };
    $("log-category").onchange = loadLogs;
    $("log-level").onchange = loadLogs;
    $("clear-logs-btn").onclick = async () => {
      await api("logs", { method: "DELETE" });
      toast("Logs cleared", "");
      loadLogs();
    };
    $("export-logs-btn").onclick = () => {
      window.open("/api/logs/export", "_blank");
    };

    $("refresh-btn").onclick = () => {
      refreshJobs();
      loadSystemPanel();
      checkExtension();
      if (state.view === "servers") loadServers(true);
      if (state.view === "history") loadHistory();
      if (state.view === "logs") loadLogs();
      toast("Refreshed", "");
    };

    window.addEventListener("hashchange", () => go(location.hash.slice(1)));
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (state.settings && state.settings.interface.theme === "system") applyInterface();
    });
  }

  // ------------------------------------------------------------------ boot --

  async function boot() {
    wire();
    try {
      await loadSettings();
      bindSettingInputs();
      setConnected(true);
    } catch (error) {
      setConnected(false);
      toast("Backend not reachable", "The dashboard cannot load its settings.", "err");
      return;
    }
    connectEvents();
    await refreshJobs();
    loadSystemPanel();
    loadServers();
    loadAbout();
    checkExtension();
    checkHandoff();

    const params = new URLSearchParams(location.search);
    const url = params.get("url");
    if (url) {
      history.replaceState(null, "", location.pathname);
      analyze(url);
    } else if (location.hash) {
      go(location.hash.slice(1));
    }

    setInterval(checkExtension, 20000);
    setInterval(() => {
      if (state.view === "servers") loadServers();
    }, 30000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
