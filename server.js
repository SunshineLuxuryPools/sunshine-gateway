// sunshine-gateway / server.js (echo test)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();

// HTTP logging + health
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/',     (_, res) => res.status(200).send('sunshine-gateway up'));

const server = http.createServer(app);
server.on('upgrade', (req) => { console.log('[UPGRADE] request for', req.url); });

// WS endpoint for Twilio <Stream>
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);

  let streamSid = null; // capture on "start"

  // keep-alive
  const iv = setInterval(() => { try { ws.ping(); } catch {} }, 25000);

  ws.on('message', (msg) => {
    let d;
    try { d = JSON.parse(msg.toString()); } catch { return; }

    if (d.event === 'start') {
      streamSid = d.start?.streamSid || null;
      console.log('[Twilio] start callSid=', d.start?.callSid, 'streamSid=', streamSid);
      return;
    }

    if (d.event === 'media') {
      // Echo the caller audio back to them (μ-law 8k base64)
      // NOTE: This is for testing 2-way only; expect a slight delay/robotic sound.
      if (streamSid && d.media?.payload) {
        const out = {
          event: 'media',
          streamSid,
          media: { payload: d.media.payload }
        };
        try { ws.send(JSON.stringify(out)); } catch {}
      }
      return;
    }

    if (d.event === 'stop') {
      console.log('[Twilio] stop');
      return;
    }

    console.log('[Twilio] event:', d.event || '(unknown)');
  });

  ws.on('close', () => { clearInterval(iv); console.log('[Twilio] WS closed'); });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// graceful shutdown
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
