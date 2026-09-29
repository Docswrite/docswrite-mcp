import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { startOAuthServer, OAUTH_PORT } from './oauth-server.js';
import { parseArgs } from './utils.js';

// OAuth2 scopes for the optional Google Docs tools.
export const SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
];

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

/**
 * Where the Google OAuth client file lives. The Google Docs tools are optional:
 * they are only enabled when one of these points at an existing file.
 *   --googleCredentials <path> | GOOGLE_CREDENTIALS_PATH | <package root>/credentials.json (local dev)
 */
export function resolveCredentialsPath(): string | null {
    const candidates = [
        args['googleCredentials'],
        process.env.GOOGLE_CREDENTIALS_PATH,
        path.join(PROJECT_ROOT, "credentials.json"),
    ].filter((p): p is string => !!p);
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved)) return resolved;
    }
    return null;
}

function resolveTokenPath(credentialsPath: string): string {
    const explicit = args['googleToken'] || process.env.GOOGLE_TOKEN_PATH;
    if (explicit) return path.resolve(explicit);
    return path.join(path.dirname(credentialsPath), "token.json");
}

function redirectUri(): string {
    return args['redirectUris'] || `http://localhost:${OAUTH_PORT}/oauth2callback`;
}

function createClient(credentialsPath: string): OAuth2Client {
    const keys = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    const conf = keys.web || keys.installed;
    if (!conf?.client_id || !conf?.client_secret) {
        throw new Error(`${credentialsPath} is not a Google OAuth client file (expected a "web" or "installed" section).`);
    }
    return new OAuth2Client(conf.client_id, conf.client_secret, redirectUri());
}

export type AuthResult =
    | { status: "ready"; client: OAuth2Client }
    | { status: "needs_consent"; authUrl: string };

/**
 * Returns an authorized client when a token is stored; otherwise starts the local
 * callback server and returns the consent URL so the tool can hand it to the user
 * (stdout belongs to the MCP protocol, so we cannot just print it).
 */
export async function authorize(credentialsPath: string): Promise<AuthResult> {
    const client = createClient(credentialsPath);
    const tokenPath = resolveTokenPath(credentialsPath);

    if (fs.existsSync(tokenPath)) {
        client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf-8")));
        client.on("tokens", (tokens) => {
            // Persist refreshed tokens, keeping the refresh_token we already had.
            try {
                const current = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
                fs.writeFileSync(tokenPath, JSON.stringify({ ...current, ...tokens }), { mode: 0o600 });
            } catch (err) {
                console.error("Could not persist refreshed Google token:", err);
            }
        });
        return { status: "ready", client };
    }

    const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
    startOAuthServer(async (code) => {
        const { tokens } = await client.getToken(code);
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, JSON.stringify(tokens), { mode: 0o600 });
        console.error("Google tokens stored at:", tokenPath);
    });
    console.error('Authorize Google Docs access by visiting:', authUrl);
    return { status: "needs_consent", authUrl };
}
