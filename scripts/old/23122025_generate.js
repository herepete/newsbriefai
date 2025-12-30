// scripts/generate.js
// Generates:
// - public/index.html (today's brief with tabs; defaults to UK tab)
// - public/archive/YYYY-MM-DD.html (dated snapshot)
// - public/archive/index.html (archive listing)
// - public/about.html (static explanation page)
// - public/changelog.html (static change history page from data/changelog.json)
// - public/data/tabs.json (structured outputs for future use)
//
// Keeps seen-items caches to avoid repeats and prefers fresh items.
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
  headers: { "user-agent": "uk-ai-brief/1.3" },
  requestOptions: { agent: httpsNoKeepAliveV4 },
});

// Freshness & selection (kept from your current logic)
const FRESH_HOURS_PRIMARY = 24;
const FRESH_HOURS_FALLBACKS = [36, 48];
const MAX_ITEMS = 6;
const MIN_DISTINCT_HOSTS = 3;

// State & output
const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, "data");
const TPL_DIR = path.join(ROOT, "templates");
const OUT_DIR = path.join(ROOT, "public");

const INDEX_TEMPLATE = path.join(TPL_DIR, "index.template.html");
const INDEX_OUT = path.join(OUT_DIR, "index.html");
const ARCHIVE_DIR = path.join(OUT_DIR, "archive");
const ABOUT_OUT = path.join(OUT_DIR, "about.html");
const CHANGELOG_OUT = path.join(OUT_DIR, "changelog.html");
const DATA_OUT_DIR = path.join(OUT_DIR, "data");
const TABS_JSON_OUT = path.join(DATA_OUT_DIR, "tabs.json");

// Seen caches:
// - Keep existing seen.json for UK so you don't lose history
// - New files for other tabs
const SEEN_UK_PATH = path.join(STATE_DIR, "seen.json");
const SEEN_BUSINESS_PATH = path.join(STATE_DIR, "seen.business.json");
const SEEN_WORK_PATH = path.join(STATE_DIR, "seen.work.json");
const SEEN_GLOBAL_PATH = path.join(STATE_DIR, "seen.global.json");

// Changelog source file
const CHANGELOG_JSON = path.join(STATE_DIR, "changelog.json");

// --- Feed groups -------------------------------------------------------------
// UK tab uses your existing FEEDS unchanged.

