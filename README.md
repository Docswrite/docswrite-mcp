# Docswrite MCP Server

Publish Google Docs to WordPress from Claude, Cursor, or any other MCP client.
Docswrite turns the doc (headings, images, links, tables) into a formatted post,
uploads the images, and fills in SEO fields.

## Quick start

1. In the Docswrite dashboard (https://docswrite.com), open your site's **Automation** page and copy its API token.
   Tokens are per site: the server publishes to the site the token was created for.
2. Run the server (Node.js 18+):

```bash
npx -y @docswrite/docswrite-mcp --docswriteToken <token>
```

Until the npm package is published, run it straight from GitHub (same flags):

```bash
npx -y github:Docswrite/docswrite-mcp --docswriteToken <token>
```

The token can also be passed as `--docswriteToken=<token>` or through the
`DOCSWRITE_TOKEN` environment variable.

> Publishing through the API/MCP currently supports **WordPress** sites.

## Client setup

### Claude Code

```bash
claude mcp add docswrite -e DOCSWRITE_TOKEN=<token> -- npx -y @docswrite/docswrite-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

```json
{
  "mcpServers": {
    "docswrite": {
      "command": "npx",
      "args": ["-y", "@docswrite/docswrite-mcp"],
      "env": { "DOCSWRITE_TOKEN": "<token>" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "docswrite": {
      "command": "npx",
      "args": ["-y", "@docswrite/docswrite-mcp"],
      "env": { "DOCSWRITE_TOKEN": "<token>" }
    }
  }
}
```

Other clients (Windsurf, VS Code, Cline, ...) use the same `command` / `args` / `env`.
To run from GitHub instead of npm, replace `@docswrite/docswrite-mcp` with
`github:Docswrite/docswrite-mcp`.

## Tools

### `docswrite-publish`

Publishes a Google Doc to the WordPress site connected to the token. The doc must be
readable by your Docswrite account. Returns a `jobId`; publishing is asynchronous.

- `google_docs_url` (required): URL of the Google Doc
- `title`, `slug`, `excerpt`, `author`
- `tags`, `categories`: comma-separated names
- `state`: `draft` (default), `published`, `future`, `pending`, `private`
- `date`: ISO 8601; a future date schedules the post
- `post_type`: `post` (default) or `page`
- `featured_image_url`, `featured_image_alt_text`, `featured_image_caption`
- `export_settings`: `compress_images`, `demote_headings`, `convert_to_webp`,
  `first_image_as_featured_image`, `add_no_follow_to_external_links`, `bold_as_strong`, `wp_content_editor`
- `yoast_settings`: `yoast_focuskw`, `yoast_metadesc`, `yoast_title`
- `rankmath_settings`: `rank_math_focus_keyword`
- `newspack_settings`: `newspack_article_summary`, `newspack_article_summary_title`, `newspack_post_subtitle`

### `docswrite-job-status`

Checks a job returned by `docswrite-publish` (`jobId`, `queueType` defaults to `post`).
`state` is `waiting`, `active`, `delayed`, `completed` or `failed`; a completed job
includes the published post, a failed one includes `failedReason`.

### Optional: Google Docs tools

`google-docs-create`, `google-docs-update`, `google-docs-search` and `google-docs-delete`
let the assistant write drafts into your own Google Drive. They need your own Google
OAuth client and are hidden unless one is configured:

1. In Google Cloud Console enable the Google Docs API and Google Drive API and create an
   OAuth client (type "Web application", redirect URI `http://localhost:3000/oauth2callback`).
2. Download the JSON and start the server with
   `--googleCredentials /path/to/credentials.json` (or `GOOGLE_CREDENTIALS_PATH`).
3. The first Google Docs tool call returns a consent URL; open it, approve, and retry.
   The token is stored next to the credentials file (override with `--googleToken` / `GOOGLE_TOKEN_PATH`).

## Errors

Tool failures come back with `isError: true` and a message the assistant can act on,
for example an invalid/expired token (HTTP 401), a token used for another site (403),
an inactive plan, or a failed WordPress publish with the reason.

## Development

```bash
npm install        # also builds via the prepare script
npm test           # build + stdio smoke test against a local fake API
npm run inspector  # MCP Inspector
```

`DOCSWRITE_API_BASE` overrides the API host (default `https://api.docswrite.com`).

## Publishing to npm

```bash
npm login
npm publish --access public
```
