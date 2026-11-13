/**
 * Plain text of a PDF, for upstreams that take no document input (Kiro): Claude Code's Read tool
 * and Anthropic `document` blocks send PDFs as base64. No dependency: objects and object
 * streams are read, Flate streams inflated, pages walked in page-tree order, text operators
 * (Tj, TJ, ', ") decoded through each font's ToUnicode map (simple fonts: one byte per
 * character). Scanned PDFs (images only) and encrypted ones give no text.
 */
import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateRawSync, inflateSync } from "node:zlib";

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
/** Inflated bytes for one stream and for the whole file (a Flate bomb stops here). */
const MAX_INFLATED_STREAM = 32 * 1024 * 1024;
const MAX_INFLATED_TOTAL = 128 * 1024 * 1024;
/** Entries one font's width table or ToUnicode map may hold. */
const MAX_MAP_ENTRIES = 70_000;
/** Work time before the pages read so far are returned (the translator runs on the event loop). */
const MAX_WORK_MS = 1500;

type PdfObject = { dict: string; streamStart?: number; streamEnd?: number; inline?: string };
type CMap = { bytes: number; map: Map<number, string> };
/** A font as the text extraction needs it: code length, ToUnicode map, glyph widths (1/1000 em). */
type FontInfo = { bytes: number; cmap?: CMap; widths: Map<number, number>; dw: number };

class PdfReader {
  private objs = new Map<number, PdfObject>();
  private decoded = new Map<number, string | null>();
  private inflated = 0;
  constructor(
    private raw: Buffer,
    private s: string
  ) {}

  scan(): void {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.s))) {
      const num = Number(m[1]);
      const bodyStart = m.index + m[0].length;
      const end = this.s.indexOf("endobj", bodyStart);
      if (end === -1) break;
      // Searches stay inside this object's body, so the scan is linear in the file size.
      const body = this.s.slice(bodyStart, end);
      const streamKw = body.indexOf("stream");
      if (streamKw !== -1 && body.slice(streamKw - 3, streamKw) !== "end") {
        let start = bodyStart + streamKw + 6;
        if (this.s[start] === "\r") start++;
        if (this.s[start] === "\n") start++;
        const stop = bodyStart + body.lastIndexOf("endstream");
        this.objs.set(num, {
          dict: body.slice(0, streamKw),
          streamStart: start,
          streamEnd: stop > start ? stop : end,
        });
      } else {
        this.objs.set(num, { dict: body });
      }
      re.lastIndex = end + 6;
    }
    // Objects packed in object streams (/Type /ObjStm).
    for (const [num, obj] of [...this.objs]) {
      if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
      const data = this.stream(num);
      const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1]);
      const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1]);
      if (!data || !Number.isFinite(first) || !Number.isFinite(n)) continue;
      const header = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
        const objNum = header[i * 2];
        const off = first + header[i * 2 + 1];
        const next =
          i + 1 < n && i * 2 + 3 < header.length ? first + header[i * 2 + 3] : data.length;
        if (!this.objs.has(objNum)) this.objs.set(objNum, { dict: data.slice(off, next) });
      }
    }
  }

  get(num: number): PdfObject | undefined {
    return this.objs.get(num);
  }

  /** The decoded stream of an object (Flate only; latin1 string), or null. */
  stream(num: number): string | null {
    if (this.decoded.has(num)) return this.decoded.get(num) ?? null;
    const obj = this.objs.get(num);
    let out: string | null = null;
    if (obj?.streamStart !== undefined && obj.streamEnd !== undefined) {
      const bytes = this.raw.subarray(
        obj.streamStart,
        Math.min(obj.streamEnd, obj.streamStart + MAX_STREAM_BYTES)
      );
      const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.dict)?.[1] || "";
      if (!filter) out = bytes.toString("latin1");
      else if (
        /^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filter.trim()) &&
        this.inflated < MAX_INFLATED_TOTAL
      ) {
        const maxOutputLength = Math.min(MAX_INFLATED_STREAM, MAX_INFLATED_TOTAL - this.inflated);
        try {
          out = inflateSync(bytes, { maxOutputLength }).toString("latin1");
        } catch {
          try {
            out = inflateRawSync(bytes, { maxOutputLength }).toString("latin1");
          } catch {
            out = null;
          }
        }
        this.inflated += out?.length ?? 0;
      }
    }
    this.decoded.set(num, out);
    return out;
  }

  /** The text of an object's dictionary, following one indirect reference. */
  dictOf(value: string): string {
    const ref = /^\s*(\d+)\s+\d+\s+R/.exec(value);
    if (ref) return this.objs.get(Number(ref[1]))?.dict || "";
    return value;
  }

  /** The stream bytes as stored (no filter applied), cut to /Length when it is a number. */
  rawStream(num: number): Buffer | null {
    const obj = this.objs.get(num);
    if (obj?.streamStart === undefined || obj.streamEnd === undefined) return null;
    const len = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(obj.dict);
    const end = len ? Math.min(obj.streamEnd, obj.streamStart + Number(len[1])) : obj.streamEnd;
    return this.raw.subarray(obj.streamStart, Math.min(end, obj.streamStart + MAX_STREAM_BYTES));
  }

  /** Flate data inflated within the file's budget (image data: not cached). */
  inflate(bytes: Buffer): Buffer | null {
    if (this.inflated >= MAX_INFLATED_TOTAL) return null;
    const maxOutputLength = Math.min(MAX_INFLATED_STREAM, MAX_INFLATED_TOTAL - this.inflated);
    let out: Buffer | null = null;
    try {
      out = inflateSync(bytes, { maxOutputLength });
    } catch {
      try {
        out = inflateRawSync(bytes, { maxOutputLength });
      } catch {
        out = null;
      }
    }
    this.inflated += out?.length ?? 0;
    return out;
  }
}

