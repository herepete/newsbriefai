# newsbriefai

# NewsBriefAI – Architecture & Daily Workflow

This project generates a fully static AI news site once per day.
There is no runtime rendering, no database, and no server-side templating at request time.

Everything below describes how the system fits together.

---

## Daily Workflow (1-minute read)

The site is regenerated once per day via cron.

There is no live content generation when users visit the site.

### 1) Content generation (Node.js)

File:
scripts/generate.js

What it does:
- Fetches RSS and Atom feeds per tab (UK, Business, Work, Global, Security, Ethics, Today in Tech)
- Applies freshness windows (24h → 36h → 48h only if needed)
- Filters off-topic and weakly-related items
- Deduplicates stories across tabs using a fixed priority order
- Calls OpenAI to generate:
  - One-line summary
  - “Why it matters” bullets
  - Explainer section
  - Tags
- Produces static output files:
  - public/index.html
  - public/archive/YYYY-MM-DD.html
  - public/archive/index.html
  - public/about.html
  - public/changelog.html
- Writes structured JSON for reuse and debugging:
  - public/data/tabs.json

---

### 2) Metrics and quality tracking (Python)

File:
scripts/metrics_trends.py

What it does:
- Reads per-run metrics emitted by generate.js
- Tracks:
  - Coverage depth per tab
  - Feed failures and retries
  - Strict vs relaxed AI relevance
  - Off-topic suppression
  - Cross-tab duplication
- Outputs:
  - public/data/metrics/metrics-YYYY-MM-DD.json
  - public/data/metrics/metrics-latest.json
  - CSV + JSON trend summaries

Metrics are for diagnostics and insight only.
They do not affect page rendering.

---

### 3) Site interest analysis (Python)

File:
scripts/apache_intrest.py

What it does:
- Parses Apache access logs
- Separates likely human traffic from automated noise
- Produces daily interest summaries
- Outputs results to log files only

No runtime dependency for the website.

---

### 4) Feedback capture (Node.js, minimal)

File:
scripts/feedbackServer.cjs

What it does:
- Handles POST requests to:
  /api/feedback
- Accepts thumbs up / thumbs down votes per tab
- Writes feedback to flat files under:
  public/data/feedback/
- No cookies, no tracking, no database

Frontend feedback is optimistic:
users see confirmation immediately.

---

### 5) Backup and housekeeping (cron)

What happens daily:
- Full site directory is copied:
  /home/bitnami/htdocs → /home/bitnami/backups/htdocs_YYYY-MM-DD_HHMMSS
- Cron configuration is backed up alongside content
- Backups older than 28 days are deleted automatically
- All cron output is logged under:
  /home/bitnami/htdocs/logs/

---

### 6) Serving (Apache)

How the site is served:
- Apache serves static HTML only
- No server-side rendering
- No database
- One dynamic endpoint exists:
  POST /api/feedback
- Everything else is plain static files

---

## File Structure Overview

Top-level layout (simplified):

/home/bitnami/htdocs
├── public/ # All user-facing static output
│ ├── index.html
│ ├── archive/
│ ├── about.html
│ ├── changelog.html
│ └── data/
│ ├── tabs.json
│ ├── metrics/
│ └── feedback/
│
├── scripts/ # All automation and generation logic
│ ├── generate.js
│ ├── metricsCollector.cjs
│ ├── metrics_trends.py
│ ├── apache_intrest.py
│ ├── feedbackServer.cjs
│ └── check_generate.sh
│
├── templates/ # HTML templates
│ └── index.template.html
│
├── data/ # Generator state
│ ├── seen.json
│ ├── seen.*.json
│ └── changelog.json
│
├── logs/ # Cron and script logs
│
└── node_modules/ # Node dependencies (dev + runtime)

---

## Architecture Overview

High-level design principles:
- Static-first
- Deterministic daily builds
- No runtime AI calls
- Minimal attack surface
- Easy to debug via logs and JSON

---

## ASCII Architecture Diagram

+---------------------+
|      cron           |
|---------------------|
| generate.js         |
| metrics_trends.py   |
| apache_intrest.py   |
| backups + cleanup   |
+----------+----------+
           |
           v
+---------------------+
|   Node.js Generator |
|---------------------|
| - RSS ingestion     |
| - Filtering         |
| - Deduplication     |
| - OpenAI prompts    |
| - HTML + JSON write |
+----------+----------+
           |
           v
+---------------------+
|    Static Output    |
|---------------------|
| public/index.html   |
| public/archive/*    |
| public/data/*       |
+----------+----------+
           |
           v
+---------------------+
|  Apache Web Server  |
|---------------------|
| - Serves static     |
| - POST /api/feedback|
+----------+----------+
           |
           v
+---------------------+
|  Flat-file Storage  |
|---------------------|
| public/data/feedback|
+---------------------+

---

## Summary

- One daily cron-driven build
- Static HTML only
- No database
- No runtime AI calls
- Simple feedback capture
- Strong separation between generation and serving
- Designed for clarity, auditability, and low operational overhead

