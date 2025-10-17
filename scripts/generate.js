// scripts/generate.js
// Generates public/index.html: a single daily-updated page summarising UK AI news,
// with freshness filter (last 24h preferred) and a seen-items cache.

import fs from "fs/promises";
import path from "path";
import RSSParser from "rss-parser";
import sanitizeHtml from "sanitize-html";
import OpenAI from "openai";

// --- Config ------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY (export it or set in CI secrets)");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const rss = new RSSParser({
  timeout: 15000,
  headers: { "user-agent": "uk-ai-brief/1.1" },
});

// UK-centric feeds that publish summaries (safe for short-context summarising)
const FEEDS = [
  "https://www.ukri.org/news/feed/",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  // Reuters sometimes DNS-fails in your environment—keep but it's optional:
  "https://feeds.reuters.com/reuters/technologyNews?format=xml",
];

// Freshness and selection
const FRESH_HOURS_PRIMARY = 24;  // try to stick to last 24h
const FRESH_HOURS_FALLBACKS = [36, 48]; // widen window only if we lack items
const MAX_ITEMS = 4;              // cap sources we feed to the model
const MIN_DISTINCT_HOSTS = 2;     // prefer at least two different publishers

// Seen cache file (to avoid repeating yesterday’s link/topic)
const STATE_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(STATE_DIR, "seen.json");

// --- Helpers -----------------------------------------------------------------

