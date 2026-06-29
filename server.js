// GlideGoal Arena - PeerJS Signaling Server
// Handles only WebRTC signaling — all game logic runs on client.
// Deploy this on Render (free tier): node server.js

const { PeerServer } = require('peer');

const PORT = process.env.PORT || 9000;

const peerServer = PeerServer({
  port: PORT,
  path: '/peerjs',
  allow_discovery: true,
  proxied: true,
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

peerServer.on('connection', (client) => {
  console.log(`[+] Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[-] Peer disconnected: ${client.getId()}`);
});

console.log(`GlideGoal PeerJS Signaling Server running on port ${PORT}`);
