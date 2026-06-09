import type { AgentTool } from "@tango/core";
import { getBrowserManager } from "./browser-manager.js";
import { getOneTimePassword, getSecret, isOpAvailable } from "./op-secret.js";

const CHURCH_ORIGIN = "https://www.churchofjesuschrist.org";
const CHURCH_STUDY_LOGIN_URL = `${CHURCH_ORIGIN}/study/login`;
const ANNOTATIONS_PATH = "/notes/api/v3/annotations";
const DEFAULT_CHURCH_URL = `${CHURCH_ORIGIN}/study/scriptures?lang=eng`;
const CHURCH_ACCOUNT_VAULT_ENV = "CHURCH_ACCOUNT_1PASSWORD_VAULT";
const CHURCH_ACCOUNT_ITEM_ENV = "CHURCH_ACCOUNT_1PASSWORD_ITEM";
const AUTH_PROBE_QUERY = {
  type: "reference",
  locale: "eng",
  docId: "128394547",
};

type GospelLibraryAction =
  | "status"
  | "open"
  | "prepare_login"
  | "login"
  | "list_annotations"
  | "create_reference_link"
  | "create_highlight"
  | "create_annotation"
  | "delete_annotation";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildAnnotationsUrl(query: unknown): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(toRecord(query))) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }

  const suffix = params.toString();
  return `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}${suffix ? `?${suffix}` : ""}`;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function envInput(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configuredChurchCredentialRef(): {
  configured: boolean;
  vault: string | null;
  item: string | null;
  missing: string[];
} {
  const vault = envInput(CHURCH_ACCOUNT_VAULT_ENV) ?? envInput("CHURCH_1PASSWORD_VAULT");
  const item = envInput(CHURCH_ACCOUNT_ITEM_ENV) ?? envInput("CHURCH_1PASSWORD_ITEM");
  const missing = [
    ...(vault ? [] : [CHURCH_ACCOUNT_VAULT_ENV]),
    ...(item ? [] : [CHURCH_ACCOUNT_ITEM_ENV]),
  ];
  return {
    configured: missing.length === 0,
    vault,
    item,
    missing,
  };
}

function requestedChurchUrl(value: unknown): string {
  const requested = stringInput(value);
  if (!requested) {
    return DEFAULT_CHURCH_URL;
  }
  if (requested.startsWith("/")) {
    return `${CHURCH_ORIGIN}${requested}`;
  }
  return requested;
}

function requestedChurchRedirectPath(value: unknown): string {
  const requested = requestedChurchUrl(value);
  try {
    const parsed = new URL(requested);
    if (parsed.origin === CHURCH_ORIGIN) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Fall back below.
  }
  return "/study/scriptures?lang=eng";
}

async function ensureChurchPage(options: {
  url?: unknown;
  openIfNeeded?: boolean;
} = {}): Promise<{ launched: boolean; navigated: boolean; currentUrl: string | null }> {
  const browserManager = getBrowserManager();
  const status = await browserManager.status();
  let launched = false;
  let navigated = false;
  if (!status.connected) {
    await browserManager.launch(9223);
    launched = true;
  }

  const current = await browserManager.status();
  const currentUrl = current.url ?? "";
  const openIfNeeded = options.openIfNeeded !== false;
  if (openIfNeeded && !currentUrl.startsWith(CHURCH_ORIGIN)) {
    await browserManager.open(requestedChurchUrl(options.url));
    navigated = true;
  }

  const finalStatus = await browserManager.status();
  return {
    launched,
    navigated,
    currentUrl: finalStatus.url ?? null,
  };
}

async function pageFetch(input: {
  url: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  const script = `
    (async () => {
      const response = await fetch(${JSON.stringify(input.url)}, {
        method: ${JSON.stringify(input.method ?? "GET")},
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        ${input.body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(input.body))},`}
      });
      const text = await response.text();
      let body = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        body
      };
    })()
  `;

  return getBrowserManager().evaluate(script);
}

function extractAnnotationId(value: unknown): string | null {
  const body = toRecord(toRecord(value).body);
  const candidates = [
    body.id,
    body.annotationId,
    toRecord(body.annotation).id,
    toRecord(body.data).id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

// Normalize curly quotes/apostrophes so a model-supplied phrase with straight quotes
// still matches the verse text (which uses typographic ’ and “”). The replacements are
// 1:1 in length, so character offsets are preserved.
function normalizeQuotes(value: string): string {
  return value.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"');
}

// Decode the small set of HTML entities that appear in scripture body text. Each decodes
// to a single character, keeping offsets aligned with what the Church highlight API expects.
function decodeScriptureEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// Resolve a verse paragraph's highlight coordinate space exactly the way the Church
// reader does: drop the leading verse-number span, strip remaining markup, decode
// entities. The resulting plain text is what start/end offsets are measured against.
function verseHighlightText(innerHtml: string): string {
  const withoutVerseNumber = innerHtml.replace(
    /^\s*<span[^>]*class="[^"]*verse-number[^"]*"[^>]*>[\s\S]*?<\/span>/i,
    "",
  );
  return decodeScriptureEntities(withoutVerseNumber.replace(/<[^>]+>/g, ""));
}

type HighlightBuild =
  | { error: string; detail?: unknown }
  | { annotation: Record<string, unknown>; resolution: Record<string, unknown> };

// Build a Gospel Library highlight/note annotation from a human-level reference
// (chapter uri + verse + phrase) by fetching the authenticated scripture content and
// resolving docId, contentVersion, the verse paragraph id (pid), and the character
// offsets of the phrase. This keeps the model out of the brittle business of reading the
// page and computing offsets itself (the failure mode that left scriptures unmarked).
async function buildHighlightAnnotation(
  input: Record<string, unknown>,
  opts: { allowAnchorOnly?: boolean } = {},
): Promise<HighlightBuild> {
  const rawUri = stringInput(input.uri) ?? stringInput(input.url);
  if (!rawUri) {
    return { error: "create_highlight needs 'uri' (e.g. /scriptures/bofm/2-ne/23) plus 'verse' and 'phrase'." };
  }

  // The uri may be the chapter (/scriptures/bofm/2-ne/23) or a verse uri (.../23.p6 or .../23.6).
  let chapterUri = rawUri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  let verseNum: number | null = null;
  const dotVerse = chapterUri.match(/\.p?(\d+)$/i);
  if (dotVerse) {
    verseNum = Number(dotVerse[1]);
    chapterUri = chapterUri.slice(0, chapterUri.length - dotVerse[0].length);
  }
  for (const candidate of [input.verse, input.paragraph]) {
    if (candidate === undefined || candidate === null) continue;
    const match = String(candidate).match(/(\d+)/);
    if (match) verseNum = Number(match[1]);
  }
  if (!verseNum || !Number.isFinite(verseNum)) {
    return { error: "create_highlight needs the verse number (e.g. verse: 6), or a uri ending in .p6." };
  }

  const phrase = stringInput(input.phrase) ?? stringInput(input.text);
  const noteContent = stringInput(input.note);
  if (!phrase && !noteContent && !opts.allowAnchorOnly) {
    return { error: "create_highlight needs 'phrase' (exact text to mark) and/or 'note' (a verse note)." };
  }

  const contentUrl = `${CHURCH_ORIGIN}/study/api/v3/language-pages/type/content?lang=eng&uri=${encodeURIComponent(chapterUri)}`;
  const resp = toRecord(await pageFetch({ url: contentUrl }));
  if (resp.ok !== true) {
    return { error: `Failed to load scripture content for ${chapterUri} (status ${String(resp.status)}).`, detail: resp.body };
  }
  const body = toRecord(resp.body);
  const pageAttributes = toRecord(toRecord(body.meta).pageAttributes);
  const docId = typeof pageAttributes["data-aid"] === "string" ? pageAttributes["data-aid"] : null;
  const contentVersion = Number(pageAttributes["data-aid-version"]);
  const html = typeof toRecord(body.content).body === "string" ? String(toRecord(body.content).body) : "";
  if (!docId || !Number.isFinite(contentVersion) || !html) {
    return { error: `Could not read content metadata (docId/version/body) for ${chapterUri}.` };
  }

  const pId = `p${verseNum}`;
  const openTag = html.match(new RegExp(`<p[^>]*id="${pId}"[^>]*>`, "i"));
  const block = html.match(new RegExp(`<p[^>]*id="${pId}"[^>]*>([\\s\\S]*?)</p>`, "i"));
  if (!openTag || !block) {
    return { error: `Verse ${verseNum} (${pId}) not found in ${chapterUri}.` };
  }
  const pid = (openTag[0].match(/data-aid="([^"]+)"/) || [])[1] ?? null;
  if (!pid) {
    return { error: `Could not resolve paragraph id (pid) for verse ${verseNum} in ${chapterUri}.` };
  }
  const verseText = verseHighlightText(block[1] ?? "");

  const color = (stringInput(input.color) ?? "yellow").toLowerCase();
  const style = stringInput(input.style) ?? "red-underline";
  const verseUri = `${chapterUri}.p${verseNum}`;

  let startOffset = -1;
  let endOffset = -1;
  if (phrase) {
    const hay = normalizeQuotes(verseText);
    const needle = normalizeQuotes(phrase).trim();
    const occurrence = Number(input.occurrence) > 0 ? Number(input.occurrence) : 1;
    let idx = -1;
    let from = 0;
    for (let i = 0; i < occurrence; i += 1) {
      idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + needle.length;
    }
    if (idx < 0) {
      return { error: `Phrase not found in verse ${verseNum}. Verse text is: "${verseText}"` };
    }
    startOffset = idx;
    endOffset = idx + needle.length;
  }

  // A note with no phrase attaches to the whole verse: the Church reader stores that as a
  // "clear" highlight spanning -1/-1 (an anchor with no visible underline/fill).
  const highlight: Record<string, unknown> = phrase
    ? { uri: verseUri, pid, color, style, startOffset, endOffset }
    : { uri: verseUri, pid, color: "clear", startOffset: -1, endOffset: -1 };

  const annotation: Record<string, unknown> = {
    type: "highlight",
    docId,
    contentVersion,
    locale: "eng",
    uri: chapterUri,
    highlights: [highlight],
    folders: [],
    tags: [],
  };
  if (noteContent) {
    annotation.note = { content: `<div>${noteContent}</div>` };
  }

  return {
    annotation,
    resolution: {
      chapterUri,
      verse: verseNum,
      paragraph: pId,
      pid,
      docId,
      contentVersion,
      verseText,
      phrase: phrase ?? null,
      startOffset,
      endOffset,
      color: phrase ? color : "clear",
      style: phrase ? style : null,
      note: noteContent ?? null,
    },
  };
}

// The Church POST schema rejects fields that appear in the GET representation (e.g.
// highlights[].mediaType). Strip those so a model that copies a listed annotation as a
// template still POSTs cleanly.
function sanitizeAnnotationForPost(annotation: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...annotation };
  if (Array.isArray(clone.highlights)) {
    clone.highlights = clone.highlights.map((entry) => {
      const record = toRecord(entry);
      const { mediaType: _mediaType, ...rest } = record;
      return rest;
    });
  }
  for (const key of ["personId", "annotationId", "id", "created", "lastUpdated", "source", "device"]) {
    delete clone[key];
  }
  return clone;
}

// Standard-works book table: alias regexes -> canonical content path + display name.
// Covers the books needed for scripture cross-referencing; aliases are case-insensitive
// and tolerate "First/Second", "1/2", abbreviations, and "Revelations" (common slip).
const SCRIPTURE_BOOKS: Array<{ path: string; name: string; aliases: RegExp[] }> = [
  // Book of Mormon
  { path: "bofm/1-ne", name: "1 Nephi", aliases: [/^(1|i|first)\s*ne(phi)?$/i] },
  { path: "bofm/2-ne", name: "2 Nephi", aliases: [/^(2|ii|second)\s*ne(phi)?$/i] },
  { path: "bofm/jacob", name: "Jacob", aliases: [/^jacob$/i] },
  { path: "bofm/enos", name: "Enos", aliases: [/^enos$/i] },
  { path: "bofm/jarom", name: "Jarom", aliases: [/^jarom$/i] },
  { path: "bofm/omni", name: "Omni", aliases: [/^omni$/i] },
  { path: "bofm/w-of-m", name: "Words of Mormon", aliases: [/^words?\s*of\s*mormon$/i, /^w[- ]?of[- ]?m$/i] },
  { path: "bofm/mosiah", name: "Mosiah", aliases: [/^mosiah$/i] },
  { path: "bofm/alma", name: "Alma", aliases: [/^alma$/i] },
  { path: "bofm/hel", name: "Helaman", aliases: [/^hel(aman)?$/i] },
  { path: "bofm/3-ne", name: "3 Nephi", aliases: [/^(3|iii|third)\s*ne(phi)?$/i] },
  { path: "bofm/4-ne", name: "4 Nephi", aliases: [/^(4|iv|fourth)\s*ne(phi)?$/i] },
  { path: "bofm/morm", name: "Mormon", aliases: [/^morm(on)?$/i] },
  { path: "bofm/ether", name: "Ether", aliases: [/^ether$/i] },
  { path: "bofm/moro", name: "Moroni", aliases: [/^moro(ni)?$/i] },
  // Doctrine and Covenants / Pearl of Great Price
  { path: "dc-testament/dc", name: "Doctrine and Covenants", aliases: [/^d\s*&?\s*c$/i, /^doctrine\s*(and|&)?\s*covenants$/i] },
  { path: "pgp/moses", name: "Moses", aliases: [/^moses$/i] },
  { path: "pgp/abr", name: "Abraham", aliases: [/^abr(aham)?$/i] },
  { path: "pgp/js-h", name: "Joseph Smith—History", aliases: [/^js[-—\s]*h(istory)?$/i, /^joseph\s*smith[-—\s]*history$/i] },
  // New Testament (commonly cross-referenced)
  { path: "nt/matt", name: "Matthew", aliases: [/^matt(hew)?$/i] },
  { path: "nt/mark", name: "Mark", aliases: [/^mark$/i] },
  { path: "nt/luke", name: "Luke", aliases: [/^luke$/i] },
  { path: "nt/john", name: "John", aliases: [/^john$/i] },
  { path: "nt/acts", name: "Acts", aliases: [/^acts$/i] },
  { path: "nt/rom", name: "Romans", aliases: [/^rom(ans)?$/i] },
  { path: "nt/rev", name: "Revelation", aliases: [/^rev(elation)?s?$/i] },
  // Old Testament (commonly cross-referenced)
  { path: "ot/gen", name: "Genesis", aliases: [/^gen(esis)?$/i] },
  { path: "ot/ex", name: "Exodus", aliases: [/^ex(odus)?$/i] },
  { path: "ot/isa", name: "Isaiah", aliases: [/^isa(iah)?$/i] },
  { path: "ot/jer", name: "Jeremiah", aliases: [/^jer(emiah)?$/i] },
  { path: "ot/ps", name: "Psalms", aliases: [/^ps(alms?)?$/i] },
  { path: "ot/mal", name: "Malachi", aliases: [/^mal(achi)?$/i] },
];

type ParsedReference = { bookPath: string; displayBook: string; chapter: number; verses: number[] };

// Parse a human scripture reference like "D&C 88:89-91", "First Nephi chapter 14",
// "Revelations chapter 17 verses 1 through 5", or "2 Nephi 23:6" into a structured form.
// Returns null if the book is unknown or the shape is unrecognized.
function parseScriptureReference(ref: string): ParsedReference | null {
  const cleaned = ref.replace(/\s+/g, " ").trim();
  // Split off the leading book name: words up to the first chapter token (a number,
  // optionally preceded by "chapter"/"section"). Keep a leading ordinal (1/2/3/First...).
  const m = cleaned.match(
    /^(.*?)\s*(?:chapters?|sections?|§)?\s*(\d+)\s*(?::|\bverses?\b|\bvs?\.?\b|\bv\b)?\s*(\d+(?:\s*(?:[-–—]|through|thru|to)\s*\d+)?(?:\s*,\s*\d+)*)?\s*$/i,
  );
  if (!m) return null;
  const bookRaw = (m[1] ?? "").replace(/[.,]+$/, "").trim();
  const chapter = Number(m[2]);
  const verseSpec = m[3]?.trim();
  if (!bookRaw || !Number.isFinite(chapter)) return null;

  const book = SCRIPTURE_BOOKS.find((b) => b.aliases.some((re) => re.test(bookRaw)));
  if (!book) return null;

  const verses: number[] = [];
  if (verseSpec) {
    for (const part of verseSpec.split(",")) {
      const range = part.match(/(\d+)\s*(?:[-–—]|through|thru|to)\s*(\d+)/i);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        for (let v = a; v <= b; v += 1) verses.push(v);
      } else {
        const single = part.match(/\d+/);
        if (single) verses.push(Number(single[0]));
      }
    }
  }
  return { bookPath: book.path, displayBook: book.name, chapter, verses };
}

type ChapterContent = { docId: string; contentVersion: number; html: string };

// Fetch + cache an authenticated scripture chapter's content (docId, contentVersion, body
// HTML). Cached per chapter uri for the lifetime of a single tool call so a multi-target
// reference resolves each target's chapter only once.
async function fetchChapterContent(
  chapterUri: string,
  cache: Map<string, ChapterContent | { error: string }>,
): Promise<ChapterContent | { error: string }> {
  const cached = cache.get(chapterUri);
  if (cached) return cached;
  const contentUrl = `${CHURCH_ORIGIN}/study/api/v3/language-pages/type/content?lang=eng&uri=${encodeURIComponent(chapterUri)}`;
  const resp = toRecord(await pageFetch({ url: contentUrl }));
  let result: ChapterContent | { error: string };
  if (resp.ok !== true) {
    result = { error: `Failed to load ${chapterUri} (status ${String(resp.status)}).` };
  } else {
    const body = toRecord(resp.body);
    const pageAttributes = toRecord(toRecord(body.meta).pageAttributes);
    const docId = typeof pageAttributes["data-aid"] === "string" ? pageAttributes["data-aid"] : null;
    const contentVersion = Number(pageAttributes["data-aid-version"]);
    const html = typeof toRecord(body.content).body === "string" ? String(toRecord(body.content).body) : "";
    result = docId && Number.isFinite(contentVersion) && html
      ? { docId, contentVersion, html }
      : { error: `Could not read content metadata for ${chapterUri}.` };
  }
  cache.set(chapterUri, result);
  return result;
}

// Resolve a verse paragraph's pid (data-aid) from chapter HTML.
function paragraphPid(html: string, verse: number): string | null {
  const openTag = html.match(new RegExp(`<p[^>]*id="p${verse}"[^>]*>`, "i"));
  if (!openTag) return null;
  return (openTag[0].match(/data-aid="([^"]+)"/) || [])[1] ?? null;
}

// Resolve one parsed reference into a Gospel Library ref object (name/uri/docId/pid/
// contentVersion/locale). Verse lists become comma-joined uri+pid; an empty verse list
// links the whole chapter (pid = chapter docId, the format the reader uses).
async function resolveReferenceTarget(
  parsed: ParsedReference,
  cache: Map<string, ChapterContent | { error: string }>,
): Promise<{ ref: Record<string, unknown> } | { error: string }> {
  const chapterUri = `/scriptures/${parsed.bookPath}/${parsed.chapter}`;
  const content = await fetchChapterContent(chapterUri, cache);
  if ("error" in content) return { error: content.error };

  if (parsed.verses.length === 0) {
    return {
      ref: {
        name: `${parsed.displayBook} ${parsed.chapter}`,
        uri: chapterUri,
        docId: content.docId,
        pid: content.docId,
        contentVersion: content.contentVersion,
        locale: "eng",
      },
    };
  }

  const pids: string[] = [];
  for (const verse of parsed.verses) {
    const pid = paragraphPid(content.html, verse);
    if (!pid) return { error: `Verse ${verse} not found in ${parsed.displayBook} ${parsed.chapter}.` };
    pids.push(pid);
  }
  const verseSuffix = parsed.verses.map((v) => `p${v}`).join(",");
  const first = parsed.verses[0];
  const last = parsed.verses[parsed.verses.length - 1];
  const name = parsed.verses.length === 1
    ? `${parsed.displayBook} ${parsed.chapter}:${first}`
    : `${parsed.displayBook} ${parsed.chapter}:${first}–${last}`;
  return {
    ref: {
      name,
      uri: `${chapterUri}.${verseSuffix}`,
      docId: content.docId,
      pid: pids.join(","),
      contentVersion: content.contentVersion,
      locale: "eng",
    },
  };
}

// Build a type:"reference" annotation that links a source verse/phrase to one or more
// target scriptures. Resolves the source anchor (offsets for a phrase, whole-verse anchor
// otherwise) and every target's metadata server-side, so the model only supplies a verse
// and human-readable reference strings.
async function buildReferenceAnnotation(input: Record<string, unknown>): Promise<HighlightBuild> {
  const linksRaw = input.links ?? input.refs ?? input.references;
  const linkList = Array.isArray(linksRaw)
    ? linksRaw.map((l) => stringInput(l)).filter((l): l is string => !!l)
    : (stringInput(linksRaw) ? [stringInput(linksRaw) as string] : []);
  if (linkList.length === 0) {
    return { error: "create_reference_link needs 'links': one or more target references, e.g. links:[\"D&C 88:87\"]." };
  }

  // Reuse the highlight builder to resolve the source anchor + (optional) phrase offsets.
  // When no phrase is given it yields a whole-verse anchor (color 'clear'); we recolor that
  // to a visible yellow anchor so the link is discoverable in the reader.
  const built = await buildHighlightAnnotation(input, { allowAnchorOnly: true });
  if ("error" in built) return built;
  const annotation = built.annotation;
  annotation.type = "reference";
  const phrase = stringInput(input.phrase) ?? stringInput(input.text);
  if (!phrase) {
    // Whole-verse reference anchor: yellow, no underline, -1/-1 offsets.
    annotation.highlights = [
      {
        uri: (annotation.highlights as Record<string, unknown>[])[0]?.uri,
        pid: (annotation.highlights as Record<string, unknown>[])[0]?.pid,
        color: (stringInput(input.color) ?? "yellow").toLowerCase(),
        startOffset: -1,
        endOffset: -1,
      },
    ];
  }

  const cache = new Map<string, ChapterContent | { error: string }>();
  const refs: Record<string, unknown>[] = [];
  const resolvedLinks: string[] = [];
  for (const link of linkList) {
    const parsed = parseScriptureReference(link);
    if (!parsed) return { error: `Could not parse reference "${link}". Use e.g. "D&C 88:87", "1 Nephi 14", or "Revelation 17:1-5".` };
    const resolved = await resolveReferenceTarget(parsed, cache);
    if ("error" in resolved) return { error: resolved.error };
    refs.push(resolved.ref);
    resolvedLinks.push(String(resolved.ref.name));
  }
  annotation.refs = refs;

  return {
    annotation,
    resolution: {
      ...built.resolution,
      type: "reference",
      links: resolvedLinks,
    },
  };
}

function summarizeProbe(value: unknown): {
  authenticated: boolean;
  needsLogin: boolean;
  inconclusive: boolean;
  status: number | null;
  url: string | null;
} {
  const record = toRecord(value);
  const status = typeof record.status === "number" ? record.status : null;
  const url = typeof record.url === "string" ? record.url : null;
  const ok = record.ok === true;
  const bodyText = typeof record.body === "string" ? record.body : "";
  const redirectedToLogin = typeof url === "string" && /login|signin|auth|oauth/i.test(url);
  const bodyLooksLikeLogin = /\bsign\s*in\b|\blog\s*in\b|username|password/i.test(bodyText);
  const needsLogin = status === 401 || status === 403 || redirectedToLogin || bodyLooksLikeLogin;
  return {
    authenticated: ok && !needsLogin,
    needsLogin,
    inconclusive: !ok && !needsLogin,
    status,
    url,
  };
}

function summarizeProbeBody(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) {
    return {
      type: "array",
      count: body.length,
    };
  }
  if (body && typeof body === "object") {
    return {
      type: "object",
      keys: Object.keys(body as Record<string, unknown>).slice(0, 12),
    };
  }
  if (typeof body === "string") {
    return {
      type: "string",
      length: body.length,
      loginSignals: /\bsign\s*in\b|\blog\s*in\b|username|password/i.test(body),
    };
  }
  return {
    type: body === null ? "null" : typeof body,
  };
}

function sanitizeProbe(value: unknown): Record<string, unknown> {
  const record = toRecord(value);
  return {
    ok: record.ok === true,
    status: typeof record.status === "number" ? record.status : null,
    statusText: typeof record.statusText === "string" ? record.statusText : null,
    url: typeof record.url === "string" ? record.url : null,
    bodySummary: summarizeProbeBody(record.body),
  };
}

async function readPageAuthState(): Promise<unknown> {
  const script = `
    (() => {
      const text = (document.body?.innerText || document.body?.textContent || "").replace(/\\s+/g, " ").trim();
      const controls = [...document.querySelectorAll("a, button, [role='button']")]
        .map((el) => {
          const element = el;
          return {
            text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
            ariaLabel: element.getAttribute("aria-label") || "",
            href: element instanceof HTMLAnchorElement ? element.href : "",
          };
        })
        .filter((entry) => entry.text || entry.ariaLabel || entry.href)
        .slice(0, 40);
      return {
        url: location.href,
        title: document.title,
        hasPasswordField: Boolean(document.querySelector("input[type='password']")),
        hasUsernameField: Boolean(document.querySelector("input[type='email'], input[name*='user' i], input[id*='user' i], input[autocomplete='username']")),
        hasOtpField: Boolean(document.querySelector("input[autocomplete='one-time-code'], input[inputmode='numeric'], input[name*='otp' i], input[id*='otp' i], input[name*='mfa' i], input[id*='mfa' i], input[name*='code' i], input[id*='code' i]")),
        bodySignals: {
          signInText: /\\bsign\\s*in\\b/i.test(text),
          signOutText: /\\bsign\\s*out\\b/i.test(text),
          passwordText: /\\bpassword\\b/i.test(text),
          accountText: /\\baccount\\b/i.test(text),
          twoFactorText: /verification\\s+code|enter\\s+(?:the\\s+)?code|one[-\\s]?time|security\\s+code|authenticator|passcode|approve\\s+(?:this\\s+)?sign[-\\s]?in/i.test(text),
        },
        controls,
      };
    })()
  `;
  return getBrowserManager().evaluate(script);
}

async function clickVisibleSignInControl(): Promise<unknown> {
  const script = `
    (() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.right > 0
          && !el.hasAttribute("disabled")
          && el.getAttribute("aria-hidden") !== "true";
      };
      const controls = [...document.querySelectorAll("a, button, [role='button']")];
      const candidates = controls.map((el) => {
        const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
        const ariaLabel = el.getAttribute("aria-label") || "";
        const href = el instanceof HTMLAnchorElement ? el.href : "";
        return { el, text, ariaLabel, href, visible: visible(el) };
      }).filter((candidate) => candidate.visible);
      const match = candidates.find((candidate) => {
        const haystack = [candidate.text, candidate.ariaLabel, candidate.href].join(" ");
        return /\\bsign\\s*in\\b|\\blog\\s*in\\b|signin|login|oauth|account/i.test(haystack);
      });
      if (!match) {
        return {
          clicked: false,
          reason: "No visible sign-in control found",
          candidates: candidates
            .filter((candidate) => candidate.text || candidate.ariaLabel || candidate.href)
            .slice(0, 12)
            .map((candidate) => ({ text: candidate.text, ariaLabel: candidate.ariaLabel, href: candidate.href })),
        };
      }
      match.el.click();
      return {
        clicked: true,
        text: match.text,
        ariaLabel: match.ariaLabel,
        href: match.href,
      };
    })()
  `;
  return getBrowserManager().evaluate(script);
}

async function openDirectChurchLogin(target?: unknown): Promise<Record<string, unknown>> {
  const redirectUri = requestedChurchRedirectPath(target);
  const loginUrl = `${CHURCH_STUDY_LOGIN_URL}?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const result = await getBrowserManager().open(loginUrl);
  return {
    opened: true,
    url: loginUrl,
    redirectUri,
    result,
  };
}

