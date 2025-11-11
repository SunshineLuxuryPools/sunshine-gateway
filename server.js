// sunshine-gateway / server.js
// TwiML webhook + Twilio <Stream> + OpenAI Realtime bridge
// Fixes: queue ≥100ms before commit, always use modalities ['text','audio'].

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Logs + health ----------
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

// ---------- HTTP server + WS upgrade logs ----------
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

  // ---- Queue & thresholds ----
  // Twilio sends 20ms mulaw frames. Commit when we have >= 6 frames (~120ms).
  const FRAME_MS = 20;
  const MIN_FRAMES_FOR_COMMIT = 6; // 120ms
  let audioQueue = [];
  let framesQueued = 0;
  let openaiReady = false;
  let saidHello = false;

  const safeSendToOpenAI = (obj) => {
    if (oaiWS.readyState !== 1) return false; // 1 = OPEN
    try { oaiWS.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  const flushIfReady = () => {
    if (!openaiReady) return;
    if (framesQueued < MIN_FRAMES_FOR_COMMIT) return;
    // Drain the queue
    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSendToOpenAI({ type: 'input_audio_buffer.append', audio: base64 });
      framesQueued--;
    }
    // Commit and request a response with audio+text
    safeSendToOpenAI({ type: 'input_audio_buffer.commit' });
    safeSendToOpenAI({ type: 'response.create', response: { modalities: ['text','audio'] } });
  };

  // Periodic flusher (200ms)
  const flusher = setInterval(flushIfReady, 200);

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

    // Speak once immediately so the caller hears something
    if (!saidHello) {
      saidHello = true;
      safeSendToOpenAI({
        type: 'response.create',
        response: { modalities: ['text','audio'], instructions: "Hi! Thanks for calling Sunshine. How can I help today?" }
      });
    }
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
  oaiWS.on('close', () => console.log('[OpenAI] closed'));

  // ---- Twilio -> OpenAI ----
  twilioWS.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] start callSid=', data.start?.callSid, 'streamSid=', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // Buffer frames; the flusher will commit once we have enough
      audioQueue.push(data.media.payload);
      framesQueued++; // 1 frame ≈ 20ms at 8kHz mulaw
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      // Optional polite sign-off
      safeSendToOpenAI({
        type: 'response.create',
        response: { modalities: ['text','audio'], instructions: "Thanks for calling Sunshine. We'll follow up shortly. Goodbye!" }
      });
      return;
    }
  });

  const cleanup = () => {
    clearInterval(flusher);
    clearInterval(keepAlive);
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  };

  twilioWS.on('close', () => { console.log('[Twilio] WS closed'); cleanup(); });
  twilioWS.on('error', cleanup);
});

// ---------- Start server ----------
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
