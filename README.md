# Docswrite MCP Server

Publish content and Google Docs to WordPress, Webflow, Contentful, Shopify, GitHub, Dev.to,
Hashnode, Medium, Ghost, Docswrite blogs, X and LinkedIn from Claude, ChatGPT, Cursor, or
any other MCP client.
Docswrite turns the doc (headings, images, links, tables) into a formatted post,
uploads the images, and fills in SEO fields.

## Remote server (recommended): `https://api.docswrite.com/mcp`

Docswrite now hosts the MCP server. There is nothing to install: add the URL as a
remote / custom connector and sign in to Docswrite when the client asks (OAuth 2.1
with dynamic client registration; you approve the connection for one organization
and can revoke it any time). Clients without OAuth can send an org API key instead
(`Authorization: Bearer dw_live_...` or `x-api-key`).

It publishes **content** directly: the assistant sends the post as Markdown or HTML
(title, excerpt, tags, categories, slug, SEO fields, canonical URL, images) to one
or many connections at once (WordPress, the WordPress plugin, Webflow, Contentful,
Shopify, GitHub, Ghost, Medium, Dev.to, Hashnode, Docswrite blogs, X, LinkedIn), as
a draft, now or scheduled. A Google Doc URL still works as the source.

| Tool | What it does |
|---|---|
| `list_connections` | Connected blogs, CMSs and social accounts (ids for `publish_post`) |
| `publish_post` | Publish content to one or many connections (draft / publish / schedule; `idempotency_key`) |
| `list_posts` | Posts across connections with status, URL and source |
| `get_post_status` | Follow a publish (`job:…`) or look up a post (`post:…`, `social:…`) |
| `update_post` | Re-publish a post with changes, or reschedule it |
| `get_account_info` | The connected user, organization, plan and remaining free posts |
| `list_pricing_plans` / `upgrade_plan` | Plans, and a Stripe checkout link (never charges by itself) |
| `search` / `fetch` | Search and read the organization's posts (ChatGPT connectors, deep research) |

**Claude (claude.ai / Desktop):** Settings -> Connectors -> Add custom connector ->
`https://api.docswrite.com/mcp`.

**ChatGPT:** Settings -> Connectors (developer mode) -> Create -> MCP server URL
`https://api.docswrite.com/mcp`, authentication OAuth.

**Claude Code:**

```bash
claude mcp add --transport http docswrite https://api.docswrite.com/mcp
# or with an org API key instead of OAuth:
claude mcp add --transport http docswrite https://api.docswrite.com/mcp --header "Authorization: Bearer dw_live_..."
```

**Cursor / VS Code / Windsurf** (`mcp.json`):

```json
{
  "mcpServers": {
    "docswrite": { "url": "https://api.docswrite.com/mcp" }
  }
}
```

**MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector --cli https://api.docswrite.com/mcp --transport http \
  --header "Authorization: Bearer dw_live_..." --method tools/list
