// scripts/metricsCollector.cjs
// CommonJS module (.cjs) because package.json has "type": "module".
//
// Purpose:
// - Collect per-run and per-tab metrics during scripts/generate.js
// - Write daily + latest metrics JSON files for scoring/trends.
//
// Files written:
//   public/data/metrics/metrics-YYYY-MM-DD.json
//   public/data/metrics-latest.json
//
// Backwards-compatible API for generate.js:
//   - startRun(meta)
//   - recordRssError() / incrementRssError()
//   - recordTabSummary(tabKey, summary)
//   - buildMetricsObject()
//   - finalizeAndWrite(meta)   <-- your generate.js calls this
//   - endRun(meta)            (alias)
//   - writeLatestAndDaily(meta) (alias)

const fs = require("fs");
const path = require("path");

function ts() {
  return new Date().toISOString();
}

function todayYMD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function safeHostname(url) {
  try {
    const u = new URL(url);
    return (u.hostname || "").replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeKey(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalKeyFromUrl(link) {
  try {
    const u = new URL(link);
    const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
    const p = (u.pathname || "").replace(/\/+$/, "");
    return `${host}${p}`.toLowerCase();
  } catch {
    return "";
  }
}

// If generate.js already provides aiStrict/offTopic on picked items, we use them.
// Otherwise we compute them.
const AI_STRICT_RE =
  /(artificial intelligence|\bai\b|machine learning|\bml\b|\bllm\b|large language model|openai|chatgpt|gpt-?4|gpt-?5|anthropic|claude|gemini|copilot|deepmind|llama|mistral|transformer|diffusion|inference|fine[-\s]?tuning|prompt injection|agentic|ai safety|alignment|arxiv)/i;

const OFFTOPIC_RE =
  /(gift guide|gift|deal|discount|sale|percent off|best (of|for)|review|tested|hands-on|buy now|price drop|shopping|to keep you toasty|which .* should you buy|top \d+|smartphone|laptop|headphones|james bond game|video game|gaming)/i;

function computeAiStrict(item) {
  const h = `${item.source || ""} ${item.title || ""} ${item.snippet || ""}`;
  return AI_STRICT_RE.test(h);
}

function computeOffTopic(item) {
  const h = `${item.source || ""} ${item.title || ""} ${item.snippet || ""}`;
  return OFFTOPIC_RE.test(h);
}

class MetricsCollector {
  constructor(opts = {}) {
    this.repoRoot = opts.repoRoot || process.cwd();
    this.outDir = opts.outDir || path.join(this.repoRoot, "public", "data");
    this.metricsDir = path.join(this.outDir, "metrics");
    this.latestPath = path.join(this.outDir, "metrics-latest.json");

    ensureDir(this.metricsDir);

    this._run = null;

    // Used to detect cross-tab duplicates within a run
    this._globalSeen = new Set();
  }

  // ----------------------------
  // Run lifecycle
  // ----------------------------

  startRun(meta = {}) {
    const ymd = meta.ymd || todayYMD();

    this._run = {
      version: 1,
      ymd,
      startedAt: meta.startedAt || ts(),
      finishedAt: null,
      runSuccess: 0,

      // tab health
      tabsTotal: 0,
      tabsSucceeded: 0,
      thinTabs: 0,
      noUpdateTabs: 0,

      // content totals
      pickedItemsTotal: 0,
      aiStrictCount: 0,
      offTopicCount: 0,
      dupCount: 0,

      // reliability totals
      rssErrors: 0,

      // diversity
      hostCount: 0,

      // detailed tab records
      tabs: [],

      meta: { ...meta },
    };

    this._globalSeen.clear();
    return this;
  }

  // Some code uses begin(); keep it
  begin(meta = {}) {
    return this.startRun(meta);
  }

  // ----------------------------
  // Reliability tracking
  // ----------------------------

  recordRssError() {
    if (!this._run) return;
    this._run.rssErrors += 1;
  }

  incrementRssError() { return this.recordRssError(); }
  addRssError() { return this.recordRssError(); }

  // ----------------------------
  // Tab recording (compat)
  // ----------------------------

  /**
   * generate.js calls recordTabSummary(tabKey, summary)
   *
   * summary is expected to include:
   * - freshnessUsed, usedSecondary, relaxedAI, failed
   * - picked: [{source,title,link?,snippet?,aiStrict?,offTopic? ...}]
   */
  recordTabSummary(tabKey, summary = {}) {
    if (!this._run) return;

    const picked = Array.isArray(summary.picked)
      ? summary.picked
      : (Array.isArray(summary.items) ? summary.items : []);

    const itemCount = picked.length;

    const THIN_THRESHOLD = 3;
    const isThin = itemCount > 0 && itemCount < THIN_THRESHOLD;
    const isNoUpdate = itemCount === 0;

    const tabHosts = new Set();
    let tabAiStrict = 0;
    let tabOffTopic = 0;
    let tabDup = 0;

    const itemsOut = picked.map((it) => {
      const title = it.title || "";
      const link = it.link || it.url || "";
      const snippet = it.snippet || "";
      const source = it.source || safeHostname(link);

      if (source) tabHosts.add(source);

      const aiStrict = (typeof it.aiStrict === "boolean") ? it.aiStrict : computeAiStrict({ source, title, snippet });
      const offTopic = (typeof it.offTopic === "boolean") ? it.offTopic : computeOffTopic({ source, title, snippet });

      const urlKey = canonicalKeyFromUrl(link);
      const titleKey = normalizeKey(title);
      const key = urlKey ? `u:${urlKey}` : `t:${titleKey}`;

      const isDup = this._globalSeen.has(key);
      if (isDup) tabDup += 1;
      else this._globalSeen.add(key);

      if (aiStrict) tabAiStrict += 1;
      if (offTopic) tabOffTopic += 1;

      return {
        title,
        link,
        source,
        aiStrict,
        offTopic,
        dup: isDup,
      };
    });

    // Update run totals
    this._run.tabsTotal += 1;
    this._run.tabsSucceeded += summary.failed ? 0 : 1;

    if (isThin) this._run.thinTabs += 1;
    if (isNoUpdate) this._run.noUpdateTabs += 1;

    this._run.pickedItemsTotal += itemCount;
    this._run.aiStrictCount += tabAiStrict;
    this._run.offTopicCount += tabOffTopic;
    this._run.dupCount += tabDup;

    this._run.tabs.push({
      key: tabKey,
      label: summary.label || tabKey,
      failed: !!summary.failed,
      freshnessUsed: summary.freshnessUsed ?? null,
      usedSecondary: !!summary.usedSecondary,
      relaxedAI: !!summary.relaxedAI,
      itemCount,
      thin: isThin,
      noUpdate: isNoUpdate,
      hosts: Array.from(tabHosts),
      counts: { aiStrict: tabAiStrict, offTopic: tabOffTopic, dup: tabDup },
      items: itemsOut.slice(0, 60),
    });
  }

  // You may also call recordTab(tabKey, meta, items) directly if you want
  recordTab(tabKey, meta = {}, items = []) {
    return this.recordTabSummary(tabKey, { ...meta, picked: items });
  }

  // ----------------------------
  // Build + finalize + write (compat)
  // ----------------------------

  buildMetricsObject() {
    // generate.js expects this to exist
    return this._run || {};
  }

  finalizeRun(meta = {}) {
    if (!this._run) return null;

    this._run.finishedAt = meta.finishedAt || ts();
    this._run.runSuccess = meta.runSuccess ? 1 : 0;

    // Compute overall hostCount across tabs
    const allHosts = new Set();
    for (const t of this._run.tabs) {
      for (const h of t.hosts || []) allHosts.add(h);
    }
    this._run.hostCount = allHosts.size;

    return this._run;
  }

  writeLatestAndDaily(meta = {}) {
    if (!this._run) return null;

    this.finalizeRun(meta);

    const dayPath = path.join(this.metricsDir, `metrics-${this._run.ymd}.json`);
    const payload = JSON.stringify(this._run, null, 2);

    writeFileAtomic(dayPath, payload);
    writeFileAtomic(this.latestPath, payload);

    return { dayPath, latestPath: this.latestPath };
  }

  // generate.js is calling this (per your log)
  finalizeAndWrite(meta = {}) {
    return this.writeLatestAndDaily(meta);
  }

  // Keep older alias
  endRun(meta = {}) {
    return this.writeLatestAndDaily(meta);
  }
}

module.exports = { MetricsCollector };

