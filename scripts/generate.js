// scripts/generate.js
// Full generator (ESM) with metrics patch integrated.
// Outputs:
// - public/index.html
// - public/archive/YYYY-MM-DD.html
// - public/archive/index.html
// - public/about.html
// - public/changelog.html (from data/changelog.json)
// - public/data/tabs.json
// - public/data/metrics/metrics-YYYY-MM-DD.json + public/data/metrics-latest.json (via MetricsCollector)
//
// Notes:
// - Uses primary + secondary feed pools
// - Widen freshness window only when needed (24h -> 36h -> 48h)
// - Cross-tab de-dupe (priority: Security → Ethics → Global → UK → Business → Work → Today in Tech)
// - JSON structured logs
// - MetricsCollector API wiring FIXED: recordTabSummary now receives picked[] items
// - NEW: "Today in Tech" tab (model-assisted exact-date history, up to 3 items) with sources
// - NEW: Sources rendered on page are filtered to "display-worthy":
//        show if aiStrict===true OR offTopic===false (prevents rogue shopping/review links)

import fs from "fs/promises";
import path from "path";
import http from "http";
import https from "https";
import dns from "dns";
import RSSParser from "rss-parser";
import sanitizeHtml from "sanitize-html";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// ---- MetricsCollector (CommonJS .cjs) ---------------------------------------
const require = createRequire(import.meta.url);
const { MetricsCollector } = require("./metricsCollector.cjs");

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

// Freshness & selection
const FRESH_HOURS_PRIMARY = 24;
const FRESH_HOURS_FALLBACKS = [36, 48];
const MAX_ITEMS = 6;
const MIN_DISTINCT_HOSTS = 3;

// Output labels
const SITE_TITLE = "Today’s 2-Minute AI Brief";
const ONE_LINER_PREFIX = "In brief — ";

// Paths (repo-root safe, independent of cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, ".."); // repo root (one level above /scripts)
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

// Seen caches
const SEEN_PATHS = {
  uk: path.join(STATE_DIR, "seen.json"),
  business: path.join(STATE_DIR, "seen.business.json"),
  work: path.join(STATE_DIR, "seen.work.json"),
  global: path.join(STATE_DIR, "seen.global.json"),
  security: path.join(STATE_DIR, "seen.security.json"),
  ethics: path.join(STATE_DIR, "seen.ethics.json"),
  // No seen cache for today_in_tech (history tab)
};

// Changelog source file
const CHANGELOG_JSON = path.join(STATE_DIR, "changelog.json");

// --- Feed groups -------------------------------------------------------------

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

const FEEDS_WORK_PRIMARY = [
  "https://www.theverge.com/rss/index.xml",
  "https://www.engadget.com/rss.xml",
];

const FEEDS_WORK_SECONDARY = [
  "https://workspaceupdates.googleblog.com/atom.xml",
  "https://www.fastcompany.com/technology/rss",
  "https://www.theguardian.com/technology/rss",
];

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

const FEEDS_SECURITY_PRIMARY = [
  "https://www.ncsc.gov.uk/api/1/services/v1/news-rss-feed.xml",
  "https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml",
  "https://www.theregister.com/security/headlines.atom",
];

const FEEDS_SECURITY_SECONDARY = [
  "https://www.theguardian.com/technology/rss",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
];

const FEEDS_ETHICS_PRIMARY = [
  "https://www.gov.uk/government/organisations/department-for-science-innovation-and-technology.atom",
  "https://www.gov.uk/government/organisations/competition-and-markets-authority.atom",
  "https://www.theguardian.com/uk/technology/rss",
];

const FEEDS_ETHICS_SECONDARY = [
  "https://www.theguardian.com/technology/rss",
  "https://www.technologyreview.com/feed/",
];

