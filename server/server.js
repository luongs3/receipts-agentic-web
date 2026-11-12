// Receipts Network host. Node 22, zero dependencies.
// Serves the Receipts agentic website (static), a public MCP server that verifies a quote
// against the page it cites, a public receipt lookup, and an optional default LLM router
// so visitors without a key can still try the sites.
//
//   GET  /                      the Receipts site (agent-manifest.json, network, runtime)
//   POST /mcp                   MCP (JSON-RPC 2.0, protocol 2025-06-18): verify_quote, get_receipt
//   GET  /receipt/<id>          a stored verification receipt (public JSON)
//   POST /llm/v1/chat/completions  default inference: OpenAI-compatible pass-through to a
//                               publisher-funded model. Rate limited per IP.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8823);
const HOST = process.env.HOST || "127.0.0.1";
const SITE = process.env.SITE_DIR || path.join(__dirname, "..", "receipts-site");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const RECEIPT_SECRET = process.env.RECEIPT_SECRET || "dev-only-secret";
const LLM_UPSTREAM = process.env.LLM_UPSTREAM || "https://generativelanguage.googleapis.com/v1beta/openai";
const LLM_KEY = process.env.LLM_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gemma-4-26b-a4b-it";
const LLM_PER_IP_HOUR = Number(process.env.LLM_PER_IP_HOUR || 120);
fs.mkdirSync(path.join(DATA, "receipts"), { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".hocon": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};
// Public agent artifacts other origins must be able to read (spec 3.3).
const PUBLIC_ARTIFACT = /(^|\/)(agent-manifest\.json|[a-z0-9_]+\.network\.json|links\.json|agent-mcp\.json|nsdeploy(-agent)?\.json|agent-card\.json)$/;

// ---------- quote verification (same verifier as luongs3/receipts) ----------
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#(?:39|x27);/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();
}
const norm = (s) => s.toLowerCase().replace(/[“”"'‘’`]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Ordered token agreement (LCS ratio) over a sliding window. Paraphrases and fabricated
// quotes score low; verbatim quotes with punctuation drift score high.
function lcsLen(a, b) {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}
function bestMatch(pageText, quote) {
  const q = norm(quote);
  const t = norm(pageText);
  if (!q) return { similarity: 0, snippet: "" };
  if (t.includes(q)) {
    const i = t.indexOf(q);
    return { similarity: 1, snippet: t.slice(Math.max(0, i - 80), i + q.length + 80) };
  }
  const qTok = q.split(" ");
  const tTok = t.split(" ");
  const win = qTok.length + 2;
  const qSet = new Set(qTok);
  const cands = [];
  for (let i = 0; i + qTok.length <= tTok.length; i += Math.max(1, Math.floor(qTok.length / 3))) {
    let hit = 0;
    for (let j = 0; j < win && i + j < tTok.length; j++) if (qSet.has(tTok[i + j])) hit++;
    if (hit / qTok.length >= 0.4) cands.push([hit, i]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  let best = 0;
  let bestAt = 0;
  for (const [, i] of cands.slice(0, 40)) {
    const s = lcsLen(qTok, tTok.slice(i, i + win)) / qTok.length;
    if (s > best) { best = s; bestAt = i; }
  }
  const snippet = tTok.slice(Math.max(0, bestAt - 12), bestAt + win + 12).join(" ");
  return { similarity: Math.round(best * 100) / 100, snippet };
}

const THRESHOLD = 0.8;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[::1\]|\[f[cd])/i;
async function verify(url, quote) {
  let u;
  try {
    u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
  } catch {
    return { status: "unverifiable", reason: "invalid URL", similarity: 0 };
  }
  if (PRIVATE_HOST.test(u.hostname)) return { status: "unverifiable", reason: "private host blocked", similarity: 0 };
  if (!quote || quote.trim().split(/\s+/).length < 3) return { status: "unverifiable", reason: "quote must be at least 3 words", similarity: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, {
      signal: ctl.signal, redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ReceiptsVerifier/2.0; +https://deploytest.theodoikenh.com/oaw-receipts/)",
        "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) return { status: "unverifiable", reason: `source returned HTTP ${r.status}`, similarity: 0, httpStatus: r.status };
    const raw = (await r.text()).slice(0, 3_000_000);
    const text = /html|xml/.test(ct) ? stripHtml(raw) : raw.replace(/\s+/g, " ");
    if (text.length < 40) return { status: "unverifiable", reason: "page has no readable text (JS-rendered or empty)", similarity: 0, httpStatus: r.status };
    const m = bestMatch(text, quote);
    const ok = m.similarity >= THRESHOLD;
    return {
      status: ok ? "verified" : "rejected",
      reason: ok ? "quote found on the cited page" : `quote not found on the cited page (best overlap ${Math.round(m.similarity * 100)}%)`,
      similarity: m.similarity, snippet: m.snippet.slice(0, 400), httpStatus: r.status, finalUrl: r.url, pageChars: text.length,
    };
  } catch (e) {
    return { status: "unverifiable", reason: e.name === "AbortError" ? "source timed out (12 s)" : `fetch failed: ${e.message}`, similarity: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- receipts: signed, stored, publicly re-readable ----------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function issueReceipt(url, quote, result) {
  const checkedAt = new Date().toISOString();
  const body = { url, quote, quoteSha256: sha(norm(quote)), checkedAt, ...result };
  const id = "rcpt_" + crypto.createHmac("sha256", RECEIPT_SECRET).update(JSON.stringify(body)).digest("hex").slice(0, 20);
  const receipt = { id, issuer: "receipts-network", ...body };
  fs.writeFileSync(path.join(DATA, "receipts", `${id}.json`), JSON.stringify(receipt, null, 1));
  return receipt;
}
function readReceipt(id) {
  if (!/^rcpt_[a-f0-9]{20}$/.test(id)) return null;
  const p = path.join(DATA, "receipts", `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// ---------- MCP ----------
const MCP_TOOLS = [
  {
    name: "verify_quote",
    description: "Fetch the cited web page and check that the quoted passage really appears on it. Returns a stored receipt: id, status (verified | rejected | unverifiable), reason, similarity 0-1 and the matching snippet from the page. Never assume a citation is real without this.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url", "quote"],
      properties: {
        url: { type: "string", description: "The http(s) URL the claim cites." },
        quote: { type: "string", description: "The exact passage the claim says appears on that page, at least 3 words." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_receipt",
    description: "Read a receipt issued earlier by verify_quote, by its id.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: { id: { type: "string", description: "Receipt id such as rcpt_0123456789abcdef0123." } },
    },
    annotations: { readOnlyHint: true },
  },
];
async function mcpCall(name, args) {
  if (name === "verify_quote") {
    const url = String(args?.url || "").slice(0, 2000);
    const quote = String(args?.quote || "").slice(0, 1000);
    return issueReceipt(url, quote, await verify(url, quote));
  }
  if (name === "get_receipt") {
    return readReceipt(String(args?.id || "")) || { error: "no receipt with that id" };
  }
  throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
}
async function handleMcp(req, res) {
  const msg = JSON.parse(await readBody(req) || "{}");
  const sid = req.headers["mcp-session-id"] || crypto.randomUUID();
  const headers = { "content-type": "application/json", "mcp-session-id": sid, "cache-control": "no-store" };
  if (msg.id === undefined) { res.writeHead(202, headers); return res.end(); }
  const reply = (result) => { res.writeHead(200, headers); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
  const fail = (code, message) => { res.writeHead(200, headers); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } })); };
  try {
    if (msg.method === "initialize") {
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "receipts-network", version: "1.0.0" } });
    }
    if (msg.method === "tools/list") return reply({ tools: MCP_TOOLS });
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/call") {
      const out = await mcpCall(msg.params?.name, msg.params?.arguments || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
    }
    return fail(-32601, `method not found: ${msg.method}`);
  } catch (e) {
    return fail(e.rpc || -32603, e.message);
  }
}

// ---------- default inference (publisher-funded, rate limited) ----------
const hits = new Map();
function allowLlm(ip) {
  const hour = Math.floor(Date.now() / 3600000);
  const k = `${ip}:${hour}`;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) hits.clear();
  return n <= LLM_PER_IP_HOUR;
}
async function handleLlm(req, res, sub) {
  if (sub === "models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "receipts-default", object: "model", owned_by: "receipts-network" }] }));
  }
  if (sub !== "chat/completions" || req.method !== "POST") { res.writeHead(404); return res.end(); }
  if (!LLM_KEY) { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "default inference is not configured; add your own key in BYOK settings" } })); }
  const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress);
  if (!allowLlm(ip)) { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "free demo quota reached for this hour; add your own key in BYOK settings" } })); }
  const body = JSON.parse(await readBody(req) || "{}");
  // The publisher pays, so the publisher picks the model. Messages and tools pass through.
  // Upstream is called without streaming: Gemini's streamed tool calls carry no
  // per-call index, so two calls in one reply would merge into one. The reply is
  // then sent in the shape the caller asked for, with each call indexed.
  const upstreamBody = { model: LLM_MODEL, messages: body.messages };
  if (Array.isArray(body.tools) && body.tools.length) { upstreamBody.tools = body.tools; upstreamBody.tool_choice = body.tool_choice || "auto"; }
  if (process.env.LLM_DEBUG) fs.appendFileSync(path.join(DATA, "llm-req.jsonl"), JSON.stringify(upstreamBody) + "\n");
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const up = await fetch(`${LLM_UPSTREAM}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify(upstreamBody),
    });
    if (up.ok) {
      const reply = cleanReply(await up.json());
      const headers = { "cache-control": "no-store", "x-nsdeploy-llm-route": "publisher-default" };
      if (!body.stream) {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        return res.end(JSON.stringify(reply));
      }
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      const choice = reply.choices?.[0] || {};
      const message = choice.message || {};
      const delta = { role: "assistant" };
      if (message.content) delta.content = message.content;
      if (message.tool_calls?.length) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
      const chunk = { id: reply.id, object: "chat.completion.chunk", created: reply.created, model: reply.model,
        choices: [{ index: 0, delta, finish_reason: choice.finish_reason || "stop" }], usage: reply.usage };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    lastStatus = up.status;
    lastText = await up.text();
    if (process.env.LLM_DEBUG) fs.writeFileSync(path.join(DATA, "last-llm-fail.json"), JSON.stringify(upstreamBody, null, 1));
    if (up.status !== 503 && up.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  res.writeHead(lastStatus || 502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `default model unavailable (${lastStatus}): ${lastText.slice(0, 200)}` } }));
}

// Gemma writes its reasoning inline as <thought>...</thought>. Visitors see only the answer.
function cleanReply(reply) {
  const message = reply.choices?.[0]?.message;
  if (message && typeof message.content === "string") {
    message.content = message.content.replace(/<thought>[\s\S]*?<\/thought>/g, "").replace(/^[\s\S]*<\/thought>/, "").trim();
  }
  return reply;
}

// ---------- http ----------
async function readBody(req) {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 2e6) throw new Error("body too large");
  }
  return s;
}
function cors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version");
  res.setHeader("access-control-expose-headers", "mcp-session-id, x-nsdeploy-llm-route");
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  const headers = { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" };
  if (PUBLIC_ARTIFACT.test(rel)) headers["access-control-allow-origin"] = "*";
  if (rel.endsWith("runtime/sandbox-worker.js")) headers["content-security-policy"] = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/mcp" || u.pathname.startsWith("/receipt/") || u.pathname.startsWith("/llm/")) {
      cors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (u.pathname === "/mcp") {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
        return await handleMcp(req, res);
      }
      if (u.pathname.startsWith("/receipt/")) {
        const r = readReceipt(u.pathname.slice("/receipt/".length));
        res.writeHead(r ? 200 : 404, { "content-type": "application/json", "cache-control": "public, max-age=60" });
        return res.end(JSON.stringify(r || { error: "no receipt with that id" }));
      }
      return await handleLlm(req, res, u.pathname.replace(/^\/llm\/v1\//, ""));
    }
    if (u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (req.method === "OPTIONS") { cors(req, res); res.writeHead(204); return res.end(); }
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`receipts-network on http://${HOST}:${PORT}`));

export { verify, bestMatch };
