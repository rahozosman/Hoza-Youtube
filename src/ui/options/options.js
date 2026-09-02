/**
 * Settings page.
 *
 * Sections are described declaratively and rendered from that description, so
 * adding a preference means adding one entry rather than a block of markup.
 * Every change writes straight through to storage — there is no Save button to
 * forget to press.
 */

import {
  el,
  $,
  $$,
  replace,
  request,
  bootAppearance,
  applyAppearance,
  toast,
  debounce,
  icon,
  ICONS,
} from '../shared/ui-kit.js';

import { MSG, SmartMode } from '../../core/constants.js';
import { THEME, DUPLICATE_POLICY } from '../../core/settings.js';
import { TEMPLATE_TOKENS, previewTemplate, DEFAULT_TEMPLATE } from '../../core/filename.js';
import { api } from '../../core/browser-compat.js';

const sectionsNode = $('#sections');
const toastSlot = $('#toast-slot');

/** Who made this. Shown in the About section and in the manifest. */
const DEVELOPER = {
  name: 'Rahoz Osman',
  email: 'hozahoza2001@gmail.com',
};

const state = {
  settings: null,
  sites: {},
  section: 'general',
};

/* ----------------------------------------------------------------- writing */

async function write(patch, { note = null } = {}) {
  const { settings } = await request(MSG.SET_SETTINGS, { patch });
  state.settings = settings;
  applyAppearance(settings.appearance);
  if (note) toast(toastSlot, note);
  return settings;
}

const writeDebounced = debounce((patch) => void write(patch), 400);

/* -------------------------------------------------------------- controls */

function switchControl(checked, onChange) {
  const input = el('input', {
    type: 'checkbox',
    checked,
    on: { change: (event) => onChange(event.target.checked) },
  });
  return el(
    'label',
    { class: 'switch' },
    input,
    el('span', { class: 'switch-track' }),
    el('span', { class: 'switch-thumb' }),
  );
}

function selectControl(value, options, onChange) {
  return el(
    'select',
    { on: { change: (event) => onChange(event.target.value) } },
    ...options.map(([optionValue, label]) =>
      el('option', { value: String(optionValue), selected: String(optionValue) === String(value) }, label),
    ),
  );
}

function numberControl(value, { min, max, step = 1 }, onChange) {
  return el('input', {
    type: 'number',
    value: String(value),
    attrs: { min, max, step },
    on: {
      change: (event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      },
    },
  });
}

function textControl(value, placeholder, onInput) {
  return el('input', {
    type: 'text',
    value: value ?? '',
    placeholder,
    on: { input: (event) => onInput(event.target.value) },
  });
}

function setting({ label, help, control, stacked = false, wide = false }) {
  return el(
    'div',
    { class: `setting${stacked ? ' setting-stacked' : ''}` },
    el(
      'div',
      { class: 'setting-text' },
      el('div', { class: 'setting-label' }, label),
      help ? el('div', { class: 'setting-help' }, help) : null,
    ),
    el('div', { class: `setting-control${wide ? ' is-wide' : ''}` }, control),
  );
}

function group(...children) {
  return el('div', { class: 'group' }, ...children.filter(Boolean));
}

function sectionShell(title, description, ...children) {
  return el(
    'section',
    { class: 'section fade-in' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', {}, title),
      description ? el('p', {}, description) : null,
    ),
    ...children.filter(Boolean),
  );
}

/* ------------------------------------------------------------- sections */

