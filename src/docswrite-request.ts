import { config } from './config.js';
import { textResult, ToolResult } from './utils.js';

export interface DocswriteRequestOptions {
    google_docs_url: string;
    title?: string;
    slug?: string;
    tags?: string;
    categories?: string;
    state?: string;
    author?: string;
    date?: string;
    excerpt?: string;
    post_type?: string;
    featured_image_url?: string;
    featured_image_alt_text?: string;
    featured_image_caption?: string;
    export_settings?: Record<string, unknown>;
    newspack_settings?: Record<string, unknown>;
    yoast_settings?: Record<string, unknown>;
    rankmath_settings?: Record<string, unknown>;
    token: string;
}

const TOKEN_HELP =
    `Copy the API token for your site from the Docswrite dashboard (${config.DOCSWRITE_APP_URL}, Automation page or site settings) ` +
    `and restart the MCP server with --docswriteToken <token> or the DOCSWRITE_TOKEN environment variable.`;

interface ApiResponse {
    ok: boolean;
    status: number;
    body: any;
    rawText: string;
}

async function postJson(url: string, token: string, payload: unknown): Promise<ApiResponse> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            // The token goes in a header, never in the URL, so it does not end up in access logs.
            'x-access-token': token,
            'User-Agent': 'docswrite-mcp',
        },
        body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let body: any = null;
    try {
        body = rawText ? JSON.parse(rawText) : null;
    } catch {
        body = null;
    }
    return { ok: response.ok, status: response.status, body, rawText };
}

function serverMessage(res: ApiResponse): string {
    const b = res.body;
    const msg = b && (b.message || b.error);
    if (typeof msg === 'string' && msg) return msg;
    if (res.rawText) return res.rawText.slice(0, 300);
    return `HTTP ${res.status}`;
}

/** Map an HTTP failure from the Docswrite API to a message an assistant can act on. */
function explainError(action: string, res: ApiResponse): string {
    const msg = serverMessage(res);
    switch (res.status) {
        case 401:
            return `${action} failed: the Docswrite token was rejected (${msg}). The token is missing, expired, or invalid. ${TOKEN_HELP}`;
        case 402:
            return `${action} failed: the Docswrite plan for this site does not allow publishing (${msg}). Upgrade or renew at ${config.DOCSWRITE_APP_URL}.`;
        case 403:
            return `${action} failed: access denied (${msg}). Docswrite tokens are issued per site, so this token can only publish to the site it was created for. ${TOKEN_HELP}`;
        case 404:
            return `${action} failed: not found (${msg}). If this is about the site, the site connected to this token may have been removed from Docswrite.`;
        case 400:
            return `${action} failed: the request was rejected (${msg}). Fix the parameters and try again.`;
        default:
            if (res.status >= 500) {
                return `${action} failed: Docswrite returned a server error (HTTP ${res.status}: ${msg}). Try again in a minute; if it keeps failing contact support@docswrite.com.`;
            }
            return `${action} failed: HTTP ${res.status}: ${msg}`;
    }
}

function networkError(action: string, error: any): ToolResult {
    return textResult(
        `${action} failed: could not reach the Docswrite API at ${config.DOCSWRITE_API_BASE} (${error?.message || error}). Check your internet connection and try again.`,
        true
    );
}

export const makeDocswriteRequest = async ({ token, ...params }: DocswriteRequestOptions): Promise<ToolResult> => {
    const action = 'Publishing to Docswrite';
    let res: ApiResponse;
    try {
        res = await postJson(config.DOCSWRITE_API_EXPORT, token, params);
    } catch (error) {
        return networkError(action, error);
    }

    if (!res.ok || res.body?.error === true) {
        return textResult(explainError(action, res), true);
    }

    const jobId = res.body?.data?.jobId ?? res.body?.jobId;
    if (!jobId) {
        // Unexpected shape: return the server message without echoing the whole payload.
        return textResult(`Docswrite accepted the request but did not return a job id: ${serverMessage(res)}`);
    }

    const data = res.body?.data || {};
    return textResult(JSON.stringify({
        success: true,
        message: res.body?.message || 'Post added to queue',
        jobId: String(jobId),
        queueType: 'post',
        site: data.sub_domain,
        state: data.state,
        post_type: data.post_type,
        next_step: `Call docswrite-job-status with jobId "${jobId}" (queueType "post") until state is "completed" or "failed". Publishing usually takes 10-60 seconds.`,
    }, null, 2));
};

export interface JobStatusOptions {
    jobId: string;
    queueType: string;
    token: string;
}

export const checkJobStatus = async ({ jobId, queueType, token }: JobStatusOptions): Promise<ToolResult> => {
    const action = 'Checking the Docswrite job status';
    let res: ApiResponse;
    try {
        res = await postJson(config.DOCSWRITE_API_JOB_STATUS, token, { jobId, queueType });
    } catch (error) {
        return networkError(action, error);
    }

    if (res.status === 403) {
        return textResult(`${action} failed: this job belongs to a different Docswrite account than the token (${serverMessage(res)}).`, true);
    }
    if (res.status === 404) {
        return textResult(`${action} failed: job "${jobId}" was not found in queue "${queueType}". Jobs expire after a while; if you just published, check that the jobId and queueType match what docswrite-publish returned.`, true);
    }
    if (!res.ok || res.body?.success === false) {
        return textResult(explainError(action, res), true);
    }

    const job = res.body?.data ?? res.body;
    if (job?.state === 'failed') {
        const reason = job.failedReason || 'unknown reason';
        const hint = /wordpress|wp-json|rest api|platform|destination/i.test(reason)
            ? ' Note: publishing through the Docswrite API/MCP currently supports WordPress sites only.'
            : '';
        return textResult(JSON.stringify({ ...job, hint: `The publish job failed: ${reason}.${hint}` }, null, 2), true);
    }
    return textResult(JSON.stringify(job, null, 2));
};
