/**
 * Popup: detect, choose a quality, download.
 *
 * The panel shows only what the current page actually offers. When a source
 * separates its video and audio tracks it says so, because Hoza YT saves the
 * stream as delivered rather than claiming a merge it cannot perform.
 */

import {
  el,
  $,
  clear,
  replace,
  icon,
  ICONS,
  request,
  subscribe,
  bootAppearance,
  openSettings,
  activeTab,
} from '../shared/ui-kit.js';

import { MSG, DetectState, SmartMode, StreamType, JobState, ACTIVE_STATES } from '../../core/constants.js';
import { pickSmart, primaryLabel, describeStream, Badge } from '../../core/quality-resolver.js';
import { humanBytes, humanDuration, domainOf } from '../../core/format-utils.js';
import { updateSettings } from '../../core/storage.js';

const body = $('#body');
const footerLabel = $('#manager-label');
const queueSummary = $('#queue-summary');

const state = {
  tab: null,
  settings: null,
  detection: null,
  items: [],
  activeItemId: null,
  streams: [],
  selectedStreamId: null,
  smartMode: SmartMode.BALANCED,
  expanded: { video: false, audio: false },
  busy: false,
  analysisError: null,
};

const VISIBLE_BEFORE_EXPAND = 4;

/* --------------------------------------------------------------- rendering */

function renderState({ tone = 'default', iconPath, title, bodyText, actions = [] }) {
  const wrapper = el(
    'div',
    { class: `state${tone === 'protected' ? ' state-protected' : tone === 'error' ? ' state-error' : ''} fade-in` },
    el('div', { class: 'state-icon' }, icon(iconPath, { size: 20, className: 'icon icon-lg' })),
    el('p', { class: 'state-title' }, title),
    bodyText ? el('p', { class: 'state-body' }, bodyText) : null,
    actions.length
      ? el('div', { class: 'row', style: 'margin-top:8px;gap:8px;flex-wrap:wrap;justify-content:center' }, ...actions)
      : null,
  );
  replace(body, wrapper);
}

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function openYouTubeServer() {
  // The local app chooses its own port, so the background worker opens the
  // dashboard rather than the popup guessing an address.
  void chrome.runtime.sendMessage({
    type: MSG.OPEN_DASHBOARD,
    url: state.tab?.url ?? '',
    title: state.tab?.title ?? null,
  });
  window.close();
}

function youtubeHandoffAction() {
  if (!isYouTubeUrl(state.tab?.url)) return null;

  return el(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      on: { click: openYouTubeServer },
    },
    icon(ICONS.external, { size: 14 }),
    'Open local media downloader',
  );
}

function thumbNode(item) {
  const duration = humanDuration(item?.duration);
  const image = item?.thumbnail
    ? el('img', { src: item.thumbnail, alt: '', loading: 'lazy', on: {
        error: (event) => {
          event.target.replaceWith(icon(ICONS.video, { size: 18 }));
        },
      } })
    : icon(item?.streamType === StreamType.AUDIO ? ICONS.audio : ICONS.video, { size: 18 });

  return el(
    'div',
    { class: 'thumb' },
    image,
    duration ? el('span', { class: 'thumb-duration' }, duration) : null,
  );
}

function mediaCard(item) {
  const site = domainOf(item.pageUrl ?? item.url);
  return el(
    'div',
    { class: 'media-card fade-in' },
    thumbNode(item),
    el(
      'div',
      { class: 'media-meta' },
      el('div', { class: 'media-title clamp-2', title: item.title ?? '' }, item.title || item.pageTitle || 'Untitled media'),
      el(
        'div',
        { class: 'media-source truncate' },
        site ?? 'Unknown source',
        item.kind && item.kind !== 'progressive'
          ? el('span', { class: 'badge badge-info' }, item.kind.toUpperCase())
          : null,
      ),
    ),
  );
}