function generalSection() {
  const { general } = state.settings;

  return sectionShell(
    'General',
    'How Hoza YT picks a quality when you do not choose one yourself.',
    group(
      setting({
        label: 'Default quality preset',
        help: 'Applied when the panel opens, and by the one-click shortcut.',
        control: selectControl(
          general.smartMode,
          [
            [SmartMode.BEST, 'Best quality'],
            [SmartMode.BALANCED, 'Best balanced'],
            [SmartMode.SAVER, 'Data saver'],
            [SmartMode.AUDIO, 'Audio only'],
            [SmartMode.CUSTOM, 'Custom preference'],
          ],
          (value) => void write({ general: { smartMode: value } }),
        ),
      }),
      setting({
        label: 'Preferred resolution',
        help: 'Used by the Custom preset and one-click. Hoza YT falls back to the closest available height rather than failing.',
        control: selectControl(
          general.preferredHeight,
          [
            [4320, '4320p (8K)'],
            [2160, '2160p (4K)'],
            [1440, '1440p'],
            [1080, '1080p'],
            [720, '720p'],
            [480, '480p'],
            [360, '360p'],
          ],
          (value) => void write({ general: { preferredHeight: Number(value) } }),
        ),
      }),
      setting({
        label: 'Preferred container',
        help: 'A tie-breaker only. Hoza YT never converts between containers.',
        control: selectControl(
          general.preferredContainer ?? '',
          [
            ['', 'No preference'],
            ['mp4', 'MP4'],
            ['webm', 'WebM'],
          ],
          (value) => void write({ general: { preferredContainer: value || null } }),
        ),
      }),
    ),
    group(
      setting({
        label: 'Notifications',
        help: 'A single notification when a download finishes or fails for good.',
        control: switchControl(general.notifications, (checked) =>
          void write({ general: { notifications: checked } }),
        ),
      }),
      setting({
        label: 'Notify on completion',
        control: switchControl(general.notifyOnComplete, (checked) =>
          void write({ general: { notifyOnComplete: checked } }),
        ),
      }),
      setting({
        label: 'Notify on failure',
        control: switchControl(general.notifyOnFailure, (checked) =>
          void write({ general: { notifyOnFailure: checked } }),
        ),
      }),
    ),
    keyboardCard(),
  );
}

function keyboardCard() {
  const shortcuts = [
    ['Alt + Shift + D', 'Open the Hoza YT panel'],
    ['Alt + Shift + Q', 'One-click download at your preferred quality'],
    ['Alt + Shift + M', 'Open the download manager'],
  ];

  return group(
    ...shortcuts.map(([keys, description]) =>
      setting({ label: description, control: el('kbd', { class: 'preview' }, keys) }),
    ),
    setting({
      label: 'Change shortcuts',
      help: 'Shortcuts are managed by the browser, on its extensions shortcuts page.',
      control: el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          on: {
            click: () => {
              // Chromium exposes this page; it cannot be opened programmatically
              // on every build, so a new tab is the reliable route.
              api.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {
                toast(toastSlot, 'Open your browser extensions page to edit shortcuts.', {
                  tone: 'warn',
                });
              });
            },
          },
        },
        'Open shortcuts',
      ),
    }),
  );
}