// Tab metadata (priority order for cross-tab de-dupe)
const TABS = [
  { key: "security", label: "AI Security", primary: FEEDS_SECURITY_PRIMARY, secondary: FEEDS_SECURITY_SECONDARY },
  { key: "ethics", label: "Ethics & Policy", primary: FEEDS_ETHICS_PRIMARY, secondary: FEEDS_ETHICS_SECONDARY },
  { key: "global", label: "Global AI", primary: FEEDS_GLOBAL_PRIMARY, secondary: FEEDS_GLOBAL_SECONDARY },
  { key: "uk", label: "UK AI", primary: FEEDS_UK_PRIMARY, secondary: FEEDS_UK_SECONDARY },
  { key: "business", label: "AI & Business", primary: FEEDS_BUSINESS_PRIMARY, secondary: FEEDS_BUSINESS_SECONDARY },
  { key: "work", label: "AI & Work", primary: FEEDS_WORK_PRIMARY, secondary: FEEDS_WORK_SECONDARY },
  // NEW: Today in Tech (history) – no feeds used (model-only)
  { key: "today_in_tech", label: "Today in Tech", primary: [], secondary: [] },
];

const TAB_DESC = {
  uk: "UK AI — A daily summary of AI news most relevant to the UK.",
  business: "AI & Business — Adoption, governance, monetisation, and real-world deployments.",
  work: "AI & Work — Productivity tools, workflow changes, and practical workplace usage.",
  global: "Global AI — Models, research, major releases, and big platform shifts worldwide.",
  security: "AI Security — Misuse, attacks, safeguards, auditing, and defensive practices.",
  ethics: "Ethics & Policy — Regulation, governance, rights, safety debates, and oversight.",
  today_in_tech: "Today in Tech — Key moments from this day that shaped modern computing and technology.",
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

function monthDayHuman() {
  const now = new Date();
  // e.g. "January 15"
  return now.toLocaleDateString("en-GB", { month: "long", day: "numeric" });
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

// AI Loose / Strict + Off-topic
const AI_LOOSE_RE =
  /(ai|artificial intelligence|machine learning|ml|llm|large language|chatgpt|openai|anthropic|gemini|copilot|deepmind|model|inference|fine[-\s]?tune|prompt|agentic|agents|safety|alignment|hallucinat|dataset|training|neural|generative|diffusion)/i;

const AI_STRICT_RE =
  /(artificial intelligence|\bai\b|machine learning|\bml\b|\bllm\b|large language model|openai|chatgpt|gpt-?4|gpt-?5|anthropic|claude|gemini|copilot|deepmind|llama|mistral|transformer|diffusion|inference|fine[-\s]?tuning|prompt injection|agentic|ai safety|alignment|arxiv)/i;

const OFFTOPIC_RE =
  /(gift guide|gift|deal|discount|sale|percent off|best (of|for)|review|tested|hands-on|buy now|price drop|shopping|to keep you toasty|which .* should you buy|top \d+|smartphone|laptop|headphones|video game|gaming|air fryer|earbuds)/i;

function aiLoose(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return AI_LOOSE_RE.test(h);
}
function aiStrict(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return AI_STRICT_RE.test(h);
}
function offTopic(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return OFFTOPIC_RE.test(h);
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
    // today_in_tech has no RSS items to score
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

// Feed error aggregation
const FEED_ERROR_COUNTS = new Map(); // url -> {count, lastMessage}
function noteFeedError(url, message) {
  const cur = FEED_ERROR_COUNTS.get(url) || { count: 0, lastMessage: "" };
  cur.count += 1;
  cur.lastMessage = message || cur.lastMessage;
  FEED_ERROR_COUNTS.set(url, cur);
}

function makeCrossTabKey(item) {
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

// --- Candidate collection ----------------------------------------------------

async function collectCandidates({ feeds, seen, maxHours, tabKey, metrics }) {
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

        const item = { title, link, source, snippet, publishedAt };
        item._score = scoreFn ? scoreFn(item) : 0;
        item._aiLoose = aiLoose(item);
        item._aiStrict = aiStrict(item);
        item._offTopic = offTopic(item);

        candidates.push(item);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      jlog("warn", "rss_error", { tab: tabKey, url, message: msg });
      noteFeedError(url, msg);
      metrics?.recordRssError?.(); // important: count for scoring
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

function meetsMinimum(items) {
  const distinct = new Set((items || []).map(i => i.source));
  return (items || []).length >= 3 && distinct.size >= Math.min(MIN_DISTINCT_HOSTS, (items || []).length);
}

function buildFallbackPanel(tabKey, reason, opts = {}) {
  const baseTitle = TAB_DESC[tabKey]?.split("—")[0]?.trim() || "This tab";
  const customOneLiner = opts?.oneLiner || `${baseTitle} has no update today.`;
  const customExplainer = opts?.explainer || `No suitable items were found for this tab in the current run.\n\n_(Reason: ${reason})_`;

  return {
    tabKey,
    items: [],
    freshnessUsed: null,
    usedSecondary: false,
    relaxedAI: false,
    oneLiner: customOneLiner,
    bullets: [
      "Coverage may be thin within the current freshness window.",
      "We’ll retry with broader sources on the next run.",
      "Use the source links on other tabs for nearby context.",
    ],
    explainerHtml: sanitizeExplainer(customExplainer),
    tags: ["no-update"],
    noteText: "",
    failed: true,
  };
}

function pickItems({ candidates, avoidKeys, requireStrictAI }) {
  const filtered = [];
  for (const it of candidates) {
    const key = makeCrossTabKey(it);
    const dupe = avoidKeys.has(key) || avoidKeys.has(`title:${normalizeKey(it.title)}`);
    if (dupe) continue;

    if (requireStrictAI && !it._aiStrict) continue;

    filtered.push(it);
  }
  return spreadAcrossHosts(filtered, MAX_ITEMS);
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

// NEW: Today in Tech prompt (model-assisted exact-date history)
function buildPromptTodayInTech(dateHuman) {
  return `You are writing a short "On this day" technology history brief.

DATE:
${dateHuman}

SCOPE:
Computing, internet, software, and AI/ML. Exclude non-tech and general world events.

CRITICAL RULES (strict):
- Only include events that happened on this EXACT calendar date (same month and day).
- Do NOT include "around this time", "this week", or approximate anniversaries.
- If you are not confident an event happened on this exact date, DO NOT include it.
- Provide UP TO 3 events. Fewer is fine. If none are confident, say so explicitly.

OUTPUT FORMAT (exact):
1) ONE_SENTENCE: <one factual sentence summarising today's tech history highlights>
2) WHY_IT_MATTERS:
   - <bullet 1>
   - <bullet 2>
   - <bullet 3>
3) EXPLAINER (200–300 words, plain English)
   - Mention the year for each event you include.
4) TAGS: comma-separated lowercase tags (3–6)
5) SOURCES:
   - <url 1>
   - <url 2>
   - <url 3>
   - <url 4>

SOURCES RULES:
- Provide 2–4 URLs that directly support the events you mentioned.
- Prefer authoritative references (e.g., Computer History Museum, IEEE, Britannica, reputable orgs/universities, well-known encyclopedic sources).
- If you cannot provide reliable URLs, write:
SOURCES:
   - NONE

If there are no confident events, still output in the same format with:
ONE_SENTENCE: No widely documented technology milestones occurred on this date.
WHY_IT_MATTERS: bullets should explain it's an incomplete historical record and invite checking other tabs.`;
}

// Robust parser even if model deviates (now also optionally captures SOURCES)
function parseModelOutput(text) {
  const oneMatch = text.match(/ONE[_\s-]*SENTENCE:\s*(.+)/i);
  let oneLiner = (oneMatch && oneMatch[1] ? oneMatch[1] : "").trim();
  if (!oneLiner) {
    oneLiner = (text.split("\n").map(s => s.trim()).find(s => s && !/^(\d\)|why|explainer|tags|tl;dr|in brief|sources)/i.test(s)) || "").trim();
  }
  if (/^tl;?dr[:\s-]/i.test(oneLiner)) oneLiner = oneLiner.replace(/^tl;?dr[:\s-]\s*/i, "");
  if (/^in brief[:\s-]/i.test(oneLiner)) oneLiner = oneLiner.replace(/^in brief[:\s-]\s*/i, "");

  const bullets = Array.from(text.matchAll(/^\s*-\s+(.+)$/gmi))
    .map((m) => m[1].trim())
    .slice(0, 3);

  const explainerPart =
    text.split(/^\s*3\)\s*EXPLAINER/i)[1] ||
    text.split(/EXPLAINER/i)[1] ||
    "";
  const explainer = explainerPart
    .replace(/^:\s*/, "")
    .split(/^\s*4\)\s*TAGS:/im)[0]
    ?.split(/^\s*TAGS:/im)[0]
    ?.split(/^\s*5\)\s*SOURCES:/im)[0]
    ?.split(/^\s*SOURCES:/im)[0]
    ?.trim() || "";

  const tagsMatch = text.match(/TAGS:\s*(.+)/i);
  const tags = (tagsMatch && tagsMatch[1] ? tagsMatch[1] : "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Optional sources parsing (for Today in Tech)
  const sources = [];
  const sourcesBlock = text.split(/^\s*(5\)\s*)?SOURCES\s*:/im)[1] || "";
  if (sourcesBlock) {
    const lines = sourcesBlock.split("\n").map(s => s.trim());
    for (const line of lines) {
      const m = line.match(/^(?:-\s*)?(https?:\/\/\S+)/i);
      if (m && m[1]) sources.push(m[1].replace(/[)\],.]+$/, ""));
      if (sources.length >= 6) break;
      if (/^\s*(?:-\s*)?none\s*$/i.test(line)) break;
      // stop if it looks like a new numbered section
      if (/^\d+\)/.test(line)) break;
    }
  }

  return { oneLiner, bullets, explainer, tags, sources };
}

