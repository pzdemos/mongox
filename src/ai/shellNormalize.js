/**
 * 将 mongosh 风格字面量尽量转成 JSON/EJSON 可解析文本。
 * 当前主要处理正则：{username: /2/i} → {username: {"$regex":"2","$options":"i"}}
 */

function canStartRegex(prefix) {
  const t = String(prefix || "").trimEnd();
  if (!t) return true;
  const last = t[t.length - 1];
  return /[:\[,({=!&|?]/.test(last);
}

export function normalizeMongoShellJsonish(text) {
  const s = String(text ?? "");
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
