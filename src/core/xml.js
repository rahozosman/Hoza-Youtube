/**
 * A small, dependency-free XML reader.
 *
 * Service workers have no `DOMParser`, and the MPD parsing has to run in the
 * background as well as in pages, so this produces a plain tree instead:
 *
 *   { name, attrs, children, text }
 *
 * It covers what a DASH manifest uses — elements, attributes, self-closing
 * tags, comments, CDATA and the five predefined entities — and deliberately
 * ignores namespaces beyond stripping the prefix, DTDs and processing
 * instructions.
 */

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

export function decodeEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return ENTITIES.get(body) ?? match;
  });
}

/** Drop a namespace prefix: `cenc:pssh` -> `pssh`. */
function localName(name) {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function makeNode(name) {
  return { name, attrs: Object.create(null), children: [], text: '' };
}

function parseAttributes(source) {
  const attrs = Object.create(null);
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const key = localName(match[1]);
    const value = match[3] !== undefined ? match[3] : (match[4] ?? '');
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Parse an XML document. Returns the root node, or null when the input has no
 * usable root. Malformed markup is skipped rather than thrown on — a manifest
 * with one odd element should still yield its usable representations.
 */
export function parseXml(source) {
  if (typeof source !== 'string' || !source.trim()) return null;

  const text = source.replace(/^﻿/, '');
  const root = makeNode('#document');
  const stack = [root];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      appendText(stack[stack.length - 1], text.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], text.slice(i, lt));

    // <!-- comment -->
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }

    // <![CDATA[ ... ]]>
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const body = end < 0 ? text.slice(lt + 9) : text.slice(lt + 9, end);
      stack[stack.length - 1].text += body;
      i = end < 0 ? n : end + 3;
      continue;
    }

    // <?xml ... ?> and <!DOCTYPE ...>
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt < 0) break;
    const raw = text.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;

    // Closing tag
    if (raw[0] === '/') {
      const name = localName(raw.slice(1).trim());
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const name = localName(space < 0 ? body : body.slice(0, space));
    if (!name) continue;

    const node = makeNode(name);
    if (space >= 0) node.attrs = parseAttributes(body.slice(space + 1));

    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root.children[0] ?? null;
}

/** Find the `>` that closes a tag, skipping any inside quoted attributes. */
function findTagEnd(text, from) {
  let quote = null;
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function appendText(node, chunk) {
  if (!chunk) return;
  const decoded = decodeEntities(chunk);
  if (decoded.trim()) node.text += decoded;
}

/* ------------------------------------------------------------- tree access */

/** Direct children with the given local name. */
export function childrenNamed(node, name) {
  if (!node) return [];
  return node.children.filter((child) => child.name === name);
}

/** First direct child with the given local name, or null. */
export function childNamed(node, name) {
  if (!node) return null;
  return node.children.find((child) => child.name === name) ?? null;
}

/** Every descendant with the given local name, in document order. */
export function descendantsNamed(node, name) {
  const out = [];
  if (!node) return out;
  const walk = (current) => {
    for (const child of current.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Trimmed text content of a node. */
export function textOf(node) {
  return node?.text?.trim() ?? '';
}

/** Numeric attribute, or null when absent or unparseable. */
export function numAttr(node, name) {
  const raw = node?.attrs?.[name];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** String attribute, or null when absent. */
export function strAttr(node, name) {
  const raw = node?.attrs?.[name];
  return raw == null || raw === '' ? null : String(raw);
}