async function probeAnnotationAuth(): Promise<{ probe: unknown; summary: ReturnType<typeof summarizeProbe> }> {
  const probe = await pageFetch({
    url: buildAnnotationsUrl(AUTH_PROBE_QUERY),
  });
  return {
    probe,
    summary: summarizeProbe(probe),
  };
}

function pageStateNeedsSecondFactor(value: unknown): boolean {
  const record = toRecord(value);
  const signals = toRecord(record.bodySignals);
  return !pageStateLooksSignedIn(value) && (record.hasOtpField === true || signals.twoFactorText === true);
}

function pageStateHasCredentialFields(value: unknown): boolean {
  const record = toRecord(value);
  return record.hasUsernameField === true || record.hasPasswordField === true;
}

function pageStateLooksSignedIn(value: unknown): boolean {
  const record = toRecord(value);
  const signals = toRecord(record.bodySignals);
  if (signals.signOutText === true) {
    return true;
  }
  const controls = Array.isArray(record.controls) ? record.controls : [];
  return controls.some((control) => {
    const entry = toRecord(control);
    const text = typeof entry.text === "string" ? entry.text : "";
    const ariaLabel = typeof entry.ariaLabel === "string" ? entry.ariaLabel : "";
    return /\bsign\s*out\b/i.test(`${text} ${ariaLabel}`);
  });
}

