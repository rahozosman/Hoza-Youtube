/**
 * The setup page, opened once when the extension is first loaded.
 *
 * An installed copy registers a native host and starts the app by itself, so
 * this page would have nothing to ask. An unpacked copy has no installer
 * behind it: nothing can launch the app, and the extension sits at
 * "unavailable" until a person starts it. That is the whole reason this page
 * exists, so it says the one thing that fixes it and then watches for it.
 *
 * It polls rather than trusting a single answer, because the app the reader is
 * being asked to open takes a few seconds to listen once they do.
 */

import { $, request, subscribe } from '../shared/ui-kit.js';
import { MSG } from '../../core/constants.js';

/** How often to look while the app is not up. Slow enough to be free. */
const POLL_MS = 2000;

let timer = null;

function paint(report) {
  const status = $('#status');
  const dashboard = $('#open-dashboard');
  if (!report?.state) return;

  if (report.ready) {
    status.dataset.state = 'ready';
    $('#status-title').textContent = 'The app is running';
    $('#status-body').textContent =
      'Everything is connected. Open a video page and click the Hoza YT icon in the toolbar.';
    dashboard.hidden = false;
    stopPolling();
    return;
  }

  dashboard.hidden = true;

  if (report.state === 'starting' || report.state === 'connecting' || report.state === 'reconnecting') {
    status.dataset.state = 'connecting';
    $('#status-title').textContent = report.text ?? 'Connecting…';
    $('#status-body').textContent = report.hint ?? 'The app is coming up.';
    return;
  }

  status.dataset.state = 'waiting';
  $('#status-title').textContent = 'The app is not running yet';
  $('#status-body').textContent = 'Follow the step below, then leave this page open — it will notice by itself.';
}

async function check({ force = false } = {}) {
  const report = await request(force ? MSG.RETRY_SERVER : MSG.GET_SERVER_STATE).catch(() => null);
  if (report) paint(report);
  return report;
}

function startPolling() {
  if (timer) return;
  timer = setInterval(() => void check(), POLL_MS);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

// Polling a browser that is not looking at this page is waste; a person who
// comes back after starting the app wants an answer immediately.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else {
    void check();
    startPolling();
  }
});

$('#recheck').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await check({ force: true });
  } finally {
    button.disabled = false;
  }
});

$('#open-dashboard').addEventListener('click', () => {
  void request(MSG.OPEN_DASHBOARD, { url: '', title: null });
});

// The background broadcasts every change, so a hit usually arrives before the
// next poll does.
subscribe(MSG.SERVER_STATE, (message) => paint(message));

void check();
startPolling();
