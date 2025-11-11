// sunshine-gateway / server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();

// Log every HTTP request (helps verify /health and warm-ups)
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });

// Health + root (Render checks)
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/',     (_, res) => res.status(200).send('sunshine-gateway up'));

// Create HTTP server and log every WS upgrade attempt
const server = http.createServer(app);
server.on('upgrade', (req) => { console.log('[UPGRADE] request for', req.url); });

// WebSocket endpoint Twilio connects to (must match Twilio env var path)
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);

  // keep-alive pings so Twilio sees a live peer
  const iv = setInterval(() => { try { ws.ping(); } catch {} }, 25000);

  ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.event === 'start')  console.log('[Twilio] start callSid=', d.start?.callSid, 'streamSid=', d.start?.streamSid);
      else if (d.event === 'media')  console.log('[Twilio] media packet received');
      else if (d.event === 'stop')   console.log('[Twilio] stop');
      else                           console.log('[Twilio] event:', d.event || '(unknown)');
    } catch (e) {
      console.error('[Twilio] parse error:', e.message);
    }
  });

  ws.on('close', () => { clearInterval(iv); console.log('[Twilio] WS closed'); });
});

// Start (Render injects PORT)
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// Graceful shutdown (optional)
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
