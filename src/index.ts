#!/usr/bin/env node

// stdout carries the MCP JSON-RPC stream. Any stray console.log (ours or a
// dependency's) would corrupt it, so route it to stderr before the server starts.
console.log = (...args: unknown[]) => console.error(...args);

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeDocswriteRequest, checkJobStatus } from './docswrite-request.js';
import { OrgClient, isOrgKey, listConnections, publishPost, listPosts, getPostStatus } from './org-api.js';
import { googleDocId, isValidTimeZone, resolveInstant, toList } from './platforms.js';
import { createDoc, updateDoc, searchDocs, deleteDoc, googleDocsConfigured } from './google-docs.js';
import { parseArgs } from './utils.js';

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const args = parseArgs();

const USAGE = `docswrite-mcp ${pkg.version} - Docswrite MCP server (stdio)

Usage:
  npx -y @docswrite/docswrite-mcp --docswriteToken <token>
  DOCSWRITE_TOKEN=<token> npx -y @docswrite/docswrite-mcp

Options:
  --docswriteToken <token>     Docswrite org API key (dw_live_..., every connection of the
                               organization) or a per-site API token (or env DOCSWRITE_TOKEN)
  --googleCredentials <path>   Optional Google OAuth client JSON; enables the google-docs-* tools
                               (or env GOOGLE_CREDENTIALS_PATH)
  --googleToken <path>         Where to store the Google OAuth token (or env GOOGLE_TOKEN_PATH;
                               default: token.json next to the credentials file)
  --help, --version
`;

if (args['help'] || args['h']) {
  process.stderr.write(USAGE);
  process.exit(0);
}
if (args['version'] || args['v']) {
  process.stderr.write(`${pkg.version}\n`);
  process.exit(0);
}

const rawToken = args['docswriteToken'] || args['token'] || process.env.DOCSWRITE_TOKEN || "";
const docswriteToken = rawToken.trim().replace(/^Bearer\s+/i, "");
if (!docswriteToken || docswriteToken === "true" || docswriteToken.includes("${")) {
  process.stderr.write(
    "Error: a Docswrite API token is required.\n" +
    "Pass it with --docswriteToken <token> or set the DOCSWRITE_TOKEN environment variable.\n" +
    "Create an org API key (dw_live_...) at https://docswrite.com/dashboard/api-keys, or copy a site's token from its Automation page.\n\n" +
    USAGE
  );
  process.exit(1);
}

const server = new McpServer({
  name: "docswrite-mcp",
  version: pkg.version,
});

// The backend accepts: draft, published, future, pending, private. Accept "publish" as an alias.
const PostState = z.preprocess(
  (v) => (typeof v === "string" && v.trim().toLowerCase() === "publish" ? "published" : v),
  z.enum(["draft", "published", "future", "pending", "private"])
);

const orgMode = isOrgKey(docswriteToken);

if (orgMode) {
  registerOrgTools();
} else {
  registerSiteTokenTools();
}