function mediaSwitcher() {
  if (state.items.length < 2) return null;

  const select = el(
    'select',
    {
      id: 'item-select',
      on: {
        change: (event) => {
          state.activeItemId = event.target.value;
          state.streams = [];
          state.selectedStreamId = null;
          state.analysisError = null;
          render();
          void analyzeActive();
        },
      },
    },
    ...state.items.map((item, index) =>
      el(
        'option',
        { value: item.id, selected: item.id === state.activeItemId },
        `${index + 1}. ${item.title || item.pageTitle || 'Media'}${item.kind && item.kind !== 'progressive' ? ` (${item.kind.toUpperCase()})` : ''}`,
      ),
    ),
  );

  return el(
    'div',
    { class: 'media-switcher' },
    el('span', { class: 'faint' }, `${state.items.length} items`),
    el('div', { class: 'grow' }, select),
  );
}

function badgeNode(label) {
  const className =
    label === Badge.BEST
      ? 'badge badge-best'
      : label === Badge.RECOMMENDED
        ? 'badge badge-recommended'
        : label === Badge.UHD_4K || label === Badge.UHD_8K
          ? 'badge badge-uhd'
          : label === Badge.VIDEO_ONLY || label === Badge.AUDIO_ONLY
            ? 'badge badge-warn'
            : 'badge';
  return el('span', { class: className }, label);
}

function optionRow(stream) {
  const selected = stream.id === state.selectedStreamId;
  const size = Number.isFinite(stream.size) && stream.size > 0
    ? `${stream.sizeEstimated ? '~' : ''}${humanBytes(stream.size)}`
    : '—';

  // Only the two most meaningful badges, so the row stays readable.
  const badges = (stream.badges ?? []).slice(0, 2);

  return el(
    'button',
    {
      class: 'option',
      type: 'button',
      attrs: { 'aria-selected': String(selected), role: 'option' },
      dataset: { streamId: stream.id },
      on: {
        click: () => {
          state.selectedStreamId = stream.id;
          render();
        },
      },
    },
    el(
      'div',
      { class: 'option-main' },
      el(
        'div',
        { class: 'option-title' },
        el('span', { class: 'truncate' }, primaryLabel(stream)),
        ...badges.map(badgeNode),
      ),
      el('div', { class: 'option-detail truncate' }, describeStream(stream) || '—'),
    ),
    el('div', { class: 'option-size' }, size),
  );
}

function optionGroup(label, streams, key) {
  if (!streams.length) return null;

  const expanded = state.expanded[key];
  const visible = expanded ? streams : streams.slice(0, VISIBLE_BEFORE_EXPAND);
  const hidden = streams.length - visible.length;

  return el(
    'section',
    { class: 'picker-group' },
    el(
      'div',
      { class: 'group-header' },
      el('span', { class: 'eyebrow' }, label),
      el('span', { class: 'group-count' }, `${streams.length}`),
    ),
    el('div', { class: 'option-list', attrs: { role: 'listbox' } }, ...visible.map(optionRow)),
    hidden > 0
      ? el(
          'button',
          {
            class: 'show-more',
            type: 'button',
            on: {
              click: () => {
                state.expanded[key] = true;
                render();
              },
            },
          },
          `Show ${hidden} more`,
        )
      : null,
  );
}

/** Advanced disclosure: exact facts about the selected stream, plus filename. */
function advancedPanel(stream) {
  if (!stream) return null;

  const facts = [
    ['Container', stream.container?.toUpperCase()],
    ['Video codec', stream.videoCodec],
    ['Audio codec', stream.audioCodec],
    ['Resolution', stream.width && stream.height ? `${stream.width} x ${stream.height}` : null],
    ['Frame rate', stream.fps ? `${Math.round(stream.fps)} fps` : null],
    ['Bitrate', stream.bandwidth ? `${Math.round(stream.bandwidth / 1000)} kbps` : null],
    ['Language', stream.lang],
    ['Delivery', stream.delivery?.toUpperCase()],
    ['Duration', humanDuration(stream.duration)],
  ].filter(([, value]) => value);

  return el(
    'details',
    { class: 'advanced' },
    el(
      'summary',
      {},
      icon(ICONS.chevron, { size: 14 }),
      'Advanced',
    ),
    el(
      'div',
      { class: 'advanced-body' },
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field-label', htmlFor: 'filename-input' }, 'Filename'),
        el('input', {
          type: 'text',
          id: 'filename-input',
          placeholder: 'Leave blank to use your template',
          value: '',
        }),
        el('p', { class: 'field-hint' }, 'Overrides the template for this download only.'),
      ),
      facts.length
        ? el(
            'dl',
            { class: 'stream-facts' },
            ...facts.flatMap(([term, value]) => [
              el('dt', {}, term),
              el('dd', { class: 'truncate' }, String(value)),
            ]),
          )
        : null,
      el(
        'button',
        {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          on: { click: openSettings },
        },
        icon(ICONS.settings, { size: 14 }),
        'All settings',
      ),
    ),
  );
}