async function loadChurchCredentials(): Promise<
  | { ok: true; username: string; password: string; vault: string; item: string }
  | {
      ok: false;
      error: string;
      credentialConfigured: boolean;
      opAvailable: boolean;
      missingConfig?: string[];
      missingFields?: string[];
    }
> {
  const ref = configuredChurchCredentialRef();
  if (!ref.configured || !ref.vault || !ref.item) {
    return {
      ok: false,
      error: "Church account 1Password item is not configured.",
      credentialConfigured: false,
      opAvailable: isOpAvailable(),
      missingConfig: ref.missing,
    };
  }

  if (!isOpAvailable()) {
    return {
      ok: false,
      error: "1Password service account token is not available to this process.",
      credentialConfigured: true,
      opAvailable: false,
    };
  }

  const [username, password] = await Promise.all([
    getSecret(ref.vault, ref.item, "username"),
    getSecret(ref.vault, ref.item, "password"),
  ]);
  const missingFields = [
    ...(username ? [] : ["username"]),
    ...(password ? [] : ["password"]),
  ];
  if (!username || !password) {
    return {
      ok: false,
      error: "Church account 1Password item is missing required login fields.",
      credentialConfigured: true,
      opAvailable: true,
      missingFields,
    };
  }

  return {
    ok: true,
    username,
    password,
    vault: ref.vault,
    item: ref.item,
  };
}

