// sunshine-gateway / server.js  (TwiML webhook + OpenAI realtime voice bridge)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Logs + health
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/',     (_, res) => res.status(200).send('sunshine-gateway up'));

// TwiML webhook (your Twilio number points here)
const twimlXml = `
<Response>
  <Say voice="alice">Good evening, Sunshine. Connecting you now.</Say>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();
app.get('/twiml',  (_req, res) => { console.log('[TwiML] GET /twiml');  res.type('text/xml').send(twimlXml); });
app.post('/twiml', (_req, res) => { console.log('[TwiML] POST /twiml'); res.type('text/xml').send(twimlXml); });

const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE] request for', req.url));

// ---- Twilio <Stream> endpoint ----
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  let streamSid = null;

  // ----- Connect to OpenAI realtime -----
  const OPENAI_RT_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12';
  const oaiWS = new ClientWS(OPENAI_RT_URL, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  const keepAlive = setInterval(() => {
    try { twilioWS.ping(); } catch {}
    try { oaiWS.ping(); } catch {}
  }, 25000);

  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');
    // Configure audio formats and persona
    oaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format: { type: 'mulaw', sample_rate_hz: 8000 },
        output_audio_format: { type: 'mulaw', sample_rate_hz: 8000 },
        instructions:
          "You are Sunshine’s friendly AI receptionist for a pool & construction company. Be concise, warm, and professional. Collect the caller’s name, phone number, and reason for calling. Offer to book a consultation. If asked about pricing or availability, give short helpful answers and suggest scheduling."
      }
    }));
    // Say something right away so the caller hears a response
    oaiWS.send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['text','audio'], instructions: "Hi there! How can I help you today?" }
    }));
  });

  // From Twilio → to OpenAI
  twilioWS.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid;
      console.log('[Twilio] start callSid=', data.start?.callSid, 'streamSid=', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // forward caller audio to OpenAI
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      // small cadence: commit frequently so the model responds
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaiWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio'] } }));
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      // close politely
      try { oaiWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio'], instructions: "Thanks for calling Sunshine. Goodbye!" } })); } catch {}
      return;
    }
  });

  // From OpenAI → to Twilio
  oaiWS.on('message', (msg) => {
    let evt; try { evt = JSON.parse(msg.toString()); } catch { return; }

    if (evt.type === 'response.output_audio.delta' && evt.audio && streamSid) {
      const pkt = { event: 'media', streamSid, media: { payload: evt.audio } };
      try { twilioWS.send(JSON.stringify(pkt)); } catch {}
    }

    if (evt.type === 'error') {
      console.error('[OpenAI ERROR]', evt);
    }
  });

  const cleanup = () => {
    clearInterval(keepAlive);
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  };
  twilioWS.on('close', cleanup);
  twilioWS.on('error', cleanup);
  oaiWS.on('close', () => { console.log('[OpenAI] closed'); cleanup(); });
  oaiWS.on('error', (e) => console.error('[OpenAI] error', e?.message || e));
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));

// graceful shutdown
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
process.on('SIGINT',  () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } });
