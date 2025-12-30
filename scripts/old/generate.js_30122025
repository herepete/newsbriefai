// scripts/generate.js
// Generates:
// - public/index.html (today's brief with tabs; defaults to UK tab)
// - public/archive/YYYY-MM-DD.html (dated snapshot)
// - public/archive/index.html (archive listing)
// - public/about.html (static explanation page)
// - public/changelog.html (static change history page from data/changelog.json)
// - public/data/tabs.json (structured outputs for future use)
//
// Keeps per-tab seen-items caches to avoid repeats.
// Uses primary + secondary feed pools (secondary used only if needed).
// If secondary feeds are used, the page shows a small note.
// Also de-dupes stories across tabs (priority order: Security → Ethics → Global → UK → Business → Work).
//
// Runtime hardening:
// - IPv4-first DNS
// - disables keep-alive to prevent lingering sockets
// - structured logging to generate.log

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

const LOG_LEVEL = (process.env.GENERATE_LOG_LEVEL || "info").toLowerCase();
const MODEL_OUTPUT_LOGGING = String(process.env.MODEL_OUTPUT_LOGGING || "false").toLowerCase() === "true";

function jlog(level, event, data = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const cur = levels[LOG_LEVEL] ?? 20;
  const lvl = levels[level] ?? 20;
  if (lvl < cur) return;
  console.log(JSON.stringify({ ts: ts(), level, event, ...data }));
}

// --- Config ------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error(`[${ts()}] Missing OPENAI_API_KEY (export it or set in CI secrets)`);
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const rss = new RSSParser({
  timeout: 15000,
  headers: { "user-agent": "newsbriefai/1.5" },
  requestOptions: { agent: httpsNoKeepAliveV4 },
});

// Freshness & selection (kept from your approach)
const FRESH_HOURS_PRIMARY = 24;
const FRESH_HOURS_FALLBACKS = [36, 48];
const MAX_ITEMS = 6;
const MIN_DISTINCT_HOSTS = 3;

// Output labels
const SITE_TITLE = "Today’s 2-Minute AI Brief";
const ONE_LINER_PREFIX = "In brief — ";

// State & output paths
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

// Seen caches (keep existing seen.json for UK)
const SEEN_PATHS = {
  uk: path.join(STATE_DIR, "seen.json"),
  business: path.join(STATE_DIR, "seen.business.json"),
  work: path.join(STATE_DIR, "seen.work.json"),
  global: path.join(STATE_DIR, "seen.global.json"),
  security: path.join(STATE_DIR, "seen.security.json"),
  ethics: path.join(STATE_DIR, "seen.ethics.json"),
};

// Changelog source file
const CHANGELOG_JSON = path.join(STATE_DIR, "changelog.json");

// --- Feed groups -------------------------------------------------------------
// Primary feeds are “high signal”. Secondary feeds are used only if needed.

// UK (Primary = UK public sector/regulators + UK AI-ish blogs; Secondary = broad UK tech)
const FEEDS_UK_PRIMARY = [
  "https://www.gov.uk/government/organisations/department-for-science-innovation-and-technology.atom",
  "https://www.gov.uk/government/organisations/competition-and-markets-authority.atom",
  "https://www.ukri.org/news/feed/",
  "https://cddo.blog.gov.uk/category/ai/feed/",
  "https://gds.blog.gov.uk/category/gov-uk/feed/",
  "https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml",
];

const FEEDS_UK_SECONDARY = [
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.theregister.com/headlines.atom",
  "https://www.theguardian.com/uk/technology/rss",
];

// AI & Business
const FEEDS_BUSINESS_PRIMARY = [
  "https://www.zdnet.com/topic/artificial-intelligence/rss.xml",
  "https://www.infoworld.com/category/artificial-intelligence/index.rss",
  "https://www.theregister.com/software/ai_ml/headlines.atom",
];

const FEEDS_BUSINESS_SECONDARY = [
  "https://techcrunch.com/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://www.engadget.com/rss.xml",
];

