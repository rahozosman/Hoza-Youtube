/** Shared vocabulary between the background, content scripts and UI pages. */

/** Message types. Every cross-context message carries `{ type, ...payload }`. */
export const MSG = {
  // content script -> background
  MEDIA_FOUND: 'media:found',
  PAGE_INFO: 'page:info',
  PAGE_PROTECTED: 'page:protected',

  // UI -> background
  GET_TAB_STATE: 'state:tab',
  ANALYZE_MEDIA: 'media:analyze',
  RESCAN: 'media:rescan',
  START_DOWNLOAD: 'download:start',
  QUICK_DOWNLOAD: 'download:quick',
  PAUSE_JOB: 'download:pause',
  RESUME_JOB: 'download:resume',
  CANCEL_JOB: 'download:cancel',
  RETRY_JOB: 'download:retry',
  REMOVE_JOB: 'download:remove',
  PAUSE_ALL: 'download:pauseAll',
  RESUME_ALL: 'download:resumeAll',
  REORDER_QUEUE: 'queue:reorder',
  GET_JOBS: 'jobs:get',
  GET_HISTORY: 'history:get',
  CLEAR_HISTORY: 'history:clear',
  REVEAL_FILE: 'file:reveal',
  OPEN_FILE: 'file:open',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  RESET_SETTINGS: 'settings:reset',
  GET_SITE_ACCESS: 'site:access:get',
  OPEN_MANAGER: 'ui:manager',
  RESOLVE_DUPLICATE: 'download:duplicate:resolve',

  // in-page panel -> background -> local Hoza YT server
  OPEN_DASHBOARD: 'ui:dashboard',
  SERVER_ANALYZE: 'hoza:analyze',
  SERVER_DOWNLOAD: 'hoza:download',
  SERVER_JOBS: 'hoza:jobs',
  SERVER_ABOUT: 'hoza:about',

<<<<<<< HEAD
  // the local app's connection, for any surface that shows it
  GET_SERVER_STATE: 'hoza:state:get',
  RETRY_SERVER: 'hoza:state:retry',

=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
  // background -> UI broadcast
  JOBS_CHANGED: 'jobs:changed',
  MEDIA_CHANGED: 'media:changed',
  DUPLICATE_PROMPT: 'download:duplicate:prompt',
<<<<<<< HEAD
  SERVER_STATE: 'hoza:state:changed',
=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57

  // background <-> offscreen
  OFFSCREEN_ASSEMBLE: 'offscreen:assemble',
  OFFSCREEN_ABORT: 'offscreen:abort',
  OFFSCREEN_PAUSE: 'offscreen:pause',
  OFFSCREEN_RESUME: 'offscreen:resume',
  OFFSCREEN_PROGRESS: 'offscreen:progress',
  OFFSCREEN_DONE: 'offscreen:done',
  OFFSCREEN_REVOKE: 'offscreen:revoke',
};

/** Lifecycle of a download job. */
export const JobState = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const ACTIVE_STATES = new Set([
  JobState.QUEUED,
  JobState.PREPARING,
  JobState.DOWNLOADING,
  JobState.PAUSED,
]);

/** How a stream is delivered, which decides the download strategy. */
export const Delivery = {
  PROGRESSIVE: 'progressive', // a single file — hand to chrome.downloads
  HLS: 'hls', // segment list — assemble
  DASH: 'dash', // segment list — assemble
};

/** What a stream actually contains. */
export const StreamType = {
  MUXED: 'video+audio',
  VIDEO: 'video',
  AUDIO: 'audio',
  SUBTITLE: 'subtitle',
};

/** Smart-quality presets offered in the popup. */
export const SmartMode = {
  BEST: 'best',
  BALANCED: 'balanced',
  SAVER: 'saver',
  AUDIO: 'audio',
  CUSTOM: 'custom',
};

/** Detection outcome shown in the popup header. */
export const DetectState = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  NONE: 'none',
  FOUND: 'found',
  MULTIPLE: 'multiple',
  PROTECTED: 'protected',
  NO_ACCESS: 'no-access',
  UNSUPPORTED_PAGE: 'unsupported-page',
};

<<<<<<< HEAD
/**
 * The local app's connection, as the user sees it.
 *
 * These are states of the *connection*, not of a server: nobody using this
 * needs to know that a port exists. Every one of them has a sentence in
 * `SERVER_STATE_TEXT`, and no surface is allowed to invent its own.
 */
export const ServerState = {
  UNKNOWN: 'unknown',
  STARTING: 'starting',
  CONNECTING: 'connecting',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  UNAVAILABLE: 'unavailable',
  NOT_INSTALLED: 'not-installed',
};

/** One sentence per state. Nothing here mentions a terminal or a command. */
export const SERVER_STATE_TEXT = {
  [ServerState.UNKNOWN]: 'Checking…',
  [ServerState.STARTING]: 'Starting…',
  [ServerState.CONNECTING]: 'Connecting…',
  [ServerState.READY]: 'Ready',
  [ServerState.RECONNECTING]: 'Reconnecting…',
  [ServerState.UNAVAILABLE]: 'Hoza YT is unavailable',
  [ServerState.NOT_INSTALLED]: 'Hoza YT is not installed on this computer',
};

=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
/** Video containers we can name confidently. */
export const CONTAINERS = ['mp4', 'webm', 'mkv', 'ts', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'flac', 'aac', 'm4s'];

/** Extensions that identify a progressive media response. */
export const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ogv',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba',
]);

/** Extensions that identify an adaptive manifest. */
export const MANIFEST_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd']);

/** Segment extensions — noise on their own, meaningful only via a manifest. */
export const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'aac', 'vtt']);

/** Anything smaller than this in a media response is almost certainly a segment. */
export const MIN_PROGRESSIVE_BYTES = 256 * 1024;

/** Refuse to buffer an assembled download larger than this (memory ceiling). */
export const MAX_ASSEMBLED_BYTES = 3 * 1024 * 1024 * 1024;

/** Poll interval for native download progress. */
export const PROGRESS_POLL_MS = 700;

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  JOBS: 'jobs',
  HISTORY: 'history',
  SITE_PREFS: 'sitePrefs',
};

export const HISTORY_LIMIT = 500;
