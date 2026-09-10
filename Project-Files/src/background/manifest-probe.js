/**
 * Media parser and quality resolver.
 *
 * Takes a detected URL and works out what the source genuinely offers. Every
 * field on a resulting stream traces back to something the manifest or the
 * HTTP response declared — nothing is filled in optimistically.
 *
 * Protection is a stop, not an obstacle: an encrypted HLS playlist or a DASH
 * manifest carrying ContentProtection produces a PROTECTED_MEDIA result.
 */

import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  playlistKind,
  isHlsPlaylist,
} from '../core/hls-parser.js';
import { parseMpd, buildSegmentPlan, isDashManifest } from '../core/dash-parser.js';
import { MediaError, ErrorCode, fromHttpStatus } from '../core/errors.js';
import { Delivery, StreamType } from '../core/constants.js';
import {
  containerOf,
  extensionOf,
  estimateSize,
  resolveUrl,
  splitCodecs,
} from '../core/format-utils.js';
import { assignBadges } from '../core/quality-resolver.js';

const FETCH_TIMEOUT_MS = 15000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

let streamSequence = 0;
const nextStreamId = () => `s${(streamSequence += 1).toString(36)}${Date.now().toString(36)}`;

/** Fetch with a timeout, mapping transport failures onto the error taxonomy. */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new MediaError(ErrorCode.NETWORK_TIMEOUT, `no response within ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new MediaError(ErrorCode.NETWORK_INTERRUPTED, err?.message ?? 'fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new MediaError(fromHttpStatus(response.status), `manifest responded ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) {
    throw new MediaError(ErrorCode.PARSE_FAILED, 'manifest is implausibly large');
  }
  const text = await response.text();
  if (!text.trim()) throw new MediaError(ErrorCode.EMPTY_STREAM, 'manifest was empty');
  return { text, finalUrl: response.url || url };
}

/**
 * Determine a progressive file's size and type. Prefers HEAD; falls back to a
 * one-byte ranged GET for servers that reject HEAD, which is common on CDNs.
 */
export async function probeProgressive(url) {
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' });
    if (head.ok) {
      const length = Number(head.headers.get('content-length'));
      return {
        size: Number.isFinite(length) && length > 0 ? length : null,
        contentType: head.headers.get('content-type'),
        acceptsRanges: (head.headers.get('accept-ranges') ?? '').includes('bytes'),
      };
    }
  } catch {
    // Fall through to the ranged GET.
  }

  try {
    const ranged = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-0' } });
    if (!ranged.ok && ranged.status !== 206) return { size: null, contentType: null };
    const contentRange = ranged.headers.get('content-range');
    const total = contentRange ? Number(contentRange.split('/')[1]) : NaN;
    // Consume the body so the connection is released promptly.
    await ranged.arrayBuffer().catch(() => {});
    return {
      size: Number.isFinite(total) && total > 0 ? total : null,
      contentType: ranged.headers.get('content-type'),
      acceptsRanges: ranged.status === 206,
    };
  } catch {
    return { size: null, contentType: null, acceptsRanges: false };
  }
}

/* -------------------------------------------------------------------- HLS */

