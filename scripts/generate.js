// scripts/generate.js
// Generates:
// - public/index.html (today's brief)
// - public/archive/YYYY-MM-DD.html (dated snapshot)
// - public/archive/index.html (archive listing)
// - public/about.html (static explanation page)
//
// Keeps a seen-items cache to avoid repeats and prefers fresh UK-centric items.
// Adds IPv4-first DNS, disables keep-alive to prevent lingering sockets, and
// timestamps all logs. Exits cleanly when done.

import fs from "fs/promises";
import path from "path";
import http from "http";
import https from "https";
import dns from "dns";
import RSSParser from "rss-parser";
import sanitizeHtml from "sanitize-html";
import OpenAI from "openai";

// --- Runtime hardening & logging --------------------------------------------

// Prefer IPv4 for DNS (reduces ENOTFOUND on some hosts)
dns.setDefaultResultOrder?.("ipv4first");

// Disable global keep-alive so sockets don't hold the event loop open
http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

// Agent used by rss-parser (no keep-alive; IPv4)
const httpsNoKeepAliveV4 = new https.Agent({ keepAlive: false, family: 4 });

function ts() { return new Date().toISOString(); }
const log = (...args) => console.log(`[${ts()}]`, ...args);
const logWarn = (...args) => console.warn(`[${ts()}]`, ...args);
const logError = (...args) => console.error(`[${ts()}]`, ...args);

// --- Config ------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  logError("Missing OPENAI_API_KEY (export it or set in CI secrets)");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const rss = new RSSParser({
  timeout: 15000,
  headers: { "user-agent": "uk-ai-brief/1.2" },
  requestOptions: { agent: httpsNoKeepAliveV4 },
});

// UK-centric feeds (balanced mix of gov/regulators/research + general tech)
const FEEDS = [
  // UK government & regulators
  "https://www.gov.uk/government/organisations/department-for-science-innovation-and-technology.atom",
  "https://www.ncsc.gov.uk/api/1/services/v1/news-rss-feed.xml",
  // (ICO/Ofcom legacy feeds removed due to 404s)
  "https://www.gov.uk/government/organisations/competition-and-markets-authority.atom",

  // Research & funding
  "https://www.ukri.org/news/feed/",
  // (Turing RSS blocked w/403; omit)
  // "https://www.turing.ac.uk/rss.xml",

  // UK/tech press with AI coverage
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.theregister.com/headlines.atom",
  "https://news.sky.com/feeds/rss/technology.xml",
  "https://www.theguardian.com/uk/technology/rss",
  // International catch-all (DNS can be flaky but useful)
  "https://feeds.reuters.com/reuters/technologyNews?format=xml",
];

// Freshness & selection
const FRESH_HOURS_PRIMARY = 24;
const FRESH_HOURS_FALLBACKS = [36, 48];
const MAX_ITEMS = 6;
const MIN_DISTINCT_HOSTS = 3;

// State & output
const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(STATE_DIR, "seen.json");
const TPL_DIR = path.join(ROOT, "templates");
const OUT_DIR = path.join(ROOT, "public");
const INDEX_TEMPLATE = path.join(TPL_DIR, "index.template.html");
const INDEX_OUT = path.join(OUT_DIR, "index.html");
const ARCHIVE_DIR = path.join(OUT_DIR, "archive");
const ABOUT_OUT = path.join(OUT_DIR, "about.html");

// --- Helpers -----------------------------------------------------------------

function truncate(text = "", n = 600) {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

function todayYMD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isoAndHumanDate() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    human: now.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" }),
  };
}

function htmlEscape(s = "") {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function scoreUK(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(^|\W)(uk|u\.k\.|united kingdom|britain|british|london|cma|ico|ncsc|dsit|ukri|ofcom|gov\.uk|govuk|turing institute)(\W|$)/i.test(h) ? 1 : 0;
}

function normalizeTitle(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isFresh(dateObj, maxHours) {
  if (!dateObj || isNaN(dateObj.getTime())) return false;
  const ageMs = Date.now() - dateObj.getTime();
  return ageMs >= 0 && ageMs <= maxHours * 3600 * 1000;
}

async function loadSeen() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    return {
      links: new Set(j.links || []),
      titles: new Set((j.titles || []).map(normalizeTitle)),
    };
  } catch {
    return { links: new Set(), titles: new Set() };
  }
}

