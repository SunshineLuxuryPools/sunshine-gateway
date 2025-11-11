// sunshine-gateway / server.js
// Enhanced AI Phone Assistant for Luxury Pools (Explore Industries Dealer)
// Twilio <Stream> ↔ OpenAI Realtime with comprehensive pool knowledge

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
app.get('/', (_req, res) => res.status(200).send('Sunshine Luxury Pools AI Assistant'));

// --- TwiML webhook
const twimlXml = `
<Response>
  <Say voice="Polly.Joanna">Good evening, Sunshine. How may I assist you today?</Say>
  <Pause length="1"/>
  <Connect><Stream url="wss://sunshine-gateway.onrender.com/stream"/></Connect>
</Response>
`.trim();
app.get('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));
app.post('/twiml', (_req, res) => res.type('text/xml').send(twimlXml));

const server = http.createServer(app);
server.on('upgrade', (req) => console.log('[UPGRADE]', req.url));

// --- Twilio <Stream> endpoint
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);

  // State management
  let streamSid = null;
  let sessionReady = false;
  let inProgress = false;
  let conversationStarted = false;

  // Audio buffer for VAD mode
  const audioQueue = [];
  let frameCount = 0;

  // --- OpenAI Realtime Connection
  const OPENAI_RT_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const oaiWS = new ClientWS(OPENAI_RT_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  function cleanup() {
    try { clearInterval(keepAlive); } catch {}
    try { clearInterval(audioSender); } catch {}
    try { oaiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  }

  const keepAlive = setInterval(() => {
    try { oaiWS.ping(); } catch {}
    try { twilioWS.ping(); } catch {}
  }, 25000);

  const safeSend = (obj) => {
    if (oaiWS.readyState !== 1) return false;
    try { 
      oaiWS.send(JSON.stringify(obj)); 
      return true; 
    } catch { 
      return false; 
    }
  };

  // Session ready - start listening immediately (TwiML handles greeting)
  const startConversation = () => {
    if (conversationStarted || !sessionReady) return;
    conversationStarted = true;
    console.log('[AI] Ready to listen to caller');
  };

  // With server VAD, we stream audio and OpenAI handles turn detection
  const sendAudioToOpenAI = () => {
    if (!sessionReady || !conversationStarted) return;
    
    while (audioQueue.length > 0) {
      const base64 = audioQueue.shift();
      safeSend({ type: 'input_audio_buffer.append', audio: base64 });
    }
  };

  // Send audio continuously
  const audioSender = setInterval(sendAudioToOpenAI, 100);

  // ===== OpenAI Event Handlers =====
  oaiWS.on('open', () => {
    console.log('[OpenAI] Connected');
    
    // Configure session with luxury pool knowledge
    safeSend({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        
        // Voice Activity Detection - AI listens and can be interrupted
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600  // Reduced to 600ms for faster responses
        },
        
        // Voice configuration - shimmer is warmer and more conversational
        voice: 'shimmer',
        
        temperature: 0.9,  // More natural and less scripted
        
        max_response_output_tokens: 150,  // Keep responses shorter
        
        input_audio_transcription: { 
          model: 'whisper-1' 
        },
        
        // ===== AI ASSISTANT INSTRUCTIONS =====
        instructions: `You're the receptionist at Sunshine Luxury Pools. Talk like a real person - natural, warm, conversational.

BE NATURAL:
- Use contractions (I'm, we're, that's, you'll)
- Vary your phrasing - don't sound rehearsed
- Be brief and to the point
- Sound genuinely interested in helping
- If interrupted, adapt quickly to the new topic

PERSONALITY:
Imagine you're a friendly neighbor who happens to work at a pool company. Warm, helpful, but not overly formal.

===== COMPANY INFO =====
Sunshine Luxury Pools - Cape Coral & Punta Gorda, FL
We install EVO fiberglass pools (made by Explore Manufacturing)
Installation: 2-3 weeks vs 3-6 months for concrete
Website: sunshineluxurypools.com
Financing: Available through Vista Fi

===== HOW TO HANDLE CALLS =====

**They ask about a coupon:**
"Oh great! What's the coupon for? I'll grab your name and number so we can get you those details."

**General pool interest:**
"Awesome! Are you thinking about putting in a pool at your place?"
Then ask what they're looking for, get name/number for a consultation.

**How long does it take:**
"Our fiberglass pools go in super fast - usually 2 to 3 weeks after permits. Way quicker than concrete."

**How much:**
"It really depends on the size and what features you want. We do free consultations where we can give you an exact quote. Can I grab your info?"

**Why fiberglass:**
"They're built in a factory so they're super consistent and strong. Plus you never have to resurface them like concrete. And installation's way faster."

**Can I customize it:**
"Totally! Built-in benches, tanning ledges, spas, custom lighting - lots of options. We customize everything."

**Financing:**
"Yeah, we work with Vista Fi - pretty flexible terms. I can have someone call you with all the financing options."

**Wants to schedule:**
Get: name, phone, what they're interested in, preferred time
Say: "Perfect, I'm getting that scheduled. You'll get a text confirmation with the details."

===== KEY POINTS =====
- Keep answers SHORT (1-2 sentences usually)
- Sound natural, not scripted
- If you don't know something: "Let me have a specialist call you back with that info"
- Always try to get: name, phone number
- Be helpful, not pushy

===== EXAMPLES OF NATURAL FLOW =====

Them: "I got something in the mail about pools"
You: "Oh nice! Was it about a specific promotion or just general info?"

Them: "How much for a medium pool?"
You: "So it varies a lot based on what you want, but we can give you an exact quote in a free consultation. What's your name?"

Them: "Do you do concrete pools?"
You: "We actually specialize in fiberglass - they install way faster and never need resurfacing. Want to hear more about those?"

Remember: You're having a conversation, not reading a script. Be real.`
      }
    });
  });
    }
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] Connection closed');
    cleanup();
  });

  twilioWS.on('error', (e) => {
    console.error('[Twilio] Connection error:', e?.message);
    cleanup();
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log('==============================================');
  console.log('🌞 Sunshine Luxury Pools AI Assistant');
  console.log('🏊 Explore Industries Authorized Dealer');
  console.log(`📞 Listening on port ${port}`);
  console.log('==============================================');
});
