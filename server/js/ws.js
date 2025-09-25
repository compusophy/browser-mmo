const http = require('http');
const { parse } = require('url');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const _ = require('underscore');
const Utils = require('./utils');

const { Class } = require('./lib/class');

function logInfo(message) {
    if (typeof console !== 'undefined' && console.info) {
        console.info(message);
    }
}

function logError(message) {
    if (typeof console !== 'undefined' && console.error) {
        console.error(message);
    }
}

const Connection = Class.extend({
    init: function(id, socket, server) {
        this.id = id;
        this._socket = socket;
        this._server = server;
        this.listen_callback = null;
        this.close_callback = null;

        const self = this;

        socket.on('message', function(raw) {
            if (!self.listen_callback) {
                return;
            }

            let payload = raw;
            if (Buffer.isBuffer(payload)) {
                payload = payload.toString('utf8');
            }

            if (typeof payload !== 'string') {
                // Unsupported payload type (e.g. ArrayBuffer). Close connection politely.
                self.close('Unsupported message type');
                return;
            }

            try {
                const parsed = JSON.parse(payload);
                self.listen_callback(parsed);
            } catch (err) {
                self.close('Received message was not valid JSON.');
            }
        });

        const handleClose = function() {
            if (self.close_callback) {
                self.close_callback();
            }
            self._server.removeConnection(self.id);
        };

        socket.on('close', handleClose);
        socket.on('error', function(err) {
            if (self._server.error_callback) {
                self._server.error_callback(err);
            } else {
                logError(err);
            }
        });
    },

    listen: function(callback) {
        this.listen_callback = callback;
    },

    onClose: function(callback) {
        this.close_callback = callback;
    },

    send: function(message) {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
            return;
        }

        let payload = message;
        if (typeof payload !== 'string') {
            try {
                payload = JSON.stringify(payload);
            } catch (err) {
                logError('Unable to serialize message for transport: ' + err.message);
                return;
            }
        }

        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
            return;
        }

        this._socket.send(payload);
    },

    close: function(reason) {
        if (!this._socket || this._socket.readyState === WebSocket.CLOSED) {
            return;
        }

        const message = reason ? String(reason) : 'Closing connection';
        logInfo('Closing connection ' + this.id + '. Reason: ' + message);

        try {
            this._socket.close(1000, message.substring(0, 120));
        } catch (err) {
            logError('Error while closing connection ' + this.id + ': ' + err.message);
            this._socket.terminate();
        }
    }
});

const STATIC_CONTENT_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg'
};

function createStaticMappings() {
    const clientBuildDir = path.resolve(__dirname, '../../client-build');
    const clientDir = path.resolve(__dirname, '../../client');
    const sharedDir = path.resolve(__dirname, '../../shared');

    const hasClientBuild = fs.existsSync(clientBuildDir) && fs.statSync(clientBuildDir).isDirectory();

    const primaryDir = hasClientBuild ? clientBuildDir : clientDir;

    return [
        { prefix: '/shared/', directory: sharedDir },
        { prefix: '/', directory: primaryDir }
    ];
}

const staticMappings = createStaticMappings();
const allowedRoots = staticMappings.map((mapping) => mapping.directory);

function resolveStaticFile(requestPath) {
    let mapping = staticMappings.find((entry) => requestPath.startsWith(entry.prefix));

    if (!mapping) {
        mapping = staticMappings[staticMappings.length - 1];
    }

    let relativePath = requestPath.slice(mapping.prefix.length);
    if (relativePath === '' || relativePath === '/') {
        relativePath = 'index.html';
    }

    const normalized = path
        .normalize(relativePath)
        .replace(/^([.\\/]+)+/, '');

    const filePath = path.join(mapping.directory, normalized);

    if (!allowedRoots.some((root) => filePath.startsWith(root))) {
        return null;
    }

    return filePath;
}

function serveStatic(req, res) {
    const { pathname } = parse(req.url || '/');
    const decodedPath = decodeURIComponent(pathname);
    const filePath = resolveStaticFile(decodedPath);

    if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return true;
    }

    let resolvedPath = filePath;
    try {
        const stats = fs.statSync(resolvedPath);
        if (stats.isDirectory()) {
            resolvedPath = path.join(resolvedPath, 'index.html');
            if (!allowedRoots.some((root) => resolvedPath.startsWith(root))) {
                res.writeHead(403);
                res.end('Forbidden');
                return true;
            }
        }
    } catch (err) {
        res.writeHead(404);
        res.end('Not found');
        return true;
    }

    try {
        const data = fs.readFileSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const type = STATIC_CONTENT_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
        return true;
    } catch (err) {
        logError('Error reading static file: ' + resolvedPath + ' - ' + err.message);
        res.writeHead(500);
        res.end('Internal server error');
        return true;
    }
}

const WebsocketServer = Class.extend({
    init: function(port, logger) {
        this.port = port;
        this._connections = {};
        this._counter = 0;
        this.connection_callback = null;
        this.error_callback = null;
        this.status_callback = null;
        this.log = logger || {
            info: logInfo,
            error: logError,
            debug: function() {}
        };

        this._httpServer = http.createServer(this._handleHttpRequest.bind(this));
        this._httpServer.on('error', this._handleServerError.bind(this));

        const self = this;
        this._httpServer.listen(port, function() {
            this.log.info('HTTP/WebSocket server listening on port ' + port);
        });

        this._wsServer = new WebSocket.Server({ server: this._httpServer });
        this._wsServer.on('connection', function(socket) {
            self._handleConnection(socket);
        });
        this._wsServer.on('error', this._handleServerError.bind(this));
    },

    _handleHttpRequest: function(req, res) {
        const { pathname } = parse(req.url || '/');

        if (pathname === '/status' && req.method === 'GET') {
            if (this.status_callback) {
                try {
                    const body = this.status_callback();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(body);
                } catch (err) {
                    logError('Error while resolving /status: ' + err.message);
                    res.writeHead(500);
                    res.end();
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        } else {
            if (!serveStatic(req, res)) {
                res.writeHead(404);
                res.end();
            }
        }
    },

    _handleServerError: function(err) {
        if (this.error_callback) {
            this.error_callback(err);
        } else {
                this.log.error(err);
        }
    },

    _handleConnection: function(socket) {
        const connection = new Connection(this._createId(), socket, this);
        this.addConnection(connection);

        if (this.connection_callback) {
            this.connection_callback(connection);
        }
    },

    _createId: function() {
        return '5' + Utils.random(99) + '' + (this._counter++);
    },

    onConnect: function(callback) {
        this.connection_callback = callback;
    },

    onError: function(callback) {
        this.error_callback = callback;
    },

    onRequestStatus: function(callback) {
        this.status_callback = callback;
    },

    addConnection: function(connection) {
        this._connections[connection.id] = connection;
    },

    removeConnection: function(id) {
        delete this._connections[id];
    },

    getConnection: function(id) {
        return this._connections[id];
    },

    forEachConnection: function(callback) {
        _.each(this._connections, callback);
    },

    broadcast: function(message) {
        this.forEachConnection(function(connection) {
            connection.send(message);
        });
    }
});

module.exports = WebsocketServer;

