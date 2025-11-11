// server.js - Sunshine Luxury Pools AI Assistant
require('dotenv').config();
const config = require('./config');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket: ClientWS } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('Sunshine Luxury Pools AI Assistant'));

// Generate TwiML from config
const twimlXml = `
<Response>
  <Say voice="Polly.Joanna">${config.greeting}</Say>
  <Pause length="1"/>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();

app.get('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));
app.post('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

// Build AI instructions from config
function buildInstructions() {
  const examples = config.conversationExamples
    .map(ex => `Caller: "${ex.caller}"\nEmma: "${ex.emma}"`)
    .join('\n\n');
  
  const quickInfo = Object.entries(config.quickInfo)
    .map(([key, val]) => `${key}: ${val}`)
    .join('\n');
  
  return `You're Emma at ${config.company.name}.

GREETING ALREADY SAID: "${config.greeting}"
Don't repeat it. React to what the CALLER says.

PERSONALITY:
${config.personality.join('\n')}

COMPANY: ${config.company.name} - ${config.company.locations.join(' & ')}
Website: ${config.company.website}
Financing: ${config.company.financing}

QUICK FACTS:
${quickInfo}

===== LEARN FROM THESE EXAMPLES =====
${examples}

===== YOUR JOB =====
- Answer questions naturally and briefly (1-2 sentences)
- Collect: name, phone, what they need
- Offer free consultations for detailed quotes
- If you don't know: "Let me get a specialist to call you back"
- Keep it real, not robotic

Be helpful, warm, brief.`;
}

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] Connected from', req.socket.remoteAddress);

  let streamSid = null;
  let sessionReady = false;
  let conversationStarted = false;
  const audioQueue = [];
  let frameCount = 0;

  const oaiWS = new ClientWS(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function cleanup() {
    try { clearInterval(keepAlive); } catch {}
    try { clearInterval(audioSender); } catch {}
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  }

  const keepAlive = setInterval(() => {
    try { oaiWS.ping(); twilioWS.ping(); } catch {}
  }, 25000);

  const safeSend = (obj) => {
    if (oaiWS.readyState === 1) {
      try { 
        oaiWS.send(JSON.stringify(obj)); 
        return true; 
      } catch {}
    }
    return false;
  };

  const sendAudioToOpenAI = () => {
    if (sessionReady && conversationStarted && audioQueue.length > 0) {
      const base64 = audioQueue.shift();
      safeSend({ type: 'input_audio_buffer.append', audio: base64 });
    }
  };

  const audioSender = setInterval(sendAudioToOpenAI, 100);

  oaiWS.on('open', () => {
    console.log('[OpenAI] Connected');
    
    safeSend({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: config.silenceDuration
        },
        
        voice: config.voice,
        temperature: config.temperature,
        max_response_output_tokens: config.maxTokens,
        
        input_audio_transcription: { model: 'whisper-1' },
        
        instructions: buildInstructions()
      }
    });
  });

  oaiWS.on('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    // Log key events only
    if (evt.type && !evt.type.includes('audio') && !evt.type.includes('speech')) {
      console.log('[OpenAI]', evt.type);
    }

    if (evt.type === 'session.updated' || evt.type === 'session.created') {
      sessionReady = true;
      conversationStarted = true;
      console.log('[AI] Ready - Voice:', config.voice);
    }

    // Stream audio back to caller
    if ((evt.type === 'response.audio.delta' || evt.type === 'response.output_audio.delta') && streamSid) {
      const audioData = evt.delta || evt.audio;
      if (audioData) {
        try {
          twilioWS.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: audioData }
          }));
        } catch (e) {
          console.error('[Twilio] Audio send error:', e.message);
        }
      }
    }

    if (evt.type === 'error') {
      console.error('[OpenAI ERROR]', evt.error?.message || evt);
    }
  });

  oaiWS.on('error', (e) => console.error('[OpenAI] Error:', e?.message));
  oaiWS.on('close', () => console.log('[OpenAI] Closed'));

  twilioWS.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid;
      console.log('[Twilio] Stream started:', streamSid);
    }

    if (data.event === 'media' && data.media?.payload && conversationStarted) {
      audioQueue.push(data.media.payload);
      frameCount++;
      if (frameCount % 100 === 0) console.log('[Audio] Frames:', frameCount);
    }

    if (data.event === 'stop') {
      console.log('[Twilio] Stream stopped');
      setTimeout(cleanup, 1000);
    }
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] Closed');
    cleanup();
  });

  twilioWS.on('error', (e) => {
    console.error('[Twilio] Error:', e?.message);
    cleanup();
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  🌞 Sunshine Luxury Pools AI          ║');
  console.log(`║  📞 Port: ${port.toString().padEnd(28)} ║`);
  console.log(`║  🎤 Voice: ${config.voice.padEnd(26)} ║`);
  console.log(`║  🧠 Temp: ${config.temperature.toString().padEnd(27)} ║`);
  console.log('╚════════════════════════════════════════╝');
});