async function saveSeen(seen) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const payload = {
    links: Array.from(seen.links),
    titles: Array.from(seen.titles),
    updated: new Date().toISOString(),
  };
  await fs.writeFile(STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

// Pull up to MAX_ITEMS respecting freshness and "seen".
async function collectItemsWithFreshness(feeds, seen, maxHours) {
  const items = [];

  for (const url of feeds) {
    try {
      const feed = await rss.parseURL(url);
      for (const it of feed.items) {
        const link = it.link || it.guid;
        if (!link) continue;

        const dateStr = it.isoDate || it.pubDate || it.pubdate || null;
        const publishedAt = dateStr ? new Date(dateStr) : null;
        if (maxHours && !isFresh(publishedAt, maxHours)) continue;

        const titleNorm = normalizeTitle(it.title || "");
        if (seen.links.has(link) || (titleNorm && seen.titles.has(titleNorm))) continue;

        items.push({
          title: (it.title || "").trim(),
          link,
          source: safeHostname(link),
          snippet: (it.contentSnippet || it.summary || it.content || "").replace(/\s+/g, " ").trim(),
          publishedAt,
        });
      }
    } catch (e) {
      logWarn("RSS error:", url, e.message);
    }
  }

  // De-dupe by link
  const seenLinks = new Set();
  const unique = [];
  for (const it of items) {
    if (!seenLinks.has(it.link)) {
      seenLinks.add(it.link);
      unique.push(it);
    }
  }

  // Prefer UK signals, then newest first
  unique.sort((a, b) => {
    const ukDelta = scoreUK(b) - scoreUK(a);
    if (ukDelta !== 0) return ukDelta;
    const at = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bt = b.publishedAt ? b.publishedAt.getTime() : 0;
    return bt - at;
  });

  // Spread across hosts to increase diversity
  const byHost = new Map();
  for (const it of unique) {
    if (!byHost.has(it.source)) byHost.set(it.source, []);
    byHost.get(it.source).push(it);
  }
  const picks = [];
  while (picks.length < MAX_ITEMS) {
    let added = false;
    for (const arr of byHost.values()) {
      if (arr.length && picks.length < MAX_ITEMS) {
        picks.push(arr.shift());
        added = true;
      }
    }
    if (!added) break;
  }

  return picks;
}

function buildPrompt(items) {
  const sourcesBlock = items.map((it, i) =>
    `(${i + 1}) [${it.source}] ${it.title}\nURL: ${it.link}\nSnippet: ${truncate(it.snippet, 600)}`
  ).join("\n\n");

  return `You are a cautious news summariser.

CONTEXT:
We publish a daily 2-minute brief focused on **AI within the UK** — regulators (CMA, ICO, Ofcom, NCSC), DSIT/government, UKRI/universities, UK-headquartered firms, and UK implications of global AI news.

INPUT SOURCES (RSS titles + snippets only):
${sourcesBlock}

YOUR TASK:
- Produce a concise, neutral daily brief **with a UK angle**.
- Output sections in this exact format:
1) ONE_SENTENCE: <a single factual sentence framed around the UK angle>
2) WHY_IT_MATTERS:
   - <bullet 1 with concrete UK relevance>
   - <bullet 2>
   - <bullet 3>
3) EXPLAINER (200–300 words, plain English; refer to UK if present)
4) TAGS: comma-separated lowercase tags (3–5), e.g., "uk-policy, cma, research-funding"

RULES:
- Use ONLY facts supported by the provided snippets/titles; do not speculate.
- Acknowledge uncertainty if sources conflict.
- No quotes longer than 20 words.
- No images.
- End with nothing else.`;
}

// Robust parser even if model deviates
function parseModelOutput(text) {
  const oneMatch = text.match(/ONE[_\s-]*SENTENCE:\s*(.+)/i);
  let oneLiner = (oneMatch && oneMatch[1] ? oneMatch[1] : "").trim();
  if (!oneLiner) {
    // Fallback: first non-empty line that isn't a header
    oneLiner = (text.split("\n").map(s => s.trim()).find(s => s && !/^(\d\)|why|explainer|tags|tl;dr)/i.test(s)) || "").trim();
  }
  // Normalise TL;DR style
  if (/^tl;?dr[:\s-]/i.test(oneLiner)) {
    oneLiner = oneLiner.replace(/^tl;?dr[:\s-]\s*/i, "");
  }

  const bullets = Array.from(text.matchAll(/^\s*-\s+(.+)$/gmi))
    .map((m) => m[1].trim())
    .slice(0, 3);

  const explainerPart = text.split(/^\s*3\)\s*EXPLAINER/i)[1] || text.split(/EXPLAINER/i)[1] || "";
  const explainer = explainerPart.replace(/^:\s*/, "").split(/^\s*4\)\s*TAGS:/im)[0]?.trim() || "";

  const tagsMatch = text.match(/TAGS:\s*(.+)/i);
  const tags = (tagsMatch && tagsMatch[1] ? tagsMatch[1] : "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return { oneLiner, bullets, explainer, tags };
}

