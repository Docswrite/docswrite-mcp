#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeDocswriteRequest, checkJobStatus } from './docswrite-request.js';
import { createDoc, updateDoc, searchDocs, deleteDoc, initClients } from './google-docs.js';
import { parseArgs } from './utils.js';

const args = parseArgs();
const docswriteToken = args['docswriteToken'] || process.env.DOCSWRITE_TOKEN;
if (!docswriteToken) {
    console.error("Error: DOCSWRITE_TOKEN is required. Either set it as an environment variable or pass it using --docswriteToken=YOUR_TOKEN");
    process.exit(1);
}

const server = new McpServer({
  name: "docswrite-mcp",
  version: "0.1.0",
});

server.tool(
  "docswrite-publish",
  "Publish content from Google Docs to WordPress using Docswrite",
  {
    google_docs_url: z.string().url().describe("URL of the Google Docs document"),
    title: z.string().optional().describe("Title of the blog post"),
    slug: z.string().optional().describe("URL slug for the post"),
    tags: z.string().optional().describe("Comma-separated list of tags"),
    categories: z.string().optional().describe("Comma-separated list of categories"),
    state: z.string().optional().default("publish").describe("Post state (draft/publish)"),
    author: z.string().optional().describe("Author name"),
    date: z.string().optional().describe("Publication date"),
    excerpt: z.string().optional().describe("Post excerpt"),
    post_type: z.string().optional().describe("Post type (post/page)"),
    featured_image_url: z.string().url().optional().describe("URL of the featured image"),
    featured_image_alt_text: z.string().optional().describe("Alt text for featured image"),
    featured_image_caption: z.string().optional().describe("Caption for featured image"),
    export_settings: z.object({
      compress_images: z.boolean().optional(),
      demote_headings: z.boolean().optional(),
      convert_to_webp: z.boolean().optional(),
      first_image_as_featured_image: z.boolean().optional(),
      add_no_follow_to_external_links: z.boolean().optional(),
      bold_as_strong: z.boolean().optional(),
      wp_content_editor: z.string().optional()
    }).optional(),
    newspack_settings: z.object({
      newspack_article_summary: z.string().optional(),
      newspack_article_summary_title: z.string().optional(),
      newspack_post_subtitle: z.string().optional()
    }).optional(),
    yoast_settings: z.object({
      yoast_focuskw: z.string().optional(),
      yoast_metadesc: z.string().optional(),
      yoast_title: z.string().optional()
    }).optional(),
    rankmath_settings: z.object({
      rank_math_focus_keyword: z.string().optional()
    }).optional()
  },
  async (params) => {
    return makeDocswriteRequest({
      ...params,
      token: docswriteToken
    });
  }
);

server.tool(
  "docswrite-job-status",
  "Check the status of a Docswrite job",
  {
    jobId: z.string().describe("The ID of the job to check"),
    queueType: z.string().default("post").describe("The type of queue (default: post)")
  },
  async (params) => {
    return checkJobStatus({
      ...params,
      token: docswriteToken
    });
  }
);

server.tool(
  "google-docs-create",
  "Create a new Google Docs document",
  {
    title: z.string().describe("The title of the new document"),
    content: z.string().describe("The content to write to the document")
  },
  async (params) => {
    return createDoc(params.title, params.content);
  }
);

server.tool(
  "google-docs-update",
  "Update an existing Google Docs document",
  {
    documentId: z.string().describe("The ID of the document to update"),
    content: z.string().describe("The content to write to the document"),
    replaceAll: z.boolean().optional().describe("Whether to replace all content (true) or append (false)")
  },
  async (params) => {
    return updateDoc(params.documentId, params.content, params.replaceAll);
  }
);

server.tool(
  "google-docs-search",
  "Search for Google Docs documents",
  {
    query: z.string().describe("The search query to find documents")
  },
  async (params) => {
    return searchDocs(params.query);
  }
);

server.tool(
  "google-docs-delete",
  "Delete a Google Docs document",
  {
    documentId: z.string().describe("The ID of the document to delete")
  },
  async (params) => {
    return deleteDoc(params.documentId);
  }
);

async function main() {
  // Initialize clients first
  console.log("Initializing Google API clients...");
  const initialized = await initClients();

  if (!initialized) {
    console.error("Failed to initialize Google API clients. Exiting.");
    process.exit(1); // Exit if initialization fails
  }
  
  console.log("Google API clients initialized successfully.");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Server started");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
