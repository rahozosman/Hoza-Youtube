/**
 * Quality intelligence.
 *
 * Ranks the streams a source actually offers, labels them, and resolves the
 * smart presets. Nothing here invents a quality: every field it reads was
 * declared by the manifest or the media response.
 */

import { StreamType, SmartMode } from './constants.js';
import {
  codecFamily,
  qualityLabel,
  shortQualityLabel,
  humanBytes,
  humanBitrate,
  audioBitrateLabel,
  displayFps,
  isLosslessAudio,
} from './format-utils.js';

/** Badges shown on a row. Order matters — the first one is the primary. */
export const Badge = {
  BEST: 'BEST',
  RECOMMENDED: 'RECOMMENDED',
  SMALLEST: 'SMALLEST',
  UHD_8K: '8K',
  UHD_4K: '4K',
  HDR: 'HDR',
  HIGH_FPS: '60 FPS',
  AUDIO_ONLY: 'AUDIO ONLY',
  VIDEO_ONLY: 'VIDEO ONLY',
};

const isVideoish = (s) => s.type === StreamType.MUXED || s.type === StreamType.VIDEO;

/** Effective bits per second once codec efficiency is taken into account. */
function effectiveBitrate(stream) {
  const raw = stream.bandwidth;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const efficiency = codecFamily(stream.videoCodec)?.efficiency ?? 1;
  return raw * efficiency;
}

/** Pixel count, falling back to a 16:9 assumption when width is absent. */
function pixels(stream) {
  if (Number.isFinite(stream.width) && Number.isFinite(stream.height)) {
    return stream.width * stream.height;
  }
  if (Number.isFinite(stream.height)) return stream.height * stream.height * (16 / 9);
  return 0;
}

/**
 * Composite quality score, weighted in the order the spec asks for:
 * resolution, then video bitrate, then codec efficiency, then framerate,
 * then audio, then compatibility.
 *
 * The magnitudes keep resolution dominant so a heavily-encoded 720p never
 * outranks a 1080p, while still separating two streams at the same height.
 */
export function scoreStream(stream) {
  if (stream.type === StreamType.SUBTITLE) return 0;

  if (stream.type === StreamType.AUDIO) return audioScore(stream);

  const height = Number.isFinite(stream.height) ? stream.height : 0;
  const resolution = height * 1000;

  const bitrate = effectiveBitrate(stream);
  // log scale: a 10x bitrate difference is worth roughly one 240p step.
  const bitrateTerm = bitrate > 0 ? Math.log10(bitrate) * 60 : 0;

  const efficiency = (codecFamily(stream.videoCodec)?.efficiency ?? 1) * 40;
  const fps = displayFps(stream.fps) ?? 0;
  const fpsTerm = fps >= 48 ? 120 : fps >= 24 ? 40 : 0;
  const audioTerm = stream.type === StreamType.MUXED ? audioScore(stream) / 40 : 0;
  const compatibility = (codecFamily(stream.videoCodec)?.compatibility ?? 0.5) * 25;
  const pixelTie = pixels(stream) / 1_000_000;

  return resolution + bitrateTerm + efficiency + fpsTerm + audioTerm + compatibility + pixelTie;
}

/** Audio-only score: lossless first, then bitrate adjusted for codec, then channels. */
export function audioScore(stream) {
  const codec = stream.audioCodec;
  if (isLosslessAudio(codec)) return 100_000;
  const rate = Number.isFinite(stream.audioBitrate)
    ? stream.audioBitrate
    : Number.isFinite(stream.bandwidth)
      ? stream.bandwidth
      : 0;
  const efficiency = codecFamily(codec)?.efficiency ?? 1;
  const channels = Number.isFinite(stream.channels) ? Math.min(stream.channels, 8) : 2;
  return rate * efficiency + channels * 2000;
}

/** Highest first. Ties break toward the smaller file, then the friendlier codec. */
export function rankStreams(streams) {
  return [...streams].sort((a, b) => {
    const delta = scoreStream(b) - scoreStream(a);
    if (Math.abs(delta) > 0.0001) return delta;
    const sizeA = a.size ?? Infinity;
    const sizeB = b.size ?? Infinity;
    if (sizeA !== sizeB) return sizeA - sizeB;
    const compatA = codecFamily(a.videoCodec ?? a.audioCodec)?.compatibility ?? 0;
    const compatB = codecFamily(b.videoCodec ?? b.audioCodec)?.compatibility ?? 0;
    return compatB - compatA;
  });
}

