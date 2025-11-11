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
  let saidHello = false;
  let conversationStarted = false;

  // Audio buffer management
  const MIN_FRAMES_FOR_COMMIT = 12; // ~240ms of audio
  let framesQueued = 0;
  let bufferDirty = false;
  const audioQueue = [];

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
    try { clearInterval(flusher); } catch {}
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

  // Initial greeting (no audio buffer needed)
  const sendInitialGreeting = () => {
    if (saidHello || !sessionReady) return;
    saidHello = true;
    inProgress = true;
    
    console.log('[AI] Sending initial greeting');
    safeSend({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'input_text',
          text: 'Good evening, Sunshine Luxury Pools. How can I help you today?'
        }]
      }
    });
    
    safeSend({ 
      type: 'response.create',
      response: { modalities: ['audio', 'text'] }
    });
  };

  // Commit audio buffer and request response
  const tryCommitAndRespond = () => {
    if (!sessionReady || inProgress || !conversationStarted) return;
    if (!bufferDirty || framesQueued < MIN_FRAMES_FOR_COMMIT) return;

    console.log('[AI] Processing', framesQueued, 'audio frames (~' + (framesQueued * 20) + 'ms)');
    
    // Send all queued audio to OpenAI
    while (audioQueue.length) {
      const base64 = audioQueue.shift();
      safeSend({ type: 'input_audio_buffer.append', audio: base64 });
      framesQueued--;
    }
    
    bufferDirty = false;
    safeSend({ type: 'input_audio_buffer.commit' });
    
    // Request AI response
    inProgress = true;
    safeSend({ 
      type: 'response.create', 
      response: { modalities: ['text', 'audio'] } 
    });
  };

  // Check for audio to process every 200ms
  const flusher = setInterval(tryCommitAndRespond, 200);

  // ===== OpenAI Event Handlers =====
  oaiWS.on('open', () => {
    console.log('[OpenAI] Connected');
    
    // Configure session with luxury pool knowledge
    safeSend({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        
        // Voice Activity Detection for natural conversation flow
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700  // Wait 700ms of silence before responding
        },
        
        input_audio_transcription: { 
          model: 'whisper-1' 
        },
        
        // ===== AI ASSISTANT INSTRUCTIONS WITH POOL KNOWLEDGE =====
        instructions: `You are the AI receptionist for Sunshine Luxury Pools, an authorized Explore Industries dealer specializing in premium fiberglass pools.

YOUR ROLE:
- Answer questions about luxury fiberglass pools professionally and warmly
- Collect caller information (name, phone, reason for calling)
- Schedule consultations
- Be conversational, brief, and natural - like a friendly receptionist

===== COMPANY INFORMATION =====
Company: Sunshine Luxury Pools
Location: Cape Coral, Florida (Southwest Florida)
Services: Premium fiberglass pool installation
Dealer For: Explore Industries (world's leading fiberglass pool manufacturer)

===== ABOUT EXPLORE INDUSTRIES =====
- Global leader in fiberglass swimming pools with 25+ years of experience
- Over 130,000 pools installed worldwide in 23 countries
- 2,000+ independent authorized dealers globally
- Manufacturing headquarters in Knoxville, Tennessee (84-acre facility)
- Uses premium Vinyl Ester Resin, Carbon Fiber, and DuPont Kevlar™ for superior strength

===== POOL BRANDS WE OFFER =====
1. **Leisure Pools** - Flagship brand, recognized globally with 500+ dealers, 60,000+ installations
2. **Imagine Pools** - Premium composite pools in partnership with PoolCorp
3. **Aviva Pools** - Ultimate luxury brand with European design aesthetics, targets exclusive market
4. **Evo Pools** - Modern innovative designs
5. **Nexus Pools** - Stylish curated collection

===== KEY BENEFITS OF FIBERGLASS POOLS =====
✓ Fast Installation - Ready in 8 days or less (vs months for concrete)
✓ Low Maintenance - Smooth gelcoat surface resists algae and stains
✓ Durable - Vinyl Ester Resin construction with Carbon Fiber reinforcement
✓ Lifetime Warranty - Industry-leading warranties on structure
✓ Beautiful Gelcoat Colors - UV, blister, and chemical resistant with diamond-like sparkle
✓ Energy Efficient - Better insulation than concrete
✓ Non-Porous Surface - Won't harbor bacteria

===== POPULAR FEATURES =====
- Tanning ledges (sun shelves) for lounging in shallow water
- Swim-up bars for resort-style entertaining
- In-water loungers and benches
- LED lighting systems with smartphone control
- Heating systems for year-round use
- Spa integration options
- Safety covers (Integra Pool Covers)

===== TYPICAL CUSTOMER QUESTIONS & ANSWERS =====

Q: How long does installation take?
A: Fiberglass pools can be installed in as little as 8 days from start to finish - much faster than concrete pools which take months.

Q: What about warranties?
A: Explore Industries offers lifetime structural warranties on the pool shell and extensive warranties on the gelcoat finish. Specific terms vary by model.

Q: How much does a pool cost?
A: Investment varies based on size, model, features, and site conditions. We offer free consultations where we can provide detailed quotes based on your specific needs and vision.

Q: Do you offer financing?
A: Yes, we work with financing partners. We can discuss options during your consultation.

Q: What's the difference between fiberglass and concrete?
A: Fiberglass installs in days (not months), requires far less maintenance, has a smooth non-porous surface that resists algae, and is more durable in Florida's climate. No replastering needed every 10-15 years like concrete.

Q: What sizes are available?
A: We offer a wide range from smaller plunge pools to large family-sized pools over 40 feet. Each brand has 20-50+ models to choose from.

Q: Can you show me designs?
A: Absolutely! We'd love to schedule a consultation where we can show you our full catalog, discuss your vision, and even do a 3D rendering of how it would look in your backyard.

===== CONVERSATION FLOW =====
1. Greet warmly: "Good evening, Sunshine Luxury Pools. How can I help you today?"
2. LISTEN to their needs - let them talk
3. Answer questions naturally and concisely
4. Collect information:
   - Their name
   - Best callback number  
   - What they're interested in (new pool, renovation, specific features)
   - Timeline if they mention it
5. Offer free consultation: "I'd love to schedule a free consultation where we can discuss your vision and show you our designs."
6. Thank them and confirm next steps

===== IMPORTANT GUIDELINES =====
- Keep responses BRIEF (1-3 sentences typically)
- Be warm and conversational, not robotic
- PAUSE after asking questions - give caller time to respond
- Don't overwhelm with too much information at once
- If you don't know something specific, offer to have an expert call them back
- Always emphasize: FREE consultation, no pressure, we're here to help
- If they ask about pricing: Mention it varies and offer consultation for detailed quote
- Focus on benefits: fast installation, low maintenance, durability, beauty

===== CONVERSATION EXAMPLES =====

Caller: "Hi, I'm interested in getting a pool."
You: "Wonderful! We'd love to help you create your backyard oasis. Are you thinking about a new pool installation or renovating an existing pool?"

Caller: "New pool. How long does it take?"
You: "Great question! Our fiberglass pools can be installed in as little as 8 days from start to finish. Much faster than concrete. What size pool are you thinking about?"

Caller: "I'm not sure, maybe medium sized?"
You: "Perfect. We have a beautiful range of designs in every size. Can I get your name and the best number to reach you? I'd love to schedule a free consultation where we can show you options and discuss your vision."

Remember: Be helpful, friendly, and efficient. Your goal is to collect information and book consultations, not to close sales on the phone.`
      }
    });
  });

  oaiWS.on('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    // Log important events (but not every audio chunk)
    if (evt.type && 
        evt.type !== 'response.audio.delta' && 
        evt.type !== 'response.output_audio.delta' &&
        evt.type !== 'input_audio_buffer.speech_started' &&
        evt.type !== 'input_audio_buffer.speech_stopped') {
      console.log('[OpenAI]', evt.type);
    }

    // Session ready
    if (evt.type === 'session.updated' || evt.type === 'session.created') {
      sessionReady = true;
      console.log('[OpenAI] Session ready');
      sendInitialGreeting();
    }

    // Response lifecycle tracking
    if (evt.type === 'response.created') {
      inProgress = true;
    }

    if (evt.type === 'response.done') {
      inProgress = false;
      conversationStarted = true;
      console.log('[OpenAI] Response complete');
      // Process any buffered caller audio
      setTimeout(tryCommitAndRespond, 100);
    }

    // Stream audio back to Twilio
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
          console.error('[Twilio] Send error:', e.message);
        }
      }
    }

    // Handle errors
    if (evt.type === 'error') {
      console.error('[OpenAI ERROR]', JSON.stringify(evt.error, null, 2));
      inProgress = false;
    }
  });

  oaiWS.on('error', (e) => {
    console.error('[OpenAI] Connection error:', e?.message);
  });

  oaiWS.on('close', (code, reason) => {
    console.log('[OpenAI] Disconnected. Code:', code);
  });

  // ===== Twilio Event Handlers =====
  let frameCount = 0;
  
  twilioWS.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] Call started. Stream SID:', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // Only queue audio after initial greeting
      if (conversationStarted) {
        audioQueue.push(data.media.payload);
        framesQueued++;
        bufferDirty = true;
        frameCount++;
        
        if (frameCount % 100 === 0) {
          console.log('[Twilio] Audio frames received:', frameCount);
        }
      }
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] Call ended');
      // Optional goodbye
      if (!inProgress && conversationStarted) {
        inProgress = true;
        safeSend({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'input_text',
              text: 'Thanks for calling Sunshine Luxury Pools. Have a wonderful day!'
            }]
          }
        });
        safeSend({ 
          type: 'response.create', 
          response: { modalities: ['audio', 'text'] } 
        });
      }
      setTimeout(cleanup, 2000);
      return;
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
