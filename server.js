/*
 * ================================================================
 *  InduShield — Railway Relay Server  (server.js)
 *  Node.js + Express + Twilio Voice API
 * ================================================================
 *  ENVIRONMENT VARIABLES (set in Railway dashboard → Variables):
 *
 *    TWILIO_ACCOUNT_SID   → Your Twilio Account SID   (ACxxxxxxx)
 *    TWILIO_AUTH_TOKEN    → Your Twilio Auth Token
 *    TWILIO_FROM_NUMBER   → Your Twilio phone number  (+1xxxxxxxxxx)
 *    EMERGENCY_TO_NUMBER  → Emergency contact number  (+91xxxxxxxxxx)
 *    PORT                 → (Railway sets this automatically)
 *
 * ================================================================
 *  Endpoints:
 *    POST /update   ← ESP32 sends sensor data here
 *    GET  /data     ← Dashboard reads latest sensor data
 *    POST /call     ← Dashboard triggers manual call
 *    GET  /ping     ← Keep-alive health check
 *    GET  /twiml    ← Twilio fetches voice message XML from here
 * ================================================================
 */

const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Twilio client ────────────────────────────────────────────
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;     // e.g. +12345678901
const toNumber   = process.env.EMERGENCY_TO_NUMBER;    // e.g. +919876543210

const client = twilio(accountSid, authToken);

// ── Middleware ───────────────────────────────────────────────
app.use(cors());                        // Allow dashboard origin
app.use(express.json());

// ── In-memory latest sensor data ────────────────────────────
let latestData = {
    gas:         0,
    temperature: 0,
    humidity:    0,
    rssi:        0,
    lastUpdate:  null
};

// Auto-call cooldown — prevent spam (30 s cooldown)
let autoCallCooldown = false;

// ── Helper: build voice message string ──────────────────────
function buildVoiceMessage(gas, temp, hum) {
    return `Warning! Dangerous gas level detected in the lab. 
            Gas concentration is ${Math.round(gas)} parts per million. 
            Temperature is ${parseFloat(temp).toFixed(1)} degrees Celsius. 
            Humidity is ${parseFloat(hum).toFixed(0)} percent. 
            Please take immediate action and evacuate the area.
            This is an automated alert from InduShield monitoring system.`;
}

// ── Helper: make Twilio voice call ───────────────────────────
async function makeTwilioCall(gas, temp, hum) {
    if (!accountSid || !authToken || !fromNumber || !toNumber) {
        console.error('[Twilio] Missing env variables — cannot make call');
        return { success: false, error: 'Twilio not configured' };
    }

    const message = buildVoiceMessage(gas, temp, hum);

    // TwiML: what Twilio says when the call is answered
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" rate="90%">${message}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" rate="90%">Repeating. ${message}</Say>
</Response>`;

    try {
        const call = await client.calls.create({
            twiml:  twiml,
            to:     toNumber,
            from:   fromNumber,
        });

        console.log(`[Twilio] ✓ Call initiated — SID: ${call.sid}`);
        return { success: true, sid: call.sid, to: toNumber, from: fromNumber };

    } catch (err) {
        console.error(`[Twilio] ✗ Call failed — ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

// ── GET /ping — keep-alive health check ─────────────────────
app.get('/ping', (req, res) => {
    res.json({ status: 'alive', uptime: process.uptime() });
});

// ── GET /data — dashboard reads latest sensor values ────────
app.get('/data', (req, res) => {
    res.json(latestData);
});

// ── POST /update — ESP32 sends sensor data ───────────────────
app.post('/update', async (req, res) => {
    const { gas, temperature, humidity, rssi } = req.body;

    if (gas === undefined || temperature === undefined || humidity === undefined) {
        return res.status(400).json({ error: 'Missing sensor fields' });
    }

    latestData = {
        gas:         parseFloat(gas),
        temperature: parseFloat(temperature),
        humidity:    parseFloat(humidity),
        rssi:        rssi || 0,
        lastUpdate:  new Date().toISOString()
    };

    console.log(`[Data] Gas:${Math.round(gas)}ppm Temp:${parseFloat(temperature).toFixed(1)}°C Hum:${parseFloat(humidity).toFixed(0)}%`);

    // ── AUTO-CALL if gas exceeds danger threshold ────────────
    if (parseFloat(gas) >= 3000 && !autoCallCooldown) {
        autoCallCooldown = true;
        console.log(`[AutoCall] Gas critical at ${Math.round(gas)} ppm — triggering Twilio call`);

        makeTwilioCall(gas, temperature, humidity).then(result => {
            console.log('[AutoCall] Result:', result);
        });

        // Reset cooldown after 30 seconds
        setTimeout(() => { autoCallCooldown = false; }, 30000);
    }

    res.json({ status: 'ok', received: latestData });
});

// ── POST /call — dashboard manual call trigger ───────────────
app.post('/call', async (req, res) => {
    const gas  = req.body.gas  ?? latestData.gas;
    const temp = req.body.temperature ?? latestData.temperature;
    const hum  = req.body.humidity    ?? latestData.humidity;

    console.log(`[ManualCall] Triggered from dashboard — Gas:${Math.round(gas)}ppm`);

    const result = await makeTwilioCall(gas, temp, hum);

    if (result.success) {
        res.json({
            status:  'calling',
            sid:     result.sid,
            to:      result.to,
            from:    result.from,
            message: `Calling ${result.to}`
        });
    } else {
        res.status(500).json({
            status: 'error',
            error:  result.error
        });
    }
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════╗`);
    console.log(`║  InduShield Railway Server       ║`);
    console.log(`║  Listening on port ${PORT}          ║`);
    console.log(`╚══════════════════════════════════╝`);
    console.log(`[Twilio] FROM : ${fromNumber || '⚠ NOT SET'}`);
    console.log(`[Twilio] TO   : ${toNumber   || '⚠ NOT SET'}`);
    console.log(`[Twilio] SID  : ${accountSid ? accountSid.slice(0,10)+'...' : '⚠ NOT SET'}`);
});