/** The `<< ... >>` that starts at or after `from` (nesting counted). */
function readDict(s: string, from: number): string {
  const start = s.indexOf("<<", from);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === "<" && s[i + 1] === "<") {
      depth++;
      i++;
    } else if (s[i] === ">" && s[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/** The value after `/Key`: an inline dict, an array, or an indirect reference. */
function valueOf(dict: string, key: string): string {
  const m = new RegExp(`/${key}\\b\\s*`).exec(dict);
  if (!m) return "";
  const at = m.index + m[0].length;
  if (dict.startsWith("<<", at)) return readDict(dict, at);
  if (dict[at] === "[") {
    const close = dict.indexOf("]", at);
    return close === -1 ? "" : dict.slice(at, close + 1);
  }
  return /^\d+\s+\d+\s+R/.exec(dict.slice(at))?.[0] || "";
}

function refsIn(value: string): number[] {
  return [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 2) out.push(parseInt(padded.slice(i, i + 2), 16));
  return out;
}

function utf16Hex(hex: string): string {
  const b = hexToBytes(hex);
  let out = "";
  for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return out;
}

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = Math.max(1, Math.ceil(cs[1].length / 2));
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (map.size >= MAX_MAP_ENTRIES) break;
      map.set(parseInt(p[1], 16), utf16Hex(p[2]));
      bytes = Math.max(bytes, Math.ceil(p[1].length / 2));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g;
    let p: RegExpExecArray | null;
    while ((p = re.exec(block[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = Math.min(parseInt(p[2], 16), lo + 65535);
      bytes = Math.max(bytes, Math.ceil(p[1].length / 2));
      if (p[3].startsWith("[")) {
        const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16Hex(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length && map.size < MAX_MAP_ENTRIES; c++)
          map.set(c, items[c - lo]);
      } else {
        const base = utf16Hex(p[3].slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && map.size < MAX_MAP_ENTRIES; c++)
          map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return { bytes, map };
}

function literalBytes(s: string, start: number): { bytes: number[]; end: number } {
  const out: number[] = [];
  let depth = 1;
  let i = start + 1;
  for (; i < s.length && depth > 0; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[++i];
      if (n === "n") out.push(10);
      else if (n === "r") out.push(13);
      else if (n === "t") out.push(9);
      else if (n === "b") out.push(8);
      else if (n === "f") out.push(12);
      else if (n >= "0" && n <= "7") {
        let oct = n;
        while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        out.push(parseInt(oct, 8) & 255);
      } else if (n === "\r" || n === "\n") {
        if (n === "\r" && s[i + 1] === "\n") i++;
      } else out.push(n.charCodeAt(0) & 255);
    } else if (c === "(") {
      depth++;
      out.push(40);
    } else if (c === ")") {
      depth--;
      if (depth > 0) out.push(41);
    } else out.push(c.charCodeAt(0) & 255);
  }
  return { bytes: out, end: i };
}

function codesOf(bytes: number[], size: number): number[] {
  const codes: number[] = [];
  for (let i = 0; i + size - 1 < bytes.length; i += size) {
    let code = 0;
    for (let k = 0; k < size; k++) code = (code << 8) | bytes[i + k];
    codes.push(code);
  }
  return codes;
}

/** Text and width (1/1000 em) of a shown string. */
function decodeShown(bytes: number[], font: FontInfo | undefined): { text: string; width: number } {
  const size = font?.cmap?.map.size ? font.cmap.bytes : font?.bytes || 1;
  let text = "";
  let width = 0;
  for (const code of codesOf(bytes, size)) {
    width += font?.widths.get(code) ?? font?.dw ?? 500;
    if (font?.cmap?.map.size) text += font.cmap.map.get(code) ?? "";
    else if (code >= 32 || code === 9) text += String.fromCharCode(code);
  }
  return { text, width };
}

/** Glyph widths from a simple font's /Widths or a CID font's /W array. */
function readWidths(
  pdf: PdfReader,
  fontDict: string
): { widths: Map<number, number>; dw: number; cid: boolean } {
  const widths = new Map<number, number>();
  const isType0 = /\/Subtype\s*\/Type0\b/.test(fontDict);
  if (isType0) {
    const descRef = refsIn(valueOf(fontDict, "DescendantFonts"))[0];
    const desc = descRef !== undefined ? pdf.get(descRef)?.dict || "" : "";
    const dw = Number(/\/DW\s+(\d+)/.exec(desc)?.[1] || 1000);
    let w = valueOf(desc, "W");
    const wRef = /^\s*(\d+)\s+\d+\s+R/.exec(w);
    if (wRef) w = pdf.get(Number(wRef[1]))?.dict || "";
    const tokens = [...w.replace(/^\s*\[|\]\s*$/g, "").matchAll(/\[|\]|[-+]?\d*\.?\d+/g)].map(
      (t) => t[0]
    );
    let i = 0;
    while (i < tokens.length) {
      const first = Number(tokens[i]);
      if (tokens[i + 1] === "[") {
        let c = first;
        i += 2;
        while (i < tokens.length && tokens[i] !== "]") {
          if (widths.size < MAX_MAP_ENTRIES) widths.set(c, Number(tokens[i]));
          c++;
          i++;
        }
        i++;
      } else if (i + 2 < tokens.length) {
        const last = Number(tokens[i + 1]);
        const width = Number(tokens[i + 2]);
        for (let c = first; c <= last && widths.size < MAX_MAP_ENTRIES; c++) widths.set(c, width);
        i += 3;
      } else break;
    }
    return { widths, dw, cid: true };
  }
  const firstChar = Number(/\/FirstChar\s+(\d+)/.exec(fontDict)?.[1] || 0);
  let list = valueOf(fontDict, "Widths");
  const ref = /^\s*(\d+)\s+\d+\s+R/.exec(list);
  if (ref) list = pdf.get(Number(ref[1]))?.dict || "";
  [...list.matchAll(/[-+]?\d*\.?\d+/g)].forEach((m, k) => widths.set(firstChar + k, Number(m[0])));
  const dw = Number(/\/MissingWidth\s+(\d+)/.exec(fontDict)?.[1] || 500);
  return { widths, dw, cid: false };
}

/** Text of one page's content stream(s). */
function contentText(content: string, fonts: Map<string, FontInfo>): string {
  let out = "";
  let font: FontInfo | undefined;
  let fontSize = 12;
  let scale = 1;
  // Pen position on the current line (text space units), and the last line's y.
  let originX = 0;
  let penX = 0;
  let lineY: number | null = null;
  const stack: unknown[] = [];
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
  };
  const show = (bytes: number[]) => {
    const shown = decodeShown(bytes, font);
    out += shown.text;
    penX += (shown.width / 1000) * fontSize;
  };
  // A move on the same line: a gap wider than a fifth of the font size is a word space.
  const moveTo = (x: number, y: number | null) => {
    if (y !== null && lineY !== null && Math.abs(y - lineY) > 0.5) newline();
    else if (x - penX > 0.2 * fontSize) space();
    if (y !== null) lineY = y;
    originX = x;
    penX = x;
  };
  const s = content;
  let i = 0;
  while (i < s.length && out.length < MAX_TEXT_CHARS) {
    const c = s[i];
    if (c === "(") {
      const lit = literalBytes(s, i);
      stack.push({ str: lit.bytes });
      i = lit.end;
      continue;
    }
    if (c === "<" && s[i + 1] !== "<") {
      const close = s.indexOf(">", i);
      if (close === -1) break;
      stack.push({ str: hexToBytes(s.slice(i + 1, close)) });
      i = close + 1;
      continue;
    }
    if (c === "<" && s[i + 1] === "<") {
      // Inline dictionary (marked content properties): skip it.
      const d = readDict(s, i);
      i += Math.max(2, d.length);
      continue;
    }
    if (c === "[") {
      // TJ array: strings and kerning numbers.
      const parts: Array<number | number[]> = [];
      i++;
      while (i < s.length && s[i] !== "]") {
        if (s[i] === "(") {
          const lit = literalBytes(s, i);
          parts.push(lit.bytes);
          i = lit.end;
        } else if (s[i] === "<") {
          const close = s.indexOf(">", i);
          if (close === -1) break;
          parts.push(hexToBytes(s.slice(i + 1, close)));
          i = close + 1;
        } else if (/[-+.\d]/.test(s[i])) {
          const num = /^[-+]?\d*\.?\d+/.exec(s.slice(i, i + 32));
          if (num) {
            parts.push(Number(num[0]));
            i += num[0].length;
          } else i++;
        } else i++;
      }
      stack.push({ arr: parts });
      i++;
      continue;
    }
    if (c === "/") {
      const name = /^\/[^\s/<>[\]()%]+/.exec(s.slice(i, i + 128));
      stack.push(name ? name[0] : "/");
      i += name ? name[0].length : 1;
      continue;
    }
    if (/[-+.\d]/.test(c)) {
      const num = /^[-+]?\d*\.?\d+/.exec(s.slice(i, i + 32));
      if (num) {
        stack.push(Number(num[0]));
        i += num[0].length;
        continue;
      }
    }
    if (/[A-Za-z'"*]/.test(c)) {
      const op = /^[A-Za-z'"*]+/.exec(s.slice(i, i + 16))?.[0] || c;
      i += op.length;
      const n = (k: number) => {
        const v = stack[stack.length - k];
        return typeof v === "number" ? v : 0;
      };
      const top = stack[stack.length - 1] as
        { str?: number[]; arr?: Array<number | number[]> } | undefined;
      if (op === "Tf") {
        const name = stack[stack.length - 2];
        font = typeof name === "string" ? fonts.get(name.slice(1)) : undefined;
        fontSize = Math.abs(n(1)) * scale || fontSize;
      } else if (op === "Tj" && top?.str) {
        show(top.str);
      } else if ((op === "'" || op === '"') && top?.str) {
        newline();
        show(top.str);
      } else if (op === "TJ" && top?.arr) {
        for (const part of top.arr) {
          if (Array.isArray(part)) show(part);
          else {
            // A negative adjustment wider than a kerning pair is a word gap (TeX word spaces
            // shrink to about 0.2 em, kerning pairs stay below about 0.12 em).
            if (part < -160) space();
            penX -= (part / 1000) * fontSize;
          }
        }
      } else if (op === "Td" || op === "TD") {
        moveTo(originX + n(2) * scale, lineY === null ? n(1) : lineY + n(1) * scale);
      } else if (op === "Tm") {
        scale = Math.hypot(n(6), n(5)) || 1;
        moveTo(n(2), n(1));
      } else if (op === "T*") {
        newline();
        penX = originX;
      } else if (op === "BT") {
        originX = 0;
        penX = 0;
      } else if (op === "BI") {
        // Inline image: skip its data up to EI.
        const ei = s.indexOf("EI", i);
        i = ei === -1 ? s.length : ei + 2;
      }
      stack.length = 0;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * `images`: the file has image objects (a scanned page is one image, with no text).
 * `pageChars`: characters (no white space) of each page that was read.
 */
type PdfText = { text: string; pages: number; images: boolean; pageChars: number[] };

/**
 * Claude Code sends the same PDF again on every later turn of a conversation: the last results
 * are kept by content hash (a few entries, text only).
 */
const CACHE_ENTRIES = 8;
const cache = new Map<string, PdfText | null>();

function cacheKeyOf(base64: string): string | null {
  if (typeof base64 !== "string" || base64.length < 44) return null;
  if (base64.length > Math.ceil((MAX_PDF_BYTES * 4) / 3) + 4) return null;
  return createHash("sha256").update(base64).digest("base64url");
}

function cached<T>(store: Map<string, T>, key: string, max: number, make: () => T): T {
  if (store.has(key)) {
    const hit = store.get(key) as T;
    store.delete(key);
    store.set(key, hit);
    return hit;
  }
  let value: T;
  try {
    value = make();
  } catch {
    value = null as T;
  }
  store.set(key, value);
  if (store.size > max) store.delete(store.keys().next().value as string);
  return value;
}

export function extractPdfText(base64: string): PdfText | null {
  const key = cacheKeyOf(base64);
  if (!key) return null;
  return cached(cache, key, CACHE_ENTRIES, () => extract(Buffer.from(base64, "base64")));
}

type OpenPdf = { pdf: PdfReader; s: string; pages: Array<{ num: number; resources: string }> };

/** Objects scanned and pages listed in page-tree order (resources inherited from parents). */
function openPdf(raw: Buffer): OpenPdf | null {
  if (raw.length < 32 || raw.length > MAX_PDF_BYTES) return null;
  const s = raw.toString("latin1");
  if (!s.startsWith("%PDF")) return null;
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s.slice(-4096)) || /\/Encrypt\s*<</.test(s.slice(-4096)))
    return null;
  const pdf = new PdfReader(raw, s);
  pdf.scan();
  const pages: Array<{ num: number; resources: string }> = [];
  const seen = new Set<number>();
  const visit = (num: number, inherited: string, depth: number) => {
    if (depth > 32 || pages.length > 5000 || seen.has(num)) return;
    seen.add(num);
    const dict = pdf.get(num)?.dict || "";
    const resources = valueOf(dict, "Resources") || inherited;
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      for (const kid of refsIn(valueOf(dict, "Kids"))) visit(kid, resources, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(dict)) {
      pages.push({ num, resources });
    }
  };
  const rootRef =
    /\/Root\s+(\d+)\s+\d+\s+R/.exec(s.slice(-8192)) || /\/Root\s+(\d+)\s+\d+\s+R/.exec(s);
  const catalog = rootRef ? pdf.get(Number(rootRef[1]))?.dict || "" : "";
  const treeRoot = refsIn(valueOf(catalog, "Pages"))[0];
  if (treeRoot !== undefined) visit(treeRoot, "", 0);
  if (pages.length === 0) return null;
  return { pdf, s, pages };
}

function extract(raw: Buffer): PdfText | null {
  const started = Date.now();
  const opened = openPdf(raw);
  if (!opened) return null;
  const { pdf, s, pages } = opened;

  const fontCache = new Map<number, FontInfo>();
  const fontInfo = (fontNum: number): FontInfo => {
    const cachedFont = fontCache.get(fontNum);
    if (cachedFont) return cachedFont;
    const dict = pdf.get(fontNum)?.dict || "";
    const ref = refsIn(valueOf(dict, "ToUnicode"))[0];
    const text = ref !== undefined ? pdf.stream(ref) : null;
    const { widths, dw, cid } = readWidths(pdf, dict);
    const info: FontInfo = {
      bytes: cid ? 2 : 1,
      cmap: text ? parseCMap(text) : undefined,
      widths,
      dw,
    };
    fontCache.set(fontNum, info);
    return info;
  };
  const fontsOf = (resources: string): Map<string, FontInfo> => {
    const fonts = new Map<string, FontInfo>();
    const fontDict = pdf.dictOf(valueOf(pdf.dictOf(resources), "Font"));
    for (const m of fontDict.matchAll(/\/([^\s/<>[\]()%]+)\s+(\d+)\s+\d+\s+R/g)) {
      fonts.set(m[1], fontInfo(Number(m[2])));
    }
    return fonts;
  };

  const texts: string[] = [];
  const pageChars: number[] = [];
  let total = 0;
  for (const page of pages) {
    if (Date.now() - started > MAX_WORK_MS) {
      texts.push(`[Pages ${texts.length + 1} to ${pages.length} were not read: time limit]`);
      break;
    }
    const dict = pdf.get(page.num)?.dict || "";
    const contents = refsIn(valueOf(dict, "Contents"));
    const fonts = fontsOf(page.resources);
    const body = contents.map((c) => pdf.stream(c) || "").join("\n");
    const text = contentText(body, fonts)
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    texts.push(text);
    pageChars.push(text.replace(/\s+/g, "").length);
    total += text.length;
    if (total > MAX_TEXT_CHARS) break;
  }
  const joined = texts
    .map((t, i) => (texts.length > 1 ? `[Page ${i + 1}]\n${t}` : t))
    .join("\n\n")
    .slice(0, MAX_TEXT_CHARS);
  return {
    text: joined,
    pages: pages.length,
    images: /\/Subtype\s*\/Image\b/.test(s),
    pageChars,
  };
}

// ── Scanned pages as images ─────────────────────────────────────────────────────────────────
//
// A scanned page is one big image and no text. For a model that reads images, the page image
// goes along: JPEG (DCTDecode) as it is stored, Flate / uncompressed pixels (gray, RGB, CMYK,
// indexed; 1-16 bits) re-encoded as PNG at most 1568 px on the long side (Claude scales larger
// images down anyway), CCITT G3/G4 fax images (most office scanners) decoded and re-encoded as
// PNG. JBIG2 and JPEG 2000 images are not decoded.

/** One scanned page as an image a model can read. */
export type PdfPageImage = { page: number; mediaType: "image/jpeg" | "image/png"; data: string };
/** `unreadable`: wanted pages whose image could not be converted (format, size, time). */
export type PdfPageImages = { images: PdfPageImage[]; unreadable: number[] };

export const MAX_PDF_PAGE_IMAGES = 20;
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_IMAGES_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_PIXELS = 60_000_000;
const MAX_IMAGE_WORK_MS = 4000;
const imageCache = new Map<string, PdfPageImages | null>();

/** Images of the given pages (1-based), largest image of each page; cached for repeated turns. */
export function extractPdfPageImages(base64: string, pagesWanted: number[]): PdfPageImages | null {
  const key = cacheKeyOf(base64);
  if (!key) return null;
  const want = [...new Set(pagesWanted.filter((p) => Number.isInteger(p) && p > 0))]
    .sort((a, b) => a - b)
    .slice(0, MAX_PDF_PAGE_IMAGES);
  if (!want.length) return { images: [], unreadable: [] };
  return cached(imageCache, `${key}:${want.join(",")}`, 2, () =>
    pageImages(Buffer.from(base64, "base64"), want)
  );
}

function pageImages(raw: Buffer, want: number[]): PdfPageImages | null {
  const started = Date.now();
  const opened = openPdf(raw);
  if (!opened) return null;
  const { pdf, pages } = opened;
  const images: PdfPageImage[] = [];
  const unreadable: number[] = [];
  let totalBytes = 0;
  for (const pageNo of want) {
    const page = pages[pageNo - 1];
    if (!page) continue;
    if (Date.now() - started > MAX_IMAGE_WORK_MS) {
      unreadable.push(pageNo);
      continue;
    }
    const found = largestImage(pdf, page.resources, 0, new Set());
    let out: { mediaType: "image/jpeg" | "image/png"; bytes: Buffer } | null = null;
    try {
      out = found ? modelImage(pdf, found.num, found.dict) : null;
    } catch {
      out = null;
    }
    if (!out || totalBytes + out.bytes.length > MAX_IMAGES_TOTAL_BYTES) {
      unreadable.push(pageNo);
      continue;
    }
    totalBytes += out.bytes.length;
    images.push({ page: pageNo, mediaType: out.mediaType, data: out.bytes.toString("base64") });
  }
  return { images, unreadable };
}

/** The image XObject with the most pixels on a page (looking one level into Form XObjects). */
function largestImage(
  pdf: PdfReader,
  resources: string,
  depth: number,
  seen: Set<number>
): { num: number; dict: string; area: number } | null {
  const xobjects = pdf.dictOf(valueOf(pdf.dictOf(resources), "XObject"));
  let best: { num: number; dict: string; area: number } | null = null;
  for (const m of xobjects.matchAll(/\/[^\s/<>[\]()%]+\s+(\d+)\s+\d+\s+R/g)) {
    const num = Number(m[1]);
    if (seen.has(num)) continue;
    seen.add(num);
    const dict = pdf.get(num)?.dict || "";
    if (/\/Subtype\s*\/Image\b/.test(dict)) {
      const area = numberIn(dict, "Width") * numberIn(dict, "Height");
      if (!best || area > best.area) best = { num, dict, area };
    } else if (/\/Subtype\s*\/Form\b/.test(dict) && depth < 2) {
      const inner = largestImage(pdf, valueOf(dict, "Resources"), depth + 1, seen);
      if (inner && (!best || inner.area > best.area)) best = inner;
    }
  }
  return best;
}

function numberIn(dict: string, key: string): number {
  const m = new RegExp(`/${key}\\s+(\\d+)\\b(?!\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : 0;
}

type ColorSpace = {
  kind: "gray" | "rgb" | "cmyk" | "indexed" | "unknown";
  /** Indexed: palette as RGB triples, and the highest index. */
  palette?: Uint8Array;
  hival?: number;
};

function colorSpaceOf(pdf: PdfReader, value: string, depth = 0): ColorSpace {
  const v = value.trim();
  const name = /^\/(\w+)/.exec(v)?.[1];
  if (name) {
    if (name === "DeviceGray" || name === "CalGray" || name === "G") return { kind: "gray" };
    if (name === "DeviceRGB" || name === "CalRGB" || name === "RGB") return { kind: "rgb" };
    if (name === "DeviceCMYK" || name === "CMYK") return { kind: "cmyk" };
    return { kind: "unknown" };
  }
  if (depth > 3) return { kind: "unknown" };
  const ref = /^(\d+)\s+\d+\s+R/.exec(v);
  if (ref) return colorSpaceOf(pdf, pdf.get(Number(ref[1]))?.dict || "", depth + 1);
  if (!v.startsWith("[")) return { kind: "unknown" };
  const inner = v.slice(1, v.lastIndexOf("]") === -1 ? v.length : v.lastIndexOf("]")).trim();
  const head = /^\/(\w+)/.exec(inner)?.[1] || "";
  const rest = inner.slice(head.length + 1).trim();
  if (head === "ICCBased") {
    const icc = /^(\d+)\s+\d+\s+R/.exec(rest);
    const n = icc ? numberIn(pdf.get(Number(icc[1]))?.dict || "", "N") : 0;
    return n === 1
      ? { kind: "gray" }
      : n === 3
        ? { kind: "rgb" }
        : n === 4
          ? { kind: "cmyk" }
          : { kind: "unknown" };
  }
  if (head === "CalGray") return { kind: "gray" };
  if (head === "CalRGB" || head === "Lab")
    return head === "CalRGB" ? { kind: "rgb" } : { kind: "unknown" };
  if (head === "Indexed" || head === "I") {
    // [/Indexed base hival lookup]: base is a name, a reference or an array.
    let baseText = "";
    let after = "";
    if (rest.startsWith("/")) {
      baseText = /^\/\w+/.exec(rest)?.[0] || "";
      after = rest.slice(baseText.length).trim();
    } else if (/^\d+\s+\d+\s+R/.test(rest)) {
      baseText = /^\d+\s+\d+\s+R/.exec(rest)?.[0] || "";
      after = rest.slice(baseText.length).trim();
    } else if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      baseText = rest.slice(0, close + 1);
      after = rest.slice(close + 1).trim();
    }
    const base = colorSpaceOf(pdf, baseText, depth + 1);
    const hivalMatch = /^(\d+)/.exec(after);
    if (!hivalMatch || (base.kind !== "gray" && base.kind !== "rgb" && base.kind !== "cmyk")) {
      return { kind: "unknown" };
    }
    const hival = Math.min(255, Number(hivalMatch[1]));
    const lookupText = after.slice(hivalMatch[0].length).trim();
    let lookup: Buffer | null = null;
    if (lookupText.startsWith("<")) {
      lookup = Buffer.from(hexToBytes(lookupText.slice(1, lookupText.indexOf(">"))));
    } else if (lookupText.startsWith("(")) {
      lookup = Buffer.from(literalBytes(lookupText, 0).bytes);
    } else {
      const lref = /^(\d+)\s+\d+\s+R/.exec(lookupText);
      const text = lref ? pdf.stream(Number(lref[1])) : null;
      lookup = text !== null ? Buffer.from(text, "latin1") : null;
    }
    if (!lookup) return { kind: "unknown" };
    const comps = base.kind === "gray" ? 1 : base.kind === "rgb" ? 3 : 4;
    const palette = new Uint8Array((hival + 1) * 3);
    for (let i = 0; i <= hival; i++) {
      const o = i * comps;
      const [r, g, b] =
        comps === 1
          ? [lookup[o] ?? 0, lookup[o] ?? 0, lookup[o] ?? 0]
          : comps === 3
            ? [lookup[o] ?? 0, lookup[o + 1] ?? 0, lookup[o + 2] ?? 0]
            : cmykToRgb(lookup[o] ?? 0, lookup[o + 1] ?? 0, lookup[o + 2] ?? 0, lookup[o + 3] ?? 0);
      palette.set([r, g, b], i * 3);
    }
    return { kind: "indexed", palette, hival };
  }
  return { kind: "unknown" };
}

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];
}

function modelImage(
  pdf: PdfReader,
  num: number,
  dict: string
): { mediaType: "image/jpeg" | "image/png"; bytes: Buffer } | null {
  const width = numberIn(dict, "Width");
  const height = numberIn(dict, "Height");
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) return null;
  const filterMatch = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] || "";
  const filters = filterMatch.match(/\/\w+/g) || [];
  if (filters.length > 1) return null;
  const filter = filters[0] || "";
  const imageMask = /\/ImageMask\s+true\b/.test(dict);
  const cs: ColorSpace = imageMask
    ? { kind: "gray" }
    : colorSpaceOf(pdf, /\/ColorSpace\s*(\/\w+|\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(dict)?.[1] || "");
  const decode = /\/Decode\s*\[\s*([^\]]*)\]/.exec(dict)?.[1].trim().split(/\s+/).map(Number) || [];
  // Gray / masks with /Decode [1 0] are stored inverted. An image mask paints its 0 samples.
  const inverted = cs.kind === "gray" && decode.length >= 2 && decode[0] === 1 && decode[1] === 0;

  if (filter === "/DCTDecode" || filter === "/DCT") {
    if (cs.kind === "cmyk" || cs.kind === "unknown") return null;
    const bytes = pdf.rawStream(num);
    if (!bytes || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return null;
    }
    return { mediaType: "image/jpeg", bytes: Buffer.from(bytes) };
  }

  const stored = pdf.rawStream(num);
  if (!stored) return null;
  const parms = valueOf(dict, "DecodeParms") || valueOf(dict, "DP");
  let samples: Buffer | null = null;
  let bpc = imageMask ? 1 : numberIn(dict, "BitsPerComponent") || 8;
  if (filter === "/CCITTFaxDecode" || filter === "/CCF") {
    const fax = decodeCcitt(stored, {
      k: Number(/\/K\s+(-?\d+)/.exec(parms)?.[1] || 0),
      columns: numberIn(parms, "Columns") || 1728,
      rows: numberIn(parms, "Rows") || height,
      blackIs1: /\/BlackIs1\s+true\b/.test(parms),
      byteAlign: /\/EncodedByteAlign\s+true\b/.test(parms),
    });
    if (!fax || fax.columns !== width) return null;
    samples = fax.data;
    bpc = 1;
  } else if (filter === "/FlateDecode" || filter === "/Fl") {
    const inflated = pdf.inflate(Buffer.from(stored));
    if (!inflated) return null;
    samples = inflated;
  } else if (filter === "") {
    samples = Buffer.from(stored);
  } else {
    return null; // JBIG2, JPEG 2000, LZW, RunLength, ...
  }
  if (cs.kind === "unknown" || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  const comps = cs.kind === "rgb" ? 3 : cs.kind === "cmyk" ? 4 : 1;
  const rowBytes = Math.ceil((width * comps * bpc) / 8);
  const predictor = numberIn(parms, "Predictor");
  if (predictor >= 10) {
    samples = pngUnfilter(samples, rowBytes, Math.max(1, Math.ceil((comps * bpc) / 8)), height);
    if (!samples) return null;
  } else if (predictor > 1) {
    return null; // TIFF predictor 2: rare, not handled
  }
  if (samples.length < rowBytes * Math.min(height, 1)) return null;
  return {
    mediaType: "image/png",
    bytes: pixelsToPng(samples, width, height, comps, bpc, cs, inverted, rowBytes),
  };
}

/** Undo PNG row filters (Flate /Predictor 10-15): one filter byte before every row. */
function pngUnfilter(data: Buffer, rowBytes: number, bpp: number, rows: number): Buffer | null {
  const out = Buffer.alloc(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const off = y * (rowBytes + 1);
    if (off + 1 + rowBytes > data.length) break; // a short stream: keep the rows that came
    const type = data[off];
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v = data[off + 1 + x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return null;
      out[row + x] = v & 255;
    }
  }
  return out;
}

/** Packed samples -> 8-bit gray or RGB, scaled down to MAX_IMAGE_EDGE, as a PNG file. */
function pixelsToPng(
  samples: Buffer,
  width: number,
  height: number,
  comps: number,
  bpc: number,
  cs: ColorSpace,
  inverted: boolean,
  rowBytes: number
): Buffer {
  const outComps = cs.kind === "gray" ? 1 : 3;
  // Area average down to at most MAX_IMAGE_EDGE on the long side.
  const scale = Math.max(1, Math.max(width, height) / MAX_IMAGE_EDGE);
  const ow = Math.max(1, Math.round(width / scale));
  const oh = Math.max(1, Math.round(height / scale));
  const colOf = new Uint32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(ow - 1, Math.floor((x * ow) / width));
  const sums = new Float64Array(ow * oh * outComps);
  const counts = new Uint32Array(ow * oh);
  const max = (1 << Math.min(bpc, 8)) - 1;
  const sampleAt = (rowStart: number, index: number): number => {
    if (bpc === 8) return samples[rowStart + index] ?? 0;
    if (bpc === 16) return samples[rowStart + index * 2] ?? 0;
    const bit = index * bpc;
    const byte = samples[rowStart + (bit >> 3)] ?? 0;
    const value = (byte >> (8 - bpc - (bit & 7))) & max;
    return cs.kind === "indexed" ? value : Math.round((value * 255) / max);
  };
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    if (rowStart >= samples.length) break;
    const oy = Math.min(oh - 1, Math.floor((y * oh) / height));
    for (let x = 0; x < width; x++) {
      const o = oy * ow + colOf[x];
      counts[o]++;
      const base = o * outComps;
      if (cs.kind === "gray") {
        const g = sampleAt(rowStart, x);
        sums[base] += inverted ? 255 - g : g;
      } else if (cs.kind === "rgb") {
        sums[base] += sampleAt(rowStart, x * 3);
        sums[base + 1] += sampleAt(rowStart, x * 3 + 1);
        sums[base + 2] += sampleAt(rowStart, x * 3 + 2);
      } else if (cs.kind === "cmyk") {
        const [r, g, b] = cmykToRgb(
          sampleAt(rowStart, x * 4),
          sampleAt(rowStart, x * 4 + 1),
          sampleAt(rowStart, x * 4 + 2),
          sampleAt(rowStart, x * 4 + 3)
        );
        sums[base] += r;
        sums[base + 1] += g;
        sums[base + 2] += b;
      } else {
        const i = Math.min(sampleAt(rowStart, x), cs.hival ?? 0) * 3;
        const pal = cs.palette as Uint8Array;
        sums[base] += pal[i];
        sums[base + 1] += pal[i + 1];
        sums[base + 2] += pal[i + 2];
      }
    }
  }
  const lineLen = ow * outComps;
  const rawRows = Buffer.alloc((lineLen + 1) * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const o = y * ow + x;
      const n = counts[o] || 1;
      for (let c = 0; c < outComps; c++) {
        rawRows[y * (lineLen + 1) + 1 + x * outComps + c] = Math.round(sums[o * outComps + c] / n);
      }
    }
  }
  return encodePng(ow, oh, outComps === 1 ? 0 : 2, rawRows);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(width: number, height: number, colorType: 0 | 2, filteredRows: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filteredRows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── CCITT fax decoding (T.4 / T.6: G3 1-D, G3 2-D, G4), for scanned black-and-white pages ──

// Run-length codes, ITU-T T.4 tables 2 and 3: "bits" -> run length.
const WHITE_TERMINATING =
  "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 " +
  "110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 " +
  "0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 " +
  "00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 " +
  "00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 " +
  "01011010 01011011 01001010 01001011 00110010 00110011 00110100";
const WHITE_MAKEUP =
  "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 " +
  "011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 " +
  "011011010 011011011 010011000 010011001 010011010 011000 010011011";
const BLACK_TERMINATING =
  "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 " +
  "00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 " +
  "00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 " +
  "000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 " +
  "000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 " +
  "000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 " +
  "000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 " +
  "000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111";
const BLACK_MAKEUP =
  "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 " +
  "0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 " +
  "0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 " +
  "0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 " +
  "0000001100100 0000001100101";
// Extended make-up codes 1792-2560, the same for both colours.
const EXTENDED_MAKEUP =
  "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 " +
  "000000010110 000000010111 000000011100 000000011101 000000011110 000000011111";

type RunTable = Map<string, number>;
let runTables: [RunTable, RunTable] | null = null;

function faxRunTables(): [RunTable, RunTable] {
  if (runTables) return runTables;
  const build = (terminating: string, makeup: string): RunTable => {
    const t: RunTable = new Map();
    terminating.split(" ").forEach((code, i) => t.set(code, i));
    makeup.split(" ").forEach((code, i) => t.set(code, (i + 1) * 64));
    EXTENDED_MAKEUP.split(" ").forEach((code, i) => t.set(code, 1792 + i * 64));
    return t;
  };
  runTables = [build(WHITE_TERMINATING, WHITE_MAKEUP), build(BLACK_TERMINATING, BLACK_MAKEUP)];
  return runTables;
}

type FaxParams = {
  k: number;
  columns: number;
  rows: number;
  blackIs1: boolean;
  byteAlign: boolean;
};

/** CCITT fax data -> 1-bit rows (PDF's meaning: black is 0 unless BlackIs1). Null on bad data. */
function decodeCcitt(data: Buffer, p: FaxParams): { data: Buffer; columns: number } | null {
  const columns = p.columns;
  if (columns <= 0 || columns > 32768) return null;
  const rowBytes = Math.ceil(columns / 8);
  const maxRows = Math.max(1, Math.min(p.rows || 65536, 65536));
  const tables = faxRunTables();
  const totalBits = data.length * 8;
  let pos = 0;
  const bit = (): number => {
    if (pos >= totalBits) return -1;
    const b = (data[pos >> 3] >> (7 - (pos & 7))) & 1;
    pos++;
    return b;
  };
  /** One run (make-up codes then a terminating code) of the given colour; -1 on bad data. */
  const run = (color: number): number => {
    const table = tables[color];
    let total = 0;
    for (;;) {
      let code = "";
      let len = -1;
      while (code.length < 13) {
        const b = bit();
        if (b < 0) return -1;
        code += b;
        const hit = table.get(code);
        if (hit !== undefined) {
          len = hit;
          break;
        }
      }
      if (len < 0) return -1;
      total += len;
      if (len < 64) return total;
    }
  };
  /** An EOL (11+ zero bits then a 1) at the current position: consumed, true. */
  const eol = (): boolean => {
    const start = pos;
    let zeros = 0;
    for (;;) {
      const b = bit();
      if (b === 0) zeros++;
      else if (b === 1 && zeros >= 11) return true;
      else break;
    }
    pos = start;
    return false;
  };
  type Mode = "V" | "H" | "P" | "EOL" | "BAD";
  const mode = (): { m: Mode; d: number } => {
    let code = "";
    for (;;) {
      const b = bit();
      if (b < 0) return { m: "EOL", d: 0 };
      code += b;
      switch (code) {
        case "1":
          return { m: "V", d: 0 };
        case "011":
          return { m: "V", d: 1 };
        case "010":
          return { m: "V", d: -1 };
        case "001":
          return { m: "H", d: 0 };
        case "0001":
          return { m: "P", d: 0 };
        case "000011":
          return { m: "V", d: 2 };
        case "000010":
          return { m: "V", d: -2 };
        case "0000011":
          return { m: "V", d: 3 };
        case "0000010":
          return { m: "V", d: -3 };
        case "0000001":
          return { m: "BAD", d: 0 }; // uncompressed-mode extension: not handled
        case "0000000": {
          // EOL / EOFB: more zeros, then a 1
          for (;;) {
            const z = bit();
            if (z !== 0) return { m: "EOL", d: 0 };
          }
        }
      }
    }
  };

  const out = Buffer.alloc(rowBytes * maxRows, p.blackIs1 ? 0x00 : 0xff);
  let ref: number[] = []; // changing elements of the line above (all white at the start)
  let rows = 0;
  while (rows < maxRows && pos < totalBits) {
    if (p.byteAlign && p.k < 0) pos = (pos + 7) & ~7;
    let twoD = p.k < 0;
    if (p.k >= 0) {
      if (eol() && eol()) break; // RTC: end of data
    }
    if (p.k > 0) {
      const tag = bit();
      if (tag < 0) break;
      twoD = tag === 0;
    }
    const cur: number[] = [];
    let ok = true;
    let ended = false;
    if (twoD) {
      let a0 = -1;
      let color = 0;
      while (a0 < columns) {
        let i = 0;
        while (i < ref.length && (ref[i] <= a0 || (i & 1) !== color)) i++;
        const b1 = i < ref.length ? ref[i] : columns;
        const b2 = i + 1 < ref.length ? ref[i + 1] : columns;
        const { m, d } = mode();
        if (m === "V") {
          const a1 = Math.max(0, Math.min(columns, b1 + d));
          if (a1 < a0) {
            ok = false;
            break;
          }
          if (a1 < columns) cur.push(a1);
          a0 = a1;
          color ^= 1;
        } else if (m === "H") {
          const r1 = run(color);
          const r2 = r1 < 0 ? -1 : run(color ^ 1);
          if (r1 < 0 || r2 < 0) {
            ok = false;
            break;
          }
          const start = Math.max(a0, 0);
          const a1 = Math.min(columns, start + r1);
          const a2 = Math.min(columns, a1 + r2);
          if (a1 < columns) cur.push(a1);
          if (a2 < columns) cur.push(a2);
          a0 = a2;
        } else if (m === "P") {
          a0 = b2;
        } else {
          if (m === "EOL") ended = true;
          else ok = false;
          break;
        }
      }
    } else {
      let a0 = 0;
      let color = 0;
      while (a0 < columns) {
        const r = run(color);
        if (r < 0) {
          ok = false;
          break;
        }
        a0 += r;
        if (a0 < columns) cur.push(a0);
        color ^= 1;
      }
      if (p.byteAlign && p.k === 0 && ok) pos = (pos + 7) & ~7;
    }
    if (ended && cur.length === 0) break; // EOFB
    if (!ok) break;
    // Paint the black spans of this row.
    const rowStart = rows * rowBytes;
    for (let j = 0; j < cur.length; j += 2) {
      const from = cur[j];
      const to = j + 1 < cur.length ? cur[j + 1] : columns;
      for (let x = from; x < to; x++) {
        const byte = rowStart + (x >> 3);
        const mask = 0x80 >> (x & 7);
        if (p.blackIs1) out[byte] |= mask;
        else out[byte] &= ~mask;
      }
    }
    rows++;
    ref = cur;
    if (ended) break;
  }
  if (rows === 0) return null;
  return { data: out, columns };
}
