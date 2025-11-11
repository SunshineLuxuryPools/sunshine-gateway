require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/', (_, res) => res.status(200).send('sunshine-gateway up'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  const iv = setInterval(() => { try { ws.ping(); } catch {} }, 25000);

  ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.event === 'start')  console.log('[Twilio] start', d.start?.callSid, d.start?.streamSid);
      if (d.event === 'media')  console.log('[Twilio] media packet received');
      if (d.event === 'stop')   console.log('[Twilio] stop');
    } catch {}
  });

  ws.on('close', () => { clearInterval(iv); console.log('[Twilio] WS closed'); });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));