function downloadsSection() {
  const { downloads } = state.settings;

  const preview = el('div', { class: 'preview' }, previewTemplate(downloads.filenameTemplate));

  const templateInput = textControl(
    downloads.filenameTemplate,
    DEFAULT_TEMPLATE,
    (value) => {
      preview.textContent = previewTemplate(value || DEFAULT_TEMPLATE);
      writeDebounced({ downloads: { filenameTemplate: value || DEFAULT_TEMPLATE } });
    },
  );

  const tokens = el(
    'div',
    { class: 'token-list' },
    ...TEMPLATE_TOKENS.map(({ token, description }) =>
      el(
        'button',
        {
          class: 'token',
          type: 'button',
          title: description,
          on: {
            click: () => {
              templateInput.value = `${templateInput.value}${token}`;
              templateInput.dispatchEvent(new Event('input'));
              templateInput.focus();
            },
          },
        },
        token,
      ),
    ),
  );

  return sectionShell(
    'Downloads',
    'Queue behaviour, naming and where files land.',
    group(
      setting({
        label: 'Simultaneous downloads',
        help: 'More at once is not always faster; most servers throttle per connection.',
        control: numberControl(downloads.maxConcurrent, { min: 1, max: 10 }, (value) =>
          void write({ downloads: { maxConcurrent: value } }),
        ),
      }),
      setting({
        label: 'Start downloads automatically',
        help: 'Off means new downloads wait in the queue until you start them.',
        control: switchControl(downloads.autoStart, (checked) =>
          void write({ downloads: { autoStart: checked } }),
        ),
      }),
      setting({
        label: 'Ask where to save each file',
        help: 'Uses the browser save dialog instead of your download folder.',
        control: switchControl(downloads.askForLocation, (checked) =>
          void write({ downloads: { askForLocation: checked } }),
        ),
      }),
      setting({
        label: 'Subfolder',
        help: 'A folder inside your downloads directory. Leave blank to save at the top level.',
        control: textControl(downloads.subfolder, 'e.g. Hoza YT', (value) =>
          writeDebounced({ downloads: { subfolder: value } }),
        ),
        wide: true,
      }),
      setting({
        label: 'When a file already exists',
        control: selectControl(
          downloads.duplicatePolicy,
          [
            [DUPLICATE_POLICY.ASK, 'Ask me'],
            [DUPLICATE_POLICY.RENAME, 'Keep both'],
            [DUPLICATE_POLICY.REPLACE, 'Replace'],
            [DUPLICATE_POLICY.SKIP, 'Skip'],
          ],
          (value) => void write({ downloads: { duplicatePolicy: value } }),
        ),
      }),
      setting({
        label: 'Automatic retries',
        help: 'How many times to retry a download that fails for a recoverable reason.',
        control: numberControl(downloads.retryLimit, { min: 0, max: 10 }, (value) =>
          void write({ downloads: { retryLimit: value } }),
        ),
      }),
      setting({
        label: 'Parallel segment fetches',
        help: 'For HLS and DASH streams. Higher is faster until the server pushes back.',
        control: numberControl(downloads.segmentConcurrency, { min: 1, max: 8 }, (value) =>
          void write({ downloads: { segmentConcurrency: value } }),
        ),
      }),
    ),
    el(
      'div',
      { class: 'group' },
      setting({
        label: 'Filename template',
        help: 'Click a token to append it. Characters your filesystem rejects are removed automatically.',
        control: templateInput,
        stacked: true,
      }),
      el('div', { style: 'padding:0 16px 16px;display:flex;flex-direction:column;gap:12px' }, tokens, preview),
    ),
  );
}

function appearanceSection() {
  const { appearance } = state.settings;

  return sectionShell(
    'Appearance',
    'How the panel and this page look.',
    group(
      setting({
        label: 'Theme',
        control: selectControl(
          appearance.theme,
          [
            [THEME.SYSTEM, 'Match system'],
            [THEME.DARK, 'Dark'],
            [THEME.LIGHT, 'Light'],
          ],
          (value) => void write({ appearance: { theme: value } }),
        ),
      }),
      setting({
        label: 'Compact mode',
        help: 'Tighter spacing and shorter rows, for smaller screens.',
        control: switchControl(appearance.compact, (checked) =>
          void write({ appearance: { compact: checked } }),
        ),
      }),
      setting({
        label: 'Animations',
        help: 'Turn off to remove transitions and progress animations.',
        control: switchControl(appearance.animations, (checked) =>
          void write({ appearance: { animations: checked } }),
        ),
      }),
    ),
  );
}

