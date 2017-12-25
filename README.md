FinalRPC
=======

A *dumb* (read simple) promise-aware RPC implementation with support for Pub/Sub for FinalPM.
Only RPC implementation for node right now that works with unix domain sockets out of the box
and has pub/sub.

```js
const {Client, Server} = require('final-rpc');

const path = require('path');
const server = new Server();

server.register({
   add(client, a, b) {
      return new Promise((resolve) => {
         setTimeout(() => {
            resolve(a + b);
         }, 500);
      });
   },
   subscribe(client) {
      server.subscribe(client, 'news');
   },
   unsubscribe(client) {
      server.unsubscribe(client, 'news');
   }
});

setInterval(() => server.publish('news', 'hi'), 1000);

server.listen('ws+unix://' + path.resolve('rpc.sock')).then(startClient);

async function startClient() {
   const client = new Client('ws+unix://'+ path.resolve('rpc.sock'));

   client.pubsub.on('news', (msg) => console.log('News:', msg));

   await client.invoke('subscribe');

   console.log('Result:', await client.invoke('add', 5, 10));
}
```

