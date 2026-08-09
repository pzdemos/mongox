/**
 * 将 mongosh 风格字面量尽量转成 JSON/EJSON 可解析文本。
 * - 正则：{username: /2/i} → {"$regex":...}
 * - ISODate("...") / new Date("...") → {"$date":"..."}
 * - ObjectId("...") → {"$oid":"..."}
 */

function canStartRegex(prefix) {
  const t = String(prefix || "").trimEnd();
  if (!t) return true;
  const last = t[t.length - 1];
  return /[:\[,({=!&|?]/.test(last);
}

function replaceShellConstructors(text) {
  let s = String(text ?? "");
  // ISODate("...") / ISODate('...')
  s = s.replace(
    /\bISODate\s*\(\s*(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1\s*\)/g,
    (_, _q, inner) => JSON.stringify({ $date: inner }),
  );
  // new Date("...") / new Date('...')
  s = s.replace(
    /\bnew\s+Date\s*\(\s*(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1\s*\)/g,
    (_, _q, inner) => JSON.stringify({ $date: inner }),
  );
  // new Date(msNumber)
  s = s.replace(/\bnew\s+Date\s*\(\s*(\d{11,15})\s*\)/g, (_, ms) =>
    JSON.stringify({ $date: { $numberLong: String(ms) } }),
  );
  // ObjectId("...")
  s = s.replace(
    /\bObjectId\s*\(\s*(["'])([a-fA-F0-9]{24})\1\s*\)/g,
    (_, _q, id) => JSON.stringify({ $oid: id }),
  );
  return s;
}

export function normalizeMongoShellJsonish(text) {
  const s = replaceShellConstructors(text);
  let out = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < s.length) {
        const c = s[i];
        out += c;
        if (c === "\\" && i + 1 < s.length) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    if (ch === "/" && canStartRegex(out)) {
      i += 1;
      let pattern = "";
      let closed = false;
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
          pattern += s[i] + s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === "/") {
          closed = true;
          i += 1;
          break;
        }
        if (s[i] === "\n") break;
        pattern += s[i];
        i += 1;
      }

      if (!closed) {
        out += `/${pattern}`;
        continue;
      }

      let flags = "";
      while (i < s.length && /[gimsuy]/.test(s[i])) {
        flags += s[i];
        i += 1;
      }

      const unescaped = pattern.replace(/\\\//g, "/").replace(/\\\\/g, "\\");
      const payload = flags
        ? { $regex: unescaped, $options: flags }
        : { $regex: unescaped };
      out += JSON.stringify(payload);
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
