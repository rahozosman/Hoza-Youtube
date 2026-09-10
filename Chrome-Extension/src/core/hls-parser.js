/**
 * HLS (RFC 8216) playlist parsing.
 *
 * Handles the two playlist kinds:
 *   - master: lists variant streams plus alternate audio/subtitle renditions
 *   - media:  lists the actual segments for one rendition
 *
 * Encryption is treated as a hard stop. `#EXT-X-KEY` (other than METHOD=NONE)
 * and `#EXT-X-SESSION-KEY` mean the segments are protected, and Hoza YT reports
 * that rather than attempting to obtain keys.
 */

import { resolveUrl, parseFrameRate, splitCodecs } from './format-utils.js';
import { StreamType } from './constants.js';

/**
 * Parse an attribute list of the form `KEY=value,KEY="quoted,value"`.
 * Quoted values may contain commas, so a naive split is not enough.
 */
export function parseAttributes(input) {
  const attrs = {};
  if (!input) return attrs;

  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && (input[i] === ',' || input[i] === ' ')) i += 1;
    if (i >= n) break;

    const eq = input.indexOf('=', i);
    if (eq < 0) break;
    const key = input.slice(i, eq).trim().toUpperCase();
    i = eq + 1;

    let value;
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1);
      if (close < 0) {
        value = input.slice(i + 1);
        i = n;
      } else {
        value = input.slice(i + 1, close);
        i = close + 1;
      }
    } else {
      let end = input.indexOf(',', i);
      if (end < 0) end = n;
      value = input.slice(i, end).trim();
      i = end;
    }
    if (key) attrs[key] = value;
  }
  return attrs;
}

function parseResolution(value) {
  if (!value) return { width: null, height: null };
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(value.trim());
  if (!match) return { width: null, height: null };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Split into trimmed, non-empty lines. Tolerates CRLF and a stray BOM. */
function toLines(text) {
  return String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function isHlsPlaylist(text) {
  return typeof text === 'string' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

/** 'master' | 'media' | null */
export function playlistKind(text) {
  if (!isHlsPlaylist(text)) return null;
  if (text.includes('#EXT-X-STREAM-INF')) return 'master';
  if (text.includes('#EXTINF')) return 'media';
  return null;
}

/** True when a KEY tag describes real encryption rather than METHOD=NONE. */
function keyTagEncrypts(attrLine) {
  const method = parseAttributes(attrLine).METHOD;
  return !!method && method.toUpperCase() !== 'NONE';
}

/**
 * Parse a master playlist.
 *
 * Returns `{ protected, variants, audio, subtitles }`. Variants carry the
 * media characteristics the source declared — nothing is inferred that the
 * playlist did not state.
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = toLines(text);
  const variants = [];
  const audio = [];
  const subtitles = [];
  let isProtected = false;
  let pending = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      if (keyTagEncrypts(line.slice('#EXT-X-SESSION-KEY:'.length))) isProtected = true;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = (a.TYPE ?? '').toUpperCase();
      const uri = resolveUrl(a.URI, baseUrl);
      const entry = {
        groupId: a['GROUP-ID'] ?? null,
        name: a.NAME ?? null,
        language: a.LANGUAGE ?? null,
        isDefault: (a.DEFAULT ?? '').toUpperCase() === 'YES',
        forced: (a.FORCED ?? '').toUpperCase() === 'YES',
        channels: a.CHANNELS ? Number(a.CHANNELS.split('/')[0]) : null,
        url: uri,
      };
      // A rendition with no URI is muxed into the variant itself.
      if (!uri) continue;
      if (type === 'AUDIO') audio.push(entry);
      else if (type === 'SUBTITLES' || type === 'CLOSED-CAPTIONS') subtitles.push(entry);
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    // Trick-play streams are not useful as downloads.
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      pending = null;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      const url = resolveUrl(line, baseUrl);
      if (url) {
        const { width, height } = parseResolution(pending.RESOLUTION);
        const codecs = splitCodecs(pending.CODECS);
        const bandwidth = Number(pending['AVERAGE-BANDWIDTH'] ?? pending.BANDWIDTH);
        variants.push({
          url,
          width,
          height,
          bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null,
          peakBandwidth: Number(pending.BANDWIDTH) || null,
          videoCodec: codecs.video,
          audioCodec: codecs.audio,
          fps: parseFrameRate(pending['FRAME-RATE']),
          audioGroup: pending.AUDIO ?? null,
          subtitleGroup: pending.SUBTITLES ?? null,
          videoRange: pending['VIDEO-RANGE'] ?? null,
          // A variant that points at a separate audio group carries video only
          // when it also declares no audio codec of its own.
          type: pending.AUDIO && !codecs.audio ? StreamType.VIDEO : StreamType.MUXED,
        });
      }
      pending = null;
    }
  }

  return { protected: isProtected, variants, audio, subtitles };
}

/**
 * Parse a media playlist into an ordered segment list.
 *
 * Returns `{ protected, live, duration, initSegment, segments }` where each
 * segment is `{ url, duration, byteRange }`.
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = toLines(text);
  const segments = [];
  let isProtected = false;
  let initSegment = null;
  let duration = 0;
  let hasEndList = false;
  let pendingDuration = null;
  let pendingByteRange = null;
  let lastByteEnd = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      if (keyTagEncrypts(line.slice('#EXT-X-KEY:'.length))) isProtected = true;
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      const url = resolveUrl(a.URI, baseUrl);
      if (url) {
        initSegment = { url, byteRange: parseByteRange(a.BYTERANGE, 0) };
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length));
      pendingDuration = Number.isFinite(value) ? value : null;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), lastByteEnd);
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = resolveUrl(line, baseUrl);
    if (!url) {
      pendingDuration = null;
      pendingByteRange = null;
      continue;
    }

    segments.push({
      url,
      duration: pendingDuration,
      byteRange: pendingByteRange,
    });
    if (pendingDuration) duration += pendingDuration;
    if (pendingByteRange) lastByteEnd = pendingByteRange.end + 1;
    pendingDuration = null;
    pendingByteRange = null;
  }

  return {
    protected: isProtected,
    live: !hasEndList,
    duration: duration > 0 ? duration : null,
    initSegment,
    segments,
  };
}

/** `#EXT-X-BYTERANGE:<length>[@<offset>]` -> inclusive `{ start, end }`. */
function parseByteRange(value, previousEnd) {
  if (!value) return null;
  const [lengthText, offsetText] = String(value).trim().split('@');
  const length = Number(lengthText);
  if (!Number.isFinite(length) || length <= 0) return null;
  const start = offsetText != null ? Number(offsetText) : previousEnd;
  if (!Number.isFinite(start) || start < 0) return null;
  return { start, end: start + length - 1, length };
}
