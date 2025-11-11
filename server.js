// sunshine-gateway / server.js
// TwiML webhook + Twilio <Stream> + OpenAI Realtime bridge
// Uses 'g711_ulaw' formats; buffers >=200ms; prevents overlapping responses.

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ----- Logs + health -----
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('sunshine-gateway up'));

// ----- TwiML webhook (Twilio points here) -----
const twimlXml = `
<Response>
  <Say voice="alice">Good morning, Sunshine. Connecting you now.</Say>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();
app.get('/twiml', (_req, res) => { console.log('[TwiML] GET /twiml');  res.type('text/xml').send(twimlXml); });
app.post('/twiml', (_req, res) => { console.log('[TwiML] POST /twiml'); res.type('text/xml').send(twimlXml); });

// ----- HTTP server + WS upgrade logs -----
const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE] request for', req.url));

// ----- Twilio <Stream> endpoint -----
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  let streamSid = null;

  // Connect to OpenAI Realtime
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

  // Queue & control
  const MIN_FRAMES_FOR_COMMIT = 10; // 10 x ~20ms = ~200ms
  let framesQueued = 0;
  let audioQueue = [];
  let openaiReady = false;
  let saidHello = false;
  let inProgress = false;

  const safeSendToOpenAI = (obj) => {
    if (oaiWS.readyState !== 1) return false; // 1 = OPEN
    try { oaiWS.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  const drainQueueAndRespond = () => {
    if (!openaiReady || inProgress) return;
    if (framesQueued < MIN_FRAMES_FOR_COMMIT) return;

    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSendToOpenAI({ type: 'input_audio_buffer.append', audio: base64 });
      framesQueued--;
    }
    safeSendToOpenAI({ type: 'input_audio_buffer.commit' });
    inProgress = true; // will be cleared on response.completed
    safeSendToOpenAI({ type: 'response.create', response: { modalities: ['text','audio'] } });
  };

  const flusher = setInterval(drainQueueAndRespond, 150);

  // ----- OpenAI events -----
  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');

    openaiReady = true;
    // IMPORTANT: formats must be strings ('g711_ulaw' | 'g711_alaw' | 'pcm16')
    safeSendToOpenAI({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          "You are Sunshine’s friendly AI receptionist for pools & construction. Be brief, warm, and professional. Collect name, callback number, and reason for calling; offer to book a consultation."
      }
    });

    if (!saidHello) {
      saidHello = true;
      inProgress = true;
      safeSendToOpenAI({
        type: 'response.create',
        response: { modalities: ['text','audio'], instructions: "Hi! Thanks for calling Sunshine. How can I help today?" }
      });
    }
  });

  oaiWS.on('message', (msg) => {
    let evt; try { evt = JSON.parse(msg.toString()); } catch { return; }

    if (evt.type === 'response.created') inProgress = true;
    if (evt.type === 'response.completed') {
      inProgress = false;
      drainQueueAndRespond();
    }

    if (evt.type === 'response.output_audio.delta' && evt.audio && streamSid) {
      const pkt = { event: 'media', streamSid, media: { payload: evt.audio } };
      try { twilioWS.send(JSON.stringify(pkt)); } catch {}
    }

    if (evt.type === 'error') console.error('[OpenAI ERROR]', evt);
  });

  oaiWS.on('error', (e) => console.error('[OpenAI] error', e?.message || e));
  oaiWS.on('close', () => console.log('[OpenAI] closed'));

  // ----- Twilio -> OpenAI -----
  twilioWS.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] start callSid=', data.start?.callSid, 'streamSid=', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      audioQueue.push(data.media.payload);
      framesQueued++;
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      if (!inProgress) {
        inProgress = true;
        safeSendToOpenAI({
          type: 'response.create',
          response: { modalities: ['text','audio'], instructions: "Thanks for calling Sunshine. We'll follow up shortly. Goodbye!" }
        });
      }
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

// ----- Start server -----
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// ----- Graceful shutdown -----
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
