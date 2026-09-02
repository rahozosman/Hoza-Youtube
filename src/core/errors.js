/**
 * Error taxonomy.
 *
 * Every failure that reaches the UI carries a code from this table, so the
 * user reads a sentence that tells them what to do rather than "Download
 * failed." Codes are stable — history records store them.
 */

export const ErrorCode = {
  NETWORK_INTERRUPTED: 'NETWORK_INTERRUPTED',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  SERVER_ERROR: 'SERVER_ERROR',
  SOURCE_EXPIRED: 'SOURCE_EXPIRED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SOURCE_FORBIDDEN: 'SOURCE_FORBIDDEN',
  CANCELLED: 'CANCELLED',
  NO_SPACE: 'NO_SPACE',
  FILE_PERMISSION: 'FILE_PERMISSION',
  FILE_NAME_INVALID: 'FILE_NAME_INVALID',
  FILE_IN_USE: 'FILE_IN_USE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  UNSUPPORTED_LAYOUT: 'UNSUPPORTED_LAYOUT',
  PROTECTED_MEDIA: 'PROTECTED_MEDIA',
  TOO_LARGE: 'TOO_LARGE',
  HOST_PERMISSION: 'HOST_PERMISSION',
  PARSE_FAILED: 'PARSE_FAILED',
  EMPTY_STREAM: 'EMPTY_STREAM',
  UNKNOWN: 'UNKNOWN',
};

/**
 * `retryable` drives whether the Failed list offers a Retry button.
 * `hint` is the second line shown under the headline.
 */
const TABLE = {
  [ErrorCode.NETWORK_INTERRUPTED]: {
    title: 'The connection dropped part-way through.',
    hint: 'Your download was saved up to that point. Retry to continue.',
    retryable: true,
  },
  [ErrorCode.NETWORK_OFFLINE]: {
    title: 'You appear to be offline.',
    hint: 'Reconnect and retry — the queue will pick up where it left off.',
    retryable: true,
  },
  [ErrorCode.NETWORK_TIMEOUT]: {
    title: 'The server stopped responding.',
    hint: 'It may be busy. Retrying in a moment usually works.',
    retryable: true,
  },
  [ErrorCode.SERVER_ERROR]: {
    title: 'The server returned an error.',
    hint: 'This is a problem at the source, not on your machine. Try again later.',
    retryable: true,
  },
  [ErrorCode.SOURCE_EXPIRED]: {
    title: 'The media source expired.',
    hint: 'Refresh the page and try again — links like this are short-lived.',
    retryable: false,
  },
  [ErrorCode.SOURCE_FORBIDDEN]: {
    title: 'The source refused the request.',
    hint: 'The link may be tied to the page session. Refresh the page and try again.',
    retryable: false,
  },
  [ErrorCode.SOURCE_UNAVAILABLE]: {
    title: 'The media is no longer available.',
    hint: 'The source removed or moved this file.',
    retryable: false,
  },
  [ErrorCode.CANCELLED]: {
    title: 'Download cancelled.',
    hint: 'Nothing was saved.',
    retryable: true,
  },
  [ErrorCode.NO_SPACE]: {
    title: 'Not enough disk space.',
    hint: 'Free up space on the download drive, then retry.',
    retryable: true,
  },
  [ErrorCode.FILE_PERMISSION]: {
    title: 'The download folder could not be written to.',
    hint: 'Check the folder permissions in Settings, under Downloads.',
    retryable: true,
  },
  [ErrorCode.FILE_NAME_INVALID]: {
    title: 'The filename was rejected by your system.',
    hint: 'Adjust the filename template in Settings, under Downloads.',
    retryable: false,
  },
  [ErrorCode.FILE_IN_USE]: {
    title: 'The target file is open in another program.',
    hint: 'Close it, or choose a different name, then retry.',
    retryable: true,
  },
  [ErrorCode.UNSUPPORTED_FORMAT]: {
    title: 'This format cannot be saved directly.',
    hint: 'The source uses a container Hoza YT cannot write without re-encoding.',
    retryable: false,
  },
  [ErrorCode.UNSUPPORTED_LAYOUT]: {
    title: 'This stream uses a segment layout Hoza YT cannot assemble.',
    hint: 'Numbered and listed segments are supported, but not this variant.',
    retryable: false,
  },
  [ErrorCode.PROTECTED_MEDIA]: {
    title: 'This media is not available for downloading through this extension.',
    hint: 'It is delivered with access protection, which Hoza YT does not work around.',
    retryable: false,
  },
  [ErrorCode.TOO_LARGE]: {
    title: 'This stream is too large to assemble in memory.',
    hint: 'Pick a lower quality, or use a progressive version if one is offered.',
    retryable: false,
  },
  [ErrorCode.HOST_PERMISSION]: {
    title: 'Hoza YT has no access to this site.',
    hint: 'Grant access from the panel to let detection run here.',
    retryable: false,
  },
  [ErrorCode.PARSE_FAILED]: {
    title: 'The stream description could not be read.',
    hint: 'The manifest is malformed or uses an unusual extension.',
    retryable: true,
  },
  [ErrorCode.EMPTY_STREAM]: {
    title: 'The source returned no data.',
    hint: 'Refresh the page and try again.',
    retryable: true,
  },
  [ErrorCode.UNKNOWN]: {
    title: 'The download stopped unexpectedly.',
    hint: 'Retry, or open the debug log in Settings, under Advanced.',
    retryable: true,
  },
};