async function analyzeHls(item) {
  const { text, finalUrl } = await fetchText(item.url);
  if (!isHlsPlaylist(text)) {
    throw new MediaError(ErrorCode.PARSE_FAILED, 'response is not an HLS playlist');
  }

  const kind = playlistKind(text);

  if (kind === 'media') {
    const media = parseMediaPlaylist(text, finalUrl);
    if (media.protected) throw new MediaError(ErrorCode.PROTECTED_MEDIA, 'playlist declares EXT-X-KEY');
    if (media.live) throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'live playlist has no end');

    const container = containerForSegments(media);
    const stream = {
      id: nextStreamId(),
      type: StreamType.MUXED,
      delivery: Delivery.HLS,
      container,
      url: finalUrl,
      width: item.width ?? null,
      height: item.height ?? null,
      bandwidth: null,
      videoCodec: null,
      audioCodec: null,
      fps: null,
      size: null,
      sizeEstimated: false,
      duration: media.duration,
      segmentCount: media.segments.length,
      sourceRef: { kind: Delivery.HLS, playlistUrl: finalUrl },
    };
    return { streams: [stream], duration: media.duration, protected: false };
  }

  if (kind !== 'master') {
    throw new MediaError(ErrorCode.PARSE_FAILED, 'playlist is neither master nor media');
  }

  const master = parseMasterPlaylist(text, finalUrl);
  if (master.protected) {
    throw new MediaError(ErrorCode.PROTECTED_MEDIA, 'master playlist declares a session key');
  }
  if (!master.variants.length && !master.audio.length) {
    throw new MediaError(ErrorCode.EMPTY_STREAM, 'master playlist lists no variants');
  }

  // One probe of the first variant gives the duration, the segment container,
  // and confirmation that the segments are not encrypted. Every size estimate
  // below is derived from that duration.
  let duration = null;
  let container = null;
  const probeTarget = master.variants[0] ?? master.audio[0];
  if (probeTarget?.url) {
    try {
      const probe = await fetchText(probeTarget.url);
      const media = parseMediaPlaylist(probe.text, probe.finalUrl);
      if (media.protected) {
        throw new MediaError(ErrorCode.PROTECTED_MEDIA, 'variant playlist declares EXT-X-KEY');
      }
      if (media.live) {
        throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'live playlist has no end');
      }
      duration = media.duration;
      container = containerForSegments(media);
    } catch (err) {
      // A protection or liveness finding is decisive and must propagate.
      if (err instanceof MediaError && err.code !== ErrorCode.PARSE_FAILED) throw err;
    }
  }

  const streams = [];

  for (const variant of master.variants) {
    streams.push({
      id: nextStreamId(),
      type: variant.type,
      delivery: Delivery.HLS,
      container: container ?? 'ts',
      containerInferred: !container,
      url: variant.url,
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth,
      videoCodec: variant.videoCodec,
      audioCodec: variant.audioCodec,
      fps: variant.fps,
      videoRange: variant.videoRange,
      size: estimateSize(variant.bandwidth, duration),
      sizeEstimated: true,
      duration,
      sourceRef: { kind: Delivery.HLS, playlistUrl: variant.url },
    });
  }

  for (const rendition of master.audio) {
    streams.push({
      id: nextStreamId(),
      type: StreamType.AUDIO,
      delivery: Delivery.HLS,
      container: container === 'ts' ? 'aac' : (container ?? 'm4a'),
      containerInferred: !container,
      url: rendition.url,
      name: rendition.name,
      lang: rendition.language,
      channels: rendition.channels,
      isDefault: rendition.isDefault,
      // A master playlist does not state a rendition's bitrate, so we do not
      // pretend to know it.
      bandwidth: null,
      audioBitrate: null,
      audioCodec: null,
      size: null,
      sizeEstimated: false,
      duration,
      sourceRef: { kind: Delivery.HLS, playlistUrl: rendition.url },
    });
  }

  const subtitles = master.subtitles.map((track) => ({
    id: nextStreamId(),
    type: StreamType.SUBTITLE,
    delivery: Delivery.HLS,
    container: 'vtt',
    url: track.url,
    name: track.name,
    lang: track.language,
    forced: track.forced,
    size: null,
    sizeEstimated: false,
    sourceRef: { kind: Delivery.HLS, playlistUrl: track.url },
  }));

  return { streams: [...streams, ...subtitles], duration, protected: false };
}

/** MPEG-TS segments concatenate into .ts; fragmented MP4 into .mp4. */
function containerForSegments(media) {
  if (media.initSegment) return 'mp4';
  const first = media.segments[0]?.url;
  const ext = first ? extensionOf(first) : null;
  if (ext === 'ts') return 'ts';
  if (ext === 'm4s' || ext === 'mp4') return 'mp4';
  if (ext === 'aac') return 'aac';
  if (ext === 'webm') return 'webm';
  return ext ? 'ts' : 'ts';
}

/* ------------------------------------------------------------------- DASH */

async function analyzeDash(item) {
  const { text, finalUrl } = await fetchText(item.url);
  if (!isDashManifest(text)) {
    throw new MediaError(ErrorCode.PARSE_FAILED, 'response is not an MPD');
  }

  const parsed = parseMpd(text, finalUrl);
  if (parsed.protected) {
    throw new MediaError(ErrorCode.PROTECTED_MEDIA, 'manifest declares ContentProtection');
  }
  if (parsed.live) {
    throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'dynamic manifests have no fixed end');
  }
  if (!parsed.streams.length) {
    throw new MediaError(ErrorCode.EMPTY_STREAM, 'manifest lists no representations');
  }

  const duration = parsed.duration;

  const streams = parsed.streams.map((entry) => {
    const container = containerOf(null, entry.mime) ?? (entry.type === StreamType.AUDIO ? 'm4a' : 'mp4');
    return {
      id: nextStreamId(),
      type: entry.type,
      delivery: Delivery.DASH,
      container,
      url: finalUrl,
      width: entry.width,
      height: entry.height,
      bandwidth: entry.bandwidth,
      videoCodec: entry.videoCodec,
      audioCodec: entry.audioCodec,
      audioBitrate: entry.type === StreamType.AUDIO ? entry.bandwidth : null,
      fps: entry.fps,
      lang: entry.lang,
      channels: entry.channels,
      size: estimateSize(entry.bandwidth, entry.duration ?? duration),
      sizeEstimated: true,
      duration: entry.duration ?? duration,
      sourceRef: {
        kind: Delivery.DASH,
        manifestUrl: finalUrl,
        address: entry.address,
        representationId: entry.representationId,
      },
    };
  });

  return {
    streams,
    duration,
    protected: false,
    partiallyProtected: parsed.partiallyProtected,
  };
}

