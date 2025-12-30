// scripts/metricsCollector.js
//
// Lightweight run-level metrics aggregator for your daily generator.
// Collects per-tab outcomes + per-item quality flags and writes:
//
//  - public/data/metrics/metrics-YYYY-MM-DD.json (immutable daily snapshot)
//  - public/data/metrics-latest.json            (rolling latest)
//
// Usage (typical):
//   const { MetricsCollector } = require("./scripts/metricsCollector");
//   const metrics = new MetricsCollector({ metricsDir: ".../public/data/metrics", latestPath: ".../public/data/metrics-latest.json" });
//
//   metrics.startRun({ dateStr: "2025-12-30", tabsPlanned: tabs.length });
//
//   // per picked item
//   metrics.recordPickedItem("AI", { url, title, aiStrict, offTopic });
//
//   // per tab summary
//   metrics.recordTabSummary("AI", { itemsPicked, usedSecondary, freshnessHours, hosts: ["bbc.co.uk","theverge.com"] });
//
//   // rss error
//   metrics.recordRssError({ tab: "AI", feed: "https://...", message: "timeout" });
//
//   // duplicates
//   metrics.addDupCount(2);
//
//   // finalize
//   await metrics.finalizeAndWrite();
//
// Notes:
//  - "thin" is < 3 itemsPicked (but > 0)
//  - "noUpdate" is 0 itemsPicked
//

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function ensureArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function todayYYYYMMDD(d = new Date()) {
  // local date (server timezone). If you want UTC, adjust here.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function tryParseHostname(u) {
  try {
    const url = new URL(u);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, obj) {
  // write to temp then rename (atomic on same filesystem)
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const json = JSON.stringify(obj, null, 2) + "\n";

  return fsp
    .writeFile(tmp, json, "utf8")
    .then(() => fsp.rename(tmp, filePath))
    .catch(async (err) => {
      // cleanup temp file if rename fails
      try { await fsp.unlink(tmp); } catch {}
      throw err;
    });
}

class MetricsCollector {
  /**
   * @param {object} opts
   * @param {string} opts.metricsDir   Absolute or relative dir for daily metrics snapshots
   * @param {string} opts.latestPath   Absolute or relative file path for rolling latest metrics
   * @param {number} [opts.thinThreshold=3] itemsPicked < thinThreshold => thin (if >0)
   */
  constructor(opts = {}) {
    if (!opts.metricsDir) throw new Error("MetricsCollector: metricsDir is required");
    if (!opts.latestPath) throw new Error("MetricsCollector: latestPath is required");

    this.metricsDir = opts.metricsDir;
    this.latestPath = opts.latestPath;
    this.thinThreshold = Number.isFinite(opts.thinThreshold) ? opts.thinThreshold : 3;

    this._reset();
  }

  _reset() {
    this.started = false;

    this.dateStr = null;
    this.runSuccess = 0; // set to 1 when finalize completes successfully
    this.tabsPlanned = null;

    // per-run counts
    this.tabsTotal = 0;        // count of tab summaries recorded
    this.tabsWithContent = 0;  // itemsPicked > 0
    this.thinTabs = 0;         // 0 < itemsPicked < thinThreshold
    this.noUpdateTabs = 0;     // itemsPicked == 0

    this.rssErrors = 0;
    this.usedSecondaryTabs = 0;
    this.maxFreshnessHours = 0;

    this.uniqueHostsSet = new Set(); // across entire run

    // item-level quality
    this.pickedItems = 0;
    this.aiStrictCount = 0;
    this.offTopicCount = 0;

    // dedupe
    this.dupCount = 0;

    // optional detail for debugging (kept small)
    this.tabDetails = {}; // tabName -> summary

    // if you ever want it: store per-tab host sets etc.
  }

  /**
   * Start a new run.
   * @param {object} opts
   * @param {string} [opts.dateStr]   Defaults to local YYYY-MM-DD
   * @param {number} [opts.tabsPlanned] Optional planned tab count for tracking
   */
  startRun(opts = {}) {
    if (this.started) throw new Error("MetricsCollector: startRun() called twice");
    this.started = true;
    this.dateStr = opts.dateStr || todayYYYYMMDD(new Date());
    this.tabsPlanned = Number.isFinite(opts.tabsPlanned) ? opts.tabsPlanned : null;
    return this;
  }

  /**
   * Record one picked item.
   * @param {string} tabName
   * @param {object} item
   * @param {string} [item.url]
   * @param {string} [item.title]
   * @param {boolean} [item.aiStrict]
   * @param {boolean} [item.offTopic]
   * @param {string|string[]} [item.hosts] optional if you already computed hosts
   */
  recordPickedItem(tabName, item = {}) {
    if (!this.started) this.startRun({});
    this.pickedItems += 1;

    if (item.aiStrict === true) this.aiStrictCount += 1;
    if (item.offTopic === true) this.offTopicCount += 1;

    // derive hosts from item.url or item.hosts
    const hosts = new Set();

    const directHosts = ensureArray(item.hosts);
    for (const h of directHosts) {
      if (typeof h === "string" && h.trim()) hosts.add(h.replace(/^www\./, "").toLowerCase());
    }

    const hn = tryParseHostname(item.url);
    if (hn) hosts.add(hn);

    for (const h of hosts) this.uniqueHostsSet.add(h);

    // (optional) we could keep tab-level counts too, but avoid bloat for now
    return this;
  }

  /**
   * Record a tab summary once selection is done for that tab.
   * @param {string} tabName
   * @param {object} summary
   * @param {number} summary.itemsPicked
   * @param {boolean} [summary.usedSecondary=false]
   * @param {number}  [summary.freshnessHours=24]
   * @param {string[]} [summary.hosts]  unique hostnames for the tab
   * @param {boolean} [summary.noUpdate] optional override; otherwise inferred from itemsPicked
   * @param {boolean} [summary.thinTab]  optional override; otherwise inferred
   */
  recordTabSummary(tabName, summary = {}) {
    if (!this.started) this.startRun({});
    if (!tabName) throw new Error("recordTabSummary: tabName required");

    const itemsPicked = Number.isFinite(summary.itemsPicked) ? summary.itemsPicked : 0;

    const noUpdate = typeof summary.noUpdate === "boolean" ? summary.noUpdate : (itemsPicked === 0);
    const thinTab =
      typeof summary.thinTab === "boolean"
        ? summary.thinTab
        : (itemsPicked > 0 && itemsPicked < this.thinThreshold);

    const usedSecondary = summary.usedSecondary === true;
    const freshnessHours = Number.isFinite(summary.freshnessHours) ? summary.freshnessHours : 24;

    // track totals
    this.tabsTotal += 1;

    if (!noUpdate && itemsPicked > 0) this.tabsWithContent += 1;
    if (thinTab) this.thinTabs += 1;
    if (noUpdate) this.noUpdateTabs += 1;

    if (usedSecondary) this.usedSecondaryTabs += 1;
    if (freshnessHours > this.maxFreshnessHours) this.maxFreshnessHours = freshnessHours;

    // tab hosts
    const hosts = ensureArray(summary.hosts)
      .filter((h) => typeof h === "string" && h.trim())
      .map((h) => h.replace(/^www\./, "").toLowerCase());

    for (const h of hosts) this.uniqueHostsSet.add(h);

    // keep small detail
    this.tabDetails[tabName] = {
      itemsPicked,
      thinTab,
      noUpdate,
      usedSecondary,
      freshnessHours,
      uniqueHosts: hosts.length,
    };

    return this;
  }

  /**
   * Record an RSS/feed error.
   * @param {object} err
   * @param {string} [err.tab]
   * @param {string} [err.feed]
   * @param {string} [err.message]
   */
  recordRssError(err = {}) {
    if (!this.started) this.startRun({});
    this.rssErrors += 1;
    // We intentionally do not store all errors here (to avoid bloat).
    return this;
  }

  /**
   * Add detected duplicate count (cross-tab or within-tab), from your dedupe logic.
   * @param {number} n
   */
  addDupCount(n) {
    if (!this.started) this.startRun({});
    const add = Number.isFinite(n) ? n : 0;
    if (add > 0) this.dupCount += add;
    return this;
  }

  /**
   * Build the daily metrics object that will be written to disk.
   */
  buildMetricsObject() {
    if (!this.started) this.startRun({});

    const uniqueHosts = this.uniqueHostsSet.size;

    return {
      date: this.dateStr,
      // Run-level
      runSuccess: this.runSuccess, // will be 1 after successful finalizeAndWrite
      tabsPlanned: this.tabsPlanned,
      tabsTotal: this.tabsTotal,
      tabsWithContent: this.tabsWithContent,
      thinTabs: this.thinTabs,
      noUpdateTabs: this.noUpdateTabs,

      // Reliability-ish
      rssErrors: this.rssErrors,
      usedSecondaryTabs: this.usedSecondaryTabs,
      maxFreshnessHours: this.maxFreshnessHours,
      uniqueHosts,

      // Quality-ish
      pickedItems: this.pickedItems,
      aiStrictCount: this.aiStrictCount,
      offTopicCount: this.offTopicCount,
      dupCount: this.dupCount,

      // Optional details (small, safe)
      tabDetails: this.tabDetails,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Ensure metrics directory exists.
   */
  async ensureDirs() {
    await fsp.mkdir(this.metricsDir, { recursive: true });
    await fsp.mkdir(path.dirname(this.latestPath), { recursive: true });
  }

  /**
   * Write daily snapshot + latest file.
   * Sets runSuccess=1 only if both writes succeed.
   */
  async finalizeAndWrite() {
    if (!this.started) this.startRun({});

    await this.ensureDirs();

    // Build first with runSuccess=0; then set to 1 when write completes.
    this.runSuccess = 0;

    const dailyPath = path.join(this.metricsDir, `metrics-${this.dateStr}.json`);

    const obj0 = this.buildMetricsObject();
    await atomicWriteJson(dailyPath, obj0);

    // now mark success and write latest
    this.runSuccess = 1;
    const obj1 = this.buildMetricsObject();

    await atomicWriteJson(this.latestPath, obj1);

    return { dailyPath, latestPath: this.latestPath };
  }
}

module.exports = { MetricsCollector };

