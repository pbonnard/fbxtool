/* Reader for ASCII FBX, producing the same tree shape as the WebAssembly
 * binary reader so that analysis and rendering do not care which one ran.
 *
 * ASCII files are text, and the work is tokenising rather than number
 * crunching, so this stays in JavaScript; the geometry it produces still goes
 * through the same WebAssembly triangulator.
 */
'use strict';

const FbxAscii = (function () {
  const VERSION_COMMENT = /;\s*FBX\s+(\d+)\.(\d+)\.(\d+)/i;
  const NODE_LINE = /^[ \t]*[A-Za-z_]\w*[ \t]*:/m;
  const INT_RE = /^[+-]?\d+$/;
  const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
  const COUNT_RE = /^\*(\d+)$/;

  const SPECIAL_FLOATS = {
    '1.#inf': Infinity, '-1.#inf': -Infinity,
    '1.#ind': NaN, '-1.#ind': NaN, '1.#qnan': NaN, '-1.#qnan': NaN,
    nan: NaN, inf: Infinity, '-inf': -Infinity,
  };

  const DELIMITERS = new Set([' ', '\t', '\r', '\f', '\v', '\n', ';', '"', ':', ',', '{', '}']);

  function looksLikeAscii(text) {
    if (VERSION_COMMENT.test(text)) return true;
    const head = text.slice(0, 8192);
    if (head.includes('FBXHeaderExtension') || head.includes('FBXVersion')) return true;
    return (head.match(NODE_LINE) || []).length >= 2 && head.includes('{');
  }

  function tokenize(text) {
    const tokens = [];
    let pos = 0;
    let line = 1;
    const length = text.length;
    while (pos < length) {
      const ch = text[pos];
      if (ch === '\n') { tokens.push({ kind: 'nl', line }); line++; pos++; }
      else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') pos++;
      else if (ch === ';') { const end = text.indexOf('\n', pos); pos = end < 0 ? length : end; }
      else if (ch === '"') {
        const end = text.indexOf('"', pos + 1);
        if (end < 0) throw new Error(`unterminated string on line ${line}`);
        let raw = text.slice(pos + 1, end);
        if (raw.includes('&quot;')) raw = raw.split('&quot;').join('"');
        tokens.push({ kind: 'str', text: raw, line });
        pos = end + 1;
      } else if (ch === ':') { tokens.push({ kind: ':', line }); pos++; }
      else if (ch === ',') { tokens.push({ kind: ',', line }); pos++; }
      else if (ch === '{') { tokens.push({ kind: '{', line }); pos++; }
      else if (ch === '}') { tokens.push({ kind: '}', line }); pos++; }
      else {
        const start = pos;
        while (pos < length && !DELIMITERS.has(text[pos])) pos++;
        tokens.push({ kind: 'word', text: text.slice(start, pos), line });
      }
    }
    tokens.push({ kind: 'eof', line });
    return tokens;
  }

  function parseValue(token) {
    if (token.kind === 'str') return { kind: 'string', value: token.text };
    const text = token.text;
    const count = COUNT_RE.exec(text);
    if (count) return { kind: 'count', value: parseInt(count[1], 10) };
    if (INT_RE.test(text)) return { kind: 'int', value: parseInt(text, 10) };
    if (FLOAT_RE.test(text)) return { kind: 'float', value: parseFloat(text) };
    const lowered = text.toLowerCase();
    if (lowered in SPECIAL_FLOATS) return { kind: 'float', value: SPECIAL_FLOATS[lowered] };
    return { kind: 'word', value: text };
  }

  function toProp(entry) {
    switch (entry.kind) {
      case 'count': return { code: '*', typeName: 'array-size', value: entry.value };
      case 'word': return { code: 'W', typeName: 'word', value: entry.value };
      case 'int': return { code: 'L', typeName: 'int64', value: entry.value };
      case 'float': return { code: 'D', typeName: 'float64', value: entry.value };
      case 'string': return { code: 'S', typeName: 'string', value: entry.value };
      default: return { code: 'W', typeName: 'word', value: String(entry.value) };
    }
  }

  /** Fold the values of an `a:` record into a single array property. */
  function foldArray(entries) {
    if (!entries.length) return [];
    const allInt = entries.every((e) => e.kind === 'int' || e.kind === 'count');
    const code = allInt ? 'l' : 'd';
    const values = entries.map((e) => (typeof e.value === 'number' ? e.value : 0));
    return [{
      code,
      typeName: (allInt ? 'int64' : 'float64') + '[]',
      array: { length: values.length, encoding: 0, byteLength: 0, dataOffset: 0 },
      // ASCII arrays are already decoded, so the values ride along.
      values,
      value: null,
    }];
  }

  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const tokens = tokenize(text);
    const warnings = [];
    let index = 0;

    const peek = (ahead = 0) => tokens[Math.min(index + ahead, tokens.length - 1)];
    const next = () => tokens[index++];
    const skipNewlines = () => { while (peek().kind === 'nl') index++; };

    function consumeSeparator() {
      if (peek().kind === ',') { index++; skipNewlines(); return true; }
      let ahead = 0;
      while (peek(ahead).kind === 'nl') ahead++;
      if (ahead && peek(ahead).kind === ',') {
        index += ahead + 1;
        skipNewlines();
        return true;
      }
      return false;
    }

    function parseProperties(name) {
      const entries = [];
      for (;;) {
        const token = peek();
        if (token.kind === 'nl' || token.kind === '{' || token.kind === '}' || token.kind === 'eof') break;
        if (token.kind === ',') { index++; entries.push({ kind: 'word', value: '' }); continue; }
        entries.push(parseValue(next()));
        if (!consumeSeparator()) break;
      }
      return name === 'a' ? foldArray(entries) : entries.map(toProp);
    }

    function parseRecords(depth, insideBraces) {
      const records = [];
      for (;;) {
        skipNewlines();
        const token = peek();
        if (token.kind === 'eof') {
          if (insideBraces) warnings.push(`file ends with an unclosed '{' (line ${token.line})`);
          return records;
        }
        if (token.kind === '}') {
          if (!insideBraces) { warnings.push(`stray '}' on line ${token.line}`); index++; continue; }
          return records;
        }
        const head = next();
        if (head.kind !== 'word' && head.kind !== 'str') {
          warnings.push(`unexpected token on line ${head.line}; skipped`);
          continue;
        }
        if (peek().kind !== ':') {
          warnings.push(`record '${head.text}' on line ${head.line} is not followed by ':'; skipped`);
          continue;
        }
        index++; // ':'
        const node = { name: head.text, props: parseProperties(head.text), children: [], line: head.line };
        if (peek().kind === '{') {
          index++;
          node.children = parseRecords(depth + 1, true);
          if (peek().kind === '}') index++;
        }
        records.push(node);
      }
    }

    const root = { name: '', props: [], children: parseRecords(0, false) };

    let version = null;
    let versionSource = null;
    const header = root.children.find((n) => n.name === 'FBXHeaderExtension');
    const declared = header && header.children.find((n) => n.name === 'FBXVersion');
    if (declared && declared.props.length && typeof declared.props[0].value === 'number') {
      version = declared.props[0].value;
      versionSource = 'FBXHeaderExtension';
    } else {
      const match = VERSION_COMMENT.exec(text.slice(0, 4096));
      if (match) {
        version = (+match[1]) * 1000 + (+match[2]) * 100 + (+match[3]);
        versionSource = 'header comment';
      } else {
        warnings.push('no FBXVersion record and no version comment; version unknown');
      }
    }
    if (!root.children.length) warnings.push('no records were found');

    return {
      encoding: 'ascii',
      version,
      versionSource,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      fileSize: text.length,
      root,
      warnings,
    };
  }

  return { parse, looksLikeAscii };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxAscii;
