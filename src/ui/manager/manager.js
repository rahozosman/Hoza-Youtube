/**
 * Download manager page: Active, Completed and Failed.
 *
 * The list re-renders on every background broadcast. Rows are cheap and the
 * lists are short, so a full redraw is simpler than diffing and never leaves
 * a stale progress bar behind.
 */

import {
  el,
  $,
  $$,
  replace,
  icon,
  ICONS,
  request,
  subscribe,
  bootAppearance,
  openSettings,
  debounce,
} from '../shared/ui-kit.js';

import { MSG, JobState, ACTIVE_STATES, StreamType } from '../../core/constants.js';
import {
  humanBytes,
  humanSpeed,
  humanEta,
  humanDate,
} from '../../core/format-utils.js';
import { describe, isRetryable } from '../../core/errors.js';
import { splitFilename } from '../../core/filename.js';

const listNode = $('#list');
const summaryNode = $('#header-summary');
const filterInput = $('#filter');

const state = {
  tab: 'active',
  jobs: [],
  history: [],
  filter: '',
  pausedGlobally: false,
};

/* ----------------------------------------------------------------- helpers */

const matchesFilter = (text) =>
  !state.filter || String(text ?? '').toLowerCase().includes(state.filter);

function iconFor(entry) {
  if (entry.state === JobState.COMPLETED) return { path: ICONS.check, cls: 'is-done' };
  if (entry.state === JobState.FAILED) return { path: ICONS.alert, cls: 'is-failed' };
  if (entry.state === JobState.CANCELLED) return { path: ICONS.x, cls: 'is-failed' };
  if (entry.streamType === StreamType.AUDIO) return { path: ICONS.audio, cls: 'is-active' };
  return { path: ICONS.video, cls: 'is-active' };
}

function metaSeparator() {
  return el('span', { class: 'dot' });
}

/** Build a meta line from parts, dropping the empty ones. */
function metaLine(parts) {
  const kept = parts.filter(Boolean);
  const nodes = [];
  kept.forEach((part, index) => {
    if (index > 0) nodes.push(metaSeparator());
    nodes.push(typeof part === 'string' ? el('span', {}, part) : part);
  });
  return el('div', { class: 'job-meta' }, ...nodes);
}

function actionButton(label, iconPath, handler, { tone = '' } = {}) {
  return el(
    'button',
    {
      class: `btn btn-icon btn-ghost ${tone}`.trim(),
      type: 'button',
      title: label,
      attrs: { 'aria-label': label },
      on: { click: handler },
    },
    icon(iconPath, { size: 15 }),
  );
}

/* ------------------------------------------------------------------- rows */