function toHtmlList(bullets) {
  return (bullets || []).map((b) => `<li>${htmlEscape(b)}</li>`).join("\n");
}

// NEW: filter sources shown to the reader
// Display-worthy if (aiStrict===true) OR (offTopic===false)
function toSourcesLinks(items) {
  const seen = new Set();
  const unique = [];

  for (const it of items || []) {
    const isDisplayWorthy = (it._aiStrict === true) || (it._offTopic === false);
    if (!isDisplayWorthy) continue;

    const key = `${it.source}|${it.title}`;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(it);
  }

  return unique.slice(0, 4).map(it => {
    const label = it.source || "source";
    const title = htmlEscape(truncate(it.title, 100));
    const href = htmlEscape(it.link);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
  }).join(" ");
}

// --- Tabs UI -----------------------------------------------------------------

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
    <button class="tab" role="tab" aria-selected="false" data-tab="today_in_tech">Today in Tech</button>
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

  .feedback{margin-top:14px;font-size:.9rem;opacity:.85}
  .fb-btn{cursor:pointer;margin-right:10px}
  .fb-btn[disabled]{opacity:.5;cursor:default}
  .fb-status{
    display:block;
    margin-top:6px;
    font-size:.9rem;
    color:var(--fg);
  }




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

  // -------------------------------
  // TAB CLICK HANDLER (FIX)
  // -------------------------------
  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if(!btn) return;
    setTab(btn.getAttribute('data-tab'));
  });

  // -------------------------------
  // FEEDBACK HANDLER (👍 / 👎)
  // -------------------------------
  document.addEventListener('click', async function(e){
    var btn = e.target && e.target.closest ? e.target.closest('.fb-btn') : null;
    if(!btn) return;

    var panel = btn.closest('.feedback');
    var tab = panel && panel.getAttribute('data-tab');


    var vote = btn.getAttribute('data-vote');
    if(!tab || !vote) return;

    // Disable both buttons for this tab
    document.querySelectorAll('.fb-btn[data-tab="'+tab+'"]').forEach(function(b){
      b.setAttribute('disabled','disabled');
    });

    var panel = btn.closest('.feedback');
    var statusEl = panel && panel.querySelector('.fb-status');
    if(statusEl){
       statusEl.textContent = vote === 'up'
          ? 'Thanks — glad this was useful 👍'
          : 'Thanks — feedback noted 👎';
    }


    try{
      await fetch('/api/feedback', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          tab: tab,
          vote: vote,
          path: location.pathname
        })
      });
    }catch(err){
      console.warn('Feedback failed', err);
    }
  });

  // Default tab on load
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

    <!-- Feedback -->
    <div class="feedback" data-tab="${htmlEscape(tabKey)}">
      <span>Was this useful?</span>
      <button class="fb-btn" data-vote="up" aria-label="Thumbs up">👍</button>
      <button class="fb-btn" data-vote="down" aria-label="Thumbs down">👎</button>
      <span class="fb-status" aria-live="polite"></span>
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
      <li><strong>Tabs:</strong> UK AI, AI &amp; Business, AI &amp; Work, Global AI, AI Security, Ethics &amp; Policy, Today in Tech.</li>
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