function truncate(text = "", n = 600) {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

function isoDateLondonToday() {
  const now = new Date();
  return {
    iso: now.toISOString(), // keep ISO in UTC for schema consumers
    human: now.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" }),
  };
}

function htmlEscape(s = "") {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function scoreUK(it) {
  const h = `${it.source} ${it.title} ${it.snippet}`.toLowerCase();
  return /(^|\W)(uk|u\.k\.|united kingdom|britain|british|london|cma|ico|ncsc|dsit|ukri|ofcom|gov\.uk|govuk)(\W|$)/i.test(h) ? 1 : 0;
}

function normalizeTitle(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isFresh(dateObj, maxHours) {
  if (!dateObj || isNaN(dateObj.getTime())) return false;
  const ageMs = Date.now() - dateObj.getTime();
  const maxMs = maxHours * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= maxMs;
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

// Pull up to MAX_ITEMS respecting freshness and “seen” cache.
async function collectItemsWithFreshness(feeds, seen, maxHours) {
  const items = [];

  for (const url of feeds) {
    try {
      const feed = await rss.parseURL(url);
      for (const it of feed.items) {
        const link = it.link || it.guid;
        if (!link) continue;

        // Try to parse date; rss-parser exposes isoDate when present
        const dateStr = it.isoDate || it.pubDate || it.pubdate || null;
        const publishedAt = dateStr ? new Date(dateStr) : null;

        // Respect freshness window
        if (maxHours && !isFresh(publishedAt, maxHours)) continue;

        // Skip repeats: link or very similar title
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
      console.warn("RSS error:", url, e.message);
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

  // Prefer UK-signals, then newer first
  unique.sort((a, b) => {
    const ukDelta = scoreUK(b) - scoreUK(a);
    if (ukDelta !== 0) return ukDelta;
    const at = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bt = b.publishedAt ? b.publishedAt.getTime() : 0;
    return bt - at;
  });

  // Balance distinct hosts if possible
  const byHost = new Map();
  for (const it of unique) {
    if (!byHost.has(it.source)) byHost.set(it.source, []);
    byHost.get(it.source).push(it);
  }
  const picks = [];
  // round-robin across hosts to try for diversity
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
  const sourcesBlock = items
    .map(
      (it, i) =>
        `(${i + 1}) [${it.source}] ${it.title}\nURL: ${it.link}\nSnippet: ${truncate(it.snippet, 600)}`
    )
    .join("\n\n");

  return `You are a cautious news summariser.

CONTEXT:
We publish a daily 2-minute brief focused on **AI within the UK** — policy, regulators, public sector guidance, research funding, UK-based companies, and UK economic impact.

INPUT SOURCES (RSS titles + snippets only):
${sourcesBlock}

YOUR TASK:
- Produce a concise, neutral daily brief **with a UK angle**.
- Prefer content where the entity/event is UK-based (regulators like CMA, ICO, NCSC; government/DSIT; UKRI; universities; UK-headquartered firms), or where global AI news has clear UK implications.
- Output sections in this exact format:
1) ONE_SENTENCE: <a single, factual 1-sentence summary framed around the UK angle>
2) WHY_IT_MATTERS:
   - <bullet 1, concrete UK relevance>
   - <bullet 2>
   - <bullet 3>
3) EXPLAINER (200–300 words, plain English; cite the UK context if present)
4) TAGS: comma-separated lowercase tags (3–5), e.g., "uk-policy, cma, research-funding"

RULES:
- Use ONLY facts supported by the provided snippets/titles; do not speculate.
- Use concrete figures and named UK bodies when present; avoid generic claims.
- If sources conflict, acknowledge uncertainty briefly.
- No quotes longer than 20 words.
- No images.
- End with nothing else.`;
}

function parseModelOutput(text) {
  const oneMatch = text.match(/ONE_SENTENCE:\s*(.+)/i);
  const oneLiner = (oneMatch && oneMatch[1] ? oneMatch[1] : "").trim();

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
  // Deduplicate by hostname + title pair
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const key = `${it.source}|${it.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(it);
    }
  }
  // Limit to 3 and label by hostname
  return unique.slice(0, 3).map(it => {
    const label = it.source || "source";
    const title = htmlEscape(truncate(it.title, 100));
    const href = htmlEscape(it.link);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
  }).join(" ");
}

// --- Main --------------------------------------------------------------------

async function main() {
  const seen = await loadSeen();

  // Try 24h; widen only if needed
  let items = await collectItemsWithFreshness(FEEDS, seen, FRESH_HOURS_PRIMARY);
  let freshnessUsed = FRESH_HOURS_PRIMARY;

  // Ensure at least MIN_DISTINCT_HOSTS if possible
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

  // Cap to MAX_ITEMS
  items = items.slice(0, MAX_ITEMS);

  // Build prompt and call model
  const prompt = buildPrompt(items);
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

  // Sanitize explainer (allow minimal formatting if model adds any)
  // Also, if we widened beyond 24h, append a subtle note.
  let explainerText = explainer;
  if (freshnessUsed > FRESH_HOURS_PRIMARY) {
    explainerText += `\n\n_(Note: One or more sources may be older than ${FRESH_HOURS_PRIMARY} hours due to limited fresh coverage.)_`;
  }

  const explainerHtml = sanitizeHtml(explainerText, {
    allowedTags: ["p", "em", "strong", "ul", "ol", "li", "a", "br"],
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
  });

  const templatePath = path.join(process.cwd(), "templates", "index.template.html");
  const outPath = path.join(process.cwd(), "public", "index.html");
  const tpl = await fs.readFile(templatePath, "utf8");

  const { iso, human } = isoDateLondonToday();
  const html = tpl
    .replace("{{ISO_DATE}}", iso)
    .replace("{{HUMAN_DATE}}", human)
    .replace("{{ONE_LINER}}", htmlEscape(oneLiner))
    .replace("{{WHY_IT_MATTERS_LIST}}", toHtmlList(bullets))
    .replace("{{EXPLAINER_HTML}}", explainerHtml)
    .replace("{{SOURCES_LINKS}}", toSourcesLinks(items))
    .replace(
      "{{TAGS}}",
      tags.map((t) => `<span class="tag">${htmlEscape(t)}</span>`).join(" ")
    );

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, "utf8");

  // Update seen cache with what we actually used today
  for (const it of items) {
    seen.links.add(it.link);
    const t = normalizeTitle(it.title || "");
    if (t) seen.titles.add(t);
  }
  await saveSeen(seen);

  console.log(`Generated public/index.html (freshness: <=${freshnessUsed}h, hosts: ${Array.from(new Set(items.map(i=>i.source))).join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