function toHtmlList(bullets) {
  return bullets.map((b) => `<li>${htmlEscape(b)}</li>`).join("\n");
}

function toSourcesLinks(items) {
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const key = `${it.source}|${it.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(it);
    }
  }
  return unique.slice(0, 4).map(it => {
    const label = it.source || "source";
    const title = htmlEscape(truncate(it.title, 100));
    const href = htmlEscape(it.link);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
  }).join(" ");
}

function renderAboutPage() {
  const { human } = isoAndHumanDate();
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>About · Today’s 2-Minute UK AI Brief</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:0;background:#0b0c10;color:#e5e7eb}
    main{max-width:760px;margin:48px auto;padding:0 16px}
    a{color:#93c5fd}
    h1{font-size:1.6rem;margin:0 0 12px}
    p{margin:0 0 12px}
    ul{padding-left:20px}
    nav{margin-bottom:16px}
  </style>
</head>
<body>
  <main>
    <nav><a href="/">← Back to today</a> · <a href="/archive/">Archive</a></nav>
    <h1>About this page</h1>
    <p>This site publishes a concise, UK-focused daily brief on AI. It aggregates public RSS feeds (e.g., DSIT, NCSC, ICO, CMA, UKRI, BBC, The Register, Reuters) and asks an AI model to draft a short summary strictly from the feed titles/snippets.</p>
    <ul>
      <li><strong>Update cadence:</strong> daily (typically morning UK time).</li>
      <li><strong>Scope:</strong> UK policy, regulators, public sector guidance, research funding, UK companies; plus global AI news with clear UK implications.</li>
      <li><strong>Limitations:</strong> We avoid speculation and keep to information present in sources. If items conflict, we note uncertainty.</li>
      <li><strong>Attribution:</strong> Source links appear on the page; click to read originals.</li>
      <li><strong>Privacy:</strong> No tracking; static HTML.</li>
    </ul>
    <p style="opacity:.7">Last generated: ${human}</p>
  </main>
</body>
</html>`;
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

// --- Main --------------------------------------------------------------------

async function main() {
  log("Start generate");

  const seen = await loadSeen();

  // Collect items with freshness, widening if needed
  let items = await collectItemsWithFreshness(FEEDS, seen, FRESH_HOURS_PRIMARY);
  let freshnessUsed = FRESH_HOURS_PRIMARY;

  const distinct = new Set(items.map(i => i.source));
  if (items.length < 3 || distinct.size < MIN_DISTINCT_HOSTS) {
    for (const h of FRESH_HOURS_FALLBACKS) {
      const attempt = await collectItemsWithFreshness(FEEDS, seen, h);
      const d2 = new Set(attempt.map(i => i.source));
      if (attempt.length >= 3 && d2.size >= Math.min(MIN_DISTINCT_HOSTS, attempt.length)) {
        items = attempt;
        freshnessUsed = h;
        break;
      }
    }
  }

  if (items.length === 0) {
    throw new Error("No fresh sources found. Try expanding feeds or widening the window.");
  }

  items = items.slice(0, MAX_ITEMS);

  // Build prompt & call model
  const prompt = buildPrompt(items);
  log("Calling OpenAI with", items.length, "items");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: "You write precise, sourced news briefs." },
      { role: "user", content: prompt },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error("Empty response from model");

  const { oneLiner, bullets, explainer, tags } = parseModelOutput(raw);

  // Sanitize explainer & append note if window > 24h
  let explainerText = explainer;
  if (freshnessUsed > FRESH_HOURS_PRIMARY) {
    explainerText += `\n\n_(Note: One or more sources may be older than ${FRESH_HOURS_PRIMARY} hours due to limited fresh coverage.)_`;
  }
  const explainerHtml = sanitizeHtml(explainerText, {
    allowedTags: ["p", "em", "strong", "ul", "ol", "li", "a", "br"],
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
  });

  const tpl = await fs.readFile(INDEX_TEMPLATE, "utf8");
  const { iso, human } = isoAndHumanDate();

  const TLDR = `TL;DR — ${htmlEscape(oneLiner)}`;
  const html = tpl
    .replace("{{ISO_DATE}}", iso)
    .replace("{{HUMAN_DATE}}", human)
    .replace("{{ONE_LINER}}", TLDR)
    .replace("{{WHY_IT_MATTERS_LIST}}", toHtmlList(bullets))
    .replace("{{EXPLAINER_HTML}}", explainerHtml)
    .replace("{{SOURCES_LINKS}}", toSourcesLinks(items))
    .replace("{{TAGS}}", tags.map((t) => `<span class="tag">${htmlEscape(t)}</span>`).join(" "));

  await writeFileAtomic(INDEX_OUT, html);

  // Update seen cache
  for (const it of items) {
    seen.links.add(it.link);
    const t = normalizeTitle(it.title || "");
    if (t) seen.titles.add(t);
  }
  await saveSeen(seen);

  // Archive + index
  const ymd = todayYMD();
  const dailyPath = path.join(ARCHIVE_DIR, `${ymd}.html`);
  await writeFileAtomic(dailyPath, html);

  const files = await fs.readdir(ARCHIVE_DIR).catch(() => []);
  const dated = files.filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();

  const archiveIndex = `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>Archive · Today’s 2-Minute UK AI Brief</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:0;background:#0b0c10;color:#e5e7eb}
    main{max-width:760px;margin:48px auto;padding:0 16px}
    a{color:#93c5fd}
    h1{font-size:1.6rem;margin:0 0 12px}
    ul{padding-left:20px}
    nav{margin-bottom:16px}
  </style>
</head>
<body>
  <main>
    <nav><a href="/">← Back to today</a> · <a href="/about.html">About</a></nav>
    <h1>Archive</h1>
    <ul>
      ${dated.map(f => {
        const label = f.replace(".html",""); // YYYY-MM-DD
        return `<li><a href="/archive/${f}">${label}</a></li>`;
      }).join("\n")}
    </ul>
  </main>
</body>
</html>`;
  await writeFileAtomic(path.join(ARCHIVE_DIR, "index.html"), archiveIndex);

  // About
  const aboutHtml = renderAboutPage();
  await writeFileAtomic(ABOUT_OUT, aboutHtml);

  log(
    `Generated index + archive (${ymd}) + about (freshness <=${freshnessUsed}h; hosts: ${Array.from(new Set(items.map(i=>i.source))).join(", ")})`
  );
}

// Clean exit to avoid lingering handles
main()
  .then(() => {
    log("Done; exiting cleanly.");
    process.exit(0);
  })
  .catch((err) => {
    logError(err);
    process.exit(1);
  });
