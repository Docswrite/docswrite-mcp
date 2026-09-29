// Smoke test: starts the built server over stdio with fake credentials and a
// local fake Docswrite API, then checks the handshake, tool list, request
// payloads and error mapping for both modes (per-site token and org API key).
// Never talks to the real api.docswrite.com.
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const seen = [];

const ORG_KEY = "dw_live_goodKey0123456789abcdefghijklmnop";
const orgSeen = [];
let flaky503 = 1;
const CONNECTIONS = [
  { id: 11, platform: "wordpress", name: "Main blog", status: "connected", capabilities: { publish: true, schedule: true, draft: true, tags: true } },
  { id: 12, platform: "devto", name: "@me on Dev.to", status: "unknown", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 13, platform: "twitter", name: "@me", status: "connected", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 14, platform: "webflow", name: "Marketing site", status: "connected", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 15, platform: "shopify", name: "Store", status: "connected", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 16, platform: "wordpress", name: "Blocked blog", status: "needs_attention", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 17, platform: "ghost", name: "Unpaid", status: "connected", capabilities: { publish: true, schedule: true, draft: true } },
  { id: 18, platform: "github", name: "Docs repo", status: "connected", capabilities: { publish: true, schedule: true, draft: false } },
];
const JOBS = {
  "j11": { id: "j11", state: "completed", returnValue: { error: false, post_url: "https://blog.example.com/?p=5", data: { id: 5 } } },
  "j12": { id: "j12", state: "completed", returnValue: { error: false, post_url: "https://dev.to/me/hello-1a2b" } },
  "j16": { id: "j16", state: "failed", failedReason: "Your site's Cloudflare is blocking Docswrite. Allowlist these IPs: 95.217.144.123, 2a01:4f9:4a:4cc7::2" },
  "j18": { id: "j18", state: "completed", returnValue: { error: false, post_url: "https://github.com/me/docs/blob/main/hello.md" } },
};
const jobPolls = {};