// Org API key mode (dw_live_...): one key, every connection of the organization.
function registerOrgTools() {
  const client = new OrgClient(docswriteToken);
  const idList = z.preprocess(
    (v) => (v === undefined || v === null ? v : Array.isArray(v) ? v.map(String) : String(v).split(",").map((x) => x.trim()).filter(Boolean)),
    z.array(z.string()).min(1)
  );
  const stringList = z.preprocess(
    (v) => (v === undefined || v === null ? v : toList(v)),
    z.array(z.string())
  );

  server.tool(
    "docswrite-list-connections",
    "List every publishing connection (WordPress, Webflow, Contentful, Shopify, GitHub, Dev.to, Hashnode, Medium, Ghost, " +
    "hosted blog, X, LinkedIn) of the Docswrite organization this API key belongs to. " +
    "Returns id, platform, name, status, capabilities, and 'api' (whether it can be published to through this server, " +
    "which states, and which basic options it takes). Use the ids with docswrite-publish-post.",
    {
      platform: z.string().optional().describe("Only this platform, e.g. wordpress, webflow, devto"),
      status: z.enum(["connected", "needs_attention", "unknown"]).optional().describe("Only connections with this cached status"),
    },
    async (params) => listConnections(client, params)
  );

  server.tool(
    "docswrite-publish-post",
    "Publish a Google Doc to one or more connections of the organization (ids from docswrite-list-connections). " +
    "Docswrite converts the doc (headings, images, links, tables) and publishes it; one request per connection. " +
    "state: draft (default), published, or scheduled (with publish_date, optionally timezone). " +
    "Basic options (tags, categories, canonical_url, excerpt, slug, featured_image_url, author, post_type) apply where the platform supports them; " +
    "a connection that does not support a given option is skipped with an explanation instead of being published without it. " +
    "Waits up to wait_seconds for the results and returns each connection's status and live URL (or error). " +
    "The Google Doc must be readable by the Docswrite user who created the API key. X and LinkedIn cannot be published to through the API.",
    {
      connection_ids: idList.describe("Connection ids to publish to (array, or one id / comma-separated ids)"),
      google_doc: z.string().describe("Google Doc URL (https://docs.google.com/document/d/<id>/edit) or document ID"),
      title: z.string().optional().describe("Post title. Defaults to the Google Doc title"),
      state: z.preprocess(
        (v) => {
          const s = typeof v === "string" ? v.trim().toLowerCase() : v;
          return s === "publish" || s === "live" || s === "now" ? "published" : s === "schedule" || s === "future" ? "scheduled" : s;
        },
        z.enum(["draft", "published", "scheduled"])
      ).optional().default("draft").describe("draft (default), published (live now), or scheduled (needs publish_date)"),
      publish_date: z.string().optional().describe("For state=scheduled: a future date, either ISO 8601 with offset (2026-10-01T09:00:00Z) or a wall-clock time YYYY-MM-DDTHH:mm read in `timezone`"),
      timezone: z.string().optional().describe("IANA time zone for a wall-clock publish_date, e.g. America/New_York. Defaults to the connection's time zone"),
      tags: stringList.optional().describe("Tag names (array or comma-separated). WordPress creates missing tags; Dev.to keeps 4, Hashnode 5, Medium 3"),
      categories: stringList.optional().describe("Category names (WordPress, GitHub)"),
      canonical_url: z.string().url().optional().describe("Canonical URL (Dev.to, Hashnode, Medium, Ghost; WordPress via Yoast SEO)"),
      excerpt: z.string().optional().describe("Excerpt / description (WordPress, hosted blog, GitHub, Dev.to, Ghost)"),
      slug: z.string().optional().describe("URL slug (WordPress, hosted blog, Shopify, GitHub, Ghost)"),
      featured_image_url: z.string().url().optional().describe("Featured/cover image URL. By default the first image in the doc is used where supported"),
      author: z.string().optional().describe("Author name, username or email (WordPress, Shopify, GitHub)"),
      post_type: z.enum(["post", "page"]).optional().describe("WordPress only: post (default) or page"),
      platform_options: z.object({
        wordpress: z.object({
          yoast_settings: z.object({ yoast_title: z.string().optional(), yoast_metadesc: z.string().optional(), yoast_focuskw: z.string().optional() }).passthrough().optional(),
          rankmath_settings: z.object({ rank_math_focus_keyword: z.string().optional() }).passthrough().optional(),
          newspack_settings: z.record(z.unknown()).optional(),
          export_settings: z.record(z.unknown()).optional().describe("Formatting, e.g. { compress_images, convert_to_webp, demote_headings, add_no_follow_to_external_links }"),
          template: z.string().optional(),
        }).optional().describe("Also used for wordpress_plugin connections"),
        contentful: z.object({
          model_id: z.string().describe("Content model id (required for Contentful)"),
          field_mappings: z.record(z.unknown()).optional(),
          custom_values: z.record(z.unknown()).optional(),
          locale: z.string().optional(),
        }).optional(),
        webflow: z.object({
          collection_id: z.string().describe("CMS collection id (required for Webflow)"),
          site_id: z.string().optional(),
          field_mappings: z.record(z.unknown()).optional(),
          custom_values: z.record(z.unknown()).optional(),
        }).optional(),
        shopify: z.object({ blog_id: z.union([z.string(), z.number()]).optional() }).optional(),
        github: z.object({ settings: z.record(z.unknown()).optional() }).optional(),
        devto: z.object({ series: z.string().optional() }).optional(),
        hashnode: z.object({ subtitle: z.string().optional() }).optional(),
        medium: z.object({ unlisted: z.boolean().optional() }).optional(),
      }).optional().describe("Advanced per-platform options; each block only applies to connections on that platform"),
      idempotency_key: z.string().max(200).optional().describe("Reuse the same key to retry safely: within 24 h a repeat returns the first result instead of publishing twice. Default: a new key per call"),
      wait_seconds: z.number().int().min(0).max(300).optional().default(90).describe("How long to wait for the results (default 90, 0 = return job ids at once)"),
    },
    async (params) => {
      const docId = googleDocId(params.google_doc);
      if (!docId) {
        return { content: [{ type: "text" as const, text: "google_doc must be a Google Docs URL (https://docs.google.com/document/d/<id>/...) or a document ID." }], isError: true };
      }
      if (params.timezone && !isValidTimeZone(params.timezone)) {
        return { content: [{ type: "text" as const, text: `Unknown time zone "${params.timezone}". Use an IANA name such as Europe/London or America/New_York.` }], isError: true };
      }
      if (params.state === "scheduled") {
        if (!params.publish_date) {
          return { content: [{ type: "text" as const, text: "state=scheduled needs publish_date (e.g. 2026-10-01T09:00 with timezone, or 2026-10-01T09:00:00Z)." }], isError: true };
        }
        const when = resolveInstant(params.publish_date, params.timezone);
        if (!when) {
          return { content: [{ type: "text" as const, text: `publish_date "${params.publish_date}" is not a valid date. Use YYYY-MM-DDTHH:mm (with timezone) or ISO 8601.` }], isError: true };
        }
        if (when.getTime() <= Date.now()) {
          return { content: [{ type: "text" as const, text: `publish_date ${when.toISOString()} is in the past. Use state=published to publish now, or pick a future date.` }], isError: true };
        }
      } else if (params.publish_date) {
        return { content: [{ type: "text" as const, text: "publish_date is only used with state=scheduled." }], isError: true };
      }
      const platform_options: Record<string, any> = { ...(params.platform_options || {}) };
      if (platform_options.wordpress) platform_options.wordpress_plugin = platform_options.wordpress;
      return publishPost(client, {
        ...params,
        google_doc_id: docId,
        platform_options,
      });
    }
  );

  server.tool(
    "docswrite-list-posts",
    "List the organization's posts across all connections, newest first: published, scheduled, drafts, in-flight and failed publishes. " +
    "Each item has id, title, connection {id, platform, name}, status, dates, url and error.",
    {
      connection_ids: idList.optional().describe("Only these connection ids"),
      status: z.array(z.enum(["scheduled", "publishing", "published", "failed", "draft"])).optional().describe("Only these statuses"),
      platform: stringList.optional().describe("Only these platforms, e.g. [\"wordpress\", \"webflow\"]"),
      from: z.string().optional().describe("From this date (ISO datetime or YYYY-MM-DD, UTC)"),
      to: z.string().optional().describe("Up to this date (ISO datetime or YYYY-MM-DD, whole day)"),
      date_field: z.enum(["date", "created", "scheduled"]).optional().describe("Which date from/to filter on (default: the item's date)"),
      q: z.string().optional().describe("Case-insensitive title search"),
      sort: z.enum(["date_desc", "date_asc", "title_asc"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 50)"),
      cursor: z.string().optional().describe("next_cursor from the previous page"),
    },
    async (params) => listPosts(client, params)
  );

  server.tool(
    "docswrite-get-post-status",
    "Check a publish started by docswrite-publish-post (job_id) or look up a post (post_id, or an id from docswrite-list-posts). " +
    "Returns its status (publishing, completed/published, draft, scheduled, failed), live URL and error.",
    {
      job_id: z.string().optional().describe("job_id returned by docswrite-publish-post"),
      post_id: z.string().optional().describe("A post id (e.g. from a scheduled publish) or an id from docswrite-list-posts"),
      connection_id: z.string().optional().describe("Narrows a post_id lookup to one connection"),
    },
    async (params) => getPostStatus(client, params)
  );
}

// Per-site token mode: unchanged from 0.2.0 (WordPress through /api/export).
function registerSiteTokenTools() {
  server.tool(
    "docswrite-publish",
    "Publish a Google Doc to the WordPress site connected to this Docswrite token. " +
    "Docswrite converts the doc (headings, images, links, tables) into a formatted post and uploads its images. " +
    "The token belongs to one site, so the post always goes to that site; the MCP/API path currently supports WordPress sites only. " +
    "The Google Doc must be readable by the Docswrite account (shared with it or 'anyone with the link'). " +
    "Publishing is asynchronous: this returns a jobId; then call docswrite-job-status until the job completes. " +
    "Defaults to a draft unless state is set.",
    {
      google_docs_url: z.string().url().describe("Full URL of the Google Doc, e.g. https://docs.google.com/document/d/<id>/edit"),
      title: z.string().optional().describe("Post title. Defaults to the Google Doc title"),
      slug: z.string().optional().describe("URL slug for the post"),
      tags: z.string().optional().describe("Comma-separated tag names; missing tags are created"),
      categories: z.string().optional().describe("Comma-separated category names"),
      state: PostState.optional().default("draft").describe("WordPress post status: draft (default), published, future (scheduled, use with date), pending, or private"),
      author: z.string().optional().describe("WordPress author (username, display name, or email)"),
      date: z.string().optional().describe("Publication date in ISO 8601 (e.g. 2026-10-01T09:00:00Z). A future date schedules the post"),
      excerpt: z.string().optional().describe("Post excerpt"),
      post_type: z.enum(["post", "page"]).optional().describe("Publish as a post (default) or a page"),
      featured_image_url: z.string().url().optional().describe("URL of the featured image. By default the first image in the doc is used"),
      featured_image_alt_text: z.string().optional().describe("Alt text for the featured image"),
      featured_image_caption: z.string().optional().describe("Caption for the featured image"),
      export_settings: z.object({
        compress_images: z.boolean().optional().describe("Compress images (default true)"),
        demote_headings: z.boolean().optional().describe("Turn H1 into H2 and so on (default false)"),
        convert_to_webp: z.boolean().optional().describe("Convert images to WebP (default true)"),
        first_image_as_featured_image: z.boolean().optional().describe("Use the first image as the featured image (default true)"),
        add_no_follow_to_external_links: z.boolean().optional().describe("Add rel=nofollow to external links (default true)"),
        bold_as_strong: z.boolean().optional().describe("Use <strong> instead of <b> (default false)"),
        wp_content_editor: z.string().optional().describe("WordPress editor format, e.g. gutenberg or classic")
      }).optional().describe("Formatting options; omit to use the defaults"),
      newspack_settings: z.object({
        newspack_article_summary: z.string().optional(),
        newspack_article_summary_title: z.string().optional(),
        newspack_post_subtitle: z.string().optional()
      }).optional().describe("Newspack theme fields (only for Newspack sites)"),
      yoast_settings: z.object({
        yoast_focuskw: z.string().optional().describe("Focus keyphrase"),
        yoast_metadesc: z.string().optional().describe("Meta description"),
        yoast_title: z.string().optional().describe("SEO title")
      }).optional().describe("Yoast SEO fields (only if Yoast is installed)"),
      rankmath_settings: z.object({
        rank_math_focus_keyword: z.string().optional()
      }).optional().describe("Rank Math fields (only if Rank Math is installed)")
    },
    async (params) => makeDocswriteRequest({ ...params, token: docswriteToken })
  );

  server.tool(
    "docswrite-job-status",
    "Check a Docswrite publishing job returned by docswrite-publish. " +
    "state is one of waiting, active, delayed, completed, failed. When completed, 'post' holds the published post (including its URL); " +
    "when failed, failedReason explains why. Poll every few seconds; publishing usually takes 10-60 seconds.",
    {
      jobId: z.string().describe("The jobId returned by docswrite-publish"),
      queueType: z.enum(["post", "publish", "pseo", "article", "moveFile"]).default("post").describe("Queue the job is in. Jobs from docswrite-publish use 'post' (the default)")
    },
    async (params) => checkJobStatus({ ...params, token: docswriteToken })
  );
}

// Google Docs tools are optional: they need the user's own Google OAuth client.
// Publishing an existing Google Doc does not need them.
if (googleDocsConfigured()) {
  server.tool(
    "google-docs-create",
    `Create a new Google Doc in the user's Google Drive with plain-text content. Returns the document URL, which can be passed to ${orgMode ? "docswrite-publish-post" : "docswrite-publish"}.`,
    {
      title: z.string().describe("The title of the new document"),
      content: z.string().describe("Plain-text content to write to the document")
    },
    async (params) => createDoc(params.title, params.content)
  );

  server.tool(
    "google-docs-update",
    "Append to or replace the text of an existing Google Doc.",
    {
      documentId: z.string().describe("The document ID (the part after /document/d/ in the URL)"),
      content: z.string().describe("Plain-text content to write"),
      replaceAll: z.boolean().optional().describe("true replaces the whole document, false (default) appends")
    },
    async (params) => updateDoc(params.documentId, params.content, params.replaceAll)
  );

  server.tool(
    "google-docs-search",
    "Full-text search the user's Google Docs. Returns up to 10 documents with ID and timestamps.",
    {
      query: z.string().describe("Text to search for")
    },
    async (params) => searchDocs(params.query)
  );

  server.tool(
    "google-docs-delete",
    "Permanently delete a Google Doc from the user's Drive (it is not moved to trash). Confirm with the user first.",
    {
      documentId: z.string().describe("The ID of the document to delete")
    },
    async (params) => deleteDoc(params.documentId)
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`docswrite-mcp ${pkg.version} running on stdio (${orgMode ? "org API key: all connections" : "per-site token"}; Google Docs tools ${googleDocsConfigured() ? "enabled" : "disabled"})`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