```

The same publishing is available over REST: `POST https://api.docswrite.com/api/v1/posts`
(see https://api.docswrite.com/openapi.json and https://api.docswrite.com/auth.md).

The rest of this README covers the **local stdio server** in this repository, which
still works (for clients that only run local servers, or to publish from Google Docs
with your own Google OAuth client).

## Quick start (local stdio server)

1. In the Docswrite dashboard, open **Settings -> API Keys** (https://docswrite.com/dashboard/api-keys)
   and create an **org API key** (`dw_live_...`). One key reaches every connection of your
   organization: the assistant lists your connections and publishes to any of them.
2. Run the server (Node.js 18+):

```bash
npx -y @docswrite/docswrite-mcp --docswriteToken dw_live_...
```

Until the npm package is published, run it straight from GitHub (same flags):

```bash
npx -y github:Docswrite/docswrite-mcp --docswriteToken dw_live_...
```

The key can also be passed as `--docswriteToken=<key>` or through the
`DOCSWRITE_TOKEN` environment variable.

### Two kinds of credentials

| Credential | Looks like | Tools | Publishes to |
|---|---|---|---|
| Org API key (recommended) | `dw_live_...` | `docswrite-list-connections`, `docswrite-publish-post`, `docswrite-list-posts`, `docswrite-get-post-status` | any CMS/blog connection of the organization |
| Per-site token (legacy) | a JWT from a site's **Automation** page | `docswrite-publish`, `docswrite-job-status` | that one WordPress site |

The server picks the mode from the credential: a `dw_live_` key is sent as
`Authorization: Bearer`, anything else works exactly as in 0.2.0. Existing per-site
tokens keep working.

## Client setup

### Claude Code

```bash
claude mcp add docswrite -e DOCSWRITE_TOKEN=dw_live_... -- npx -y @docswrite/docswrite-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

```json
{
  "mcpServers": {
    "docswrite": {
      "command": "npx",
      "args": ["-y", "@docswrite/docswrite-mcp"],
      "env": { "DOCSWRITE_TOKEN": "dw_live_..." }
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
      "env": { "DOCSWRITE_TOKEN": "dw_live_..." }
    }
  }
}
```

Other clients (Windsurf, VS Code, Cline, ...) use the same `command` / `args` / `env`.
To run from GitHub instead of npm, replace `@docswrite/docswrite-mcp` with
`github:Docswrite/docswrite-mcp`.

## Tools (org API key)

### `docswrite-list-connections`

Lists the organization's connections: `id`, `platform`, `name`, `status`
(`connected`, `needs_attention`, or `unknown` when not checked recently), `capabilities`,
and `api` (whether the server can publish to it, which states, which basic options).
Optional filters: `platform`, `status`.

### `docswrite-publish-post`

Publishes one Google Doc to one or more connections, one `POST /api/posts` per connection
(the same request the dashboard composer sends), then waits for the results and returns each
connection's status and live URL, or its error.

- `connection_ids` (required): ids from `docswrite-list-connections`
- `google_doc` (required): Google Doc URL or ID. The doc must be readable by the Docswrite
  user who created the API key.
- `state`: `draft` (default), `published`, or `scheduled` with `publish_date`
  (ISO 8601, or `YYYY-MM-DDTHH:mm` read in `timezone`, an IANA zone)
- `title`: defaults to the doc title
- Basic options, where the platform supports them:

| Option | WordPress | Hosted blog | Shopify | GitHub | Dev.to | Hashnode | Medium | Ghost | Webflow / Contentful |
|---|---|---|---|---|---|---|---|---|---|
| `tags` | yes | yes | yes | yes | first 4 | first 5 | first 3 | yes | via field mapping |
| `categories` | yes | | | yes | | | | | |
| `canonical_url` | Yoast | | | | yes | yes | yes | yes | |
| `excerpt` | yes | yes | | yes | description | | | yes | |
| `slug` | yes | yes | yes | yes | | | | yes | |
| `featured_image_url` | yes | yes | yes | yes | cover | cover | cover | yes | |
| `author` | yes | | yes | yes | | | | | |
| `post_type` (`post`/`page`) | yes | | | | | | | | |

  A connection that does not take an option you set is **skipped with an explanation**
  instead of being published without it; the other connections still publish.
- `platform_options`: advanced per-platform settings. `webflow.collection_id` and
  `contentful.model_id` are required for those platforms; also `wordpress.yoast_settings`,
  `rankmath_settings`, `export_settings`, `template`; `shopify.blog_id`; `github.settings`;
  `devto.series`; `hashnode.subtitle`; `medium.unlisted`.
- `idempotency_key`: sent as `Idempotency-Key: <key>:<connection_id>`. Repeating a call with
  the same key within 24 h returns the first result instead of publishing twice. A new key is
  generated per call by default, and internal retries always reuse it.
- `wait_seconds`: how long to wait for results (default 90, max 300; `0` returns job ids).

X and LinkedIn connections are listed but cannot be published to through the API.
GitHub has no drafts.

### `docswrite-list-posts`

The organization's posts across connections (published, scheduled, drafts, in-flight and
failed publishes), newest first. Filters: `connection_ids`, `status`, `platform`,
`from` / `to` (+ `date_field`), `q` (title), `sort`, `limit`, `cursor`.

### `docswrite-get-post-status`

Follows a publish (`job_id` from `docswrite-publish-post`) or looks up a post (`post_id`,
e.g. from a scheduled publish, or an `id` from `docswrite-list-posts`).

## Tools (per-site token)

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

Tool failures come back with `isError: true` (or, for multi-connection publishes, per
connection in `results`) and a message the assistant can act on:

- **401**: the key is invalid, revoked or expired. Create or regenerate one on the API Keys page.
- **402**: the organization's plan limit is reached. Upgrade the plan.
- **403**: access denied, e.g. the admin who created the key left the organization
  (regenerate the key) or the key belongs to another organization.
- **Cloudflare**: if Cloudflare in front of `api.docswrite.com` challenges the request, the
  message says so (with the Ray ID) instead of reporting a bad key. If the destination
  WordPress site's Cloudflare/firewall blocks Docswrite, the result names the IPs to allowlist.
- **Unsupported option / platform**: the connection is skipped with the list of options it takes.
- **429**: 60 requests per minute per key; the server spaces out its status polling to stay under it.

Per-site token errors are unchanged (401 invalid/expired token, 403 token for another site,
inactive plan, failed WordPress publish with the reason).

## Development

```bash
npm install        # also builds via the prepare script
npm test           # build + stdio smoke test against a local fake API
npm run inspector  # MCP Inspector
```

`DOCSWRITE_API_BASE` overrides the API host (default `https://api.docswrite.com`).

## Publishing to npm

Not automated (the repo has no workflows).

```bash
npm login
npm publish --access public
```
