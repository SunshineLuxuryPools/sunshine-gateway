// sunshine-gateway / server.js
// TwiML webhook + Twilio <Stream> + OpenAI Realtime bridge (with queue/throttle)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Basic logs + health ----------
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('sunshine-gateway up'));

// ---------- TwiML webhook (point your Twilio number here) ----------
const twimlXml = `
<Response>
  <Say voice="alice">Good morning, Sunshine. Connecting you now.</Say>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();

app.get('/twiml', (_req, res) => { console.log('[TwiML] GET /twiml');  res.type('text/xml').send(twimlXml); });
app.post('/twiml', (_req, res) => { console.log('[TwiML] POST /twiml'); res.type('text/xml').send(twimlXml); });

// ---------- HTTP server + upgrade logs ----------
const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE] request for', req.url));

// ---------- Twilio <Stream> endpoint ----------
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  let streamSid = null;

  // ----- Connect to OpenAI Realtime -----
  const OPENAI_RT_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12';
  const oaiWS = new ClientWS(OPENAI_RT_URL, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  // Keep-alives
  const keepAlive = setInterval(() => {
    try { twilioWS.ping(); } catch {}
    try { oaiWS.ping(); } catch {}
  }, 25000);

  // ---- Queue & throttle so we don't send before OpenAI is ready ----
  let openaiReady = false;
  const audioQueue = [];
  let flushTimer = null;
  const FLUSH_MS = 250;          // how often we commit & request response
  let saidHello = false;

  const safeSendToOpenAI = (obj) => {
    if (!oaiWS || oaiWS.readyState !== 1) return false; // 1 = OPEN
    try { oaiWS.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  const flushQueue = () => {
    if (!openaiReady || oaiWS.readyState !== 1) return;
    if (audioQueue.length === 0) return;
    // append all queued audio frames
    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSendToOpenAI({ type: 'input_audio_buffer.append', audio: base64 });
    }
    // commit and request audio response
    safeSendToOpenAI({ type: 'input_audio_buffer.commit' });
    safeSendToOpenAI({ type: 'response.create', response: { modalities: ['audio'] } });
  };

  const startFlusher = () => {
    if (flushTimer) return;
    flushTimer = setInterval(flushQueue, FLUSH_MS);
  };

  const stopFlusher = () => {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  };

  // ---- OpenAI events ----
  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');
    openaiReady = true;

    // Configure formats & persona
    safeSendToOpenAI({
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'mulaw', sample_rate_hz: 8000 },
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000 },
        instructions:
          "You are Sunshine’s friendly AI receptionist for pools & construction. Be brief, warm, and professional. Collect name, callback number, and reason for calling; offer to book a consultation."
      }
    });

    // Say hello immediately once, so caller hears something
    if (!saidHello) {
      saidHello = true;
      safeSendToOpenAI({
        type: 'response.create',
        response: { modalities: ['text','audio'], instructions: "Hi! Thanks for calling Sunshine. How can I help today?" }
      });
    }

    startFlusher();
  });

  oaiWS.on('message', (msg) => {
    let evt; try { evt = JSON.parse(msg.toString()); } catch { return; }
    // Forward OpenAI audio chunks to Twilio
    if (evt.type === 'response.output_audio.delta' && evt.audio && streamSid) {
      const pkt = { event: 'media', streamSid, media: { payload: evt.audio } };
      try { twilioWS.send(JSON.stringify(pkt)); } catch {}
    }
    if (evt.type === 'error') console.error('[OpenAI ERROR]', evt);
  });

  oaiWS.on('error', (e) => console.error('[OpenAI] error', e?.message || e));
  oaiWS.on('close', () => { console.log('[OpenAI] closed'); stopFlusher(); });

  // ---- Twilio -> OpenAI ----
  twilioWS.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] start callSid=', data.start?.callSid, 'streamSid=', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // buffer audio; flusher will deliver when OpenAI is OPEN
      audioQueue.push(data.media.payload);
      startFlusher();
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      // polite goodbye
      safeSendToOpenAI({
        type: 'response.create',
        response: { modalities: ['audio'], instructions: "Thanks for calling Sunshine. We'll follow up shortly. Goodbye!" }
      });
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] WS closed');
    stopFlusher();
    clearInterval(keepAlive);
    try { oaiWS.close(); } catch {}
  });

  twilioWS.on('error', () => {
    stopFlusher();
    clearInterval(keepAlive);
    try { oaiWS.close(); } catch {}
  });
});

// ---------- Start server ----------
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
