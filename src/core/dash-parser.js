/**
 * MPEG-DASH manifest (MPD) parsing.
 *
 * Supports the layouts that actually appear in the wild for on-demand content:
 *   - SegmentTemplate with $Number$ or $Time$, with or without a SegmentTimeline
 *   - SegmentList
 *   - SegmentBase / plain BaseURL, which is a single file and therefore
 *     downloadable progressively
 *
 * Any `<ContentProtection>` marks the adaptation set as protected, and Hoza YT
 * reports that instead of attempting to obtain keys.
 */

import {
  parseXml,
  childNamed,
  childrenNamed,
  descendantsNamed,
  textOf,
  numAttr,
  strAttr,
} from './xml.js';
import { resolveUrl, parseFrameRate, splitCodecs } from './format-utils.js';
import { StreamType, Delivery } from './constants.js';
import { MediaError, ErrorCode } from './errors.js';

/**
 * ISO 8601 duration -> seconds. DASH uses forms like `PT1H2M3.5S` and
 * occasionally includes a day component.
 */
export function parseIsoDuration(value) {
  if (!value) return null;
  const match =
    /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      String(value).trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map((part) => (part == null ? 0 : Number(part)));
  const seconds = y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + s;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function isDashManifest(text) {
  return typeof text === 'string' && /<MPD[\s>]/i.test(text);
}

/** Walk a chain of nodes, appending each level's BaseURL to the base. */
function resolveBase(nodes, baseUrl) {
  let current = baseUrl;
  for (const node of nodes) {
    const value = textOf(childNamed(node, 'BaseURL'));
    if (value) current = resolveUrl(value, current) ?? current;
  }
  return current;
}

/** Fill $Number$, $Time$, $RepresentationID$, $Bandwidth$ and $$ in a template. */
export function fillTemplate(template, vars) {
  if (!template) return null;
  // `$$` is the DASH escape for a literal dollar, and is only two characters —
  // it must be matched before the general $Identifier$ form.
  return template.replace(/\$\$|\$([A-Za-z]+)(?:%0(\d+)([dxX]))?\$/g, (match, name, width, kind) => {
    if (match === '$$') return '$';
    const key = name.toLowerCase();
    let value;
    if (key === 'number') value = vars.number;
    else if (key === 'time') value = vars.time;
    else if (key === 'representationid') value = vars.representationId;
    else if (key === 'bandwidth') value = vars.bandwidth;
    else return match;

    if (value == null) return match;
    if (width) {
      const radix = kind === 'd' ? 10 : 16;
      let text = Number(value).toString(radix);
      if (kind === 'X') text = text.toUpperCase();
      return text.padStart(Number(width), '0');
    }
    return String(value);
  });
}

/** Expand a SegmentTimeline into absolute `{ time, duration }` entries. */
function expandTimeline(timelineNode) {
  const entries = [];
  let cursor = 0;
  for (const s of childrenNamed(timelineNode, 'S')) {
    const t = numAttr(s, 't');
    const d = numAttr(s, 'd');
    const r = numAttr(s, 'r') ?? 0;
    if (d == null || d <= 0) continue;
    if (t != null) cursor = t;
    // r = -1 means "repeat until the period ends", which only occurs on live
    // manifests. Those have no stable end, so we stop rather than guess.
    if (r < 0) return { entries, unbounded: true };
    for (let i = 0; i <= r; i += 1) {
      entries.push({ time: cursor, duration: d });
      cursor += d;
    }
  }
  return { entries, unbounded: false };
}

/**
 * Build the download plan for one Representation.
 *
 * Returns either
 *   `{ delivery: 'progressive', url }` for a single-file representation, or
 *   `{ delivery: 'dash', initSegment, segments }` for a segmented one.
 *
 * Throws a MediaError(UNSUPPORTED_LAYOUT) when the layout cannot be expanded.
 */
export function buildSegmentPlan({ representation, adaptationSet, period, base, periodDuration }) {
  const chain = [period, adaptationSet, representation].filter(Boolean);
  const repBase = resolveBase(chain, base);
  const representationId = strAttr(representation, 'id');
  const bandwidth = numAttr(representation, 'bandwidth');

  const template =
    childNamed(representation, 'SegmentTemplate') ??
    childNamed(adaptationSet, 'SegmentTemplate') ??
    childNamed(period, 'SegmentTemplate');

  const list =
    childNamed(representation, 'SegmentList') ??
    childNamed(adaptationSet, 'SegmentList') ??
    childNamed(period, 'SegmentList');

  const segmentBase =
    childNamed(representation, 'SegmentBase') ?? childNamed(adaptationSet, 'SegmentBase');

  // A representation with only a SegmentBase (or nothing at all) is one file.
  if (!template && !list) {
    const url = repBase;
    if (!url) throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'representation has no BaseURL');
    return { delivery: Delivery.PROGRESSIVE, url, indexed: !!segmentBase };
  }

  if (list) {
    const initNode = childNamed(list, 'Initialization');
    const initUrl = strAttr(initNode, 'sourceURL');
    const segments = childrenNamed(list, 'SegmentURL')
      .map((node) => {
        const media = strAttr(node, 'media');
        return media ? { url: resolveUrl(media, repBase) } : { url: repBase };
      })
      .filter((segment) => !!segment.url);
    if (!segments.length) {
      throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'SegmentList is empty');
    }
    return {
      delivery: Delivery.DASH,
      initSegment: initUrl ? { url: resolveUrl(initUrl, repBase) } : null,
      segments,
    };
  }

  // SegmentTemplate
  const media = strAttr(template, 'media');
  if (!media) throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'SegmentTemplate has no @media');

  const timescale = numAttr(template, 'timescale') ?? 1;
  const startNumber = numAttr(template, 'startNumber') ?? 1;
  const initialization = strAttr(template, 'initialization');
  const initSegment = initialization
    ? {
        url: resolveUrl(
          fillTemplate(initialization, { representationId, bandwidth, number: startNumber, time: 0 }),
          repBase,
        ),
      }
    : null;

  const timelineNode = childNamed(template, 'SegmentTimeline');
  const segments = [];

  if (timelineNode) {
    const { entries, unbounded } = expandTimeline(timelineNode);
    if (unbounded) {
      throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'live SegmentTimeline has no end');
    }
    entries.forEach((entry, index) => {
      const url = resolveUrl(
        fillTemplate(media, {
          representationId,
          bandwidth,
          number: startNumber + index,
          time: entry.time,
        }),
        repBase,
      );
      if (url) segments.push({ url, duration: entry.duration / timescale });
    });
  } else {
    const segDuration = numAttr(template, 'duration');
    if (!segDuration || segDuration <= 0) {
      throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'SegmentTemplate has no duration');
    }
    if (!periodDuration || periodDuration <= 0) {
      throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'manifest declares no duration');
    }
    const perSegment = segDuration / timescale;
    const count = Math.ceil(periodDuration / perSegment);
    for (let index = 0; index < count; index += 1) {
      const url = resolveUrl(
        fillTemplate(media, {
          representationId,
          bandwidth,
          number: startNumber + index,
          time: Math.round(index * segDuration),
        }),
        repBase,
      );
      if (url) segments.push({ url, duration: perSegment });
    }
  }

  if (!segments.length) {
    throw new MediaError(ErrorCode.UNSUPPORTED_LAYOUT, 'no segments could be derived');
  }
  return { delivery: Delivery.DASH, initSegment, segments };
}

