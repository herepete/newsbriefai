// scripts/feedbackServer.cjs
// Local-only feedback collector (no auth, no IP storage)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3001;
const HOST = "127.0.0.1";

const DATA_DIR = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "feedback"
);

fs.mkdirSync(DATA_DIR, { recursive: true });

// Very small rate limiter (global)
let recentHits = [];
function allowRequest() {
  const now = Date.now();
  recentHits = recentHits.filter(t => now - t < 60_000);
  if (recentHits.length > 30) return false;
  recentHits.push(now);
  return true;
}

function todayYMD() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 10_000) reject(new Error("Payload too large"));
    });
    req.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/feedback") {
    res.writeHead(404);
    return res.end();
  }

  if (!allowRequest()) {
    res.writeHead(429);
    return res.end("Rate limited");
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);

    const { ymd, tab, vote, anonId } = body;

    if (
      !ymd ||
      !tab ||
      !anonId ||
      !["up", "down"].includes(vote)
    ) {
      res.writeHead(400);
      return res.end("Invalid payload");
    }

    const filePath = path.join(DATA_DIR, `feedback-${ymd}.json`);
    let payload = { votes: [] };

    if (fs.existsSync(filePath)) {
      payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    // Overwrite existing vote for same anonId + tab
    payload.votes = payload.votes.filter(
      v => !(v.anonId === anonId && v.tab === tab)
    );

    payload.votes.push({
      ymd,
      tab,
      vote,
      anonId,
      createdAt: new Date().toISOString(),
    });

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    res.writeHead(204);
    res.end();
  } catch (err) {
    res.writeHead(500);
    res.end("Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Feedback server listening on http://${HOST}:${PORT}`);
});