export function describe(code) {
  return TABLE[code] ?? TABLE[ErrorCode.UNKNOWN];
}

export function isRetryable(code) {
  return describe(code).retryable;
}

/** Error carrying a taxonomy code plus optional technical detail for the log. */
export class MediaError extends Error {
  constructor(code, detail) {
    super(detail || describe(code).title);
    this.name = 'MediaError';
    this.code = code in TABLE ? code : ErrorCode.UNKNOWN;
    this.detail = detail ?? null;
  }

  toJSON() {
    const { title, hint } = describe(this.code);
    return { code: this.code, title, hint, detail: this.detail };
  }
}

/** Normalise anything thrown into a serialisable record. */
export function toRecord(err) {
  if (err instanceof MediaError) return err.toJSON();
  const code = classifyThrown(err);
  const { title, hint } = describe(code);
  return { code, title, hint, detail: err?.message ?? String(err ?? '') };
}

function classifyThrown(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (err?.name === 'AbortError') return ErrorCode.CANCELLED;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return ErrorCode.NETWORK_OFFLINE;
  }
  if (msg.includes('timeout') || msg.includes('timed out')) return ErrorCode.NETWORK_TIMEOUT;
  if (msg.includes('failed to fetch') || msg.includes('networkerror')) {
    return ErrorCode.NETWORK_INTERRUPTED;
  }
  if (msg.includes('quota') || msg.includes('out of memory')) return ErrorCode.NO_SPACE;
  return ErrorCode.UNKNOWN;
}

/** Map an HTTP status from a media or manifest request onto the taxonomy. */
export function fromHttpStatus(status) {
  if (status === 401 || status === 403) return ErrorCode.SOURCE_FORBIDDEN;
  if (status === 404 || status === 410) return ErrorCode.SOURCE_UNAVAILABLE;
  if (status === 408 || status === 504) return ErrorCode.NETWORK_TIMEOUT;
  if (status === 416) return ErrorCode.SOURCE_EXPIRED;
  if (status === 429) return ErrorCode.SERVER_ERROR;
  if (status >= 500) return ErrorCode.SERVER_ERROR;
  if (status >= 400) return ErrorCode.SOURCE_UNAVAILABLE;
  return ErrorCode.UNKNOWN;
}

/**
 * Map chrome.downloads.DownloadItem.error onto the taxonomy.
 * The full list lives in the downloads API InterruptReason enum.
 */
export function fromInterruptReason(reason) {
  switch (reason) {
    case 'FILE_ACCESS_DENIED':
    case 'FILE_VIRUS_INFECTED':
    case 'FILE_BLOCKED':
    case 'FILE_SECURITY_CHECK_FAILED':
      return ErrorCode.FILE_PERMISSION;
    case 'FILE_NO_SPACE':
      return ErrorCode.NO_SPACE;
    case 'FILE_NAME_TOO_LONG':
    case 'FILE_TOO_LARGE':
      return ErrorCode.FILE_NAME_INVALID;
    case 'FILE_TOO_SHORT':
      return ErrorCode.EMPTY_STREAM;
    case 'FILE_SAME_AS_SOURCE':
      return ErrorCode.FILE_IN_USE;
    case 'NETWORK_FAILED':
    case 'NETWORK_DISCONNECTED':
      return ErrorCode.NETWORK_INTERRUPTED;
    case 'NETWORK_TIMEOUT':
      return ErrorCode.NETWORK_TIMEOUT;
    case 'NETWORK_SERVER_DOWN':
      return ErrorCode.SERVER_ERROR;
    case 'NETWORK_INVALID_REQUEST':
      return ErrorCode.SOURCE_EXPIRED;
    case 'SERVER_FAILED':
    case 'SERVER_BAD_CONTENT':
    case 'SERVER_CERT_PROBLEM':
      return ErrorCode.SERVER_ERROR;
    case 'SERVER_NO_RANGE':
      return ErrorCode.SOURCE_EXPIRED;
    case 'SERVER_UNAUTHORIZED':
    case 'SERVER_FORBIDDEN':
      return ErrorCode.SOURCE_FORBIDDEN;
    case 'SERVER_UNREACHABLE':
      return ErrorCode.SOURCE_UNAVAILABLE;
    case 'SERVER_CONTENT_LENGTH_MISMATCH':
    case 'SERVER_CROSS_ORIGIN_REDIRECT':
      return ErrorCode.NETWORK_INTERRUPTED;
    case 'USER_CANCELED':
      return ErrorCode.CANCELLED;
    case 'USER_SHUTDOWN':
    case 'CRASH':
      return ErrorCode.NETWORK_INTERRUPTED;
    default:
      return ErrorCode.UNKNOWN;
  }
}