function smartModeRow() {
  const modes = [
    [SmartMode.BEST, 'Best'],
    [SmartMode.BALANCED, 'Balanced'],
    [SmartMode.SAVER, 'Data saver'],
    [SmartMode.AUDIO, 'Audio'],
  ];

  return el(
    'div',
    { class: 'smart-modes' },
    ...modes.map(([mode, label]) =>
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          attrs: { 'aria-pressed': String(state.smartMode === mode) },
          on: {
            click: () => {
              state.smartMode = mode;
              applySmartSelection();
              void updateSettings({ general: { smartMode: mode } }).catch(() => {});
              render();
            },
          },
        },
        mode === SmartMode.BEST ? icon(ICONS.sparkle, { size: 12 }) : null,
        label,
      ),
    ),
    el(
      'button',
      {
        class: 'chip',
        type: 'button',
        attrs: { 'aria-pressed': String(state.smartMode === SmartMode.CUSTOM) },
        on: {
          click: () => {
            state.smartMode = SmartMode.CUSTOM;
            render();
          },
        },
      },
      'Custom',
    ),
  );
}

/** Notice shown when the chosen stream carries only one half of the media. */
function splitTrackNotice(stream) {
  if (!stream) return null;

  if (stream.type === StreamType.VIDEO) {
    const audio = state.streams.filter((s) => s.type === StreamType.AUDIO);
    return el(
      'div',
      { class: 'notice notice-warn' },
      icon(ICONS.alert, { size: 14 }),
      el(
        'div',
        {},
        el('strong', {}, 'Video only. '),
        audio.length
          ? 'This source keeps audio in a separate track. Download an audio option too, then combine them in a player or editor.'
          : 'This source provides no matching audio track.',
      ),
    );
  }

  if (stream.containerInferred) {
    return el(
      'div',
      { class: 'notice' },
      icon(ICONS.alert, { size: 14 }),
      'The container was inferred from the stream segments; the saved extension may differ.',
    );
  }

  return null;
}

function actionsBlock(stream) {
  const size = stream && Number.isFinite(stream.size) && stream.size > 0
    ? `${stream.sizeEstimated ? 'about ' : ''}${humanBytes(stream.size)}`
    : 'size unknown';

  return el(
    'div',
    { class: 'actions' },
    stream
      ? el(
          'div',
          { class: 'action-summary' },
          el('span', { class: 'truncate' }, primaryLabel(stream)),
          el('span', {}, size),
        )
      : null,
    el(
      'button',
      {
        class: 'btn btn-primary btn-lg',
        type: 'button',
        disabled: !stream || state.busy,
        on: { click: () => void startDownload() },
      },
      state.busy ? el('span', { class: 'spinner' }) : icon(ICONS.download, { size: 16 }),
      state.busy ? 'Starting' : 'Download',
    ),
  );
}