// AI & Work
const FEEDS_WORK_PRIMARY = [
  // NOTE: Workspace Updates sometimes triggers http link parsing issues; keep it in secondary.
  "https://www.theverge.com/rss/index.xml",
  "https://www.engadget.com/rss.xml",
];

const FEEDS_WORK_SECONDARY = [
  "https://workspaceupdates.googleblog.com/atom.xml",
  "https://www.fastcompany.com/technology/rss",
  "https://www.theguardian.com/technology/rss",
];

// Global AI (Primary = arXiv + major tech press; Secondary = broader tech press)
const FEEDS_GLOBAL_PRIMARY = [
  "https://export.arxiv.org/rss/cs.AI",
  "https://export.arxiv.org/rss/cs.LG",
  "https://www.technologyreview.com/feed/",
];

const FEEDS_GLOBAL_SECONDARY = [
  "https://www.theverge.com/rss/index.xml",
  "https://www.engadget.com/rss.xml",
  "https://www.theregister.com/headlines.atom",
  "https://www.theguardian.com/technology/rss",
];

// AI Security
const FEEDS_SECURITY_PRIMARY = [
  "https://www.ncsc.gov.uk/api/1/services/v1/news-rss-feed.xml",
  "https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml",
  "https://www.theregister.com/security/headlines.atom",
];

const FEEDS_SECURITY_SECONDARY = [
  "https://www.theguardian.com/technology/rss",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
];

// Ethics & Policy
const FEEDS_ETHICS_PRIMARY = [
  "https://www.gov.uk/government/organisations/department-for-science-innovation-and-technology.atom",
  "https://www.gov.uk/government/organisations/competition-and-markets-authority.atom",
  "https://www.theguardian.com/uk/technology/rss",
];

const FEEDS_ETHICS_SECONDARY = [
  "https://www.theguardian.com/technology/rss",
  "https://www.technologyreview.com/feed/",
];

// Tab metadata (UI + prompt intent)
const TABS = [
  // Priority order for cross-tab de-dupe
  { key: "security", label: "AI Security", primary: FEEDS_SECURITY_PRIMARY, secondary: FEEDS_SECURITY_SECONDARY },
  { key: "ethics", label: "Ethics & Policy", primary: FEEDS_ETHICS_PRIMARY, secondary: FEEDS_ETHICS_SECONDARY },
  { key: "global", label: "Global AI", primary: FEEDS_GLOBAL_PRIMARY, secondary: FEEDS_GLOBAL_SECONDARY },
  { key: "uk", label: "UK AI", primary: FEEDS_UK_PRIMARY, secondary: FEEDS_UK_SECONDARY },
  { key: "business", label: "AI & Business", primary: FEEDS_BUSINESS_PRIMARY, secondary: FEEDS_BUSINESS_SECONDARY },
  { key: "work", label: "AI & Work", primary: FEEDS_WORK_PRIMARY, secondary: FEEDS_WORK_SECONDARY },
];

