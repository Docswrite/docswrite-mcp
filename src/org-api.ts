/**
 * Org API key mode (`dw_live_…`): one key reaches every connection of the
 * organization, as in Zernio (key -> list accounts -> post to any of them).
 *
 *   GET  /api/connections          the org's connections
 *   POST /api/posts                publish a Google Doc to one connection (Idempotency-Key)
 *   POST /api/job/status           { jobId, queueType: 'publish' } until completed/failed
 *   GET  /api/posts                the org's posts across connections
 */
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { textResult, ToolResult } from './utils.js';
import {
    Connection, PublishInput, blockerFor, buildPostBody, describeSupport,
} from './platforms.js';

export const ORG_KEY_PREFIX = 'dw_live_';
export const isOrgKey = (token: string) => token.startsWith(ORG_KEY_PREFIX);

const KEYS_URL = `${config.DOCSWRITE_APP_URL}/dashboard/api-keys`;
const KEY_HELP = `Create or regenerate an org API key in Docswrite (${KEYS_URL}) and restart the MCP server with it (--docswriteToken or DOCSWRITE_TOKEN).`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const envMs = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
};
// Overridable so the smoke test runs in milliseconds.
const POLL_MS = () => envMs('DOCSWRITE_POLL_INTERVAL_MS', 3000);
const RETRY_MS = () => envMs('DOCSWRITE_RETRY_DELAY_MS', 2000);

export interface ApiResponse {
    ok: boolean;
    status: number;
    body: any;
    rawText: string;
    headers: Headers;
}

export class OrgClient {
    constructor(private readonly key: string) {}

    async request(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string } = {}): Promise<ApiResponse> {
        const url = new URL(`${config.DOCSWRITE_API_BASE}${path}`);
        for (const [k, v] of Object.entries(opts.query || {})) {
            if (v === undefined || v === null || v === '') continue;
            url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
        }
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            // Org keys go in the Authorization header, never in the URL.
            'Authorization': `Bearer ${this.key}`,
            'User-Agent': 'docswrite-mcp',
        };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        const response = await fetch(url, {
            method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        const rawText = await response.text();
        let body: any = null;
        try {
            body = rawText ? JSON.parse(rawText) : null;
        } catch {
            body = null;
        }
        return { ok: response.ok, status: response.status, body, rawText, headers: response.headers };
    }
}

function serverMessage(res: ApiResponse): string {
    const b = res.body;
    const msg = b && (typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : null);
    if (msg) return msg;
    if (res.rawText && !looksLikeHtml(res.rawText)) return res.rawText.slice(0, 300);
    return `HTTP ${res.status}`;
}

const looksLikeHtml = (t: string) => /^\s*</.test(t);

/** Cloudflare answered instead of the Docswrite API (bot challenge / WAF block). */
function cloudflareBlock(res: ApiResponse): string | null {
    if (res.body) return null;
    const html = res.rawText || '';
    const challenged = Boolean(res.headers.get('cf-mitigated'));
    const blockPage = (res.status === 403 || res.status === 429 || res.status === 503)
        && looksLikeHtml(html) && /cloudflare|cf-ray|just a moment|attention required/i.test(html);
    if (!challenged && !blockPage) return null;
    const ray = res.headers.get('cf-ray');
    return `The request never reached Docswrite: Cloudflare in front of ${config.DOCSWRITE_API_BASE} blocked it (HTTP ${res.status}, bot/firewall challenge). ` +
        `This is not a problem with your API key. Wait a minute and retry; if it keeps happening from this network, contact support@docswrite.com` +
        `${ray ? ` with Cloudflare Ray ID ${ray}` : ''}.`;
}

const WP_BLOCK_RE = /Your site's (Cloudflare|firewall(?: \([^)]+\))?) is blocking Docswrite/i;

