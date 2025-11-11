// sunshine-gateway / server.js
// Twilio <Stream> ↔ OpenAI Realtime (g711_ulaw). Robust queueing & overlap guards.

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
  let inProgress = false;         // true while OpenAI is generating/playing
  let saidHello = false;
  let conversationStarted = false;

  // Audio queue
  const MIN_FRAMES_FOR_COMMIT = 10; // 10*~20ms = ~200ms
  let framesQueued = 0;
  let bufferDirty = false;
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
    inProgress = true;
    
    console.log('[Bridge] Sending initial greeting');
    // Use conversation.item.create to add assistant message directly
    safeSend({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'input_text',
            text: 'Good evening, Sunshine Pools and Construction. How can I help you today?'
          }
        ]
      }
    });
    
    // Then create response to generate the audio
    safeSend({ 
      type: 'response.create',
      response: { modalities: ['audio'] }
    });
  };

  // Commit & ask for response only when appropriate
  const tryCommitAndRespond = () => {
    if (!sessionReady || inProgress) return;
    if (!bufferDirty || framesQueued < MIN_FRAMES_FOR_COMMIT) return;

    console.log('[Bridge] committing', framesQueued, 'frames (~', framesQueued * 20, 'ms)');
    
    // Send all queued audio
    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSend({ type: 'input_audio_buffer.append', audio: base64 });
      framesQueued--;
    }
    
    bufferDirty = false;
    
    // Commit the buffer
    safeSend({ type: 'input_audio_buffer.commit' });
    
    // Request response
    inProgress = true;
    safeSend({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
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
        turn_detection: null,  // Server-controlled turn detection
        input_audio_transcription: { model: 'whisper-1' },
        instructions: `You are Sunshine Pools and Construction's friendly AI receptionist. 

Be brief, warm, and professional. Your job is to:
1. Greet callers warmly
2. Listen to their needs
3. Collect their name, callback number, and reason for calling
4. Offer to book a consultation if appropriate
5. Thank them for calling

Keep responses concise and natural. Don't overwhelm with too much information at once.`
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
      // Send greeting once session is ready
      sendInitialGreeting();
    }

    if (evt.type === 'session.created') {
      console.log('[OpenAI] session created');
    }

    // Track response lifecycle
    if (evt.type === 'response.created') {
      inProgress = true;
      console.log('[OpenAI] response started');
    }

    if (evt.type === 'response.done') {
      inProgress = false;
      console.log('[OpenAI] response completed');
      conversationStarted = true;
      // Check if we have buffered audio to process
      tryCommitAndRespond();
    }

    // Handle audio deltas (both field names for compatibility)
    if ((evt.type === 'response.audio.delta' || evt.type === 'response.output_audio.delta') && streamSid) {
      const audioData = evt.delta || evt.audio;
      if (audioData) {
        const pkt = { 
          event: 'media', 
          streamSid, 
          media: { payload: audioData } 
        };
        try { twilioWS.send(JSON.stringify(pkt)); } catch(e) {
          console.error('[Twilio] Error sending audio:', e.message);
        }
      }
    }

    if (evt.type === 'error') {
      console.error('[OpenAI ERROR]', JSON.stringify(evt, null, 2));
      inProgress = false;
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
        frameCountLog++;
        if (frameCountLog % 50 === 0) {
          console.log('[Twilio] Total media frames received:', frameCountLog);
        }
      }
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] Stream stopped');
      // Send goodbye if appropriate
      if (!inProgress && conversationStarted) {
        inProgress = true;
        safeSend({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: 'Thanks for calling Sunshine. Have a great day!' }]
          }
        });
        safeSend({ type: 'response.create', response: { modalities: ['audio'] } });
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
