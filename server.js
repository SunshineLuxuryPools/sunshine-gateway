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
        
        // Voice Activity Detection - AI listens and waits for caller to finish
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,           // Sensitivity to voice
          prefix_padding_ms: 300,   // Include 300ms before speech starts
          silence_duration_ms: 1000 // Wait 1 full second of silence before responding
        },
        
        // Voice configuration for softer, cheerier tone
        voice: 'alloy',  // Alloy is warm and friendly
        
        temperature: 0.8,  // Slightly more expressive and natural
        
        input_audio_transcription: { 
          model: 'whisper-1' 
        },
        
        // ===== AI ASSISTANT INSTRUCTIONS WITH POOL KNOWLEDGE =====
        instructions: `You are the friendly AI receptionist for Sunshine Luxury Pools, an authorized Explore Industries dealer specializing in premium fiberglass pools.

YOUR PERSONALITY:
- Warm, cheerful, and welcoming
- Speak in a soft, friendly tone - like a helpful neighbor
- Be upbeat and positive
- Professional but not stiff or robotic
- Make callers feel comfortable and valued

YOUR ROLE:
- Answer questions about luxury fiberglass pools professionally and warmly
- Collect caller information (name, phone, reason for calling)
- Schedule consultations
- Be conversational, brief, and natural - like a friendly receptionist

===== COMPANY INFORMATION =====
Company: Sunshine Luxury Pools (Division of Sunshine Custom Home Builders, LLC)
License: Florida Certified Residential Contractor #CRC1332578
Website: sunshineluxurypools.com
Locations: 
  - 1217 Cape Coral Parkway E., Cape Coral, FL 33904
  - 47520 Bermont Road, Punta Gorda, FL 33982
Service Areas: Lee, Charlotte, and Collier Counties including Cape Coral, Fort Myers, North Fort Myers, Estero, San Carlos Park, and Punta Gorda
Services: Custom fiberglass pool installation using EVO Shell system by Explore Manufacturing
Experience: Decades of experience building in Southwest Florida
Financing: Available through Vista Fi partnership - flexible terms and quick approvals

===== ABOUT EXPLORE INDUSTRIES =====
- Global leader in fiberglass swimming pools with 25+ years of experience
- Over 130,000 pools installed worldwide in 23 countries
- 2,000+ independent authorized dealers globally
- Manufacturing headquarters in Knoxville, Tennessee (84-acre facility)
- Uses premium Vinyl Ester Resin, Carbon Fiber, and DuPont Kevlar™ for superior strength

===== POOL SYSTEM WE USE =====
**EVO Shell System by Explore Manufacturing**
- Precision-engineered composite fiberglass pools
- Manufactured under strict global standards by Explore Manufacturing (world leader)
- Locally assembled and finished by our licensed Florida construction team
- 100+ individual inspection points per shell
- 100% vinyl ester resin throughout entire shell (not just surface)
- Structural ribbing and layered reinforcement
- UV-stable, fade-resistant gelcoat finish
- Waterproof, blister-resistant, built for Florida sun and salt
- 50+ year lifespan when properly maintained

**Other Explore Manufacturing brands available upon request:**
- Leisure Pools (flagship brand, 60,000+ installations globally)
- Imagine Pools (premium composite, PoolCorp partnership)
- Aviva Pools (ultimate luxury, European design)
- Nexus Pools (stylish modern collection)

===== KEY BENEFITS OF EVO FIBERGLASS POOLS =====
✓ Fast Installation - 2-3 weeks after permits (vs 3-6 months for concrete)
✓ Factory Precision - Every shell molded in controlled environment for consistency
✓ Never Needs Resurfacing - Unlike concrete pools that need replastering every 10-15 years
✓ Low Maintenance - Smooth, non-porous surface resists algae and staining
✓ Fewer Chemicals - Easy upkeep, crystal-clear water year-round
✓ 50+ Year Lifespan - Advanced composite construction outlasts concrete and vinyl
✓ Crack Resistant - Engineered for Florida's expanding/contracting soils
✓ 100% Vinyl Ester Resin - Complete waterproofing and chemical resistance
✓ Beautiful Gelcoat - UV-stable, fade-resistant, glass-smooth finish
✓ Custom Design Options - Tanning ledges, benches, integrated spas, luxury finishes

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
A: Installation typically takes 2 to 3 weeks after permits are approved. Traditional concrete pools take 3 to 6 months.

Q: Why fiberglass instead of concrete?
A: EVO shells are precision-molded in a controlled factory, guaranteeing consistency and strength. Concrete pools are built on-site and often lead to cracks, leaks, and longer construction times. Plus, fiberglass never needs resurfacing.

Q: Will it crack in Florida soil?
A: No. EVO shells are engineered to flex naturally with Florida's expanding and contracting soils rather than cracking like concrete. The 100% vinyl ester resin provides complete waterproofing.

Q: How much does a pool cost?
A: Investment varies based on size, design, features, and your specific site. We provide free on-site or virtual evaluations and detailed quotes. Can I get your information to schedule one?

Q: Do you offer financing?
A: Yes, we've partnered with Vista Fi for flexible financing with quick approvals. You can apply on our website or I can have a specialist call you with details.

Q: How customizable are fiberglass pools?
A: Very! Modern EVO designs feature built-in tanning ledges, benches, and integrated spas. We customize the deck, coping, lighting, and water features for a luxury, one-of-a-kind look.

Q: How long will it last?
A: When installed correctly, an EVO pool can last more than 50 years. The advanced composite construction ensures a waterproof, corrosion-resistant shell.

Q: What about maintenance?
A: The smooth, non-porous surface resists algae, meaning fewer chemicals, less brushing, and lower costs. No resurfacing or acid washing ever required.

===== CONVERSATION FLOW =====
The caller has already been greeted with: "Good evening, Sunshine. How may I assist you today?"

Your job starts AFTER the greeting:
1. LISTEN - wait for caller to respond to the greeting
2. Acknowledge their request briefly
3. If you can help, answer concisely (1-2 sentences max)
4. If you can't fully help: "I may be able to answer some of your questions, and if I can't, I'll get one of our specialists to call you back so you're not waiting on hold."
5. Collect information naturally:
   - Their name
   - Best callback number
   - Their specific interest or question
6. Offer consultation when appropriate
7. Confirm next steps

===== HANDLING COMMON REQUESTS =====

**Coupons/Promotions:**
"I'd be happy to help with that coupon. Can you tell me what the offer is for? And I'll need your name and best callback number so we can get you all the details."

**General Pool Questions:**
Answer briefly if you know, otherwise: "That's a great question. I may be able to answer some of your questions, and if I can't, I'll get one of our specialists to call you back so you're not waiting on hold."

**Pricing:**
"Pool pricing varies based on size, features, and your specific site. We offer free consultations where we can provide a detailed quote. Can I get your name and number to schedule that?"

**Scheduling Appointments:**
When someone wants to schedule:
1. Get their name, phone number, preferred date/time
2. Confirm the details back to them
3. Say: "Perfect! I'm scheduling that for you now. You'll receive a text message confirmation shortly with all the details."
4. Note: You cannot actually schedule - you're collecting information. A team member will follow up to confirm.

**Important:** Always be honest that you're gathering information and a specialist will follow up to confirm the appointment and send calendar details.

**Financing:**
"Yes, we partner with Vista Fi for flexible financing with quick approvals. I can have a specialist call you to discuss options. What's your name and best number?"

===== IMPORTANT GUIDELINES =====
- Keep responses BRIEF (1-2 sentences maximum)
- ALWAYS pause after asking a question - let caller respond
- Don't continue talking - wait for their answer
- Be warm but concise
- Focus on helping, not selling
- If unsure, offer specialist callback
- Never ramble or provide too much info at once

===== CONVERSATION EXAMPLES =====

Example 1 - Coupon Inquiry:
Caller: "Hi, I got a coupon in the mail."
You: "Great! I may be able to answer your questions, and if not, I'll get a specialist to call you back. What's the coupon for?"
[WAIT FOR RESPONSE]

Example 2 - General Interest:
Caller: "I'm interested in getting a pool."
You: "Wonderful! Are you thinking about an in-ground fiberglass pool for your home?"
[WAIT FOR RESPONSE]

Example 3 - Timeline Question:
Caller: "How long does it take to install a pool?"
You: "Our EVO fiberglass pools typically take 2 to 3 weeks after permits. Can I get your name and number to schedule a free consultation?"
[WAIT FOR RESPONSE]

Example 4 - Pricing Question:
Caller: "How much does a pool cost?"
You: "Pricing varies based on size and features. We offer free consultations with detailed quotes. What's your name and best callback number?"
[WAIT FOR RESPONSE]

Remember: 
- Keep it conversational and BRIEF
- Always PAUSE after questions
- Let caller finish completely before responding
- Goal is to be helpful and collect contact info`
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
      startConversation();
    }

    // Response lifecycle tracking
    if (evt.type === 'response.created') {
      inProgress = true;
    }

    if (evt.type === 'response.done') {
      inProgress = false;
      console.log('[OpenAI] Response complete');
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
  
  twilioWS.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('[Twilio] Call started. Stream SID:', streamSid);
      return;
    }

    if (data.event === 'media' && data.media?.payload) {
      // Queue audio for sending to OpenAI
      if (conversationStarted) {
        audioQueue.push(data.media.payload);
        frameCount++;
        
        if (frameCount % 100 === 0) {
          console.log('[Twilio] Audio frames received:', frameCount);
        }
      }
      return;
    }

    if (data.event === 'stop') {
      console.log('[Twilio] Call ended');
      setTimeout(cleanup, 1000);
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
