// Smoke test: starts the built server over stdio with a fake token and a local
// fake Docswrite API, then checks the handshake, tool list, and error mapping.
// Never talks to the real api.docswrite.com.
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const seen = [];

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
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
    env: { ...process.env, DOCSWRITE_TOKEN: "", GOOGLE_CREDENTIALS_PATH: "/nonexistent", DOCSWRITE_API_BASE: base, ...env },
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

api.close();
console.log("smoke test passed");