/** Extra advice for a publish failure reason. */
export function failureHint(reason: string): string | undefined {
    if (WP_BLOCK_RE.test(reason)) {
        return 'The destination site\'s Cloudflare/firewall is blocking Docswrite. Allowlist the IP addresses in the message (Cloudflare: Security -> WAF -> Tools -> IP Access Rules -> Allow), then publish again.';
    }
    if (/subscription is not active|free plan|upgrade|plan limit|publishing limit/i.test(reason)) {
        return `The organization's Docswrite plan does not allow this publish. Upgrade at ${config.DOCSWRITE_APP_URL}/pricing.`;
    }
    if (/google|drive|permission|not found.*doc|insufficient/i.test(reason)) {
        return 'Check that the Google Doc exists and is readable by the Docswrite user who created the API key (share it with them, or make it viewable by link).';
    }
    return undefined;
}

/** Map an HTTP failure to { code, message } an assistant can act on. */
export function explainOrgError(action: string, res: ApiResponse): { code: string; message: string } {
    const blocked = cloudflareBlock(res);
    if (blocked) return { code: 'CLOUDFLARE_BLOCKED', message: `${action} failed: ${blocked}` };
    const code: string = res.body?.code || `HTTP_${res.status}`;
    const msg = serverMessage(res);
    const say = (m: string) => ({ code, message: `${action} failed: ${m}` });
    switch (res.status) {
        case 401:
            if (code === 'API_KEY_REVOKED') return say(`this Docswrite API key was revoked. ${KEY_HELP}`);
            if (code === 'API_KEY_EXPIRED') return say(`this Docswrite API key has expired. ${KEY_HELP}`);
            return say(`the Docswrite API key was rejected (${msg}). Check that the whole dw_live_… key was copied. ${KEY_HELP}`);
        case 402:
            return say(`plan limit reached (${msg}). Upgrade the organization's Docswrite plan at ${config.DOCSWRITE_APP_URL}/pricing.`);
        case 403:
            if (code === 'API_KEY_OWNER_INACTIVE') {
                return say(`the admin who created this API key is no longer in the organization. An org admin must regenerate the key (${KEYS_URL}).`);
            }
            if (code === 'ORG_MISMATCH') return say(`this API key belongs to a different organization (${msg}).`);
            if (/subscription is not active|free plan|upgrade/i.test(msg)) {
                return { code: 'PLAN_LIMIT', message: `${action} failed: the organization's plan does not allow this (${msg}). Upgrade at ${config.DOCSWRITE_APP_URL}/pricing.` };
            }
            return say(`access denied (${msg}).`);
        case 404:
            if (code === 'CONNECTION_NOT_FOUND') {
                return say('no connection with that id in this organization. Call docswrite-list-connections for the valid ids.');
            }
            return say(`not found (${msg}).`);
        case 409:
            if (code === 'IDEMPOTENCY_IN_PROGRESS') return say('the same request (same Idempotency-Key) is still running. Wait a few seconds and check docswrite-list-posts.');
            return say(msg);
        case 422:
            if (code === 'IDEMPOTENCY_KEY_REUSED') return say('this idempotency_key was already used with different parameters in the last 24 h. Use a new idempotency_key.');
            return say(msg);
        case 424:
            return say(`${msg} ${failureHint(msg) || ''}`.trim());
        case 429: {
            const after = res.headers.get('retry-after');
            return say(`rate limit reached (60 requests per minute per API key).${after ? ` Retry in ${after} s.` : ''}`);
        }
        case 400:
            return say(`${msg}${code === 'UNSUPPORTED_CONNECTION' ? ' Call docswrite-list-connections to see which connections accept API publishing.' : ''}`);
        default:
            if (res.status >= 500) {
                return say(`Docswrite returned a server error (HTTP ${res.status}: ${msg}). Try again in a minute; if it keeps failing contact support@docswrite.com.`);
            }
            return say(`HTTP ${res.status}: ${msg}`);
    }
}

function networkError(action: string, error: any): string {
    return `${action} failed: could not reach the Docswrite API at ${config.DOCSWRITE_API_BASE} (${error?.message || error}). Check your internet connection and try again.`;
}

const errorResult = (text: string) => textResult(text, true);
const jsonResult = (value: unknown, isError = false) => textResult(JSON.stringify(value, null, 2), isError);

// ---------------------------------------------------------------- connections

async function fetchConnections(client: OrgClient, action: string, query: Record<string, unknown> = {}): Promise<{ connections?: Connection[]; error?: string }> {
    let res: ApiResponse;
    try {
        res = await client.request('GET', '/api/connections', { query });
    } catch (e) {
        return { error: networkError(action, e) };
    }
    if (!res.ok || res.body?.error === true) return { error: explainOrgError(action, res).message };
    const list = Array.isArray(res.body) ? res.body : res.body?.connections;
    return { connections: Array.isArray(list) ? list : [] };
}

