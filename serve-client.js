const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const CLIENT_DIR = path.join(__dirname, 'client');
const SHARED_DIR = path.join(__dirname, 'shared');

const PUBLIC_PREFIXES = [
    { prefix: '/shared/', directory: SHARED_DIR },
    { prefix: '/', directory: CLIENT_DIR }
];

const server = http.createServer((req, res) => {
    const requestedUrl = decodeURIComponent(req.url);

    let servingDir = CLIENT_DIR;
    let relativePath = requestedUrl;

    for (const mapping of PUBLIC_PREFIXES) {
        if (requestedUrl.startsWith(mapping.prefix)) {
            servingDir = mapping.directory;
            relativePath = requestedUrl.slice(mapping.prefix.length);
            break;
        }
    }

    if (relativePath === '' || relativePath === '/') {
        relativePath = 'index.html';
    }

    // Normalise and prevent directory traversal
    const normalisedPath = path.normalize(relativePath).replace(/^([\.\\/])*\./, '');
    let filePath = path.join(servingDir, normalisedPath);

    // Security check to prevent directory traversal
    const allowedRoots = [CLIENT_DIR, SHARED_DIR];
    if (!allowedRoots.some((root) => filePath.startsWith(root))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Internal server error');
            }
            return;
        }

        if (stats.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
            if (!filePath.startsWith(servingDir)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }

            // Set content type based on file extension
            const ext = path.extname(filePath).toLowerCase();
            const contentTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'text/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.mp3': 'audio/mpeg',
                '.ogg': 'audio/ogg',
                '.woff': 'font/woff',
                '.woff2': 'font/woff2',
                '.ttf': 'font/ttf',
                '.svg': 'image/svg+xml'
            };

            res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
            res.end(data);
        });
    });
});

server.listen(PORT, () => {
    console.log(`Client server running at http://localhost:${PORT}`);
    console.log('Open your browser and navigate to the URL above to play BrowserQuest');
});