/* ------------------------------------------------------------ progressive */

async function analyzeProgressive(item) {
  const probe = await probeProgressive(item.url);
  const contentType = probe.contentType ?? item.contentType;
  const container = containerOf(item.url, contentType) ?? 'mp4';
  const audioOnly = String(contentType ?? '').startsWith('audio/') ||
    ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'weba'].includes(container);

  const codecs = splitCodecs(codecParamOf(contentType));

  const stream = {
    id: nextStreamId(),
    type: audioOnly ? StreamType.AUDIO : StreamType.MUXED,
    delivery: Delivery.PROGRESSIVE,
    container,
    url: item.url,
    width: item.width ?? null,
    height: item.height ?? null,
    videoCodec: codecs.video,
    audioCodec: codecs.audio,
    bandwidth:
      probe.size && item.duration ? Math.round((probe.size * 8) / item.duration) : null,
    size: probe.size ?? item.contentLength ?? null,
    sizeEstimated: false,
    duration: item.duration ?? null,
    acceptsRanges: probe.acceptsRanges ?? false,
    sourceRef: { kind: Delivery.PROGRESSIVE, url: item.url },
  };

  return { streams: [stream], duration: item.duration ?? null, protected: false };
}

/** Pull a codecs="..." parameter out of a content type, if present. */
function codecParamOf(contentType) {
  if (!contentType) return null;
  const match = /codecs\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ entry */

/**
 * Analyse one detected media item.
 * Resolves to `{ streams, duration, protected }` with badges already applied,
 * or throws a MediaError the UI can render directly.
 */
export async function analyzeItem(item) {
  if (item.protected) {
    throw new MediaError(ErrorCode.PROTECTED_MEDIA, item.protectedReason ?? 'page uses EME');
  }

  let result;
  if (item.kind === Delivery.HLS) result = await analyzeHls(item);
  else if (item.kind === Delivery.DASH) result = await analyzeDash(item);
  else result = await analyzeProgressive(item);

  const withBadges = assignBadges(result.streams);
  return { ...result, streams: withBadges };
}

/**
 * Expand a stream into a concrete download plan, at the moment the user asks
 * for it. Segment lists are resolved here rather than at detection time so a
 * page with many qualities does not fetch every playlist up front.
 */
export async function buildPlan(stream) {
  const ref = stream?.sourceRef;
  if (!ref) throw new MediaError(ErrorCode.UNSUPPORTED_FORMAT, 'stream has no source reference');

  if (ref.kind === Delivery.PROGRESSIVE) {
    return { delivery: Delivery.PROGRESSIVE, url: ref.url };
  }

  if (ref.kind === Delivery.HLS) {
    const { text, finalUrl } = await fetchText(ref.playlistUrl);
    if (!isHlsPlaylist(text)) {
      throw new MediaError(ErrorCode.PARSE_FAILED, 'variant is not an HLS playlist');
    }
    const media = parseMediaPlaylist(text, finalUrl);
    if (media.protected) {
      throw new MediaError(ErrorCode.PROTECTED_MEDIA, 'playlist declares EXT-X-KEY');
    }
    if (media.live) {
      throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'live playlist has no end');
    }
    if (!media.segments.length) {
      throw new MediaError(ErrorCode.EMPTY_STREAM, 'playlist lists no segments');
    }
    return {
      delivery: Delivery.HLS,
      segments: media.segments,
      initSegment: media.initSegment,
      duration: media.duration,
    };
  }

  if (ref.kind === Delivery.DASH) {
    const { text, finalUrl } = await fetchText(ref.manifestUrl);
    const parsed = parseMpd(text, finalUrl);
    const target = locate(parsed.streams, ref);
    if (!target) {
      throw new MediaError(ErrorCode.SOURCE_EXPIRED, 'representation is gone from the manifest');
    }
    return buildSegmentPlan({
      representation: target.nodes.representation,
      adaptationSet: target.nodes.adaptationSet,
      period: target.nodes.period,
      base: target.base,
      periodDuration: target.duration ?? parsed.duration,
    });
  }

  throw new MediaError(ErrorCode.UNSUPPORTED_FORMAT, `unknown source kind ${ref.kind}`);
}

/** Re-find a representation after a manifest re-fetch, by id then by position. */
function locate(streams, ref) {
  if (ref.representationId) {
    const byId = streams.find((s) => s.representationId === ref.representationId);
    if (byId) return byId;
  }
  const a = ref.address;
  if (!a) return null;
  return (
    streams.find(
      (s) =>
        s.address?.periodIndex === a.periodIndex &&
        s.address?.adaptationIndex === a.adaptationIndex &&
        s.address?.representationIndex === a.representationIndex,
    ) ?? null
  );
}

export { resolveUrl };