export async function listConnections(client: OrgClient, params: { platform?: string; status?: string }): Promise<ToolResult> {
    const { connections, error } = await fetchConnections(client, 'Listing connections', params);
    if (error) return errorResult(error);
    const rows = connections!.map((c) => ({
        id: String(c.id),
        platform: c.platform,
        name: c.name,
        detail: (c as any).detail ?? null,
        status: (c as any).status ?? 'unknown',
        status_message: (c as any).status_message ?? null,
        capabilities: c.capabilities || {},
        api: describeSupport(c),
    }));
    return jsonResult({
        count: rows.length,
        connections: rows,
        note: rows.length
            ? 'Pass one or more ids to docswrite-publish-post as connection_ids. status "unknown" only means it was not checked recently.'
            : `No connections yet. Connect a site at ${config.DOCSWRITE_APP_URL}/dashboard/connections.`,
    });
}

// ---------------------------------------------------------------- publishing

export interface PublishPostParams extends PublishInput {
    connection_ids: string[];
    idempotency_key?: string;
    wait_seconds: number;
}

interface PublishResult {
    connection_id: string;
    platform?: string;
    name?: string;
    status: 'published' | 'draft' | 'scheduled' | 'publishing' | 'failed' | 'skipped';
    url?: string | null;
    job_id?: string;
    post_id?: string | number | null;
    scheduled_for?: string | null;
    error?: string;
    error_code?: string;
    hint?: string;
    image_failures?: unknown[];
    note?: string;
}

function doneStatus(state: string): PublishResult['status'] {
    return state === 'scheduled' ? 'scheduled' : state === 'draft' ? 'draft' : 'published';
}

function fromJob(data: any, state: string): Partial<PublishResult> | null {
    const s = data?.state;
    if (s === 'completed') {
        const rv = data.returnValue || data.post || {};
        const url = rv.post_url || rv.data?.link || rv.data?.url || null;
        const imageFailures = Array.isArray(rv.image_failures) && rv.image_failures.length ? rv.image_failures : undefined;
        return {
            status: doneStatus(state),
            url,
            ...(imageFailures ? { image_failures: imageFailures, note: 'Published, but some images failed to upload.' } : {}),
            ...(state === 'draft' && url ? { note: 'Draft: the URL opens the editor; the public link works once published.' } : {}),
        };
    }
    if (s === 'failed') {
        const reason = data.failedReason || 'Publishing failed';
        const hint = failureHint(reason);
        return { status: 'failed', error: reason, error_code: 'PUBLISH_FAILED', ...(hint ? { hint } : {}) };
    }
    return null;
}

async function jobStatus(client: OrgClient, jobId: string): Promise<{ res?: ApiResponse; error?: string }> {
    try {
        return { res: await client.request('POST', '/api/job/status', { body: { jobId, queueType: 'publish' } }) };
    } catch (e) {
        return { error: networkError('Checking the publish job', e) };
    }
}

async function awaitJob(client: OrgClient, jobId: string, state: string, deadline: number, intervalMs: number): Promise<Partial<PublishResult>> {
    while (Date.now() < deadline) {
        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        const { res } = await jobStatus(client, jobId);
        if (!res) continue; // network blip: keep polling
        if (res.status === 429) {
            const after = Number(res.headers.get('retry-after')) || 5;
            await sleep(Math.min(after * 1000, Math.max(0, deadline - Date.now())));
            continue;
        }
        if (!res.ok || res.body?.success === false) {
            if (res.status >= 500) continue;
            const e = explainOrgError('Checking the publish job', res);
            return { status: 'publishing', error: e.message, error_code: e.code };
        }
        const done = fromJob(res.body?.data ?? res.body, state);
        if (done) return done;
    }
    return {
        status: 'publishing',
        note: `Still publishing. Call docswrite-get-post-status with job_id "${jobId}" in a few seconds.`,
    };
}