function render() {
  const detection = state.detection;
  if (!detection) return;

  switch (detection.state) {
    case DetectState.UNSUPPORTED_PAGE:
      renderState({
        iconPath: ICONS.lock,
        title: 'Not available here',
        bodyText: 'Browser pages and the extension gallery are off limits to extensions.',
      });
      return;

    case DetectState.PROTECTED:
      renderState({
        tone: 'protected',
        iconPath: ICONS.lock,
        title: 'This media is protected',
        bodyText:
          'It is delivered with access protection. Hoza YT does not work around protection, so it cannot be downloaded here.',
        actions: [youtubeHandoffAction()],
      });
      return;

    case DetectState.NO_ACCESS:
      renderState({
        iconPath: ICONS.search,
        title: 'Hoza YT has no access to this site',
        bodyText:
          'Grant access to let detection watch this site. Hoza YT requests no site access when it is installed.',
        actions: [
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', on: { click: () => void grantAccess() } },
            'Grant access to this site',
          ),
          youtubeHandoffAction(),
        ],
      });
      return;

    case DetectState.NONE:
      if (!detection.detectionEnabled) {
        renderState({
          iconPath: ICONS.search,
          title: 'Detection is switched off here',
          bodyText: 'Turn detection back on for this site to look for media.',
          actions: [
            el(
              'button',
              { class: 'btn', type: 'button', on: { click: () => void setSiteDetection(true) } },
              'Enable for this site',
            ),
          ],
        });
        return;
      }
      renderState({
        iconPath: ICONS.search,
        title: 'No downloadable media was detected',
        bodyText: isYouTubeUrl(state.tab?.url)
          ? 'YouTube playback is handled by the local downloader.'
          : 'This page does not expose a downloadable media file yet.',
        actions: [youtubeHandoffAction()],
      });
      return;

    default:
      break;
  }

  const item = state.items.find((candidate) => candidate.id === state.activeItemId);
  if (!item) {
    renderState({ iconPath: ICONS.search, title: 'No media selected' });
    return;
  }

  const fragments = [mediaCard(item), mediaSwitcher()];

  if (state.analysisError) {
    fragments.push(
      el(
        'div',
        { class: 'notice notice-danger' },
        icon(ICONS.alert, { size: 14 }),
        el(
          'div',
          {},
          el('strong', {}, state.analysisError.title),
          el('div', { class: 'faint', style: 'margin-top:2px' }, state.analysisError.hint ?? ''),
        ),
      ),
    );
    if (state.items.length > 1) {
      fragments.push(
        el('p', { class: 'field-hint' }, 'Another detected item on this page may still work.'),
      );
    }
    replace(body, ...fragments.filter(Boolean));
    return;
  }

  if (!state.streams.length) {
    fragments.push(
      el(
        'div',
        { class: 'state' },
        el('div', { class: 'state-icon' }, el('span', { class: 'spinner' })),
        el('p', { class: 'state-title' }, 'Reading available qualities'),
        el('p', { class: 'state-body' }, 'Asking the source what it offers.'),
      ),
    );
    replace(body, ...fragments.filter(Boolean));
    return;
  }

  const video = state.streams.filter(
    (stream) => stream.type === StreamType.MUXED || stream.type === StreamType.VIDEO,
  );
  const audio = state.streams.filter((stream) => stream.type === StreamType.AUDIO);
  const selected = state.streams.find((stream) => stream.id === state.selectedStreamId) ?? null;

  fragments.push(
    smartModeRow(),
    optionGroup('Video', video, 'video'),
    optionGroup('Audio', audio, 'audio'),
    splitTrackNotice(selected),
    advancedPanel(selected),
    actionsBlock(selected),
  );

  replace(body, ...fragments.filter(Boolean));
}

/* ------------------------------------------------------------------ logic */

function applySmartSelection() {
  if (state.smartMode === SmartMode.CUSTOM) return;
  const chosen = pickSmart(state.streams, state.smartMode, {
    preferredHeight: state.settings?.general.preferredHeight ?? 1080,
    preferredContainer: state.settings?.general.preferredContainer ?? null,
    preferredVideoCodec: state.settings?.general.preferredVideoCodec ?? null,
  });
  state.selectedStreamId = chosen?.id ?? null;
}

