import http from 'http';
import url from 'url';
import { handleOAuthCallback } from './auth.js';

const PORT = 3000;

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url || '', true);
    
    if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.query.code as string;
        
        if (!code) {
            res.writeHead(400);
            res.end('No authorization code received');
            return;
        }

        try {
            await handleOAuthCallback(code);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                    <body>
                        <h1>Authentication Successful!</h1>
                        <p>You can close this window and return to your application.</p>
                    </body>
                </html>
            `);
        } catch (error) {
            console.error('OAuth callback error:', error);
            res.writeHead(500);
            res.end('Authentication failed');
        }
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

export function startOAuthServer() {
    server.listen(PORT, () => {
        console.error(`OAuth callback server listening on http://localhost:${PORT}`);
    });
} 