async function postWithRetry(client: OrgClient, body: unknown, idempotencyKey: string): Promise<{ res?: ApiResponse; error?: string }> {
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(RETRY_MS());
        let res: ApiResponse;
        try {
            // Same Idempotency-Key on every attempt: a retry never publishes twice.
            res = await client.request('POST', '/api/posts', { body, idempotencyKey });
        } catch (e) {
            lastError = networkError('Publishing', e);
            if (attempt >= 1) break;
            continue;
        }
        const retryable = (res.status >= 502 && res.status <= 504) || (res.status === 409 && res.body?.code === 'IDEMPOTENCY_IN_PROGRESS');
        if (retryable && attempt < 3) continue;
        return { res };
    }
    return { error: lastError || 'Publishing failed' };
}

async function publishOne(client: OrgClient, conn: Connection, input: PublishPostParams, keyBase: string, deadline: number, intervalMs: number): Promise<PublishResult> {
    const base: PublishResult = { connection_id: String(conn.id), platform: conn.platform, name: conn.name, status: 'failed' };
    const blocker = blockerFor(conn, input);
    if (blocker) return { ...base, status: 'skipped', error: blocker, error_code: 'UNSUPPORTED' };

    const body = buildPostBody(conn, input);
    const { res, error } = await postWithRetry(client, body, `${keyBase}:${conn.id}`.slice(0, 255));
    if (!res) return { ...base, error, error_code: 'NETWORK' };
    if (!res.ok || res.body?.error === true) {
        const e = explainOrgError(`Publishing to ${conn.name || conn.id}`, res);
        const hint = failureHint(serverMessage(res));
        return { ...base, error: e.message, error_code: e.code, ...(hint ? { hint } : {}) };
    }

    const jobId = res.body?.jobId ?? res.body?.data?.jobId;
    if (!jobId) {
        // Webflow/Contentful/Shopify/GitHub/articles with a future date: held by the
        // Docswrite scheduler, nothing runs now.
        if (res.body?.scheduled) {
            return { ...base, status: 'scheduled', post_id: res.body.post_id ?? null, scheduled_for: res.body.publish_date ?? null, url: null };
        }
        return { ...base, status: doneStatus(input.state), url: null };
    }
    const job_id = String(jobId);
    if (input.wait_seconds <= 0) {
        return { ...base, status: 'publishing', job_id, note: `Queued. Call docswrite-get-post-status with job_id "${job_id}".` };
    }
    return { ...base, job_id, ...(await awaitJob(client, job_id, input.state, deadline, intervalMs)) } as PublishResult;
}

export async function publishPost(client: OrgClient, params: PublishPostParams): Promise<ToolResult> {
    const ids = [...new Set(params.connection_ids.map((x) => String(x).trim()).filter(Boolean))];
    if (!ids.length) return errorResult('Give at least one connection id in connection_ids. Call docswrite-list-connections to see them.');

    const { connections, error } = await fetchConnections(client, 'Looking up the connections');
    if (error) return errorResult(error);
    const byId = new Map(connections!.map((c) => [String(c.id), c]));

    const keyBase = (params.idempotency_key?.trim() || randomUUID()).slice(0, 200);
    const deadline = Date.now() + params.wait_seconds * 1000;
    // Stay well under the 60 requests/min key limit while polling several jobs.
    const intervalMs = Math.max(POLL_MS(), ids.length > 1 ? ids.length * POLL_MS() * 0.7 : 0);

    const results = await Promise.all(ids.map(async (id): Promise<PublishResult> => {
        const conn = byId.get(id);
        if (!conn) {
            return {
                connection_id: id,
                status: 'skipped',
                error: `No connection "${id}" in this organization. Call docswrite-list-connections for the valid ids.`,
                error_code: 'CONNECTION_NOT_FOUND',
            };
        }
        try {
            return await publishOne(client, conn, params, keyBase, deadline, intervalMs);
        } catch (e: any) {
            return { connection_id: id, platform: conn.platform, name: conn.name, status: 'failed', error: String(e?.message || e) };
        }
    }));

    const failed = results.filter((r) => r.status === 'failed' || r.status === 'skipped').length;
    const pending = results.filter((r) => r.status === 'publishing').length;
    const summary = {
        ok: results.length - failed - pending,
        publishing: pending,
        failed,
        total: results.length,
    };
    return jsonResult({ summary, results, idempotency_key: keyBase }, failed === results.length);
}