async function analyzeActive() {
  if (!state.activeItemId) return;
  try {
    const { item } = await request(MSG.ANALYZE_MEDIA, {
      tabId: state.tab.id,
      itemId: state.activeItemId,
    });
    state.streams = item.streams ?? [];
    state.analysisError = null;
    applySmartSelection();
  } catch (err) {
    state.streams = [];
    state.analysisError = err.record ?? { title: err.message, hint: '' };
  }
  render();
}

async function loadState({ scan = true } = {}) {
  const response = await request(MSG.GET_TAB_STATE, { tabId: state.tab.id, scan });
  state.detection = response;
  state.items = response.items ?? [];
  state.settings = response.settings ?? state.settings;
  state.smartMode = state.settings?.general.smartMode ?? SmartMode.BALANCED;

  if (state.items.length && !state.items.some((item) => item.id === state.activeItemId)) {
    state.activeItemId = state.items[0].id;
    state.streams = [];
    state.selectedStreamId = null;
  }

  render();

  if (state.activeItemId && !state.streams.length) await analyzeActive();
}

async function rescan() {
  renderState({
    iconPath: ICONS.refresh,
    title: 'Scanning',
    bodyText: 'Looking again at what this page exposes.',
  });
  state.streams = [];
  state.selectedStreamId = null;
  state.analysisError = null;
  const response = await request(MSG.RESCAN, { tabId: state.tab.id });
  state.detection = response;
  state.items = response.items ?? [];
  state.activeItemId = state.items[0]?.id ?? null;
  render();
  if (state.activeItemId) await analyzeActive();
}

async function grantAccess() {
  const { pattern } = await request(MSG.GET_SITE_ACCESS, { url: state.tab.url });
  if (!pattern) return;
  try {
    // `webRequest` is optional and asked for here rather than at install, so
    // the browser never shows a broad warning for a site you have not visited.
    // It must be requested from a user gesture, which this click is.
    const granted = await chrome.permissions.request({
      permissions: ['webRequest'],
      origins: [pattern],
    });
    if (granted) await rescan();
  } catch {
    // The user dismissed the prompt.
  }
}

async function setSiteDetection(enabled) {
  await request('site:prefs:set', { url: state.tab.url, patch: { detection: enabled } });
  await loadState();
}

async function startDownload(conflict = null) {
  const stream = state.streams.find((candidate) => candidate.id === state.selectedStreamId);
  if (!stream) return;

  const filenameInput = $('#filename-input');
  const filenameOverride = filenameInput?.value?.trim() || null;

  state.busy = true;
  render();

  try {
    const result = await request(MSG.START_DOWNLOAD, {
      tabId: state.tab.id,
      itemId: state.activeItemId,
      streamId: stream.id,
      conflict,
      filenameOverride,
    });

    if (result.status === 'duplicate') {
      state.busy = false;
      render();
      showDuplicateSheet(result);
      return;
    }

    state.busy = false;
    if (result.status === 'skipped') {
      render();
      return;
    }

    render();
    await refreshQueue();
  } catch (err) {
    state.busy = false;
    render();
    const record = err.record;
    body.prepend(
      el(
        'div',
        { class: 'notice notice-danger fade-in' },
        icon(ICONS.alert, { size: 14 }),
        el(
          'div',
          {},
          el('strong', {}, record?.title ?? 'The download could not start.'),
          record?.hint ? el('div', { class: 'faint', style: 'margin-top:2px' }, record.hint) : null,
        ),
      ),
    );
  }
}

/* -------------------------------------------------------- duplicate sheet */