const FEEDS_UK = [
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

// New tabs (RSS only; reliable mainstream sources)
const FEEDS_AI_BUSINESS = [
  "https://venturebeat.com/category/ai/feed/",
  "https://www.theregister.com/software/ai_ml/headlines.atom",
  "https://www.zdnet.com/topic/artificial-intelligence/rss.xml",
  "https://www.infoworld.com/category/artificial-intelligence/index.rss",
  "https://www.computerworld.com/index.rss",
  "https://techcrunch.com/feed/",
];

const FEEDS_AI_WORK = [
  "https://workspaceupdates.googleblog.com/atom.xml",
  "https://www.theverge.com/rss/index.xml",
  "https://www.engadget.com/rss.xml",
  "https://www.fastcompany.com/technology/rss",
  "https://www.theguardian.com/technology/rss",
  "https://techcrunch.com/feed/",
];

const FEEDS_GLOBAL_AI = [
  "https://openai.com/blog/rss/",
  "https://googleaiblog.blogspot.com/atom.xml",
  "https://www.technologyreview.com/feed/",
  "https://www.wired.com/feed/category/artificial-intelligence/latest/rss",
  "https://feeds.reuters.com/reuters/technologyNews?format=xml",
  "https://venturebeat.com/category/ai/feed/",
];

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
  return s.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function normalizeTitle(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isFresh(dateObj, maxHours) {
  if (!dateObj || isNaN(dateObj.getTime())) return false;
  const ageMs = Date.now() - dateObj.getTime();
  return ageMs >= 0 && ageMs <= maxHours * 3600 * 1000;
}

// Keep your UK scoring logic as-is
function scoreUK(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(^|\W)(uk|u\.k\.|united kingdom|britain|british|london|cma|ico|ncsc|dsit|ukri|ofcom|gov\.uk|govuk|turing institute)(\W|$)/i.test(h) ? 1 : 0;
}

// Light nudges for the new tabs (only impacts ordering)
function scoreBusiness(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(enterprise|company|companies|rollout|deployment|adoption|governance|roi|procurement|product|customers|regulation|compliance|contact centre|crm|erp|hcm|scm|supply chain|cost)/i.test(h) ? 1 : 0;
}
function scoreWork(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(productivity|copilot|assistant|workflow|automation|meeting|notes|email|docs|spreadsheets|slides|calendar|teams|slack|notion|jira|confluence|chrome extension)/i.test(h) ? 1 : 0;
}
function scoreGlobal(_it) {
  return 0;
}

async function loadSeenFrom(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const j = JSON.parse(raw);
    return {
      links: new Set(j.links || []),
      titles: new Set((j.titles || []).map(normalizeTitle)),
    };
  } catch {
    return { links: new Set(), titles: new Set() };
  }
}

async function saveSeenTo(statePath, seen) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const payload = {
    links: Array.from(seen.links),
    titles: Array.from(seen.titles),
    updated: new Date().toISOString(),
  };
  await fs.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

// Pull up to MAX_ITEMS respecting freshness and "seen".
async function collectItemsWithFreshness(feeds, seen, maxHours, scoreFn) {
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

        const source = safeHostname(link);
        const snippet = (it.contentSnippet || it.summary || it.content || "")
          .replace(/\s+/g, " ")
          .trim();

        const item = {
          title: (it.title || "").trim(),
          link,
          source,
          snippet,
          publishedAt,
        };

        item._score = scoreFn ? scoreFn(item) : 0;
        items.push(item);
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

  // Prefer score then newest first
  unique.sort((a, b) => {
    const sDelta = (b._score || 0) - (a._score || 0);
    if (sDelta !== 0) return sDelta;
    const at = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bt = b.publishedAt ? b.publishedAt.getTime() : 0;
    return bt - at;
  });

  // Spread across hosts to increase diversity (kept from your approach)
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

// Prompts
function buildPromptForTab(tabKey, items) {
  const sourcesBlock = items.map((it, i) =>
    `(${i + 1}) [${it.source}] ${it.title}\nURL: ${it.link}\nSnippet: ${truncate(it.snippet, 600)}`
  ).join("\n\n");

  if (tabKey === "uk") {
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

  const intent =
    tabKey === "business"
      ? "How companies are actually using AI this week (adoption, ROI signals, governance, real deployments)."
      : tabKey === "work"
      ? "Productivity tools gaining traction (workflows, copilots, time-savers, practical workplace usage)."
      : "Global AI (new models, major research, regulation, funding, big platform shifts).";

  return `You are a cautious news summariser.

CONTEXT:
We publish a daily 2-minute brief about: ${intent}

INPUT SOURCES (RSS titles + snippets only):
${sourcesBlock}

YOUR TASK:
- Produce a concise, neutral daily brief aligned to the context above.
- Output sections in this exact format:
1) ONE_SENTENCE: <a single factual sentence>
2) WHY_IT_MATTERS:
   - <bullet 1>
   - <bullet 2>
   - <bullet 3>
3) EXPLAINER (200–300 words, plain English)
4) TAGS: comma-separated lowercase tags (3–5)

RULES:
- Use ONLY facts supported by the provided snippets/titles; do not speculate.
- Acknowledge uncertainty if sources conflict.
- No quotes longer than 20 words.
- No images.
- End with nothing else.`;
}

// Robust parser even if model deviates (kept from your script)
function parseModelOutput(text) {
  const oneMatch = text.match(/ONE[_\s-]*SENTENCE:\s*(.+)/i);
  let oneLiner = (oneMatch && oneMatch[1] ? oneMatch[1] : "").trim();
  if (!oneLiner) {
    oneLiner = (text.split("\n").map(s => s.trim()).find(s => s && !/^(\d\)|why|explainer|tags|tl;dr)/i.test(s)) || "").trim();
  }
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

function sanitizeExplainer(explainerText) {
  // matches your existing sanitize policy
  return sanitizeHtml(explainerText, {
    allowedTags: ["p", "em", "strong", "ul", "ol", "li", "a", "br"],
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

// --- Tabs UI (Option 1: description under tabs) ------------------------------

function tabsNavHtml() {
  return `
<div class="tabs-wrap">
  <div class="tabs" role="tablist" aria-label="Brief tabs">
    <button class="tab is-active" role="tab" aria-selected="true" data-tab="uk">UK AI</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="business">AI &amp; Business</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="work">AI &amp; Work</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="global">Global AI</button>
  </div>
  <p class="tab-desc" id="tabDesc">UK AI brief — A daily summary of AI news most relevant to the UK.</p>
</div>
`.trim();
}

function tabsAssetsHtml() {
  // Uses your CSS variables so it fits the current look perfectly.
  return `
<style>
  .tabs{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 6px}
  .tab{appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;padding:6px 2px;cursor:pointer}
  .tab:hover{color:var(--fg)}
  .tab.is-active{color:var(--fg);border-bottom:2px solid var(--fg)}
  .tab-desc{margin:0 0 10px;color:var(--muted);font-size:.95rem;line-height:1.4}
</style>

<script>
(function(){
  var TAB_DESC = {
    uk: "UK AI brief — A daily summary of AI news most relevant to the UK.",
    business: "AI & Business — How companies are actually using AI this week (adoption, ROI, governance).",
    work: "AI & Work — Productivity tools gaining traction (workflows, copilots, practical use-cases).",
    global: "Global AI — New models, research, regulation, and big platform shifts worldwide."
  };

  function setTab(next){
    var tabs = document.querySelectorAll('.tab');
    var panels = document.querySelectorAll('.brief-panel');

    tabs.forEach(function(t){
      var active = t.getAttribute('data-tab') === next;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    panels.forEach(function(p){
      var match = p.getAttribute('data-tab') === next;
      if(match){
        p.removeAttribute('hidden');
        p.setAttribute('aria-hidden','false');
      }else{
        p.setAttribute('hidden','');
        p.setAttribute('aria-hidden','true');
      }
    });

    var el = document.getElementById('tabDesc');
    if(el) el.textContent = TAB_DESC[next] || "";
  }

  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if(!btn) return;
    setTab(btn.getAttribute('data-tab'));
  });

  // Always start on UK AI
  setTab('uk');
})();
</script>
`.trim();
}

// Panel rendering uses your existing classes (.card, .tldr, etc.)
function renderPanelHtml({ tabKey, oneLiner, bullets, explainerHtml, sourcesLinks, tagsHtml }) {
  const hiddenAttrs = tabKey === "uk" ? "" : ' hidden aria-hidden="true"';
  return `
<section class="brief-panel" data-tab="${htmlEscape(tabKey)}"${hiddenAttrs}>
  <section class="card">
    <p class="tldr">TL;DR — ${htmlEscape(oneLiner)}</p>

    <h2>Why it matters</h2>
    <ul>
      ${toHtmlList(bullets)}
    </ul>

    <h2>Explainer</h2>
    <div class="explainer">
      ${explainerHtml}
    </div>

    <p class="sources">Sources: ${sourcesLinks}</p>

    <div class="tags" aria-label="Tags">
      ${tagsHtml}
    </div>
  </section>
</section>
`.trim();
}

// Pages kept (about, archive). About now includes changelog link.
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
    <nav><a href="/">← Back to today</a> · <a href="/archive/">Archive</a> · <a href="/changelog.html">Changelog</a></nav>
    <h1>About this page</h1>
    <p>This site publishes concise daily AI briefs from public RSS/Atom feeds and asks an AI model to draft short summaries strictly from feed titles/snippets.</p>
    <ul>
      <li><strong>Update cadence:</strong> daily (typically morning UK time).</li>
      <li><strong>Tabs:</strong> UK AI, AI &amp; Business, AI &amp; Work, Global AI.</li>
      <li><strong>Limitations:</strong> We avoid speculation and keep to information present in sources. If items conflict, we note uncertainty.</li>
      <li><strong>Attribution:</strong> Source links appear on the page; click to read originals.</li>
      <li><strong>Privacy:</strong> No tracking; static HTML.</li>
    </ul>
    <p>You can connect with me on
      <a href="https://www.linkedin.com/in/peter-white-37112941/" target="_blank" rel="noopener">LinkedIn</a>.
    </p>
    <p style="opacity:.7">Last generated: ${human}</p>
  </main>
</body>
</html>`;
}

async function renderChangelogPage() {
  const { human } = isoAndHumanDate();
  let entries = [];
  try {
    const raw = await fs.readFile(CHANGELOG_JSON, "utf8");
    const j = JSON.parse(raw);
    entries = Array.isArray(j.entries) ? j.entries : [];
  } catch {
    entries = [];
  }

  entries.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const items = entries.map(e => {
    const date = htmlEscape(e.date || "");
    const type = htmlEscape(e.type || "");
    const title = htmlEscape(e.title || "");
    const detail = htmlEscape(e.detail || "");
    return `<li><strong>${date}</strong> — <em>${type}</em> — ${title}${detail ? ` <span style="opacity:.75">(${detail})</span>` : ""}</li>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>Changelog · Today’s 2-Minute UK AI Brief</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:0;background:#0b0c10;color:#e5e7eb}
    main{max-width:760px;margin:48px auto;padding:0 16px}
    a{color:#93c5fd}
    h1{font-size:1.6rem;margin:0 0 12px}
    nav{margin-bottom:16px}
    ul{padding-left:20px}
    li{margin-bottom:10px}
    code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <nav><a href="/">← Back to today</a> · <a href="/about.html">About</a> · <a href="/archive/">Archive</a></nav>
    <h1>Changelog</h1>
    ${entries.length ? `<ul>${items}</ul>` : `<p style="opacity:.8">No changelog entries yet. Create <code>data/changelog.json</code> to populate this page.</p>`}
    <p style="opacity:.7">Last generated: ${human}</p>
  </main>
</body>
</html>`;
}

// --- Tab generation ----------------------------------------------------------

async function generateOneTab({ tabKey, feeds, seenPath, scoreFn }) {
  const seen = await loadSeenFrom(seenPath);

  let items = await collectItemsWithFreshness(feeds, seen, FRESH_HOURS_PRIMARY, scoreFn);
  let freshnessUsed = FRESH_HOURS_PRIMARY;

  const distinct = new Set(items.map(i => i.source));
  if (items.length < 3 || distinct.size < MIN_DISTINCT_HOSTS) {
    for (const h of FRESH_HOURS_FALLBACKS) {
      const attempt = await collectItemsWithFreshness(feeds, seen, h, scoreFn);
      const d2 = new Set(attempt.map(i => i.source));
      if (attempt.length >= 3 && d2.size >= Math.min(MIN_DISTINCT_HOSTS, attempt.length)) {
        items = attempt;
        freshnessUsed = h;
        break;
      }
    }
  }

  if (items.length === 0) {
    throw new Error(`[${tabKey}] No fresh sources found. Try expanding feeds or widening the window.`);
  }

  items = items.slice(0, MAX_ITEMS);

  const prompt = buildPromptForTab(tabKey, items);
  log(`[${tabKey}] Calling OpenAI with`, items.length, "items");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: "You write precise, sourced news briefs." },
      { role: "user", content: prompt },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error(`[${tabKey}] Empty response from model`);

  const { oneLiner, bullets, explainer, tags } = parseModelOutput(raw);

  let explainerText = explainer;
  if (freshnessUsed > FRESH_HOURS_PRIMARY) {
    explainerText += `\n\n_(Note: One or more sources may be older than ${FRESH_HOURS_PRIMARY} hours due to limited fresh coverage.)_`;
  }

  const explainerHtml = sanitizeExplainer(explainerText);

  // Update seen cache
  for (const it of items) {
    seen.links.add(it.link);
    const t = normalizeTitle(it.title || "");
    if (t) seen.titles.add(t);
  }
  await saveSeenTo(seenPath, seen);

  return { tabKey, items, freshnessUsed, oneLiner, bullets, explainerHtml, tags };
}

// --- Main --------------------------------------------------------------------

async function main() {
  log("Start generate");

  // Generate tabs (UK first; default tab)
  const uk = await generateOneTab({ tabKey: "uk", feeds: FEEDS_UK, seenPath: SEEN_UK_PATH, scoreFn: scoreUK });
  const business = await generateOneTab({ tabKey: "business", feeds: FEEDS_AI_BUSINESS, seenPath: SEEN_BUSINESS_PATH, scoreFn: scoreBusiness });
  const work = await generateOneTab({ tabKey: "work", feeds: FEEDS_AI_WORK, seenPath: SEEN_WORK_PATH, scoreFn: scoreWork });
  const global = await generateOneTab({ tabKey: "global", feeds: FEEDS_GLOBAL_AI, seenPath: SEEN_GLOBAL_PATH, scoreFn: scoreGlobal });

  const tabs = [uk, business, work, global];

  // Load template
  const tpl = await fs.readFile(INDEX_TEMPLATE, "utf8");

  // Ensure template supports tabs placeholders
  const supportsTabs =
    tpl.includes("{{TABS_NAV}}") &&
    tpl.includes("{{TAB_PANELS}}") &&
    tpl.includes("{{TABS_ASSETS}}");

  if (!supportsTabs) {
    throw new Error("index.template.html must include {{TABS_NAV}}, {{TAB_PANELS}}, {{TABS_ASSETS}} placeholders.");
  }

  const { iso, human } = isoAndHumanDate();

  // Create panel HTML (each is a .card so it matches existing design)
  const panelsHtml = tabs.map(t => {
    const sourcesLinks = toSourcesLinks(t.items);
    const tagsHtml = (t.tags || []).map(tag => `<span class="tag">${htmlEscape(tag)}</span>`).join(" ");
    return renderPanelHtml({
      tabKey: t.tabKey,
      oneLiner: t.oneLiner,
      bullets: t.bullets,
      explainerHtml: t.explainerHtml,
      sourcesLinks,
      tagsHtml,
    });
  }).join("\n\n");

  // Final index html
  const html = tpl
    .replace("{{ISO_DATE}}", iso)
    .replace("{{HUMAN_DATE}}", human)
    .replace("{{TABS_NAV}}", tabsNavHtml())
    .replace("{{TAB_PANELS}}", panelsHtml)
    .replace("{{TABS_ASSETS}}", tabsAssetsHtml());

  await writeFileAtomic(INDEX_OUT, html);

  // Write structured JSON (optional but handy)
  await fs.mkdir(DATA_OUT_DIR, { recursive: true });
  const tabsJson = {
    generated_at_iso: iso,
    generated_at_human: human,
    tabs: tabs.map(t => ({
      key: t.tabKey,
      freshnessUsed: t.freshnessUsed,
      oneLiner: t.oneLiner,
      bullets: t.bullets,
      tags: t.tags,
      sources: t.items.map(it => ({
        title: it.title,
        link: it.link,
        source: it.source,
        publishedAt: it.publishedAt ? it.publishedAt.toISOString?.() : null,
      })),
    })),
  };
  await writeFileAtomic(TABS_JSON_OUT, JSON.stringify(tabsJson, null, 2));

  // Archive snapshot (kept)
  const ymd = todayYMD();
  await writeFileAtomic(path.join(ARCHIVE_DIR, `${ymd}.html`), html);

  // Archive index (kept; now includes changelog link)
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
    <nav><a href="/">← Back to today</a> · <a href="/about.html">About</a> · <a href="/changelog.html">Changelog</a></nav>
    <h1>Archive</h1>
    <ul>
      ${dated.map(f => {
        const label = f.replace(".html","");
        return `<li><a href="/archive/${f}">${label}</a></li>`;
      }).join("\n")}
    </ul>
  </main>
</body>
</html>`;
  await writeFileAtomic(path.join(ARCHIVE_DIR, "index.html"), archiveIndex);

  // About (kept; updated nav)
  await writeFileAtomic(ABOUT_OUT, renderAboutPage());

  // Changelog (new)
  await writeFileAtomic(CHANGELOG_OUT, await renderChangelogPage());

  log(`Generated index + archive (${ymd}) + about + changelog`);
  for (const t of tabs) {
    log(`[${t.tabKey}] freshness<=${t.freshnessUsed}h; hosts: ${Array.from(new Set(t.items.map(i => i.source))).join(", ")}`);
  }
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

