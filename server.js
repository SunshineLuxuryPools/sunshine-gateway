// sunshine-gateway / server.js (TwiML webhook + WS stream + loud logs)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Loud HTTP logging
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });

// Health + root
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/',     (_, res) => res.status(200).send('sunshine-gateway up'));

// TwiML webhook (GET for browser test, POST for Twilio)
const twimlXml = `
<Response>
  <Say voice="alice">Good evening, Sunshine. Connecting you now.</Say>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();

app.get('/twiml',  (_req, res) => { console.log('[TwiML] GET /twiml');  res.type('text/xml').send(twimlXml); });
app.post('/twiml', (_req, res) => { console.log('[TwiML] POST /twiml'); res.type('text/xml').send(twimlXml); });

// HTTP server + WS upgrade logging
const server = http.createServer(app);
server.on('upgrade', (req) => { console.log('[UPGRADE] request for', req.url); });

// WebSocket endpoint for Twilio <Stream>
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  let streamSid = null;

  const iv = setInterval(() => { try { ws.ping(); } catch {} }, 25000);

  ws.on('message', (msg) => {
    let d; try { d = JSON.parse(msg.toString()); } catch { return; }
    if (d.event === 'start') {
      streamSid = d.start?.streamSid || null;
      console.log('[Twilio] start callSid=', d.start?.callSid, 'streamSid=', streamSid);
    } else if (d.event === 'media') {
      console.log('[Twilio] media packet received');
    } else if (d.event === 'stop') {
      console.log('[Twilio] stop');
    } else {
      console.log('[Twilio] event:', d.event || '(unknown)');
    }
  });

  ws.on('close', () => { clearInterval(iv); console.log('[Twilio] WS closed'); });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// Graceful shutdown
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