function showDuplicateSheet(result) {
  const close = () => backdrop.remove();

  const choose = async (conflict) => {
    close();
    await startDownload(conflict);
  };

  const sheet = el(
    'div',
    { class: 'sheet' },
    el('h3', {}, 'You may already have this'),
    el('p', { class: 'muted' }, result.message),
    el(
      'div',
      { class: 'notice' },
      el(
        'div',
        { class: 'grow' },
        el('div', { class: 'truncate mono' }, result.existing?.filename ?? result.filename),
        result.existing?.finishedAt
          ? el(
              'div',
              { class: 'faint', style: 'margin-top:2px' },
              `Saved ${new Date(result.existing.finishedAt).toLocaleString()}`,
            )
          : null,
      ),
    ),
    el(
      'div',
      { class: 'sheet-actions' },
      el(
        'button',
        { class: 'btn', type: 'button', on: { click: () => void choose('rename') } },
        'Keep both',
      ),
      el(
        'button',
        { class: 'btn', type: 'button', on: { click: () => void choose('replace') } },
        'Replace',
      ),
      el(
        'button',
        { class: 'btn btn-ghost btn-wide', type: 'button', on: { click: close } },
        'Cancel',
      ),
    ),
  );

  const backdrop = el(
    'div',
    {
      class: 'sheet-backdrop',
      on: {
        click: (event) => {
          if (event.target === backdrop) close();
        },
      },
    },
    sheet,
  );

  document.body.append(backdrop);
}

/* ------------------------------------------------------------------ queue */

async function refreshQueue() {
  try {
    const { jobs } = await request(MSG.GET_JOBS);
    const active = jobs.filter((job) => ACTIVE_STATES.has(job.state));
    const downloading = active.filter((job) => job.state === JobState.DOWNLOADING);

    footerLabel.textContent = active.length ? `Downloads (${active.length})` : 'Downloads';

    clear(queueSummary);
    if (downloading.length) {
      const total = downloading.reduce((sum, job) => sum + (job.totalBytes ?? 0), 0);
      const done = downloading.reduce((sum, job) => sum + (job.bytesReceived ?? 0), 0);
      const percent = total > 0 ? Math.round((done / total) * 100) : null;
      queueSummary.append(
        el('span', { class: 'queue-dot' }),
        el('span', {}, percent != null ? `${percent}%` : 'Downloading'),
      );
    } else if (active.length) {
      queueSummary.append(el('span', {}, `${active.length} queued`));
    }
  } catch {
    // The background may be starting up; the next broadcast will correct this.
  }
}

/* ---------------------------------------------------------- engine state
 *
 * One line, and only while the local app is not simply working. Nothing here
 * ever asks the user to start a server, install a runtime or open a terminal:
 * the app was installed with the extension and starts itself.
 */

function paintEngineState(report) {
  const row = $('#engine-state');
  if (!row || !report?.state) return;
  if (report.ready) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  row.dataset.state = report.state;
  $('#engine-text').textContent = report.text ?? '';
  row.title = report.hint ? `${report.error ?? report.text} ${report.hint}` : '';
}

async function loadEngineState() {
  const report = await request(MSG.GET_SERVER_STATE).catch(() => null);
  if (report) paintEngineState(report);
}

/* ------------------------------------------------------------------- boot */

async function init() {
  state.settings = await bootAppearance();
  state.tab = await activeTab();

  $('#rescan').append(icon(ICONS.refresh, { size: 15 }));
  $('#open-settings').append(icon(ICONS.settings, { size: 15 }));
  const youtubeServer = $('#open-youtube-server');
  youtubeServer.append(icon(ICONS.external, { size: 15 }));

  $('#rescan').addEventListener('click', () => void rescan());
  $('#open-settings').addEventListener('click', openSettings);
  youtubeServer.addEventListener('click', openYouTubeServer);
  $('#open-manager').addEventListener('click', () => {
    void request(MSG.OPEN_MANAGER, { section: 'active' });
    window.close();
  });

  if (!state.tab) {
    renderState({ iconPath: ICONS.alert, title: 'No active tab' });
    return;
  }

  subscribe(MSG.SERVER_STATE, (message) => paintEngineState(message));
  void loadEngineState();

  subscribe(MSG.JOBS_CHANGED, () => void refreshQueue());
  subscribe(MSG.MEDIA_CHANGED, (message) => {
    if (message.tabId === state.tab.id && !state.streams.length) {
      void loadState({ scan: false });
    }
  });

  await Promise.all([loadState(), refreshQueue()]);
}

void init();