function activeRow(job, queuePosition) {
  const { path, cls } = iconFor(job);

  const total = Number.isFinite(job.totalBytes) && job.totalBytes > 0 ? job.totalBytes : null;
  const received = job.bytesReceived ?? 0;
  const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null;

  const isDownloading = job.state === JobState.DOWNLOADING;
  const isPaused = job.state === JobState.PAUSED;
  const isQueued = job.state === JobState.QUEUED;

  const progressClass = [
    'progress',
    total ? '' : isDownloading ? 'progress-indeterminate' : '',
    isPaused ? 'progress-paused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const statusParts = [];
  if (isQueued) statusParts.push(queuePosition ? `Waiting (#${queuePosition})` : 'Waiting');
  else if (isPaused) statusParts.push('Paused');
  else if (job.state === JobState.PREPARING) statusParts.push(job.note ?? 'Preparing');
  else if (job.note) statusParts.push(job.note);

  if (total) {
    statusParts.push(`${humanBytes(received)} of ${job.sizeEstimated ? '~' : ''}${humanBytes(total)}`);
  } else if (received > 0) {
    statusParts.push(humanBytes(received));
  }
  if (isDownloading && job.speed) statusParts.push(humanSpeed(job.speed));
  if (isDownloading && job.eta != null) statusParts.push(humanEta(job.eta));

  return el(
    'article',
    { class: 'job fade-in' },
    el('div', { class: `job-icon ${cls}` }, icon(path, { size: 18 })),
    el(
      'div',
      { class: 'job-main' },
      el('div', { class: 'job-title truncate', title: job.filename }, job.title || job.filename),
      metaLine([job.qualityLabel, job.container?.toUpperCase(), ...statusParts]),
      el(
        'div',
        { class: 'job-progress' },
        el(
          'div',
          { class: progressClass },
          el('div', {
            class: 'progress-bar',
            style: `width:${percent ?? (total ? 0 : 100)}%`,
          }),
        ),
        el('span', { class: 'job-percent' }, percent != null ? `${percent}%` : ''),
      ),
    ),
    el(
      'div',
      { class: 'job-actions' },
      isPaused || isQueued
        ? actionButton('Resume', ICONS.play, () => act(MSG.RESUME_JOB, job.id))
        : actionButton('Pause', ICONS.pause, () => act(MSG.PAUSE_JOB, job.id)),
      actionButton('Cancel', ICONS.x, () => act(MSG.CANCEL_JOB, job.id), { tone: 'btn-danger' }),
    ),
  );
}

function completedRow(entry) {
  const { stem, ext } = splitFilename(entry.filename);
  return el(
    'article',
    { class: 'job fade-in' },
    el('div', { class: 'job-icon is-done' }, icon(ICONS.check, { size: 18 })),
    el(
      'div',
      { class: 'job-main' },
      el('div', { class: 'job-title truncate', title: entry.filename }, stem),
      metaLine([
        entry.quality,
        ext?.toUpperCase(),
        Number.isFinite(entry.totalBytes) ? humanBytes(entry.totalBytes) : null,
        humanDate(entry.finishedAt),
      ]),
    ),
    el(
      'div',
      { class: 'job-actions' },
      entry.chromeDownloadId != null
        ? actionButton('Open file', ICONS.external, () =>
            act(MSG.OPEN_FILE, null, { downloadId: entry.chromeDownloadId }),
          )
        : null,
      entry.chromeDownloadId != null
        ? actionButton('Show in folder', ICONS.folder, () =>
            act(MSG.REVEAL_FILE, null, { downloadId: entry.chromeDownloadId }),
          )
        : null,
      entry.stream
        ? actionButton('Download again', ICONS.retry, () => act(MSG.RETRY_JOB, entry.id))
        : null,
      actionButton('Remove from list', ICONS.trash, () =>
        act(MSG.REMOVE_JOB, entry.id, { fromHistory: true }),
      ),
    ),
  );
}

function failedRow(entry) {
  const { title, hint } = describe(entry.error?.code);
  const canRetry = isRetryable(entry.error?.code) && !!entry.stream;

  return el(
    'article',
    { class: 'job fade-in' },
    el('div', { class: 'job-icon is-failed' }, icon(ICONS.alert, { size: 18 })),
    el(
      'div',
      { class: 'job-main' },
      el('div', { class: 'job-title truncate' }, entry.title || entry.filename),
      el('div', { class: 'job-error' }, title),
      el('div', { class: 'job-error-hint' }, hint),
      metaLine([entry.quality, entry.container?.toUpperCase(), humanDate(entry.finishedAt)]),
    ),
    el(
      'div',
      { class: 'job-actions' },
      canRetry ? actionButton('Retry', ICONS.retry, () => act(MSG.RETRY_JOB, entry.id)) : null,
      actionButton('Remove from list', ICONS.trash, () =>
        act(MSG.REMOVE_JOB, entry.id, { fromHistory: true }),
      ),
    ),
  );
}

function emptyState(tab) {
  const copy = {
    active: {
      iconPath: ICONS.download,
      title: 'Nothing downloading',
      body: 'Open the Hoza YT panel on a page with media to start a download.',
    },
    completed: {
      iconPath: ICONS.check,
      title: 'No completed downloads yet',
      body: 'Finished downloads appear here, with a link to the file.',
    },
    failed: {
      iconPath: ICONS.alert,
      title: 'Nothing has failed',
      body: 'Downloads that stop with an error are listed here so you can retry them.',
    },
  }[tab];

  return el(
    'div',
    { class: 'state' },
    el('div', { class: 'state-icon' }, icon(copy.iconPath, { size: 20, className: 'icon icon-lg' })),
    el('p', { class: 'state-title' }, copy.title),
    el('p', { class: 'state-body' }, copy.body),
  );
}

/* --------------------------------------------------------------- rendering */

function render() {
  const active = state.jobs.filter((job) => ACTIVE_STATES.has(job.state));
  const completed = state.history.filter((entry) => entry.state === JobState.COMPLETED);
  const failed = state.history.filter(
    (entry) => entry.state === JobState.FAILED || entry.state === JobState.CANCELLED,
  );

  $('#count-active').textContent = String(active.length);
  $('#count-completed').textContent = String(completed.length);
  $('#count-failed').textContent = String(failed.length);

  const downloading = active.filter((job) => job.state === JobState.DOWNLOADING);
  summaryNode.textContent = downloading.length
    ? `${downloading.length} downloading, ${active.length - downloading.length} waiting`
    : active.length
      ? `${active.length} waiting`
      : `${completed.length} saved`;

  $('#pause-all').disabled = !active.length || state.pausedGlobally;
  $('#resume-all').disabled = !state.pausedGlobally && !active.some((job) => job.state === JobState.PAUSED);

  let rows;
  if (state.tab === 'active') {
    const filtered = active.filter((job) => matchesFilter(job.title) || matchesFilter(job.filename));
    const queued = filtered.filter((job) => job.state === JobState.QUEUED);
    rows = filtered.map((job) =>
      activeRow(job, job.state === JobState.QUEUED ? queued.indexOf(job) + 1 : null),
    );
  } else if (state.tab === 'completed') {
    rows = completed
      .filter((entry) => matchesFilter(entry.title) || matchesFilter(entry.filename))
      .map(completedRow);
  } else {
    rows = failed
      .filter((entry) => matchesFilter(entry.title) || matchesFilter(entry.filename))
      .map(failedRow);
  }

  replace(listNode, rows.length ? rows : emptyState(state.tab));
}

/* ------------------------------------------------------------------ actions */

async function act(type, id, extra = {}) {
  try {
    await request(type, { id, ...extra });
  } catch {
    // The background reports failures through the job list itself.
  }
  await refresh();
}

async function refresh() {
  try {
    const [jobsResponse, historyResponse] = await Promise.all([
      request(MSG.GET_JOBS),
      request(MSG.GET_HISTORY),
    ]);
    state.jobs = jobsResponse.jobs ?? [];
    state.pausedGlobally = !!jobsResponse.pausedGlobally;
    state.history = historyResponse.entries ?? [];
    render();
  } catch {
    // Transient during a service-worker restart; the next broadcast recovers.
  }
}

function selectTab(tab) {
  state.tab = tab;
  for (const button of $$('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  const clearButton = $('#clear');
  clearButton.hidden = tab === 'active';
  clearButton.textContent = tab === 'completed' ? 'Clear completed' : 'Clear failed';
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  render();
}

/* --------------------------------------------------------------------- boot */

async function init() {
  await bootAppearance();

  for (const button of $$('.tab')) {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  }

  $('#settings').addEventListener('click', openSettings);
  $('#pause-all').addEventListener('click', () => void act(MSG.PAUSE_ALL));
  $('#resume-all').addEventListener('click', () => void act(MSG.RESUME_ALL));

  $('#clear').addEventListener('click', async () => {
    await request(MSG.CLEAR_HISTORY, { scope: state.tab === 'completed' ? 'completed' : 'failed' });
    await refresh();
  });

  filterInput.addEventListener(
    'input',
    debounce((event) => {
      state.filter = event.target.value.trim().toLowerCase();
      render();
    }, 150),
  );

  subscribe(MSG.JOBS_CHANGED, (message) => {
    state.jobs = message.jobs ?? state.jobs;
    render();
    // History changes alongside job completion, so pull it too.
    void request(MSG.GET_HISTORY)
      .then((response) => {
        state.history = response.entries ?? state.history;
        render();
      })
      .catch(() => {});
  });

  const initial = ['active', 'completed', 'failed'].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : 'active';
  selectTab(initial);

  await refresh();
}

void init();
