// sunshine-gateway / server.js
// Twilio <Stream> ↔ OpenAI Realtime bridge with g711_ulaw,
// session confirmation, ≥200ms buffering, and overlap guards.

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('sunshine-gateway up'));

const twimlXml = `
<Response>
  <Say voice="alice">Good morning, Sunshine. Connecting you now.</Say>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();
app.get('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));
app.post('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));

const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE] request for', req.url));

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);

  let streamSid = null;
  let sessionReady = false;
  let inProgress = false;
  let saidHello = false;
  let framesQueued = 0;
  const audioQueue = [];

  const OPENAI_RT_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12';
  const oaiWS = new ClientWS(OPENAI_RT_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  // --- define cleanup BEFORE any use (function declaration is hoisted) ---
  function cleanup() {
    try { clearInterval(keepAlive); } catch {}
    try { clearInterval(flusher); } catch {}
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  }

  const keepAlive = setInterval(() => {
    try { oaiWS.ping(); } catch {}
    try { twilioWS.ping(); } catch {}
  }, 20000);

  const MIN_FRAMES_FOR_COMMIT = 10; // ~200ms (10 * 20ms frames)

  const safeSend = (obj) => {
    if (oaiWS.readyState !== 1) return;
    oaiWS.send(JSON.stringify(obj));
  };

  const drainQueueAndRespond = () => {
    if (!sessionReady || inProgress) return;
    if (framesQueued < MIN_FRAMES_FOR_COMMIT) return;

    console.log('[Bridge] committing', framesQueued, 'frames (~', framesQueued * 20, 'ms)');
    while (audioQueue.length) {
      safeSend({ type: 'input_audio_buffer.append', audio: audioQueue.shift() });
      framesQueued--;
    }
    safeSend({ type: 'input_audio_buffer.commit' });
    inProgress = true;
    safeSend({ type: 'response.create', response: { modalities: ['text','audio'] } });
  };

  const flusher = setInterval(drainQueueAndRespond, 150);

  // ----- OpenAI events -----
  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');
    safeSend({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          "You are Sunshine’s friendly AI receptionist for pools and construction. Be brief, warm, and professional. Collect name, callback number, and reason for calling. Offer to book a consultation."
      }
    });
  });

  oaiWS.on('message', (msg) => {
    let evt; try { evt = JSON.parse(msg.toString()); } catch { return; }

    if (evt.type === 'session.updated') {
      sessionReady = true;
      console.log('[OpenAI] session confirmed');
      if (!saidHello) {
        saidHello = true;
        console.log('[OpenAI] sending hello');
        safeSend({
          type: 'response.create',
          response: { modalities: ['text','audio'], instructions: "Hi there! Thanks for calling Sunshine. How can I help today?" }
        });
      }
    }

    if (evt.type === 'response.created') inProgress = true;
    if (evt.type === 'response.completed') { inProgress = false; drainQueueAndRespond(); }

    if (evt.type === 'response.output_audio.delta' && evt.audio && streamSid) {
      const pkt = { event: 'media', streamSid, media: { payload: evt.audio } };
      try { twilioWS.send(JSON.stringify(pkt)); } catch {}
    }

    if (evt.type !== 'response.output_audio.delta') console.log('[OpenAI EVT]', evt.type);
    if (evt.type === 'error') console.error('[OpenAI ERROR]', evt);
  });

  oaiWS.on('error', (e) => console.error('[OpenAI] error', e?.message));
  oaiWS.on('close', () => console.log('[OpenAI] closed'));

  // ----- Twilio -> OpenAI -----
  let frameCountLog = 0;
  twilioWS.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid;
      console.log('[Twilio] start', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      audioQueue.push(data.media.payload);
      framesQueued++;
      frameCountLog++;
      if (frameCountLog % 25 === 0) console.log('[Twilio] media frames queued:', frameCountLog);
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      if (!inProgress) {
        inProgress = true;
        safeSend({
          type: 'response.create',
          response: { modalities: ['text','audio'], instructions: "Thanks for calling Sunshine. Goodbye!" }
        });
      }
      return;
    }
  });

  twilioWS.on('close', () => { console.log('[Twilio] WS closed'); cleanup(); });
  twilioWS.on('error', cleanup);
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));