function orgApi(req, res, body) {
  const json = (status, value, headers = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };
  const auth = req.headers.authorization || "";
  const key = auth.replace(/^Bearer /, "");
  const u = new URL(req.url, "http://x");
  orgSeen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
  if (key === "dw_live_revokedKey0123456789abcdefghijk") return json(401, { error: true, code: "API_KEY_REVOKED", message: "This API key was revoked" });
  if (key === "dw_live_cloudflareBlocked0123456789abcd") {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/html");
    res.setHeader("cf-ray", "8c1234abcd-FRA");
    return res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cloudflare</body></html>");
  }
  if (key !== ORG_KEY) return json(401, { error: true, code: "INVALID_API_KEY", message: "Invalid API key" });
  const rl = { "RateLimit-Limit": "60", "RateLimit-Remaining": "59", "RateLimit-Reset": "30" };

  if (req.method === "GET" && u.pathname === "/api/connections") return json(200, { connections: CONNECTIONS }, rl);
  if (req.method === "GET" && u.pathname === "/api/posts") {
    return json(200, {
      posts: [
        { id: "post:5", kind: "post", post_id: 5, job_id: null, title: "Hello", connection: { id: 11, platform: "wordpress", name: "Main blog" }, status: "published", url: "https://blog.example.com/?p=5", scheduled_for: null, published_at: "2026-09-29T10:00:00.000000Z", created_at: "2026-09-29T09:59:00.000000Z", google_doc_id: "doc", secret_field: "nope" },
        { id: "post:77", kind: "post", post_id: 77, job_id: null, title: "Later", connection: { id: 14, platform: "webflow", name: "Marketing site" }, status: "scheduled", url: null, scheduled_for: "2030-01-01T09:00:00.000000Z", published_at: null, created_at: "2026-09-29T09:59:00.000000Z", google_doc_id: "doc" },
      ],
      next_cursor: null,
      has_more: false,
    }, rl);
  }
  if (req.method === "POST" && u.pathname === "/api/posts") {
    const id = Number(body.connection_id);
    if (id === 11 && flaky503-- > 0) return json(503, { error: true, message: "upstream busy" });
    if (id === 17) return json(402, { error: true, code: "PLAN_LIMIT", message: "Your plan's publishing limit is reached" });
    if (id === 14) return json(200, { error: false, queued: false, scheduled: true, post_id: 77, publish_date: "2030-01-01T09:00:00.000Z" }, rl);
    return json(200, { error: false, jobId: `j${id}`, queued: true }, rl);
  }
  if (req.method === "POST" && u.pathname === "/api/job/status") {
    if (body.queueType !== "publish") return json(400, { success: false, error: "wrong queue" });
    const job = JOBS[body.jobId];
    if (!job) return json(404, { success: false, error: "Job not found" });
    jobPolls[body.jobId] = (jobPolls[body.jobId] || 0) + 1;
    // First poll: still running.
    if (jobPolls[body.jobId] === 1) return json(200, { success: true, data: { id: job.id, state: "active", progress: 50 } }, rl);
    return json(200, { success: true, data: job }, rl);
  }
  return json(404, { error: true, message: "no route" });
}

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer dw_live_")) return orgApi(req, res, JSON.parse(body || "{}"));
    seen.push({ url: req.url, token: req.headers["x-access-token"], body: JSON.parse(body || "{}") });
    res.setHeader("Content-Type", "application/json");
    if (req.headers["x-access-token"] !== "good-token") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: true, message: "Unauthenticated" }));
    }
    if (req.url === "/api/export") {
      return res.end(JSON.stringify({ error: false, message: "Post added to queue", data: { jobId: "42", sub_domain: "example", state: "published", user: { password: "secret-hash" } } }));
    }
    return res.end(JSON.stringify({ success: true, data: { id: "42", state: "failed", failedReason: "WordPress REST API returned 403" } }));
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${api.address().port}`;

function startServer(argv, env = {}) {
  const child = spawn(process.execPath, [entry, ...argv], {
    env: {
      ...process.env, DOCSWRITE_TOKEN: "", GOOGLE_CREDENTIALS_PATH: "/nonexistent", DOCSWRITE_API_BASE: base,
      DOCSWRITE_POLL_INTERVAL_MS: "20", DOCSWRITE_RETRY_DELAY_MS: "10", ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  let stdoutGarbage = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { stdoutGarbage.push(line); continue; }
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      pending.set(myId, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, request, notify, garbage: () => stdoutGarbage };
}

async function handshake(s) {
  const init = await s.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  s.notify("notifications/initialized");
  return init;
}

const callText = (r) => r.result.content.map((c) => c.text).join("\n");

// 1. Space-separated flag, bad token: tools list + 401 mapping.
{
  const s = startServer(["--docswriteToken", "fake-token"]);
  const init = await handshake(s);
  assert.equal(init.result.serverInfo.name, "docswrite-mcp");
  const tools = (await s.request("tools/list")).result.tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  assert.deepEqual(tools.sort(), ["docswrite-job-status", "docswrite-publish"]);
  const r = await s.request("tools/call", { name: "docswrite-publish", arguments: { google_docs_url: "https://docs.google.com/document/d/abc/edit" } });
  assert.equal(r.result.isError, true);
  assert.match(callText(r), /token was rejected/);
  assert.equal(seen.at(-1).token, "fake-token");
  assert.equal(seen.at(-1).url, "/api/export", "token must not be in the query string");
  assert.equal(seen.at(-1).body.state, "draft");
  assert.deepEqual(s.garbage(), [], "stdout must only carry JSON-RPC");
  s.child.kill();
}

// 2. --flag=value form, good token, "publish" alias, job failure hint.
{
  const s = startServer(["--docswriteToken=good-token"]);
  await handshake(s);
  const r = await s.request("tools/call", { name: "docswrite-publish", arguments: { google_docs_url: "https://docs.google.com/document/d/abc/edit", state: "publish" } });
  assert.notEqual(r.result.isError, true, callText(r));
  const out = JSON.parse(callText(r));
  assert.equal(out.jobId, "42");
  assert.ok(!callText(r).includes("secret-hash"), "must not echo the user object");
  assert.equal(seen.at(-1).body.state, "published");
  const st = await s.request("tools/call", { name: "docswrite-job-status", arguments: { jobId: "42" } });
  assert.equal(st.result.isError, true);
  assert.match(callText(st), /WordPress sites only/);
  s.child.kill();
}

// 3. DOCSWRITE_TOKEN env var.
{
  const s = startServer([], { DOCSWRITE_TOKEN: "good-token" });
  await handshake(s);
  const r = await s.request("tools/call", { name: "docswrite-job-status", arguments: { jobId: "42" } });
  assert.equal(seen.at(-1).token, "good-token");
  assert.ok(r.result);
  s.child.kill();
}

// 4. No token: exits 1 with a helpful message.
{
  const s = startServer([]);
  let err = "";
  s.child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => s.child.on("exit", r));
  assert.equal(code, 1);
  assert.match(err, /token is required/);
}


// 5. Org API key: tool list, connections, headers.
const orgCall = async (s, name, args) => s.request("tools/call", { name, arguments: args });
{
  const s = startServer(["--docswriteToken", ORG_KEY]);
  await handshake(s);
  const tools = (await s.request("tools/list")).result.tools.map((t) => t.name);
  console.log("org tools:", tools.join(", "));
  assert.deepEqual(tools.sort(), ["docswrite-get-post-status", "docswrite-list-connections", "docswrite-list-posts", "docswrite-publish-post"]);

  const lc = await orgCall(s, "docswrite-list-connections", {});
  assert.notEqual(lc.result.isError, true, callText(lc));
  const conns = JSON.parse(callText(lc));
  assert.equal(conns.count, CONNECTIONS.length);
  const tw = conns.connections.find((c) => c.id === "13");
  assert.equal(tw.api.publishable_via_api, false);
  const dev = conns.connections.find((c) => c.id === "12");
  assert.deepEqual(dev.api.options, ["tags", "canonical_url", "excerpt", "featured_image_url"]);
  const gh = conns.connections.find((c) => c.id === "18");
  assert.ok(!gh.api.states.includes("draft"));
  const req0 = orgSeen.at(-1);
  assert.equal(req0.headers.authorization, `Bearer ${ORG_KEY}`);
  assert.equal(req0.headers["x-access-token"], undefined);
  assert.ok(!JSON.stringify(req0.query).includes("dw_live_"), "key must not be in the URL");

  // 6. Publish to many connections: payloads, idempotency, retries, awaiting, per-connection errors.
  orgSeen.length = 0;
  const pub = await orgCall(s, "docswrite-publish-post", {
    connection_ids: ["11", "12", "13", "16", "17", "999", "15"],
    google_doc: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789/edit",
    state: "publish",
    tags: "one, two, three, four, five",
    canonical_url: "https://example.com/original",
    excerpt: "Short summary",
    idempotency_key: "run-1",
    wait_seconds: 5,
  });
  const out = JSON.parse(callText(pub));
  const by = Object.fromEntries(out.results.map((r) => [r.connection_id, r]));
  assert.equal(by["11"].status, "published", JSON.stringify(by["11"]));
  assert.equal(by["11"].url, "https://blog.example.com/?p=5");
  assert.equal(by["12"].status, "published");
  assert.equal(by["12"].url, "https://dev.to/me/hello-1a2b");
  assert.equal(by["13"].status, "skipped");
  assert.match(by["13"].error, /cannot be published to through the API/);
  assert.equal(by["16"].status, "failed");
  assert.match(by["16"].error, /Cloudflare is blocking Docswrite/);
  assert.match(by["16"].hint, /Allowlist/);
  assert.equal(by["17"].status, "failed");
  assert.equal(by["17"].error_code, "PLAN_LIMIT");
  assert.match(by["17"].error, /plan limit reached/);
  assert.equal(by["999"].error_code, "CONNECTION_NOT_FOUND");
  assert.equal(by["15"].status, "skipped", "Shopify has no canonical_url/excerpt");
  assert.match(by["15"].error, /canonical_url, excerpt are not supported for Shopify/);
  assert.equal(out.summary.ok, 2);
  assert.equal(out.idempotency_key, "run-1");

  const posts = orgSeen.filter((r) => r.method === "POST" && r.path === "/api/posts");
  assert.ok(!posts.some((p) => [13, 15, 999].includes(Number(p.body.connection_id))), "skipped connections must not be called");
  const wp = posts.filter((p) => p.body.connection_id === 11);
  assert.equal(wp.length, 2, "a 503 is retried once");
  assert.equal(wp[0].headers["idempotency-key"], "run-1:11");
  assert.equal(wp[1].headers["idempotency-key"], "run-1:11", "retries reuse the Idempotency-Key");
  assert.deepEqual(wp[1].body, {
    connection_id: 11,
    google_doc_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789",
    destination: "wordpress",
    tags: "one, two, three, four, five",
    excerpt: "Short summary",
    yoast_settings: { yoast_canonical: "https://example.com/original" },
    state: "published",
  });
  const dv = posts.find((p) => p.body.connection_id === 12);
  assert.deepEqual(dv.body, {
    connection_id: 12,
    google_doc_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789",
    destination: "devto",
    tags: ["one", "two", "three", "four"],
    excerpt: "Short summary",
    data: { devto: { tags: ["one", "two", "three", "four"], canonical_url: "https://example.com/original", description: "Short summary" } },
    state: "published",
  });
  const polls = orgSeen.filter((r) => r.path === "/api/job/status");
  assert.ok(polls.every((p) => p.body.queueType === "publish"));

  // 7. Scheduled publish held by the Docswrite scheduler (no job id), composer mode fields.
  orgSeen.length = 0;
  const sch = await orgCall(s, "docswrite-publish-post", {
    connection_ids: "14",
    google_doc: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789",
    state: "scheduled",
    publish_date: "2030-01-01T10:00",
    timezone: "Europe/Berlin",
    platform_options: { webflow: { collection_id: "col1" } },
  });
  const so = JSON.parse(callText(sch));
  assert.equal(so.results[0].status, "scheduled");
  assert.equal(so.results[0].post_id, 77);
  const sb = orgSeen.find((r) => r.path === "/api/posts").body;
  assert.equal(sb.state, "draft");
  assert.equal(sb.date, "2030-01-01T10:00");
  assert.equal(sb.publish_date, "2030-01-01T10:00");
  assert.equal(sb.publish_timezone, "Europe/Berlin");
  assert.deepEqual(sb.data, { webflow: { collection_id: "col1", field_mappings: {}, custom_values: {} } });
  assert.match(orgSeen.find((r) => r.path === "/api/posts").headers["idempotency-key"], /^[0-9a-f-]{36}:14$/);

  // Webflow without a collection, GitHub draft, past schedule, bad doc: refused locally.
  const wf = JSON.parse(callText(await orgCall(s, "docswrite-publish-post", { connection_ids: ["14", "18"], google_doc: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789" })));
  assert.match(wf.results[0].error, /collection_id/);
  assert.match(wf.results[1].error, /do not support drafts/);
  const past = await orgCall(s, "docswrite-publish-post", { connection_ids: "11", google_doc: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789", state: "scheduled", publish_date: "2020-01-01T00:00:00Z" });
  assert.equal(past.result.isError, true);
  assert.match(callText(past), /in the past/);
  const badDoc = await orgCall(s, "docswrite-publish-post", { connection_ids: "11", google_doc: "not a doc" });
  assert.equal(badDoc.result.isError, true);

  // wait_seconds: 0 returns the job id; get-post-status follows it.
  const q = JSON.parse(callText(await orgCall(s, "docswrite-publish-post", { connection_ids: "18", google_doc: "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789", state: "published", wait_seconds: 0 })));
  assert.equal(q.results[0].status, "publishing");
  assert.equal(q.results[0].job_id, "j18");
  const st0 = JSON.parse(callText(await orgCall(s, "docswrite-get-post-status", { job_id: "j18" })));
  assert.equal(st0.status, "publishing");
  const st = JSON.parse(callText(await orgCall(s, "docswrite-get-post-status", { job_id: "j18" })));
  assert.equal(st.status, "completed");
  assert.equal(st.url, "https://github.com/me/docs/blob/main/hello.md");

  // 8. list-posts filters and post lookup.
  orgSeen.length = 0;
  const lp = JSON.parse(callText(await orgCall(s, "docswrite-list-posts", { connection_ids: ["11", "14"], status: ["published", "scheduled"], from: "2026-09-01", limit: 10 })));
  assert.equal(lp.count, 2);
  assert.equal(lp.posts[0].secret_field, undefined);
  assert.deepEqual(orgSeen[0].query, { connection_ids: "11,14", status: "published,scheduled", from: "2026-09-01", limit: "10" });
  const ps = JSON.parse(callText(await orgCall(s, "docswrite-get-post-status", { post_id: "77" })));
  assert.equal(ps.status, "scheduled");
  assert.deepEqual(s.garbage(), []);
  s.child.kill();
}

// 9. Org key errors: invalid, revoked, Cloudflare block.
for (const [key, re] of [
  ["dw_live_badKey0123456789abcdefghijklmnopq", /API key was rejected/],
  ["dw_live_revokedKey0123456789abcdefghijk", /was revoked/],
  ["dw_live_cloudflareBlocked0123456789abcd", /Cloudflare .*blocked it.*8c1234abcd-FRA/],
]) {
  const s = startServer([], { DOCSWRITE_TOKEN: key });
  await handshake(s);
  const r = await orgCall(s, "docswrite-list-connections", {});
  assert.equal(r.result.isError, true);
  assert.match(callText(r), re);
  s.child.kill();
}

api.close();
console.log("smoke test passed");