/**
 * Parse an MPD into a flat list of representations.
 *
 * Each entry keeps a reference to the nodes it came from so the segment plan
 * can be built lazily, only for the stream the user actually picks.
 */
export function parseMpd(text, baseUrl) {
  const root = parseXml(text);
  if (!root || root.name !== 'MPD') {
    throw new MediaError(ErrorCode.PARSE_FAILED, 'root element is not <MPD>');
  }

  const isDynamic = (strAttr(root, 'type') ?? 'static').toLowerCase() === 'dynamic';
  const totalDuration = parseIsoDuration(strAttr(root, 'mediaPresentationDuration'));
  const mpdBase = resolveBase([root], baseUrl);

  const streams = [];
  let anyProtected = false;

  const periods = descendantsNamed(root, 'Period');
  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const period = periods[periodIndex];
    const periodDuration = parseIsoDuration(strAttr(period, 'duration')) ?? totalDuration;

    const adaptationSets = childrenNamed(period, 'AdaptationSet');
    for (let adaptationIndex = 0; adaptationIndex < adaptationSets.length; adaptationIndex += 1) {
      const adaptationSet = adaptationSets[adaptationIndex];
      const protectedSet = descendantsNamed(adaptationSet, 'ContentProtection').length > 0;
      if (protectedSet) {
        anyProtected = true;
        continue;
      }

      const setMime = strAttr(adaptationSet, 'mimeType');
      const contentType = (
        strAttr(adaptationSet, 'contentType') ??
        setMime?.split('/')[0] ??
        ''
      ).toLowerCase();
      const lang = strAttr(adaptationSet, 'lang');
      const setCodecs = strAttr(adaptationSet, 'codecs');
      const setFps = strAttr(adaptationSet, 'frameRate');

      const representations = childrenNamed(adaptationSet, 'Representation');
      for (
        let representationIndex = 0;
        representationIndex < representations.length;
        representationIndex += 1
      ) {
        const representation = representations[representationIndex];
        if (descendantsNamed(representation, 'ContentProtection').length > 0) {
          anyProtected = true;
          continue;
        }

        const mime = strAttr(representation, 'mimeType') ?? setMime;
        const codecsText = strAttr(representation, 'codecs') ?? setCodecs;
        const codecs = splitCodecs(codecsText);
        const width = numAttr(representation, 'width') ?? numAttr(adaptationSet, 'width');
        const height = numAttr(representation, 'height') ?? numAttr(adaptationSet, 'height');
        const bandwidth = numAttr(representation, 'bandwidth');

        const kind = contentType || (height ? 'video' : 'audio');
        let type;
        if (kind === 'video') {
          type = codecs.audio ? StreamType.MUXED : StreamType.VIDEO;
        } else if (kind === 'audio') {
          type = StreamType.AUDIO;
        } else if (kind === 'text') {
          type = StreamType.SUBTITLE;
        } else {
          continue;
        }

        streams.push({
          type,
          mime,
          width,
          height,
          bandwidth,
          videoCodec: codecs.video,
          audioCodec: codecs.audio ?? (kind === 'audio' ? codecsText : null),
          fps: parseFrameRate(strAttr(representation, 'frameRate') ?? setFps),
          lang,
          sampleRate: numAttr(representation, 'audioSamplingRate'),
          channels: readChannels(representation) ?? readChannels(adaptationSet),
          duration: periodDuration,
          representationId: strAttr(representation, 'id'),
          // Positional address, so the representation can be found again after
          // the stream list has crossed a message boundary to the UI and back.
          address: { periodIndex, adaptationIndex, representationIndex },
          // Retained for in-process use; stripped before the list is sent anywhere.
          nodes: { representation, adaptationSet, period },
          base: mpdBase,
        });
      }
    }
  }

  return {
    protected: anyProtected && streams.length === 0,
    partiallyProtected: anyProtected && streams.length > 0,
    live: isDynamic,
    duration: totalDuration,
    base: mpdBase,
    streams,
  };
}

function readChannels(node) {
  const config = childNamed(node, 'AudioChannelConfiguration');
  const value = strAttr(config, 'value');
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