function detectionSection() {
  const { detection } = state.settings;
  const origins = Object.entries(state.sites);

  return sectionShell(
    'Detection',
    'Where Hoza YT looks for media, and where it stays out of the way.',
    group(
      setting({
        label: 'Enable detection',
        help: 'The master switch. Off means Hoza YT never scans a page.',
        control: switchControl(detection.enabled, (checked) =>
          void write({ detection: { enabled: checked } }),
        ),
      }),
      setting({
        label: 'Scan when the panel opens',
        control: switchControl(detection.scanOnOpen, (checked) =>
          void write({ detection: { scanOnOpen: checked } }),
        ),
      }),
      setting({
        label: 'Watch network responses',
        help: 'Needed to find streams delivered through a player rather than a plain link. Only applies to sites you have granted access.',
        control: switchControl(detection.watchNetwork, (checked) =>
          void write({ detection: { watchNetwork: checked } }),
        ),
      }),
    ),
    el(
      'div',
      { class: 'section-head' },
      el('h3', {}, 'Per-site preferences'),
      el('p', { class: 'muted' }, 'Sites you have adjusted. Everything else uses the defaults above.'),
    ),
    origins.length
      ? el(
          'div',
          { class: 'site-list' },
          ...origins.map(([origin, prefs]) =>
            el(
              'div',
              { class: 'site-row' },
              el('span', { class: 'site-origin truncate' }, origin),
              el(
                'div',
                { class: 'row' },
                el('span', { class: 'faint' }, prefs.detection === false ? 'Detection off' : 'Detection on'),
                el(
                  'button',
                  {
                    class: 'btn btn-sm btn-ghost',
                    type: 'button',
                    on: {
                      click: async () => {
                        await request('site:prefs:set', {
                          url: origin,
                          patch: { detection: prefs.detection === false },
                        });
                        await load();
                      },
                    },
                  },
                  prefs.detection === false ? 'Turn on' : 'Turn off',
                ),
              ),
            ),
          ),
        )
      : el(
          'div',
          { class: 'notice' },
          icon(ICONS.search, { size: 14 }),
          'No per-site preferences yet. Adjust one from the panel while you are on a site.',
        ),
  );
}

function privacySection() {
  return sectionShell(
    'Privacy',
    'What Hoza YT stores, and what it never does.',
    el(
      'div',
      { class: 'statement' },
      el('p', {}, el('strong', {}, 'Everything stays on this device.')),
      el(
        'ul',
        {},
        el('li', {}, 'Settings and download history are written to local extension storage. Nothing is sent to a server.'),
        el('li', {}, 'Detected media is held in memory for the tab that is open, and dropped when that tab navigates away or closes.'),
        el('li', {}, 'No analytics, no telemetry, no third-party scripts, and no remote code of any kind.'),
        el('li', {}, 'Page contents are never uploaded anywhere.'),
        el('li', {}, 'Hoza YT requests no site access when it is installed. You grant each site individually, and can revoke access at any time from the browser extensions page.'),
      ),
    ),
    el(
      'div',
      { class: 'section-head' },
      el('h3', {}, 'Why each permission is needed'),
    ),
    el(
      'div',
      { class: 'group' },
      el(
        'div',
        { style: 'padding:16px' },
        el(
          'dl',
          { class: 'perm-list' },
          el('dt', {}, 'downloads'), el('dd', {}, 'Save files and report their progress.'),
          el('dt', {}, 'storage'), el('dd', {}, 'Keep your settings and history locally.'),
          el('dt', {}, 'activeTab'), el('dd', {}, 'Scan the page you are on, only when you open the panel.'),
          el('dt', {}, 'scripting'), el('dd', {}, 'Run that scan.'),
          el('dt', {}, 'webRequest'), el('dd', {}, 'Optional, and requested only when you grant a site. Observes media responses read-only; requests are never blocked or altered.'),
          el('dt', {}, 'offscreen'), el('dd', {}, 'Join stream segments into one file, which a service worker cannot do alone.'),
          el('dt', {}, 'notifications'), el('dd', {}, 'Tell you when a download finishes.'),
          el('dt', {}, 'contextMenus'), el('dd', {}, 'Add the right-click entries.'),
          el('dt', {}, 'tabs'), el('dd', {}, 'Read the title and address of the tab a download came from.'),
        ),
      ),
    ),
    el(
      'div',
      { class: 'notice notice-accent' },
      icon(ICONS.lock, { size: 14 }),
      el(
        'div',
        {},
        el('strong', {}, 'Protected media is refused, not bypassed. '),
        'When a page uses content protection, or a stream is delivered encrypted, Hoza YT reports that and stops. It does not circumvent protection, access controls or authentication.',
      ),
    ),
  );
}