// --- Tab generation ----------------------------------------------------------

// Standard RSS tabs
async function generateOneTab({ tabKey, tabLabel, primaryFeeds, secondaryFeeds, avoidKeys, metrics }) {
  const seenPath = SEEN_PATHS[tabKey];
  const seen = await loadSeenFrom(seenPath);

  const planSteps = [];
  planSteps.push({ hours: FRESH_HOURS_PRIMARY, feeds: primaryFeeds, usedSecondary: false });
  planSteps.push({ hours: FRESH_HOURS_PRIMARY, feeds: [...primaryFeeds, ...secondaryFeeds], usedSecondary: true });
  for (const h of FRESH_HOURS_FALLBACKS) {
    planSteps.push({ hours: h, feeds: primaryFeeds, usedSecondary: false });
    planSteps.push({ hours: h, feeds: [...primaryFeeds, ...secondaryFeeds], usedSecondary: true });
  }

  let best = [];
  let bestMeta = { freshnessUsed: FRESH_HOURS_PRIMARY, usedSecondary: false, relaxedAI: false };

  for (const step of planSteps) {
    const candidates = await collectCandidates({ feeds: step.feeds, seen, maxHours: step.hours, tabKey, metrics });

    // Attempt 1: require strict AI
    let picks = pickItems({ candidates, avoidKeys, requireStrictAI: true });
    let relaxedAI = false;

    // If too strict, relax to best available (but keep note)
    if (picks.length < 3) {
      const relaxed = pickItems({ candidates, avoidKeys, requireStrictAI: false });
      if (relaxed.length > picks.length) {
        picks = relaxed;
        relaxedAI = true;
      }
    }

    const meta = { freshnessUsed: step.hours, usedSecondary: step.usedSecondary, relaxedAI };

    if (picks.length > best.length) {
      best = picks;
      bestMeta = meta;
    }

    if (meetsMinimum(picks)) {
      best = picks;
      bestMeta = meta;
      break;
    }
  }

  // Selection log
  jlog("info", "tab_selection", {
    tab: tabKey,
    freshnessUsed: bestMeta.freshnessUsed,
    usedSecondary: bestMeta.usedSecondary,
    relaxedAI: bestMeta.relaxedAI,
    picked: best.map(it => ({
      source: it.source,
      title: it.title,
      age_hours: ageHours(it.publishedAt),
      score: it._score || 0,
      aiLoose: !!it._aiLoose,
      aiStrict: !!it._aiStrict,
      offTopic: !!it._offTopic,
    })),
  });

  if (best.length === 0) {
    throw new Error(`[${tabKey}] No suitable items found in freshness windows.`);
  }

  // Call model
  const prompt = buildPromptForTab(tabKey, best);
  log(`[${tabKey}] Calling OpenAI with`, best.length, "items");

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
  if (bestMeta.freshnessUsed > FRESH_HOURS_PRIMARY) {
    explainerText += `\n\n_(Note: Some sources may be older than ${FRESH_HOURS_PRIMARY} hours due to limited fresh coverage.)_`;
  }

  const noteBits = [];
  if (bestMeta.usedSecondary) noteBits.push("Wider sources used today due to limited fresh coverage.");
  if (bestMeta.relaxedAI) noteBits.push("Some items may be only loosely AI-related due to limited matching items.");
  const noteText = noteBits.length ? noteBits.join(" ") : "";

  const explainerHtml = sanitizeExplainer(explainerText);

  // Update seen cache
  for (const it of best) {
    seen.links.add(it.link);
    const t = normalizeTitle(it.title || "");
    if (t) seen.titles.add(t);
  }
  await saveSeenTo(seenPath, seen);

  return {
    tabKey,
    label: tabLabel,
    items: best,
    freshnessUsed: bestMeta.freshnessUsed,
    usedSecondary: bestMeta.usedSecondary,
    relaxedAI: bestMeta.relaxedAI,
    oneLiner,
    bullets,
    explainerHtml,
    tags,
    noteText,
    failed: false,
  };
}

