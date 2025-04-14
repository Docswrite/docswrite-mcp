import { authenticate } from "@google-cloud/local-auth";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import { startOAuthServer } from './oauth-server.js';
import { parseArgs } from './utils.js';
// Set up OAuth2.0 scopes
export const SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly"
];

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const TOKEN_PATH = path.join(PROJECT_ROOT, "token.json");
const CREDENTIALS_PATH = path.join(PROJECT_ROOT, "credentials.json");
const REDIRECT_URIS = parseArgs()['redirectUris'] || "http://localhost:3000/oauth2callback";

export async function authorize() {
    try {
        // Load client secrets
        const content = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
        const keys = JSON.parse(content);
        const { client_id, client_secret } = keys.web;
        
        // Create OAuth2 client
        const oAuth2Client = new OAuth2Client(
            client_id,
            client_secret,
            REDIRECT_URIS
        );

        // Check for existing token
        if (fs.existsSync(TOKEN_PATH)) {
            const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
            oAuth2Client.setCredentials(tokens);
            return oAuth2Client;
        }

        // Generate authorization URL
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });

        console.error('Authorize this app by visiting this url:', authUrl);
        
        // Start OAuth server to handle callback
        startOAuthServer();

        // Wait for user to complete authorization
        return new Promise<OAuth2Client>((resolve, reject) => {
            const checkToken = setInterval(() => {
                if (fs.existsSync(TOKEN_PATH)) {
                    clearInterval(checkToken);
                    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
                    oAuth2Client.setCredentials(tokens);
                    resolve(oAuth2Client);
                }
            }, 1000);

            // Timeout after 5 minutes
            setTimeout(() => {
                clearInterval(checkToken);
                reject(new Error('Authorization timed out'));
            }, 300000);
        });
    } catch (error) {
        console.error("Error authorizing with Google:", error);
        throw error;
    }
}

export async function handleOAuthCallback(code: string): Promise<OAuth2Client> {
    try {
        // Load client secrets
        const content = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
        const keys = JSON.parse(content);
        const { client_id, client_secret } = keys.web;
        
        // Create OAuth2 client
        const oAuth2Client = new OAuth2Client(
            client_id,
            client_secret,
            REDIRECT_URIS
        );

        // Exchange code for tokens
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Store the tokens
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.error("Tokens stored successfully at:", TOKEN_PATH);

        return oAuth2Client;
    } catch (error) {
        console.error("Error handling OAuth callback:", error);
        throw error;
    }
} 