async function fillChurchLoginCredentials(input: {
  username: string;
  password: string;
}): Promise<unknown> {
  const script = `
    (() => {
      const suppliedUsername = ${JSON.stringify(input.username)};
      const suppliedPassword = ${JSON.stringify(input.password)};
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && !el.hasAttribute("disabled")
          && el.getAttribute("aria-hidden") !== "true";
      };
      const textOf = (el) => [
        el instanceof HTMLInputElement ? el.value : "",
        el.textContent || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
      ].join(" ").replace(/\\s+/g, " ").trim();
      const inputs = [...document.querySelectorAll("input")].filter((el) =>
        visible(el) && (el instanceof HTMLInputElement) && el.type !== "hidden"
      );
      const inputHaystack = (input) => [
        input.type,
        input.name,
        input.id,
        input.autocomplete,
        input.placeholder,
        input.getAttribute("aria-label") || "",
      ].join(" ");
      const excludedUsername = /otp|mfa|code|token|captcha|search|remember/i;
      const usernameInput = inputs.find((input) => {
        if (input.type === "password") return false;
        const haystack = inputHaystack(input);
        return !excludedUsername.test(haystack)
          && (/username|email|login|identifier|user/i.test(haystack) || input.type === "email" || input.autocomplete === "username");
      }) || inputs.find((input) => {
        if (input.type === "password") return false;
        const haystack = inputHaystack(input);
        return !excludedUsername.test(haystack) && ["", "text", "email"].includes(input.type);
      });
      const passwordInput = inputs.find((input) =>
        input.type === "password" || /current-password|password/i.test(inputHaystack(input))
      );
      const setValue = (input, value) => {
        input.focus();
        const prototype = Object.getPrototypeOf(input);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor?.set) {
          descriptor.set.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      };
      let filledUsername = false;
      let filledPassword = false;
      if (usernameInput && usernameInput.value !== suppliedUsername) {
        setValue(usernameInput, suppliedUsername);
        filledUsername = true;
      }
      if (passwordInput && passwordInput.value !== suppliedPassword) {
        setValue(passwordInput, suppliedPassword);
        filledPassword = true;
      }
      const usernameReady = Boolean(usernameInput && usernameInput.value);
      const passwordReady = Boolean(passwordInput && passwordInput.value);
      const clickable = [...document.querySelectorAll("button, input[type='submit'], a, [role='button']")]
        .filter((el) => visible(el))
        .map((el) => ({ el, text: textOf(el) }))
        .filter((entry) => entry.text && !/forgot|create|register|cancel|help/i.test(entry.text));
      const submit = clickable.find((entry) => /\\bsign\\s*in\\b|\\blog\\s*in\\b|continue|next|submit|verify/i.test(entry.text));
      let clicked = false;
      let clickedText = "";
      let submittedViaForm = false;
      if (submit && (filledUsername || filledPassword || usernameReady || passwordReady)) {
        submit.el.click();
        clicked = true;
        clickedText = submit.text.slice(0, 80);
      } else if ((filledUsername || filledPassword || usernameReady || passwordReady) && (passwordInput || !usernameInput)) {
        const form = (passwordInput || usernameInput)?.closest("form");
        if (form instanceof HTMLFormElement) {
          form.requestSubmit();
          submittedViaForm = true;
        }
      }
      return {
        url: location.href,
        title: document.title,
        usernameFieldFound: Boolean(usernameInput),
        passwordFieldFound: Boolean(passwordInput),
        filledUsername,
        filledPassword,
        usernameReady,
        passwordReady,
        clicked,
        clickedText,
        submittedViaForm,
      };
    })()
  `;
  return getBrowserManager().evaluate(script);
}