function advancedSection() {
  const { advanced } = state.settings;

  return sectionShell(
    'Advanced',
    'Diagnostics and resets.',
    group(
      setting({
        label: 'Keep download history',
        help: 'Off means completed downloads are not recorded, and duplicate detection has less to work with.',
        control: switchControl(advanced.keepHistory, (checked) =>
          void write({ advanced: { keepHistory: checked } }),
        ),
      }),
      setting({
        label: 'History limit',
        help: 'Oldest entries are dropped beyond this count.',
        control: numberControl(advanced.historyLimit, { min: 0, max: 5000, step: 50 }, (value) =>
          void write({ advanced: { historyLimit: value } }),
        ),
      }),
      setting({
        label: 'Debug logging',
        help: 'Writes verbose detail to the extension console. Leave off unless you are diagnosing something.',
        control: switchControl(advanced.debugLogging, (checked) =>
          void write({ advanced: { debugLogging: checked } }),
        ),
      }),
    ),
    el(
      'div',
      { class: 'danger-zone' },
      el(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          on: {
            click: async () => {
              await request(MSG.CLEAR_HISTORY, { scope: 'all' });
              toast(toastSlot, 'Download history cleared.');
            },
          },
        },
        'Clear download history',
      ),
      el(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          on: {
            click: async () => {
              const { settings } = await request(MSG.RESET_SETTINGS);
              state.settings = settings;
              applyAppearance(settings.appearance);
              renderSection();
              toast(toastSlot, 'Settings reset to defaults.');
            },
          },
        },
        'Reset all settings',
      ),
    ),
  );
}

function aboutSection() {
  const manifest = api.runtime.getManifest();

  return sectionShell(
    'About',
    'Who made this, and what it is for.',
    group(
      setting({
        label: 'Extension',
        help: manifest.description,
        control: el('span', { class: 'preview' }, `${manifest.name} ${manifest.version}`),
        wide: true,
      }),
      setting({
        label: 'Developer',
        control: el('span', { class: 'setting-label' }, DEVELOPER.name),
      }),
      setting({
        label: 'Contact',
        help: 'For questions, bug reports and feedback.',
        control: el(
          'a',
          { class: 'btn btn-sm', href: `mailto:${DEVELOPER.email}` },
          icon(ICONS.external, { size: 14 }),
          DEVELOPER.email,
        ),
        wide: true,
      }),
    ),
    el(
      'div',
      { class: 'notice notice-accent' },
      icon(ICONS.lock, { size: 14 }),
      el(
        'div',
        {},
        el('strong', {}, 'Responsible use. '),
        'Hoza YT is for media you are authorised to download. It does not circumvent content protection, access controls or authentication, and it never converts a stream into a quality the source does not provide.',
      ),
    ),
  );
}

/* -------------------------------------------------------------- rendering */

const SECTIONS = {
  general: generalSection,
  downloads: downloadsSection,
  appearance: appearanceSection,
  detection: detectionSection,
  privacy: privacySection,
  advanced: advancedSection,
  about: aboutSection,
};

/** True only for a section this page actually defines, never a prototype key. */
function isKnownSection(name) {
  return typeof name === 'string' && Object.hasOwn(SECTIONS, name);
}

function renderSection() {
  // Fall back rather than throw: a stale hash, or markup newer than this
  // script after a partial reload, must not leave the page blank.
  if (!isKnownSection(state.section)) state.section = 'general';

  replace(sectionsNode, SECTIONS[state.section]());
  for (const button of $$('.nav-item')) {
    button.setAttribute('aria-selected', String(button.dataset.section === state.section));
  }
}

async function load() {
  const response = await request(MSG.GET_SETTINGS);
  state.settings = response.settings;
  state.sites = response.sites ?? {};
  applyAppearance(state.settings.appearance);
  renderSection();
}

/* ------------------------------------------------------------------- boot */

async function init() {
  await bootAppearance();

  const manifest = api.runtime.getManifest();
  $('#version').textContent = `Version ${manifest.version}`;

  for (const button of $$('.nav-item')) {
    button.addEventListener('click', () => {
      state.section = button.dataset.section;
      if (location.hash.slice(1) !== state.section) {
        history.replaceState(null, '', `#${state.section}`);
      }
      renderSection();
    });
  }

  $('#open-manager').addEventListener('click', () => {
    void request(MSG.OPEN_MANAGER, { section: 'active' });
  });

  const initial = location.hash.slice(1);
  if (isKnownSection(initial)) state.section = initial;

  await load();
}

void init();