// NEW: Today in Tech tab generator (model-only, exact-date history)
async function generateTodayInTechTab({ tabKey, tabLabel, metrics }) {
  const dateHuman = monthDayHuman();

  const prompt = buildPromptTodayInTech(dateHuman);
  log(`[${tabKey}] Calling OpenAI (history) for date`, dateHuman);

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2, // requested: A (low creativity / safer)
    messages: [
      { role: "system", content: "You are careful and avoid hallucinations. If unsure, you say you are unsure and you do not invent facts." },
      { role: "user", content: prompt },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error(`[${tabKey}] Empty response from model`);

  if (MODEL_OUTPUT_LOGGING) {
    jlog("debug", "model_output", { tab: tabKey, text: raw.slice(0, 4000) });
  }

  const { oneLiner, bullets, explainer, tags, sources } = parseModelOutput(raw);

  // Build pseudo-items from SOURCES so the UI can render citations.
  // Mark as display-worthy: aiStrict=true and offTopic=false.
  const items = (sources || [])
    .filter(u => /^https?:\/\//i.test(u))
    .slice(0, 6)
    .map(u => ({
      title: "Reference",
      link: u,
      source: safeHostname(u),
      snippet: "",
      publishedAt: null,
      _score: 0,
      _aiLoose: true,
      _aiStrict: true,
      _offTopic: false,
    }))
    .filter(it => it.source); // ensure hostname exists

  // If model explicitly says "no milestones", treat as a non-crash "no update" style panel.
  const noMilestones =
    /^no widely documented technology milestones occurred on this date/i.test(oneLiner || "") ||
    /\bno widely documented technology milestones\b/i.test(raw);

  jlog("info", "tab_selection", {
    tab: tabKey,
    freshnessUsed: 0,
    usedSecondary: false,
    relaxedAI: false,
    picked: items.map(it => ({
      source: it.source,
      title: it.title,
      age_hours: null,
      score: 0,
      aiLoose: true,
      aiStrict: true,
      offTopic: false,
    })),
  });

  if (noMilestones) {
    return {
      tabKey,
      label: tabLabel,
      items, // may be empty if sources NONE
      freshnessUsed: 0,
      usedSecondary: false,
      relaxedAI: false,
      oneLiner: "No widely documented technology milestones occurred on this date.",
      bullets: bullets?.length ? bullets : [
        "Historical records can be incomplete or inconsistently documented.",
        "Some events may not have a clear, widely cited date.",
        "Check other tabs for today’s current tech context.",
      ],
      explainerHtml: sanitizeExplainer(explainer || "No widely documented technology milestones were confidently verified for this exact calendar date."),
      tags: (tags && tags.length) ? tags : ["tech-history", "on-this-day"],
      noteText: "",
      failed: false,
    };
  }

  // If it produced content but no sources, still allow it (sources section will just show nothing meaningful).
  const explainerHtml = sanitizeExplainer(explainer || "");
  const finalTags = (tags && tags.length) ? tags : ["tech-history", "on-this-day"];

  return {
    tabKey,
    label: tabLabel,
    items,
    freshnessUsed: 0,
    usedSecondary: false,
    relaxedAI: false,
    oneLiner: oneLiner || `On ${dateHuman}, several notable tech milestones helped shape modern computing.`,
    bullets: bullets?.length ? bullets : [
      "Technology milestones often have long tail impacts on today’s platforms and products.",
      "Seeing origins helps separate hype from real underlying shifts.",
      "History gives context for today’s AI and software debates.",
    ],
    explainerHtml,
    tags: finalTags,
    noteText: "",
    failed: false,
  };
}

// --- Main --------------------------------------------------------------------

async function main() {
  const ymd = todayYMD();

  log("Start generate");
  jlog("info", "run_start", { ymd, log_level: LOG_LEVEL, model_output_logging: MODEL_OUTPUT_LOGGING });

  // Metrics collector (writes to public/data/metrics/*)
  const metrics = new MetricsCollector({ repoRoot: ROOT });
  metrics.startRun({ ymd, generator: "scripts/generate.js" });

  try {
    // Ensure output dirs exist
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    await fs.mkdir(DATA_OUT_DIR, { recursive: true });

    const tpl = await fs.readFile(INDEX_TEMPLATE, "utf8");
    const supportsTabs =
      tpl.includes("{{TABS_NAV}}") &&
      tpl.includes("{{TAB_PANELS}}") &&
      tpl.includes("{{TABS_ASSETS}}");

    if (!supportsTabs) {
      throw new Error("index.template.html must include {{TABS_NAV}}, {{TAB_PANELS}}, {{TABS_ASSETS}} placeholders.");
    }

    const avoidKeys = new Set();
    const results = [];

    for (const tab of TABS) {
      try {
        let res;

        if (tab.key === "today_in_tech") {
          res = await generateTodayInTechTab({
            tabKey: tab.key,
            tabLabel: tab.label,
            metrics,
          });
        } else {
          res = await generateOneTab({
            tabKey: tab.key,
            tabLabel: tab.label,
            primaryFeeds: tab.primary,
            secondaryFeeds: tab.secondary,
            avoidKeys,
            metrics,
          });

          // For RSS tabs, add picked items into avoidKeys so later tabs don’t repeat the same stories
          for (const it of res.items) {
            avoidKeys.add(makeCrossTabKey(it));
            avoidKeys.add(`title:${normalizeKey(it.title)}`);
          }
        }

        results.push(res);
      } catch (err) {
        const msg = err?.message || String(err);
        log(`[${tab.key}] Tab failed; using fallback panel:`, msg);
        jlog("warn", "tab_failed", { tab: tab.key, message: msg });

        // Today in Tech fallback should be clearer
        if (tab.key === "today_in_tech") {
          results.push(buildFallbackPanel(tab.key, msg, {
            oneLiner: "Today in Tech has no update today.",
            explainer: `No verified "On this day" tech history items were produced for the exact date.\n\n_(Reason: ${msg})_`,
          }));
        } else {
          results.push(buildFallbackPanel(tab.key, msg));
        }
      } finally {
        // ---------------- PATCHED METRICS WIRING ----------------
        // Pass picked[] items (not just counts), so collector can compute itemCount/hosts/aiStrict/offTopic/dup
        const last = results[results.length - 1];

        const picked = (last?.items || []).map(it => ({
          source: it.source || "",
          title: it.title || "",
          link: it.link || it.url || "",
          snippet: it.snippet || "",
          aiStrict: typeof it._aiStrict === "boolean" ? it._aiStrict : undefined,
          offTopic: typeof it._offTopic === "boolean" ? it._offTopic : undefined,
        }));

        const hosts = Array.from(new Set(picked.map(i => i.source).filter(Boolean)));

        metrics.recordTabSummary(tab.key, {
          label: tab.label,
          failed: !!last?.failed,
          usedSecondary: !!last?.usedSecondary,
          relaxedAI: !!last?.relaxedAI,
          freshnessUsed: Number.isFinite(last?.freshnessUsed) ? last.freshnessUsed : 0,
          hosts,
          picked, // <-- key fix
          historical: tab.key === "today_in_tech" ? true : false,
        });
        // ---------------------------------------------------------
      }
    }

    const { iso, human } = isoAndHumanDate();

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

    const html = tpl
      .replaceAll("Today’s 2-Minute UK AI Brief", SITE_TITLE)
      .replace("{{ISO_DATE}}", iso)
      .replace("{{HUMAN_DATE}}", human)
      .replace("{{TABS_NAV}}", tabsNavHtml())
      .replace("{{TAB_PANELS}}", panelsHtml)
      .replace("{{TABS_ASSETS}}", tabsAssetsHtml());

    await writeFileAtomic(INDEX_OUT, html);
    await writeFileAtomic(path.join(ARCHIVE_DIR, `${ymd}.html`), html);

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

    await writeFileAtomic(ABOUT_OUT, renderAboutPage());
    await writeFileAtomic(CHANGELOG_OUT, await renderChangelogPage());

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
          aiLoose: !!it._aiLoose,
          aiStrict: !!it._aiStrict,
          offTopic: !!it._offTopic,
          score: it._score || 0,
        })),
      })),
    };
    await writeFileAtomic(TABS_JSON_OUT, JSON.stringify(tabsJson, null, 2));

    // Run summaries
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

    // Write metrics at the end of a successful run
    metrics.finalizeAndWrite({ runSuccess: true });

  } catch (err) {
    // Ensure metrics still get written even on failure
    try {
      metrics.finalizeAndWrite({ runSuccess: false });
    } catch (e) {
      log("Failed to write metrics on error:", e?.message || String(e));
    }
    throw err;
  }
}

// Clean exit
main()
  .then(() => {
    log("Done; exiting cleanly.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[${ts()}]`, err);
    process.exit(1);
  });