async function fillChurchOneTimePassword(otp: string): Promise<unknown> {
  const script = `
    (() => {
      const suppliedOtp = ${JSON.stringify(otp)};
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && !el.hasAttribute("disabled")
          && el.getAttribute("aria-hidden") !== "true";
      };
      const haystack = (input) => [
        input.type,
        input.name,
        input.id,
        input.autocomplete,
        input.placeholder,
        input.getAttribute("aria-label") || "",
      ].join(" ");
      const inputs = [...document.querySelectorAll("input")].filter((el) =>
        visible(el) && (el instanceof HTMLInputElement) && el.type !== "hidden"
      );
      const otpInput = inputs.find((input) =>
        input.autocomplete === "one-time-code"
          || /otp|mfa|one[-_\\s]?time|verification|security|passcode|code/i.test(haystack(input))
      ) || inputs.find((input) => input.inputMode === "numeric");
      if (!otpInput) {
        return { url: location.href, otpFieldFound: false, filledOtp: false, clicked: false };
      }
      otpInput.focus();
      const prototype = Object.getPrototypeOf(otpInput);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(otpInput, suppliedOtp);
      } else {
        otpInput.value = suppliedOtp;
      }
      otpInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: suppliedOtp }));
      otpInput.dispatchEvent(new Event("change", { bubbles: true }));
      const clickables = [...document.querySelectorAll("button, input[type='submit'], a, [role='button']")]
        .filter((el) => visible(el))
        .map((el) => ({
          el,
          text: [
            el instanceof HTMLInputElement ? el.value : "",
            el.textContent || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
          ].join(" ").replace(/\\s+/g, " ").trim(),
        }))
        .filter((entry) => entry.text && !/cancel|back|resend/i.test(entry.text));
      const submit = clickables.find((entry) => /verify|continue|next|submit|sign\\s*in|log\\s*in/i.test(entry.text));
      let clicked = false;
      let clickedText = "";
      if (submit) {
        submit.el.click();
        clicked = true;
        clickedText = submit.text.slice(0, 80);
      } else {
        const form = otpInput.closest("form");
        if (form instanceof HTMLFormElement) {
          form.requestSubmit();
          clicked = true;
          clickedText = "form.requestSubmit";
        }
      }
      return {
        url: location.href,
        otpFieldFound: true,
        filledOtp: true,
        clicked,
        clickedText,
      };
    })()
  `;
  return getBrowserManager().evaluate(script);
}

