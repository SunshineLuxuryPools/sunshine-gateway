// sunshine-gateway / server.js
// Twilio <Stream> ↔ OpenAI Realtime (g711_ulaw) with VAD turn-taking, strict commit guards, short replies.

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Basic logs + health
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('sunshine-gateway up'));

// --- TwiML webhook (point your Twilio number here as Webhook POST)
const twimlXml = `
<Response>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();
app.get('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));
app.post('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));

const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE] request for', req.url));

// --- Twilio <Stream> endpoint
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);

  // State
  let streamSid = null;
  let sessionReady = false;
  let inProgress = false;             // true only while OpenAI is producing audio
  let saidHello = false;
  let conversationStarted = false;

  // Audio queue
  const MIN_FRAMES_FOR_COMMIT = 10;   // ≈ 200ms (10 x ~20ms frames)
  const MIN_SILENCE_MS = 450;         // wait since last caller audio before commit
  let framesQueued = 0;
  let bufferDirty = false;
  let lastMediaAt = 0;
  const audioQueue = [];

  // --- Connect to OpenAI Realtime
  const OPENAI_RT_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const oaiWS = new ClientWS(OPENAI_RT_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  // cleanup must be defined before usage
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

  const safeSend = (obj) => {
    if (oaiWS.readyState !== 1) return false;
    try { oaiWS.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  // Send initial greeting WITHOUT committing audio buffer
  const sendInitialGreeting = () => {
    if (saidHello || !sessionReady) return;
    saidHello = true;

    console.log('[Bridge] Sending initial greeting');
    // Add assistant message to conversation…
    safeSend({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: 'Hi! Thanks for calling Sunshine. How can I help today?' }]
      }
    });
    // …then render it as audio
    safeSend({ type: 'response.create', response: { modalities: ['text','audio'] } });
  };

  // Commit & ask for response only when appropriate
  const tryCommitAndRespond = () => {
    if (!sessionReady || inProgress) return;
    if (!bufferDirty || framesQueued < MIN_FRAMES_FOR_COMMIT) return;
    if (audioQueue.length === 0) return;

    const now = Date.now();
    if (now - lastMediaAt < MIN_SILENCE_MS) return;  // wait for caller to finish

    console.log('[Bridge] committing', framesQueued, 'frames (~', framesQueued * 20, 'ms), queueLen=', audioQueue.length);

    // Send all queued audio
    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSend({ type: 'input_audio_buffer.append', audio: base64 });
      framesQueued--;
    }
    bufferDirty = false;

    // Commit the buffer
    safeSend({ type: 'input_audio_buffer.commit' });

    // Request response AFTER a real commit (inProgress flips true on response.created)
    safeSend({ type: 'response.create', response: { modalities: ['text','audio'] } });
  };

  const flusher = setInterval(tryCommitAndRespond, 150);

  // ---- OpenAI events
  oaiWS.on('open', () => {
    console.log('[OpenAI] connected');
    safeSend({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'alloy', // try 'verse' or 'aria' if you prefer
        // Server-side turn taking (no monologues, wait after a question)
        turn_detection: {
          type: 'server',
          threshold: 0.5,
          silence_duration_ms: 600
        },
        input_audio_transcription: { model: 'whisper-1' },
        instructions: `You are the friendly receptionist for Sunshine Custom Home Builders and Sunshine Luxury Pools.

Rules:
- Keep replies to 1 short sentence, then STOP.
- Ask exactly one question at a time, then WAIT for the caller.
- Do NOT pitch or list services unless asked.
- Offer to book only when the caller asks for a quote/appointment or after they’ve explained the need.
- Confirm name and callback number before booking.
- If the caller gives a time, repeat it back as a question and wait for “yes”.
- If you didn't catch something, ask a brief follow-up, then wait.`
      }
    });
  });

  oaiWS.on('message', (msg) => {
    let evt; 
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    // Log non-stream events
    if (evt.type && evt.type !== 'response.audio.delta' && evt.type !== 'response.output_audio.delta') {
      console.log('[OpenAI EVT]', evt.type);
    }

    if (evt.type === 'session.updated') {
      sessionReady = true;
      console.log('[OpenAI] session confirmed');
      sendInitialGreeting();
    }

    // Track response lifecycle (flip busy only on created/completed)
    if (evt.type === 'response.created') {
      inProgress = true;
      console.log('[OpenAI] response started');
    }

    if (evt.type === 'response.completed' || evt.type === 'response.done' || evt.type === 'response.output_audio.done') {
      inProgress = false;
      console.log('[OpenAI] response completed');
      conversationStarted = true;
      tryCommitAndRespond();
    }

    // Handle audio deltas (both field names for compatibility)
    if ((evt.type === 'response.audio.delta' || evt.type === 'response.output_audio.delta') && streamSid) {
      const audioData = evt.delta || evt.audio;
      if (audioData) {
        const pkt = { event: 'media', streamSid, media: { payload: audioData } };
        try { twilioWS.send(JSON.stringify(pkt)); } catch(e) {
          console.error('[Twilio] Error sending audio:', e.message);
        }
      }
    }

    if (evt.type === 'error') {
      console.error('[OpenAI ERROR]', JSON.stringify(evt, null, 2));
      inProgress = false; // unblock if an error occurs
    }
  });

  oaiWS.on('error', (e) => {
    console.error('[OpenAI] WebSocket error:', e?.message);
  });
  
  oaiWS.on('close', (code, reason) => {
    console.log('[OpenAI] closed. Code:', code, 'Reason:', reason?.toString());
  });

  // ---- Twilio → OpenAI
  let frameCountLog = 0;
  twilioWS.on('message', (buf) => {
    let data; 
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] Stream started. SID:', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // Only queue audio after conversation has started
      if (conversationStarted) {
        audioQueue.push(data.media.payload);
        framesQueued++;
        bufferDirty = true;
        lastMediaAt = Date.now();
        frameCountLog++;
        if (frameCountLog % 50 === 0) console.log('[Twilio] Total media frames received:', frameCountLog);
      }
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] Stream stopped');
      // Optional: brief sign-off if idle
      if (!inProgress && conversationStarted) {
        safeSend({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: 'Thanks for calling Sunshine. Have a great day!' }]
          }
        });
        safeSend({ type: 'response.create', response: { modalities: ['text','audio'] } });
      }
      return;
    }
  });

  twilioWS.on('close', () => { 
    console.log('[Twilio] WebSocket closed'); 
    cleanup(); 
  });
  
  twilioWS.on('error', (e) => {
    console.error('[Twilio] WebSocket error:', e?.message);
    cleanup();
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('🌞 Sunshine Gateway listening on port ' + port));
