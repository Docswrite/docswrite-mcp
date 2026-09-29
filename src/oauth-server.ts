import http from 'http';

export const OAUTH_PORT = Number(process.env.GOOGLE_OAUTH_PORT || 3000);

let server: http.Server | null = null;

/** Start (once) a localhost server that receives the Google OAuth redirect. */
export function startOAuthServer(onCode: (code: string) => Promise<void>) {
    if (server) return;

    server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url || '/', `http://localhost:${OAUTH_PORT}`);
        if (parsed.pathname !== '/oauth2callback') {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const code = parsed.searchParams.get('code');
        if (!code) {
            res.writeHead(400);
            res.end('No authorization code received');
            return;
        }

        try {
            await onCode(code);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Google Docs connected</h1><p>You can close this window and retry the request in your AI assistant.</p></body></html>');
            server?.close();
            server = null;
        } catch (error) {
            console.error('OAuth callback error:', error);
            res.writeHead(500);
            res.end('Authentication failed');
        }
    });

    server.on('error', (err) => {
        console.error(`Google OAuth callback server could not listen on port ${OAUTH_PORT}:`, err.message);
        server = null;
    });

    server.listen(OAUTH_PORT, () => {
        console.error(`OAuth callback server listening on http://localhost:${OAUTH_PORT}`);
    });
}
