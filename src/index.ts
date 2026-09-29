#!/usr/bin/env node

// stdout carries the MCP JSON-RPC stream. Any stray console.log (ours or a
// dependency's) would corrupt it, so route it to stderr before the server starts.
console.log = (...args: unknown[]) => console.error(...args);

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeDocswriteRequest, checkJobStatus } from './docswrite-request.js';
import { createDoc, updateDoc, searchDocs, deleteDoc, googleDocsConfigured } from './google-docs.js';
import { parseArgs } from './utils.js';

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const args = parseArgs();

const USAGE = `docswrite-mcp ${pkg.version} - Docswrite MCP server (stdio)

Usage:
  npx -y @docswrite/docswrite-mcp --docswriteToken <token>
  DOCSWRITE_TOKEN=<token> npx -y @docswrite/docswrite-mcp

Options:
  --docswriteToken <token>     Docswrite API token for your site (or env DOCSWRITE_TOKEN)
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
    "Copy the token for your site from the Docswrite dashboard (https://docswrite.com, Automation page).\n\n" +
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

// Google Docs tools are optional: they need the user's own Google OAuth client.
// Publishing an existing Google Doc does not need them.
if (googleDocsConfigured()) {
  server.tool(
    "google-docs-create",
    "Create a new Google Doc in the user's Google Drive with plain-text content. Returns the document URL, which can be passed to docswrite-publish.",
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
  console.error(`docswrite-mcp ${pkg.version} running on stdio (Google Docs tools ${googleDocsConfigured() ? "enabled" : "disabled"})`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
