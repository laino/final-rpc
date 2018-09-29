
const WebSocket = require('ws');
const http = require('http');
const util = require('util');
const url = require('url');
const {EventEmitter} = require('events');

class Server extends EventEmitter {
    constructor(options) {
        super();

        options = Object.assign({
            httpServer: null,
            wsServer: null
        }, options);

        this.methods = new Map();

        this.httpServer = options.httpServer;
        this.server = options.wsServer;

        if (!this.httpServer && !this.server) {
            this.httpServer = options.server || http.createServer();
        }

        if (!this.server) {
            this.server = new WebSocket.Server({
                server: this.httpServer,
                perMessageDeflate: false
            });
        }

        this._onError = this._onError.bind(this);
        this._onConnection = this._onConnection.bind(this);

        if (this.httpServer) {
            this.httpServer.on('error', this._onError);
        }

        this.server.on('error', this._onError);
        this.server.on('connection', this._onConnection);

        this.channels = new Map();
        this.subscribedChannels = new WeakMap();
    }

    subscribe(client, channel) {
        if (!this.server.clients.has(client)) {
            return;
        }

        let subscribers = this.channels.get(channel);

        if (!subscribers) {
            this.channels.set(channel, subscribers = new Set());
        }

        let channels = this.subscribedChannels.get(client);

        if (!channels) {
            this.subscribedChannels.set(client, channels = new Set());
        }

        subscribers.add(client);
        channels.add(channel);
    }

    unsubscribe(client, channel) {
        const subscribers = this.channels.get(channel);

        if (subscribers) {
            subscribers.delete(client);
        }

        const channels = this.subscribedChannels.get(client);

        if (channels) {
            channels.delete(channel);
        }
    }

    register(methods) {
        for (const [method,fn] of Object.entries(methods)) {
            this.methods.set(method, fn);
        }
    }

    _onConnection(client) {
        client.on('message', (msg) => {
            this._onMessage(client, msg);
        });

        client.on('close', () => {
            this._onDisconnect(client);
        });

        client.on('error', (error) => {
            this.emit('clienterror', client, error);
        });

        this.emit('connection', client);
    }

    _onError(error) {
        this.emit('error', error);
    }

    _onDisconnect(client) {
        const channels = this.subscribedChannels.get(client);

        if (channels) {
            for (const channel of channels.entries()) {
                this.unsubscribe(client, channel);
            }

            this.subscribedChannels.delete(client);
        }

        this.emit('disconnect', client);
    }

    _onMessage(client, data) {
        const msg = decodeMsg(data);

        if (!(msg instanceof Array) || msg[0] !== 0) {
            return;
        }

        const [, method, cbID, ...args] = msg;

        const fn = this.methods.get(method);

        const that = this;

        if (!fn) {
            reject('no such method');
            return;
        }

        try {
            const result = fn(client, ...args);

            if (typeof result === 'object' && typeof result.then === 'function') {
                return result.then(resolve, reject);
            }

            resolve(result);
        } catch (error) {
            reject(error);
        }

        function resolve(result) {
            that._send(client, [0, cbID, result]);
        }

        function reject(error) {
            if (error instanceof Error) {
                error = {
                    name: error.name,
                    stack: error.stack,
                    message: error.message
                };
            }
            that._send(client, [1, cbID, error]);
        }
    }

    publish(channel, ...args) {
        let subscribers = this.channels.get(channel);

        if (!subscribers) {
            return;
        }

        for (const client of subscribers.values()) {
            this._send(client, [2, channel, ...args]);
        }
    }

    _send(client, msg) {
        try {
            client.send(encodeMsg(msg));
        } catch (error) {
            this.emit('clienterror', client, error);
        }
    }

    close() {
        return new Promise((resolve, reject) => {
            if (!this.httpServer) {
                return resolve();
            }

            this.httpServer.close((error) => {
                if (error) {
                    return reject(error);
                }

                resolve();
            });
        });
    }

    async listen(_url) {
        if (!this.httpServer) {

            throw new Error('no http server');
        }

        const parsed = url.parse(_url);
        const listen = util.promisify(this.httpServer.listen.bind(this.httpServer));

        if (parsed.protocol === 'ws+unix:') {
            const path = parsed.host + (parsed.pathname || '');
            await listen(path);
        } else {
            await listen(Number(parsed.port), parsed.hostname);
        }
    }
}

class Client extends EventEmitter {
    constructor(host) {
        super();

        this._onError = this._onError.bind(this);
        this._onClose = this._onClose.bind(this);
        this._onMessage = this._onMessage.bind(this);

        this.pubsub = new EventEmitter();
        this.outstandingRequests = new Map();
        this.counter = 0;

        this.openPromise = new Promise((resolve, reject) => {
            const socket = new WebSocket(host);

            const onOpen = () => {
                socket.removeListener('error', onError);

                socket.on('error', this._onError);
                socket.on('close', this._onClose);
                socket.on('message', this._onMessage);

                this.socket = socket;

                this.emit('open');

                resolve(this);
            };

            const onError = (error) => {
                socket.removeListener('open', onOpen);
                reject(error);
            };

            socket.once('open', onOpen);
            socket.once('error', onError);
        });

        this.openPromise.catch((error) => {
            this.emit('error', error);
        });
    }

    async waitOpen() {
        // Prevent 'error' event from getting thrown when there are no listeners
        function noop(){}

        this.on('error', noop);

        this.openPromise.catch(noop).then(() => {
            this.removeListener('error', noop);
        });

        return this.openPromise;
    }

    async invoke(method, ...args) {
        const cbID = this.counter++;

        await this.openPromise;

        return new Promise((resolve, reject) => {
            this.socket.send(encodeMsg([0, method, cbID, ...args]));
            this.outstandingRequests.set(cbID, {resolve, reject});
        });
    }

    async close() {
        await this.openPromise;

        return await new Promise((resolve) => {
            this.socket.close();

            this.once('close', resolve);
        });
    }

    _onMessage(_data) {
        const msg = decodeMsg(_data);

        if (!(msg instanceof Array)) {
            return;
        }

        const [type, ...data] = msg;

        if (type === 0 || type === 1) {
            const promise = this.outstandingRequests.get(data[0]);

            if (!promise) {
                return;
            }

            this.outstandingRequests.delete(data[0]);

            if (type === 0) {
                promise.resolve(data[1]);
            } else {
                promise.reject(data[1]);
            }

            return;
        }

        if (type === 2) {
            this.emit('publish', ...data);
            this.pubsub.emit(...data);
            return;
        }
    }

    _onError(error) {
        this.emit('error', error);
    }

    _onClose() {
        for (const promise of this.outstandingRequests.values()) {
            promise.reject(new Error('connection closed'));
        }

        this.outstandingRequests.clear();

        this.emit('close');
    }

}

function encodeMsg(msg) {
    return JSON.stringify(msg);
}

function decodeMsg(data) {
    try {
        return JSON.parse(data.toString());
    } catch (error) {
        return null;
    }
}

module.exports = { Server, Client, WebSocket };
