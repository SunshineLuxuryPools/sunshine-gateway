// sunshine-gateway / server.js
// Adds explicit session confirmation before greeting + stronger keepalive.

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
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  let streamSid = null;
  let sessionReady = false;
  let openaiReady = false;
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

  const safeSend = (obj) => {
    if (oaiWS.readyState !== 1) return;
    oaiWS.send(JSON.stringify(obj));
  };

  const keepAlive = setInterval(() => {
    try { oaiWS.ping(); } catch {}
    try { twilioWS.ping(); } catch {}
  }, 20000);

  const drainQueueAndRespond = () => {
    if (!sessionReady || inProgress) return;
    if (framesQueued < 10) return; // ~200ms

    while (audioQueue.length) {
      safeSend({ type: 'input_audio_buffer.append', audio: audioQueue.shift() });
      framesQueued--;
    }
    safeSend({ type: 'input_audio_buffer.commit' });
    inProgress = true;
    safeSend({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
  };
  const flusher = setInterval(drainQueueAndRespond, 150);

  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');
    openaiReady = true;
    // Send session update
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
          response: { modalities: ['text', 'audio'], instructions: "Hi there! Thanks for calling Sunshine. How can I help today?" }
        });
      }
    }

    if (evt.type === 'response.created') inProgress = true;
    if (evt.type === 'response.completed') { inProgress = false; drainQueueAndRespond(); }

    if (evt.type === 'response.output_audio.delta' && evt.audio && streamSid) {
      const pkt = { event: 'media', streamSid, media: { payload: evt.audio } };
      try { twilioWS.send(JSON.stringify(pkt)); } catch {}
    }

    if (evt.type !== 'response.output_audio.delta') {
      console.log('[OpenAI EVT]', evt.type);
    }

    if (evt.type === 'error') console.error('[OpenAI ERROR]', evt);
  });

  oaiWS.on('error', (e) => console.error('[OpenAI] error', e?.message));
  oaiWS.on('close', () => console.log('[OpenAI] closed'));

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
      if (framesQueued % 25 === 0) console.log('[Twilio] framesQueued:', framesQueued);
    }
    if (data.event === 'stop') {
      console.log('[Twilio] stop');
      safeSend({
        type: 'response.create',
        response: { modalities: ['text','audio'], instructions: "Thanks for calling Sunshine. Goodbye!" }
      });
    }
  });

  twilioWS.on('close', () => { console.log('[Twilio] WS closed'); cleanup(); });
  twilioWS.on('error', cleanup);

  const cleanup = () => {
    clearInterval(keepAlive);
    clearInterval(flusher);
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  };
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Gateway listening on :' + port));