/**
 * Quality per byte, used by the Balanced preset. Streams with no known size
 * fall back to bitrate, which is the same ratio expressed differently.
 */
function efficiencyScore(stream) {
  const quality = scoreStream(stream);
  const cost = stream.size ?? (stream.bandwidth ? stream.bandwidth * 60 : null);
  if (!cost || cost <= 0) return quality;
  return quality / Math.sqrt(cost);
}

/**
 * Attach badges to a ranked list. Mutates nothing — returns new stream
 * objects carrying a `badges` array.
 */
export function assignBadges(streams) {
  const videos = streams.filter(isVideoish);
  const audios = streams.filter((s) => s.type === StreamType.AUDIO);

  const rankedVideo = rankStreams(videos);
  const best = rankedVideo[0] ?? null;

  const balancedPool = rankedVideo.filter((s) => (s.height ?? 0) <= 1080);
  const recommended =
    (balancedPool.length ? balancedPool : rankedVideo)
      .slice()
      .sort((a, b) => efficiencyScore(b) - efficiencyScore(a))[0] ?? null;

  const sized = rankedVideo.filter((s) => Number.isFinite(s.size) && s.size > 0);
  const smallest = sized.length
    ? sized.reduce((min, s) => (s.size < min.size ? s : min))
    : null;

  const bestAudio = rankStreams(audios)[0] ?? null;

  return streams.map((stream) => {
    const badges = [];
    if (stream === best) badges.push(Badge.BEST);
    if (stream === recommended && stream !== best) badges.push(Badge.RECOMMENDED);
    if (stream === smallest && stream !== best && stream !== recommended) {
      badges.push(Badge.SMALLEST);
    }
    if (stream === bestAudio && audios.length > 1) badges.push(Badge.BEST);

    const height = stream.height ?? 0;
    if (height >= 4320) badges.push(Badge.UHD_8K);
    else if (height >= 2160) badges.push(Badge.UHD_4K);

    if (isHdr(stream)) badges.push(Badge.HDR);
    if ((displayFps(stream.fps) ?? 0) >= 48) badges.push(Badge.HIGH_FPS);

    if (stream.type === StreamType.AUDIO) badges.push(Badge.AUDIO_ONLY);
    if (stream.type === StreamType.VIDEO) badges.push(Badge.VIDEO_ONLY);

    return { ...stream, badges };
  });
}

function isHdr(stream) {
  const range = String(stream.videoRange ?? '').toUpperCase();
  if (range && range !== 'SDR') return true;
  const codec = String(stream.videoCodec ?? '').toLowerCase();
  return codec.startsWith('dvh1') || codec.startsWith('dvhe');
}

/**
 * Resolve a smart preset against what the source offers.
 *
 * Every preset degrades rather than fails: if the exact target is missing, the
 * closest available option is returned. Returns null only when the list has no
 * candidate of the required kind at all.
 */
export function pickSmart(streams, mode, prefs = {}) {
  const videos = rankStreams(streams.filter(isVideoish));
  const audios = rankStreams(streams.filter((s) => s.type === StreamType.AUDIO));

  switch (mode) {
    case SmartMode.BEST:
      return videos[0] ?? audios[0] ?? null;

    case SmartMode.BALANCED: {
      if (!videos.length) return audios[0] ?? null;
      const pool = videos.filter((s) => (s.height ?? 0) <= 1080);
      const candidates = pool.length ? pool : videos;
      return candidates.slice().sort((a, b) => efficiencyScore(b) - efficiencyScore(a))[0];
    }

    case SmartMode.SAVER: {
      if (!videos.length) return audios[audios.length - 1] ?? null;
      // Lowest rung that is still watchable; only go below 360p if nothing else exists.
      const watchable = videos.filter((s) => (s.height ?? 0) >= 360);
      const pool = watchable.length ? watchable : videos;
      return pool[pool.length - 1];
    }

    case SmartMode.AUDIO:
      return audios[0] ?? null;

    case SmartMode.CUSTOM:
    default:
      return pickPreferred(streams, prefs);
  }
}

/**
 * One-click resolution: honour the remembered preference, and fall back to the
 * closest available height rather than refusing to download.
 */
export function pickPreferred(streams, prefs = {}) {
  const {
    preferredHeight = 1080,
    preferredContainer = null,
    preferredVideoCodec = null,
    audioOnly = false,
  } = prefs;

  const audios = rankStreams(streams.filter((s) => s.type === StreamType.AUDIO));
  if (audioOnly) return audios[0] ?? null;

  const videos = rankStreams(streams.filter(isVideoish));
  if (!videos.length) return audios[0] ?? null;

  // Prefer an exact height match, then the nearest below, then the nearest above.
  const withHeight = videos.filter((s) => Number.isFinite(s.height));
  const pool = withHeight.length ? withHeight : videos;

  // Prefer the best option at or below the target. When everything on offer is
  // higher, step up to the *lowest* of those rather than the highest — the
  // nearest neighbour, not the opposite end of the ladder.
  const atOrBelow = pool.filter((s) => (s.height ?? 0) <= preferredHeight);
  const tier = atOrBelow.length ? atOrBelow : [pool[pool.length - 1]];

  const targetHeight = tier[0]?.height ?? null;
  const sameHeight = tier.filter((s) => s.height === targetHeight);
  const candidates = sameHeight.length ? sameHeight : tier;

  const byContainer = preferredContainer
    ? candidates.filter((s) => s.container === preferredContainer)
    : [];
  const byCodec = preferredVideoCodec
    ? (byContainer.length ? byContainer : candidates).filter(
        (s) => codecFamily(s.videoCodec)?.short === preferredVideoCodec,
      )
    : [];

  return byCodec[0] ?? byContainer[0] ?? candidates[0] ?? null;
}

/* ------------------------------------------------------------- description */

/** Primary row label: "1080p Full HD", "Opus 160 kbps", "English (subtitles)". */
export function primaryLabel(stream) {
  if (stream.type === StreamType.SUBTITLE) {
    return stream.name ?? stream.lang ?? 'Subtitles';
  }
  if (stream.type === StreamType.AUDIO) {
    const rate = audioBitrateLabel(stream.audioBitrate ?? stream.bandwidth, stream.audioCodec);
    const codec = codecFamily(stream.audioCodec)?.name;
    if (codec && rate) return `${codec} ${rate}`;
    return rate ?? codec ?? stream.name ?? 'Audio';
  }
  return qualityLabel(stream.height) ?? stream.container?.toUpperCase() ?? 'Video';
}

export function compactLabel(stream) {
  if (stream.type === StreamType.AUDIO) {
    return audioBitrateLabel(stream.audioBitrate ?? stream.bandwidth, stream.audioCodec) ?? 'Audio';
  }
  if (stream.type === StreamType.SUBTITLE) return stream.lang?.toUpperCase() ?? 'SUB';
  return shortQualityLabel(stream.height);
}

/**
 * The detail line from the spec, built only from fields the source declared:
 *   1080p • MP4 • H.264 • 1920x1080 • 5.2 Mbps • 184 MB
 */
export function describeStream(stream) {
  const parts = [];

  if (isVideoish(stream)) {
    const quality = qualityLabel(stream.height, { withSuffix: false });
    if (quality) parts.push(quality);
  }
  if (stream.container) parts.push(stream.container.toUpperCase());

  const video = codecFamily(stream.videoCodec)?.name;
  if (video) parts.push(video);
  const audio = codecFamily(stream.audioCodec)?.name;
  if (audio && (!video || stream.type !== StreamType.MUXED)) parts.push(audio);

  if (Number.isFinite(stream.width) && Number.isFinite(stream.height)) {
    parts.push(`${stream.width}x${stream.height}`);
  }

  const fps = displayFps(stream.fps);
  if (fps && fps >= 48) parts.push(`${fps} fps`);

  const bitrate = humanBitrate(stream.bandwidth);
  if (bitrate) parts.push(bitrate);

  if (Number.isFinite(stream.size) && stream.size > 0) {
    parts.push(stream.sizeEstimated ? `~${humanBytes(stream.size)}` : humanBytes(stream.size));
  }

  return parts.join(' • ');
}

/** Human summary of what a detection found, for the popup header. */
export function summariseDetection(streams) {
  const video = streams.filter(isVideoish).length;
  const audio = streams.filter((s) => s.type === StreamType.AUDIO).length;
  const parts = [];
  if (video) parts.push(`${video} video ${video === 1 ? 'quality' : 'qualities'}`);
  if (audio) parts.push(`${audio} audio ${audio === 1 ? 'stream' : 'streams'}`);
  if (!parts.length) return 'No downloadable streams';
  return `${parts.join(' and ')} available`;
}