async function tryProbeFromCurrentChurchPage(): Promise<{
  auth: Awaited<ReturnType<typeof probeAnnotationAuth>> | null;
  currentUrl: string | null;
}> {
  const status = await getBrowserManager().status();
  const currentUrl = status.url ?? null;
  if (!currentUrl?.startsWith(CHURCH_ORIGIN)) {
    return { auth: null, currentUrl };
  }
  return {
    auth: await probeAnnotationAuth(),
    currentUrl,
  };
}

async function runOnePasswordLogin(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const browserManager = getBrowserManager();
  const browser = await ensureChurchPage({
    url: input.url,
    openIfNeeded: true,
  });

  const before = await probeAnnotationAuth();
  if (before.summary.authenticated) {
    return {
      connected: true,
      launched: browser.launched,
      navigated: browser.navigated,
      authenticated: true,
      needsLogin: false,
      currentUrl: browser.currentUrl,
      credentialSource: null,
      probe: sanitizeProbe(before.probe),
      message: "Already authenticated to Gospel Library annotations.",
    };
  }

  const credentials = await loadChurchCredentials();
  if (!credentials.ok) {
    const pageState = await readPageAuthState().catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const click = pageStateHasCredentialFields(pageState)
      ? null
      : await clickVisibleSignInControl().catch((error) => ({
          clicked: false,
          reason: error instanceof Error ? error.message : String(error),
        }));
    return {
      connected: true,
      launched: browser.launched,
      navigated: browser.navigated,
      authenticated: false,
      needsLogin: true,
      credentialSource: "onepassword",
      credentialReady: false,
      credentialConfigured: credentials.credentialConfigured,
      opAvailable: credentials.opAvailable,
      missingConfig: credentials.missingConfig,
      missingFields: credentials.missingFields,
      pageState,
      click,
      initialProbe: sanitizeProbe(before.probe),
      message: "Gospel Library login needs the configured Church account 1Password item. Do not ask Devin for the password in chat; ask him to fix the 1Password item or service-account access.",
    };
  }

  const attempts: Array<Record<string, unknown>> = [];
  let pageState = await readPageAuthState().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!pageStateHasCredentialFields(pageState)) {
    const click = await clickVisibleSignInControl().catch((error) => ({
      clicked: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    attempts.push({ step: "open-sign-in", click });
    if (toRecord(click).clicked !== true) {
      const direct = await openDirectChurchLogin(input.url).catch((error) => ({
        opened: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      attempts.push({ step: "open-direct-login", direct });
    }
    await browserManager.wait({ timeout: 2500 }).catch(() => undefined);
    pageState = await readPageAuthState().catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (pageStateLooksSignedIn(pageState)) {
      const signedInProbe = await tryProbeFromCurrentChurchPage().catch((error) => ({
        auth: null,
        currentUrl: null,
        error: error instanceof Error ? error.message : String(error),
      }));
      if ("auth" in signedInProbe && signedInProbe.auth?.summary.authenticated) {
        return {
          connected: true,
          launched: browser.launched,
          navigated: browser.navigated,
          authenticated: true,
          needsLogin: false,
          credentialSource: "onepassword",
          credentialReady: true,
          currentUrl: signedInProbe.currentUrl,
          attempts,
          initialProbe: sanitizeProbe(before.probe),
          finalProbe: sanitizeProbe(signedInProbe.auth.probe),
          message: "Authenticated to Gospel Library annotations using the configured 1Password item.",
        };
      }

      const direct = await openDirectChurchLogin(input.url).catch((error) => ({
        opened: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      attempts.push({ step: "refresh-study-login", attempt, direct });
      await browserManager.wait({ timeout: 3500 }).catch(() => undefined);
      const refreshedProbe = await tryProbeFromCurrentChurchPage().catch((error) => ({
        auth: null,
        currentUrl: null,
        error: error instanceof Error ? error.message : String(error),
      }));
      if ("auth" in refreshedProbe && refreshedProbe.auth?.summary.authenticated) {
        return {
          connected: true,
          launched: browser.launched,
          navigated: browser.navigated,
          authenticated: true,
          needsLogin: false,
          credentialSource: "onepassword",
          credentialReady: true,
          currentUrl: refreshedProbe.currentUrl,
          attempts,
          initialProbe: sanitizeProbe(before.probe),
          finalProbe: sanitizeProbe(refreshedProbe.auth.probe),
          message: "Authenticated to Gospel Library annotations using the configured 1Password item.",
        };
      }
      pageState = await readPageAuthState().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    if (pageStateNeedsSecondFactor(pageState)) {
      const otp = await getOneTimePassword(credentials.vault, credentials.item);
      if (!otp) {
        const status = await browserManager.status();
        return {
          connected: true,
          launched: browser.launched,
          navigated: browser.navigated,
          authenticated: false,
          needsLogin: true,
          needsSecondFactor: true,
          credentialSource: "onepassword",
          credentialReady: true,
          currentUrl: status.url,
          attempts,
          pageState,
          initialProbe: sanitizeProbe(before.probe),
          message: "Church sign-in reached a second-factor challenge. Porter can continue after Devin completes or approves the second factor.",
        };
      }

      const otpFill = await fillChurchOneTimePassword(otp);
      attempts.push({ step: "fill-totp", otpFieldFound: toRecord(otpFill).otpFieldFound === true, clicked: toRecord(otpFill).clicked === true });
      await browserManager.wait({ timeout: 3500 }).catch(() => undefined);
    } else if (pageStateHasCredentialFields(pageState)) {
      const fill = await fillChurchLoginCredentials({
        username: credentials.username,
        password: credentials.password,
      });
      attempts.push({
        step: "fill-credentials",
        attempt,
        usernameFieldFound: toRecord(fill).usernameFieldFound === true,
        passwordFieldFound: toRecord(fill).passwordFieldFound === true,
        filledUsername: toRecord(fill).filledUsername === true,
        filledPassword: toRecord(fill).filledPassword === true,
        clicked: toRecord(fill).clicked === true,
        submittedViaForm: toRecord(fill).submittedViaForm === true,
      });
      await browserManager.wait({ timeout: 3500 }).catch(() => undefined);
    } else {
      const click = await clickVisibleSignInControl().catch((error) => ({
        clicked: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      attempts.push({ step: "open-sign-in", attempt, click });
      if (toRecord(click).clicked !== true) {
        const direct = await openDirectChurchLogin(input.url).catch((error) => ({
          opened: false,
          reason: error instanceof Error ? error.message : String(error),
        }));
        attempts.push({ step: "open-direct-login", attempt, direct });
      }
      await browserManager.wait({ timeout: 2500 }).catch(() => undefined);
    }

    const currentProbe = await tryProbeFromCurrentChurchPage().catch((error) => ({
      auth: null,
      currentUrl: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    if ("auth" in currentProbe && currentProbe.auth?.summary.authenticated) {
      return {
        connected: true,
        launched: browser.launched,
        navigated: browser.navigated,
        authenticated: true,
        needsLogin: false,
        credentialSource: "onepassword",
        credentialReady: true,
        currentUrl: currentProbe.currentUrl,
        attempts,
        initialProbe: sanitizeProbe(before.probe),
        finalProbe: sanitizeProbe(currentProbe.auth.probe),
        message: "Authenticated to Gospel Library annotations using the configured 1Password item.",
      };
    }

    pageState = await readPageAuthState().catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const finalStatus = await browserManager.status();
  if (!(finalStatus.url ?? "").startsWith(CHURCH_ORIGIN)) {
    await browserManager.open(requestedChurchUrl(input.url)).catch(() => undefined);
  }
  const final = await tryProbeFromCurrentChurchPage().catch((error) => ({
    auth: null,
    currentUrl: finalStatus.url ?? null,
    error: error instanceof Error ? error.message : String(error),
  }));

  return {
    connected: true,
    launched: browser.launched,
    navigated: browser.navigated,
    authenticated: "auth" in final ? final.auth?.summary.authenticated ?? false : false,
    needsLogin: "auth" in final ? final.auth?.summary.needsLogin ?? true : true,
    inconclusive: "auth" in final ? final.auth?.summary.inconclusive ?? false : false,
    credentialSource: "onepassword",
    credentialReady: true,
    currentUrl: "currentUrl" in final ? final.currentUrl : finalStatus.url,
    attempts,
    initialProbe: sanitizeProbe(before.probe),
    finalProbe: "auth" in final && final.auth ? sanitizeProbe(final.auth.probe) : null,
    pageState,
    message: "Porter attempted Church sign-in with the configured 1Password item, but Gospel Library authentication is not verified yet. Inspect the browser for 2FA, captcha, or an upstream Church login error.",
  };
}

export function gospelLibraryActionLooksMutating(action: string): boolean {
  return ["create_reference_link", "create_highlight", "create_annotation", "delete_annotation"].includes(action.trim().toLowerCase());
}

export function createGospelLibraryTools(): AgentTool[] {
  return [
    {
      name: "gospel_library",
      description: [
        "Authenticated Gospel Library notes API wrapper using the current Church website browser session.",
        "",
        "Actions:",
        "- status: launch/navigate if needed, then check browser connection, current Church page, and annotation endpoint auth status",
        "- open: launch/connect and open a Church/Gospel Library URL",
        "- prepare_login: launch/open Church site, detect auth, and click a visible sign-in control if needed",
        "- login: launch/open Church site and use the configured 1Password Church login item to re-authenticate when needed",
        "- list_annotations: GET /notes/api/v3/annotations with optional query object",
        "- create_reference_link: LINK a verse (or a phrase in it) to one or more other scriptures. Pass a human-level",
        "    source + target list and the tool resolves every target's docId/pid/contentVersion server-side. Params:",
        "      uri: source chapter path, e.g. '/scriptures/bofm/2-ne/23'; verse: source verse number, e.g. 10",
        "      links: array of target references as plain strings, e.g. [\"D&C 88:87\"], [\"Revelation 17:1-5\"], [\"1 Nephi 14\"]",
        "            (ranges and whole-chapter links supported; multiple targets allowed in one call)",
        "      phrase: optional — to anchor the link on specific words (also underlines them); color/style/note optional",
        "    Advanced: pass a full `annotation` object instead to POST it verbatim.",
        "- create_highlight: MARK/UNDERLINE scripture text (optionally colored, optionally with a note). Just pass a",
        "    human-level reference and the tool resolves docId, contentVersion, the verse's pid, and the exact character",
        "    offsets for you — you do NOT need to read the page or compute offsets. Params:",
        "      uri: chapter path, e.g. '/scriptures/bofm/2-ne/23' (or a verse path ending in .p6)",
        "      verse: verse number, e.g. 6 (omit if uri already ends in .p6)",
        "      phrase: the EXACT words to underline/highlight, e.g. 'day of the Lord' (verbatim from the verse)",
        "      color: yellow|pink|blue|green|orange|red|purple|... (default yellow); style: red-underline|highlight (default red-underline)",
        "      note: optional study note text to attach to the verse",
        "      occurrence: optional 1-based match index when the phrase repeats in the verse (default 1)",
        "    To attach only a note to a whole verse, pass uri+verse+note and omit phrase. Advanced: pass a full `annotation`",
        "    object instead to POST it verbatim. The tool verifies the new annotation and returns its id + resolved offsets.",
        "- create_annotation: POST any annotation payload (generic; for non-highlight/reference types).",
        "- delete_annotation: DELETE an annotation by annotation_id",
        "",
        "This tool owns browser launch/navigation for Gospel Library. Do not ask the user to open a browser tab. Use login before asking for help; ask the user only when 1Password access, password-manager approval, captcha, or 2FA blocks authentication.",
        "It never stores or prints cookies. Do not hardcode personal IDs; use IDs from the authenticated page/API payload when a write requires them.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "status",
              "open",
              "prepare_login",
              "login",
              "list_annotations",
              "create_reference_link",
              "create_highlight",
              "create_annotation",
              "delete_annotation",
            ],
          },
          url: {
            type: "string",
            description: "For open/status/prepare_login: Church URL or path. Defaults to /study/scriptures?lang=eng.",
          },
          open_if_needed: {
            type: "boolean",
            description: "For status: launch/navigate to Church site when needed. Defaults to true.",
          },
          query: {
            type: "object",
            description: "For list_annotations: query parameters such as uri, docId, folderId, tagId, limit, or offset.",
          },
          annotation: {
            type: "object",
            description: "For create_reference_link/create_annotation (or advanced create_highlight): complete annotation payload for the Gospel Library notes API.",
          },
          verse: {
            type: "number",
            description: "For create_highlight: verse number to mark, e.g. 6. Omit if uri already ends in .p6.",
          },
          phrase: {
            type: "string",
            description: "For create_highlight: the exact words to underline/highlight, verbatim from the verse, e.g. 'day of the Lord'.",
          },
          color: {
            type: "string",
            description: "For create_highlight: yellow|pink|blue|green|orange|red|purple|... (default yellow).",
          },
          style: {
            type: "string",
            description: "For create_highlight: 'red-underline' underlines the range; 'highlight' fills the color (default red-underline).",
          },
          note: {
            type: "string",
            description: "For create_highlight: optional study note text to attach to the verse (pass without phrase to note the whole verse).",
          },
          occurrence: {
            type: "number",
            description: "For create_highlight: 1-based match index when the phrase repeats in the verse (default 1).",
          },
          links: {
            type: "array",
            items: { type: "string" },
            description: "For create_reference_link: target scriptures as plain strings, e.g. [\"D&C 88:87\", \"Revelation 17:1-5\", \"1 Nephi 14\"]. Ranges and whole-chapter links supported.",
          },
          annotation_id: {
            type: "string",
            description: "For delete_annotation: annotation ID to delete.",
          },
          verify: {
            type: "boolean",
            description: "For create/delete actions: verify when possible. Defaults to true.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action ?? "").trim().toLowerCase() as GospelLibraryAction;
        const browserManager = getBrowserManager();

        if (action === "status") {
          const browser = await ensureChurchPage({
            url: input.url,
            openIfNeeded: input.open_if_needed !== false,
          });
          const status = await browserManager.status();
          const onChurchSite = (status.url ?? "").startsWith(CHURCH_ORIGIN);
          const auth = onChurchSite
            ? await probeAnnotationAuth()
            : null;
          return {
            connected: status.connected,
            launched: browser.launched,
            navigated: browser.navigated,
            currentUrl: status.url,
            onChurchSite,
            authenticated: auth?.summary.authenticated ?? false,
            needsLogin: auth?.summary.needsLogin ?? true,
            inconclusive: auth?.summary.inconclusive ?? false,
            probe: auth ? sanitizeProbe(auth.probe) : null,
            message: auth?.summary.authenticated
                ? "Gospel Library annotations endpoint is authenticated."
                : auth?.summary.needsLogin
                ? "Gospel Library session is not authenticated yet. Use login to re-authenticate with the configured 1Password item; only ask the user if 1Password access, captcha, or 2FA blocks authentication."
                : "Gospel Library annotations endpoint was reachable but the probe result was inconclusive. Inspect the probe before deciding this is an auth failure.",
          };
        }

        if (action === "open") {
          const browser = await ensureChurchPage({
            url: input.url,
            openIfNeeded: true,
          });
          return {
            connected: true,
            launched: browser.launched,
            navigated: browser.navigated,
            currentUrl: browser.currentUrl,
          };
        }

        if (action === "prepare_login") {
          const browser = await ensureChurchPage({
            url: input.url,
            openIfNeeded: true,
          });
          const before = await probeAnnotationAuth();
          if (before.summary.authenticated) {
            return {
              connected: true,
              launched: browser.launched,
              navigated: browser.navigated,
              authenticated: true,
              needsLogin: false,
              currentUrl: browser.currentUrl,
              probe: sanitizeProbe(before.probe),
              message: "Already authenticated to Gospel Library annotations.",
            };
          }

          const pageStateBefore = await readPageAuthState();
          const click = await clickVisibleSignInControl();
          const directLogin = toRecord(click).clicked === true
            ? null
            : await openDirectChurchLogin(input.url).catch((error) => ({
                opened: false,
                reason: error instanceof Error ? error.message : String(error),
              }));
          await browserManager.wait({ timeout: 2500 }).catch(() => undefined);
          const status = await browserManager.status();
          const pageStateAfter = await readPageAuthState().catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
          const after = (status.url ?? "").startsWith(CHURCH_ORIGIN)
            ? await probeAnnotationAuth().catch((error) => ({
              probe: { error: error instanceof Error ? error.message : String(error) },
                summary: { authenticated: false, needsLogin: true, inconclusive: false, status: null, url: null },
              }))
            : null;

          return {
            connected: true,
            launched: browser.launched,
            navigated: browser.navigated,
            authenticated: after?.summary.authenticated ?? false,
            needsLogin: after?.summary.needsLogin ?? true,
            inconclusive: after?.summary.inconclusive ?? false,
            currentUrl: status.url,
            initialProbe: sanitizeProbe(before.probe),
            click,
            directLogin,
            pageStateBefore,
            pageStateAfter,
            finalProbe: after ? sanitizeProbe(after.probe) : null,
            message: after?.summary.authenticated
              ? "Authenticated to Gospel Library annotations."
              : after?.summary.inconclusive
                ? "Browser sign-in preparation ran, but the final annotation probe was inconclusive. Inspect the browser page before deciding this is an auth failure."
                : "Browser is prepared for Gospel Library sign-in. Continue with browser snapshot/click/fill if saved credentials are available; ask the user only for credential entry, password-manager approval, or 2FA.",
          };
        }

        if (action === "login") {
          return runOnePasswordLogin(input);
        }

        await ensureChurchPage();

        if (action === "list_annotations") {
          return pageFetch({
            url: buildAnnotationsUrl(input.query),
          });
        }

        if (action === "create_highlight") {
          // Preferred path: build the payload from a human-level reference (uri + verse +
          // phrase). Escape hatch: a fully-formed `annotation` object is POSTed as-is.
          let annotation = sanitizeAnnotationForPost(toRecord(input.annotation));
          let resolution: Record<string, unknown> | null = null;
          if (Object.keys(annotation).length === 0) {
            const built = await buildHighlightAnnotation(input);
            if ("error" in built) {
              return built;
            }
            annotation = built.annotation;
            resolution = built.resolution;
          }

          const created = await pageFetch({
            url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}`,
            method: "POST",
            body: annotation,
          });

          if (input.verify === false) {
            return { created, resolution, verified: null };
          }

          const annotationId = extractAnnotationId(created);
          const verification = annotationId
            ? await pageFetch({
                url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}/${encodeURIComponent(annotationId)}`,
              })
            : null;

          return {
            created,
            annotationId,
            resolution,
            verification,
          };
        }

        if (action === "create_reference_link" || action === "create_annotation") {
          // create_reference_link preferred path: build the type:reference annotation from
          // a source verse/phrase + human-readable `links`. Escape hatch (and the only path
          // for create_annotation): a fully-formed `annotation` object POSTed as-is.
          let annotation = sanitizeAnnotationForPost(toRecord(input.annotation));
          let resolution: Record<string, unknown> | null = null;
          const wantsHighLevel = action === "create_reference_link"
            && Object.keys(annotation).length === 0
            && (input.links !== undefined || input.refs !== undefined || input.references !== undefined);
          if (wantsHighLevel) {
            const built = await buildReferenceAnnotation(input);
            if ("error" in built) {
              return built;
            }
            annotation = built.annotation;
            resolution = built.resolution;
          }
          if (Object.keys(annotation).length === 0) {
            return { error: `${action} requires an annotation object, or (for create_reference_link) 'uri'+'verse'+'links'.` };
          }

          const created = await pageFetch({
            url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}`,
            method: "POST",
            body: annotation,
          });

          if (input.verify === false) {
            return { created, resolution, verified: null };
          }

          const annotationId = extractAnnotationId(created);
          const verification = annotationId
            ? await pageFetch({
                url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}/${encodeURIComponent(annotationId)}`,
              })
            : null;

          return {
            created,
            annotationId,
            resolution,
            verification,
          };
        }

        if (action === "delete_annotation") {
          const annotationId = typeof input.annotation_id === "string"
            ? input.annotation_id.trim()
            : "";
          if (!annotationId) {
            return { error: "delete_annotation requires annotation_id" };
          }

          const deleted = await pageFetch({
            url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}/${encodeURIComponent(annotationId)}`,
            method: "DELETE",
          });

          if (input.verify === false) {
            return { deleted, verified: null };
          }

          const verification = await pageFetch({
            url: `${CHURCH_ORIGIN}${ANNOTATIONS_PATH}/${encodeURIComponent(annotationId)}`,
          });

          return {
            deleted,
            annotationId,
            verification,
          };
        }

        return { error: `Unknown gospel_library action: ${String(input.action ?? "")}` };
      },
    },
  ];
}