// ---------------------------------------------------------------- posts

const compactPost = (p: any) => ({
    id: p.id,
    kind: p.kind,
    post_id: p.post_id ?? null,
    job_id: p.job_id ?? null,
    title: p.title ?? null,
    connection: p.connection ?? null,
    status: p.status,
    ...(p.publishing ? { publishing: true } : {}),
    scheduled_for: p.scheduled_for ?? null,
    published_at: p.published_at ?? null,
    created_at: p.created_at ?? null,
    url: p.url ?? null,
    google_doc_id: p.google_doc_id ?? null,
    ...(p.error ? { error: p.error } : {}),
});

export interface ListPostsParams {
    connection_ids?: string[];
    status?: string[];
    platform?: string[];
    from?: string;
    to?: string;
    date_field?: string;
    q?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
}

async function fetchPosts(client: OrgClient, query: Record<string, unknown>): Promise<{ body?: any; error?: string }> {
    let res: ApiResponse;
    try {
        res = await client.request('GET', '/api/posts', { query });
    } catch (e) {
        return { error: networkError('Listing posts', e) };
    }
    if (!res.ok || res.body?.error === true) return { error: explainOrgError('Listing posts', res).message };
    return { body: res.body || {} };
}

export async function listPosts(client: OrgClient, params: ListPostsParams): Promise<ToolResult> {
    const { body, error } = await fetchPosts(client, {
        connection_ids: params.connection_ids,
        status: params.status,
        platform: params.platform,
        from: params.from,
        to: params.to,
        date_field: params.date_field,
        q: params.q,
        sort: params.sort,
        limit: params.limit,
        cursor: params.cursor,
    });
    if (error) return errorResult(error);
    const posts = Array.isArray(body.posts) ? body.posts.map(compactPost) : [];
    return jsonResult({
        count: posts.length,
        posts,
        has_more: Boolean(body.has_more),
        next_cursor: body.next_cursor ?? null,
    });
}

export async function getPostStatus(client: OrgClient, params: { job_id?: string; post_id?: string; connection_id?: string }): Promise<ToolResult> {
    if (params.job_id) {
        const jobId = String(params.job_id).replace(/^job:/, '');
        const { res, error } = await jobStatus(client, jobId);
        if (!res) return errorResult(error!);
        if (res.status === 404) {
            return errorResult(`Job "${jobId}" was not found. Finished jobs expire after a while; look the post up with docswrite-list-posts instead.`);
        }
        if (res.status === 403 && !res.body?.code) {
            return errorResult(`Job "${jobId}" was queued by a different Docswrite user or key, so this key cannot read it. Use docswrite-list-posts.`);
        }
        if (!res.ok || res.body?.success === false) return errorResult(explainOrgError('Checking the publish job', res).message);
        const data = res.body?.data ?? res.body ?? {};
        const done = fromJob(data, 'published');
        const out = done
            ? { job_id: jobId, ...done, status: done.status === 'published' ? 'completed' : done.status }
            : { job_id: jobId, status: 'publishing', state: data.state, progress: data.progress ?? null, note: 'Still publishing; check again in a few seconds.' };
        return jsonResult(out, (out as any).status === 'failed');
    }

    if (params.post_id) {
        const wanted = String(params.post_id).trim();
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
            const { body, error } = await fetchPosts(client, {
                connection_ids: params.connection_id,
                limit: 100,
                cursor,
            });
            if (error) return errorResult(error);
            const hit = (body.posts || []).find((p: any) => String(p.id) === wanted || String(p.post_id) === wanted || String(p.job_id) === wanted);
            if (hit) return jsonResult(compactPost(hit), hit.status === 'failed');
            if (!body.has_more || !body.next_cursor) break;
            cursor = body.next_cursor;
        }
        return errorResult(`Post "${wanted}" was not found among the organization's recent posts${params.connection_id ? ` on connection ${params.connection_id}` : ''}. Use docswrite-list-posts with filters.`);
    }

    return errorResult('Give job_id (from docswrite-publish-post) or post_id (from docswrite-list-posts or a scheduled publish).');
}