const TAB_DESC = {
  uk: "UK AI — A daily summary of AI news most relevant to the UK.",
  business: "AI & Business — Adoption, governance, monetisation, and real-world deployments.",
  work: "AI & Work — Productivity tools, workflow changes, and practical workplace usage.",
  global: "Global AI — Models, research, major releases, and big platform shifts worldwide.",
  security: "AI Security — Misuse, attacks, safeguards, auditing, and defensive practices.",
  ethics: "Ethics & Policy — Regulation, governance, rights, safety debates, and oversight.",
};

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
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function normalizeTitle(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeKey(s = "") {
  return normalizeTitle(String(s || "")).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isFresh(dateObj, maxHours) {
  if (!dateObj || isNaN(dateObj.getTime())) return false;
  const ageMs = Date.now() - dateObj.getTime();
  return ageMs >= 0 && ageMs <= maxHours * 3600 * 1000;
}

function ageHours(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return null;
  return Math.round(((Date.now() - dateObj.getTime()) / 3600000) * 10) / 10;
}

// A “loose but useful” AI relevance check.
// Used only when a tab is otherwise empty — it can be relaxed.
function isAIish(item) {
  const h = `${item.source} ${item.title} ${item.snippet}`.toLowerCase();
  return /(ai|artificial intelligence|machine learning|ml|llm|large language|chatgpt|openai|anthropic|gemini|copilot|deepmind|model|inference|fine[-\s]?tune|prompt|agentic|agents|safety|alignment|hallucinat|dataset|training|neural|generative|diffusion)/i.test(h);
}

// Scoring nudges (light touch)
function scoreUK(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(^|\W)(uk|u\.k\.|united kingdom|britain|british|london|cma|ico|ncsc|dsit|ukri|ofcom|gov\.uk|govuk)(\W|$)/i.test(h) ? 2 : 0;
}
function scoreBusiness(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(enterprise|company|companies|rollout|deployment|adoption|governance|roi|procurement|pricing|monetis|monetiz|product|customers|compliance|contact centre|crm|erp|hcm|scm|supply chain|cost|revenue|subscription)/i.test(h) ? 2 : 0;
}
function scoreWork(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(productivity|copilot|assistant|workflow|automation|meeting|notes|email|docs|spreadsheets|slides|calendar|teams|slack|notion|jira|confluence|chrome extension|knowledge base)/i.test(h) ? 2 : 0;
}
function scoreSecurity(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(security|vulnerability|exploit|malware|phishing|prompt injection|jailbreak|exfiltrat|data leak|red team|audit|abuse|misuse|fraud|deepfake|policy bypass|supply chain attack|adversarial)/i.test(h) ? 2 : 0;
}
function scoreEthics(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(ethic|policy|regulat|governance|rights|privacy|copyright|ip |intellectual property|bias|fairness|transparen|accountab|safety|oversight|legislation|ai act|cma|ico|ofcom|standards)/i.test(h) ? 2 : 0;
}
function scoreGlobal(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(model|release|launch|benchmark|arxiv|paper|preprint|dataset|training|inference|open source|weights|parameter|gemini|gpt|claude|llama|mistral|deepmind|anthropic|openai)/i.test(h) ? 1 : 0;
}

function scoreForTab(tabKey) {
  switch (tabKey) {
    case "uk": return scoreUK;
    case "business": return scoreBusiness;
    case "work": return scoreWork;
    case "security": return scoreSecurity;
    case "ethics": return scoreEthics;
    case "global": return scoreGlobal;
    default: return () => 0;
  }
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

// Feed error aggregation for end-of-run summary
const FEED_ERROR_COUNTS = new Map(); // url -> {count, lastMessage}
function noteFeedError(url, message) {
  const cur = FEED_ERROR_COUNTS.get(url) || { count: 0, lastMessage: "" };
  cur.count += 1;
  cur.lastMessage = message || cur.lastMessage;
  FEED_ERROR_COUNTS.set(url, cur);
}

// Pull items from feeds (with seen + freshness); returns raw candidates (not yet picked)
async function collectCandidates({ feeds, seen, maxHours, tabKey }) {
  const candidates = [];
  const scoreFn = scoreForTab(tabKey);

  for (const url of feeds) {
    try {
      const feed = await rss.parseURL(url);
      for (const it of feed.items || []) {
        const link = it.link || it.guid;
        if (!link) continue;

        const dateStr = it.isoDate || it.pubDate || it.pubdate || null;
        const publishedAt = dateStr ? new Date(dateStr) : null;
        if (maxHours && !isFresh(publishedAt, maxHours)) continue;

        const title = (it.title || "").trim();
        const titleNorm = normalizeTitle(title);
        if (seen.links.has(link) || (titleNorm && seen.titles.has(titleNorm))) continue;

        const source = safeHostname(link);
        const snippet = (it.contentSnippet || it.summary || it.content || "")
          .replace(/\s+/g, " ")
          .trim();

        const item = {
          title,
          link,
          source,
          snippet,
          publishedAt,
        };
        item._score = scoreFn ? scoreFn(item) : 0;
        item._aiish = isAIish(item);
        candidates.push(item);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      jlog("warn", "rss_error", { tab: tabKey, url, message: msg });
      noteFeedError(url, msg);
    }
  }

  // De-dupe by link
  const seenLinks = new Set();
  const unique = [];
  for (const it of candidates) {
    if (!seenLinks.has(it.link)) {
      seenLinks.add(it.link);
      unique.push(it);
    }
  }

  // Sort: score desc, then newest
  unique.sort((a, b) => {
    const sDelta = (b._score || 0) - (a._score || 0);
    if (sDelta !== 0) return sDelta;
    const at = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bt = b.publishedAt ? b.publishedAt.getTime() : 0;
    return bt - at;
  });

  return unique;
}

function spreadAcrossHosts(items, maxItems) {
  const byHost = new Map();
  for (const it of items) {
    if (!byHost.has(it.source)) byHost.set(it.source, []);
    byHost.get(it.source).push(it);
  }
  const picks = [];
  while (picks.length < maxItems) {
    let added = false;
    for (const arr of byHost.values()) {
      if (arr.length && picks.length < maxItems) {
        picks.push(arr.shift());
        added = true;
      }
    }
    if (!added) break;
  }
  return picks;
}

function makeCrossTabKey(item) {
  // Prefer link host+path; otherwise title
  try {
    const u = new URL(item.link);
    const host = u.hostname.replace(/^www\./, "");
    const pathPart = (u.pathname || "").replace(/\/+$/, "");
    return `${host}${pathPart}`.toLowerCase();
  } catch {
    return `title:${normalizeKey(item.title)}`;
  }
}

function sanitizeExplainer(explainerText) {
  return sanitizeHtml(explainerText, {
    allowedTags: ["p", "em", "strong", "ul", "ol", "li", "a", "br"],
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

// --- Prompts -----------------------------------------------------------------

function buildPromptForTab(tabKey, items) {
  const sourcesBlock = items.map((it, i) =>
    `(${i + 1}) [${it.source}] ${it.title}\nURL: ${it.link}\nSnippet: ${truncate(it.snippet, 600)}`
  ).join("\n\n");

  const intentMap = {
    uk: "AI news relevant to the UK (policy, regulators, public sector, research, UK companies, and UK implications).",
    business: "AI & Business (how organisations adopt/monetise AI, governance, compliance, ROI, product updates for enterprises).",
    work: "AI & Work (productivity tools, workflow changes, workplace usage, practical day-to-day improvements).",
    global: "Global AI (new models, research, major releases, significant platform shifts).",
    security: "AI Security (misuse, attacks, vulnerabilities, safeguards, audits, red-teaming, defensive techniques).",
    ethics: "Ethics & Policy (regulation, governance, rights, privacy, bias/fairness, safety and oversight; copyright/economy impacts).",
  };

  const intent = intentMap[tabKey] || "AI news";

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
4) TAGS: comma-separated lowercase tags (3–6)

RULES:
- Use ONLY facts supported by the provided snippets/titles; do not speculate.
- If a story is only loosely related, be explicit about uncertainty and keep it short.
- No quotes longer than 20 words.
- No images.
- End with nothing else.`;
}

// Robust parser even if model deviates
function parseModelOutput(text) {
  const oneMatch = text.match(/ONE[_\s-]*SENTENCE:\s*(.+)/i);
  let oneLiner = (oneMatch && oneMatch[1] ? oneMatch[1] : "").trim();
  if (!oneLiner) {
    oneLiner = (text.split("\n").map(s => s.trim()).find(s => s && !/^(\d\)|why|explainer|tags|tl;dr|in brief)/i.test(s)) || "").trim();
  }
  if (/^tl;?dr[:\s-]/i.test(oneLiner)) {
    oneLiner = oneLiner.replace(/^tl;?dr[:\s-]\s*/i, "");
  }
  if (/^in brief[:\s-]/i.test(oneLiner)) {
    oneLiner = oneLiner.replace(/^in brief[:\s-]\s*/i, "");
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
  return (bullets || []).map((b) => `<li>${htmlEscape(b)}</li>`).join("\n");
}

function toSourcesLinks(items) {
  const seen = new Set();
  const unique = [];
  for (const it of items || []) {
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

// --- Tabs UI (Option 1: description under tabs) ------------------------------

function tabsNavHtml() {
  return `
<div class="tabs-wrap">
  <div class="tabs" role="tablist" aria-label="Brief tabs">
    <button class="tab is-active" role="tab" aria-selected="true" data-tab="uk">UK AI</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="business">AI &amp; Business</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="work">AI &amp; Work</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="global">Global AI</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="security">AI Security</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="ethics">Ethics &amp; Policy</button>
  </div>
  <p class="tab-desc" id="tabDesc">${htmlEscape(TAB_DESC.uk)}</p>
  <p class="tab-note" id="tabNote" hidden></p>
</div>
`.trim();
}

function tabsAssetsHtml() {
  return `
<style>
  .tabs{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 6px}
  .tab{appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;padding:6px 2px;cursor:pointer}
  .tab:hover{color:var(--fg)}
  .tab.is-active{color:var(--fg);border-bottom:2px solid var(--fg)}
  .tab-desc{margin:0 0 6px;color:var(--muted);font-size:.95rem;line-height:1.4}
  .tab-note{margin:0 0 10px;color:var(--muted);font-size:.9rem;opacity:.85}
</style>

<script>
(function(){
  var TAB_DESC = ${JSON.stringify(TAB_DESC)};
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

    var descEl = document.getElementById('tabDesc');
    if(descEl) descEl.textContent = TAB_DESC[next] || "";

    // optional note line per panel
    var noteEl = document.getElementById('tabNote');
    var panel = document.querySelector('.brief-panel[data-tab="'+next+'"]');
    var note = panel ? panel.getAttribute('data-note') : "";
    if(noteEl){
      if(note){
        noteEl.textContent = note;
        noteEl.hidden = false;
      }else{
        noteEl.textContent = "";
        noteEl.hidden = true;
      }
    }
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

function renderPanelHtml({ tabKey, oneLiner, bullets, explainerHtml, sourcesLinks, tagsHtml, noteText }) {
  const hiddenAttrs = tabKey === "uk" ? "" : ' hidden aria-hidden="true"';
  const noteAttr = noteText ? ` data-note="${htmlEscape(noteText)}"` : "";
  return `
<section class="brief-panel" data-tab="${htmlEscape(tabKey)}"${noteAttr}${hiddenAttrs}>
  <section class="card">
    <p class="tldr">${htmlEscape(ONE_LINER_PREFIX)}${htmlEscape(oneLiner)}</p>

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

// --- Pages -------------------------------------------------------------------

function renderAboutPage() {
  const { human } = isoAndHumanDate();
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>About · ${SITE_TITLE}</title>
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
    <h1>About this site</h1>
    <p>This site publishes concise daily AI briefs from public RSS/Atom feeds and asks an AI model to draft short summaries strictly from feed titles/snippets.</p>
    <ul>
      <li><strong>Update cadence:</strong> daily (typically morning UK time).</li>
      <li><strong>Tabs:</strong> UK AI, AI &amp; Business, AI &amp; Work, Global AI, AI Security, Ethics &amp; Policy.</li>
      <li><strong>Attribution:</strong> Source links appear on each tab; click to read originals.</li>
      <li><strong>Limitations:</strong> Summaries only reflect what appears in the feed titles/snippets. If coverage is thin, we may broaden sources and note it.</li>
      <li><strong>Privacy:</strong> No tracking; static HTML.</li>
    </ul>
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
  <title>Changelog · ${SITE_TITLE}</title>
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

// --- Selection strategy ------------------------------------------------------
//
// Order per your preference:
// A) If insufficient items, try SECONDARY feeds (same freshness window)
// B) If still insufficient, widen time window (36/48), again trying primary then primary+secondary.
//
// Also:
// - Cross-tab de-dupe: skip stories already used by higher priority tabs.
// - “AI-ish” filter: applied first, but relaxed automatically if it would cause “no update”.

function meetsMinimum(items) {
  const distinct = new Set((items || []).map(i => i.source));
  return (items || []).length >= 3 && distinct.size >= Math.min(MIN_DISTINCT_HOSTS, (items || []).length);
}

function buildFallbackPanel(tabKey, reason) {
  return {
    tabKey,
    items: [],
    freshnessUsed: null,
    usedSecondary: false,
    relaxedAI: false,
    oneLiner: `${TAB_DESC[tabKey]?.split("—")[0]?.trim() || "This tab"} has no update today.`,
    bullets: [
      "Coverage may be thin within the current freshness window.",
      "We’ll retry with broader sources on the next run.",
      "Use the source links on other tabs for nearby context.",
    ],
    explainerHtml: sanitizeExplainer(
      `No suitable items were found for this tab in the current run.\n\n_(Reason: ${reason})_`
    ),
    tags: ["no-update"],
    noteText: "",
    failed: true,
  };
}

// Pick items from candidates with: (optional) AI-ish requirement, cross-tab de-dupe, host spread.
function pickItems({ candidates, avoidKeys, requireAI }) {
  const filtered = [];
  for (const it of candidates) {
    const key = makeCrossTabKey(it);
    const dupe = avoidKeys.has(key) || avoidKeys.has(`title:${normalizeKey(it.title)}`);
    if (dupe) continue;

    if (requireAI && !it._aiish) continue;

    filtered.push(it);
  }

  // Spread across hosts
  const picks = spreadAcrossHosts(filtered, MAX_ITEMS);

  return picks;
}

async function generateOneTab({ tabKey, primaryFeeds, secondaryFeeds, avoidKeys }) {
  const seenPath = SEEN_PATHS[tabKey];
  const seen = await loadSeenFrom(seenPath);

  const planSteps = [];
  // 24h: primary, then primary+secondary
  planSteps.push({ hours: FRESH_HOURS_PRIMARY, feeds: primaryFeeds, usedSecondary: false });
  planSteps.push({ hours: FRESH_HOURS_PRIMARY, feeds: [...primaryFeeds, ...secondaryFeeds], usedSecondary: true });
  // 36/48: primary, then primary+secondary
  for (const h of FRESH_HOURS_FALLBACKS) {
    planSteps.push({ hours: h, feeds: primaryFeeds, usedSecondary: false });
    planSteps.push({ hours: h, feeds: [...primaryFeeds, ...secondaryFeeds], usedSecondary: true });
  }

  let best = null;
  let bestMeta = null;

  for (const step of planSteps) {
    const candidates = await collectCandidates({ feeds: step.feeds, seen, maxHours: step.hours, tabKey });

    // Attempt 1: require AI-ish
    let picks = pickItems({ candidates, avoidKeys, requireAI: true });
    let relaxedAI = false;

    // If AI-ish is too strict, relax to “best available”
    if (picks.length < 3) {
      const relaxed = pickItems({ candidates, avoidKeys, requireAI: false });
      if (relaxed.length > picks.length) {
        picks = relaxed;
        relaxedAI = true;
      }
    }

    const meta = { freshnessUsed: step.hours, usedSecondary: step.usedSecondary, relaxedAI };

    if (!best || (picks.length > (best.length || 0))) {
      best = picks;
      bestMeta = meta;
    }

    // If we meet the minimum, stop early
    if (meetsMinimum(picks)) {
      best = picks;
      bestMeta = meta;
      break;
    }
  }

  const picks = best || [];
  const meta = bestMeta || { freshnessUsed: FRESH_HOURS_PRIMARY, usedSecondary: false, relaxedAI: false };

  // Log selection detail
  jlog("info", "tab_selection", {
    tab: tabKey,
    freshnessUsed: meta.freshnessUsed,
    usedSecondary: meta.usedSecondary,
    relaxedAI: meta.relaxedAI,
    picked: picks.map(it => ({
      source: it.source,
      title: it.title,
      age_hours: ageHours(it.publishedAt),
      score: it._score || 0,
      aiish: !!it._aiish,
    })),
  });

  if (picks.length === 0) {
    throw new Error(`[${tabKey}] No fresh sources found. Try expanding feeds or widening the window.`);
  }

  // Build prompt & call model
  const prompt = buildPromptForTab(tabKey, picks);
  log(`[${tabKey}] Calling OpenAI with`, picks.length, "items");

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

  if (MODEL_OUTPUT_LOGGING) {
    jlog("debug", "model_output", { tab: tabKey, text: raw.slice(0, 4000) });
  }

  const { oneLiner, bullets, explainer, tags } = parseModelOutput(raw);

  let explainerText = explainer;
  if (meta.freshnessUsed > FRESH_HOURS_PRIMARY) {
    explainerText += `\n\n_(Note: Some sources may be older than ${FRESH_HOURS_PRIMARY} hours due to limited fresh coverage.)_`;
  }

  const noteBits = [];
  if (meta.usedSecondary) noteBits.push("Wider sources used today due to limited fresh coverage.");
  if (meta.relaxedAI) noteBits.push("Some items may be only loosely AI-related due to limited matching items.");
  const noteText = noteBits.length ? noteBits.join(" ") : "";

  const explainerHtml = sanitizeExplainer(explainerText);

  // Update seen cache
  for (const it of picks) {
    seen.links.add(it.link);
    const t = normalizeTitle(it.title || "");
    if (t) seen.titles.add(t);
  }
  await saveSeenTo(seenPath, seen);

  return {
    tabKey,
    items: picks,
    freshnessUsed: meta.freshnessUsed,
    usedSecondary: meta.usedSecondary,
    relaxedAI: meta.relaxedAI,
    oneLiner,
    bullets,
    explainerHtml,
    tags,
    noteText,
    failed: false,
  };
}

// --- Main --------------------------------------------------------------------

async function main() {
  const ymd = todayYMD();

  log("Start generate");
  jlog("info", "run_start", { ymd, log_level: LOG_LEVEL, model_output_logging: MODEL_OUTPUT_LOGGING });

  // Ensure output dirs exist
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  await fs.mkdir(DATA_OUT_DIR, { recursive: true });

  // Load template
  const tpl = await fs.readFile(INDEX_TEMPLATE, "utf8");
  const supportsTabs =
    tpl.includes("{{TABS_NAV}}") &&
    tpl.includes("{{TAB_PANELS}}") &&
    tpl.includes("{{TABS_ASSETS}}");

  if (!supportsTabs) {
    throw new Error("index.template.html must include {{TABS_NAV}}, {{TAB_PANELS}}, {{TABS_ASSETS}} placeholders.");
  }

  // Cross-tab de-dupe set (priority order = TABS array order)
  const avoidKeys = new Set();

  const results = [];
  for (const tab of TABS) {
    try {
      const res = await generateOneTab({
        tabKey: tab.key,
        primaryFeeds: tab.primary,
        secondaryFeeds: tab.secondary,
        avoidKeys,
      });

      // Add picked items into avoidKeys so later tabs don’t repeat the same stories
      for (const it of res.items) {
        avoidKeys.add(makeCrossTabKey(it));
        avoidKeys.add(`title:${normalizeKey(it.title)}`);
      }

      results.push(res);
    } catch (err) {
      const msg = err?.message || String(err);
      log(`[${tab.key}] Tab failed; using fallback panel:`, msg);
      jlog("warn", "tab_failed", { tab: tab.key, message: msg });
      results.push(buildFallbackPanel(tab.key, msg));
    }
  }

  const { iso, human } = isoAndHumanDate();

  // Build panels HTML (each is a .card so it matches current design)
  const panelsHtml = results.map(t => {
    const sourcesLinks = toSourcesLinks(t.items);
    const tagsHtml = (t.tags || []).map(tag => `<span class="tag">${htmlEscape(tag)}</span>`).join(" ");
    return renderPanelHtml({
      tabKey: t.tabKey,
      oneLiner: t.oneLiner,
      bullets: t.bullets,
      explainerHtml: t.explainerHtml,
      sourcesLinks,
      tagsHtml,
      noteText: t.noteText,
    });
  }).join("\n\n");

  // Final index html
  const html = tpl
    .replaceAll("Today’s 2-Minute UK AI Brief", SITE_TITLE) // helps if template still contains old title text
    .replace("{{ISO_DATE}}", iso)
    .replace("{{HUMAN_DATE}}", human)
    .replace("{{TABS_NAV}}", tabsNavHtml())
    .replace("{{TAB_PANELS}}", panelsHtml)
    .replace("{{TABS_ASSETS}}", tabsAssetsHtml());

  await writeFileAtomic(INDEX_OUT, html);

  // Archive snapshot
  await writeFileAtomic(path.join(ARCHIVE_DIR, `${ymd}.html`), html);

  // Archive index
  const files = await fs.readdir(ARCHIVE_DIR).catch(() => []);
  const dated = files.filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();

  const archiveIndex = `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>Archive · ${SITE_TITLE}</title>
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
        const label = f.replace(".html", "");
        return `<li><a href="/archive/${f}">${label}</a></li>`;
      }).join("\n")}
    </ul>
  </main>
</body>
</html>`;
  await writeFileAtomic(path.join(ARCHIVE_DIR, "index.html"), archiveIndex);

  // About + Changelog
  await writeFileAtomic(ABOUT_OUT, renderAboutPage());
  await writeFileAtomic(CHANGELOG_OUT, await renderChangelogPage());

  // Structured JSON (handy for debugging / future UI)
  const tabsJson = {
    generated_at_iso: iso,
    generated_at_human: human,
    title: SITE_TITLE,
    tabs: results.map(t => ({
      key: t.tabKey,
      label: (TABS.find(x => x.key === t.tabKey)?.label) || t.tabKey,
      freshnessUsed: t.freshnessUsed,
      usedSecondary: t.usedSecondary,
      relaxedAI: t.relaxedAI,
      failed: !!t.failed,
      noteText: t.noteText || "",
      oneLiner: t.oneLiner,
      bullets: t.bullets,
      tags: t.tags,
      sources: (t.items || []).map(it => ({
        title: it.title,
        link: it.link,
        source: it.source,
        publishedAt: it.publishedAt ? (it.publishedAt.toISOString?.() || null) : null,
        aiish: !!it._aiish,
        score: it._score || 0,
      })),
    })),
  };
  await writeFileAtomic(TABS_JSON_OUT, JSON.stringify(tabsJson, null, 2));

  // End-of-run summaries
  log(`Generated index + archive (${ymd}) + about + changelog`);
  for (const t of results) {
    const hosts = Array.from(new Set((t.items || []).map(i => i.source)));
    log(
      `[${t.tabKey}] freshness<=${t.freshnessUsed ?? "n/a"}h; hosts: ${hosts.length ? hosts.join(", ") : "none"}${t.failed ? " (FAILED)" : ""}`
    );
  }

  if (FEED_ERROR_COUNTS.size) {
    log("Feed errors summary:");
    for (const [url, meta] of FEED_ERROR_COUNTS.entries()) {
      log(` - ${url} (${meta.count}x) last: ${meta.lastMessage}`);
    }
  }

  jlog("info", "run_end", { ymd });
}

// Clean exit to avoid lingering handles
main()
  .then(() => {
    log("Done; exiting cleanly.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[${ts()}]`, err);
    process.exit(1);
  });

