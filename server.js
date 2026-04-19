const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app  = express();
const PORT = process.env.PORT || 3000;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const toNumber1  = process.env.EMERGENCY_TO_NUMBER;
const toNumber2  = process.env.EMERGENCY_TO_NUMBER2;

const GAS_WARN    = 2000;
const GAS_DANGER  = 3000;
const TEMP_WARN   = 35.0;
const TEMP_DANGER = 40.0;
const HUM_WARN    = 70.0;
const HUM_DANGER  = 80.0;

const DATA_TIMEOUT_MS = 10000; // 10 seconds — if no ESP32 data, go stale

const missingVars = [];
if (!accountSid) missingVars.push('TWILIO_ACCOUNT_SID');
if (!authToken)  missingVars.push('TWILIO_AUTH_TOKEN');
if (!fromNumber) missingVars.push('TWILIO_FROM_NUMBER');
if (!toNumber1)  missingVars.push('EMERGENCY_TO_NUMBER');
if (missingVars.length > 0) {
    console.warn('[Twilio] Missing env vars: ' + missingVars.join(', '));
    console.warn('[Twilio] SMS/calls disabled — server will still serve data');
}

let client = null;
try {
    if (accountSid && authToken) {
        client = twilio(accountSid, authToken);
        console.log('[Twilio] Client initialized ✓');
    }
} catch (err) {
    console.error('[Twilio] Client init failed: ' + err.message);
}

app.use(cors());
app.use(express.json());

let latestData = {
    gas:         0,
    temperature: 0,
    humidity:    0,
    rssi:        0,
    lastUpdate:  null
};

let autoCallCD = { gas: false, temp: false, hum: false };
let autoSmsCD  = { gas: false, temp: false, hum: false };

// ── Stale check ───────────────────────────────────────────────
function isDataStale() {
    if (!latestData.lastUpdate) return true;
    return (Date.now() - new Date(latestData.lastUpdate).getTime()) > DATA_TIMEOUT_MS;
}

// ── Watchdog: reset if no data for 10s ───────────────────────
setInterval(() => {
    if (isDataStale()) {
        const wasLive = latestData.gas > 0 || latestData.temperature > 0;
        if (wasLive) {
            console.log('[Watchdog] No data received — resetting to safe values');
        }
        latestData = {
            gas:         0,
            temperature: 0,
            humidity:    0,
            rssi:        0,
            lastUpdate:  latestData.lastUpdate // keep last seen time for reference
        };
        autoCallCD = { gas: false, temp: false, hum: false };
        autoSmsCD  = { gas: false, temp: false, hum: false };
    }
}, 5000);

// ── Helpers ───────────────────────────────────────────────────
function levelStr(val, warn, danger) {
    if (val >= danger) return 'DANGER';
    if (val >= warn)   return 'WARNING';
    return 'SAFE';
}

function getNumbers() {
    const nums = [];
    if (toNumber1) nums.push(toNumber1);
    if (toNumber2) nums.push(toNumber2);
    return nums;
}

function buildVoiceMessage(gas, temp, hum) {
    return (
        'Alert! Alert! This is an automated emergency call from the InduShield ' +
        'monitoring system in the GIOE Lab. ' +
        'A dangerous situation has been detected and immediate action is required. ' +
        'Gas concentration is '   + Math.round(gas)             + ' parts per million. ' +
        'Temperature is '         + parseFloat(temp).toFixed(1) + ' degrees Celsius. ' +
        'Humidity is '            + parseFloat(hum).toFixed(0)  + ' percent. ' +
        'Please evacuate the lab immediately and contact the lab supervisor. ' +
        'This message will now repeat.'
    );
}

// ✅ SMS under 160 chars
function buildSMSBody(gas, temp, hum) {
    const gS = levelStr(gas,  GAS_WARN,  GAS_DANGER);
    const tS = levelStr(temp, TEMP_WARN, TEMP_DANGER);
    const hS = levelStr(hum,  HUM_WARN,  HUM_DANGER);
    return (
        'DANGER! Gas:' + Math.round(gas) + 'ppm[' + gS + '] ' +
        'Temp:' + parseFloat(temp).toFixed(1) + 'C[' + tS + '] ' +
        'Hum:' + parseFloat(hum).toFixed(0) + '%[' + hS + '] ' +
        'Evacuate GIOE Lab now!'
    );
}

async function callNumber(toNum, gas, temp, hum) {
    const msg = buildVoiceMessage(gas, temp, hum);
    const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Pause length="1"/>' +
        '<Say voice="alice">' + msg + '</Say>' +
        '<Pause length="1"/>' +
        '<Say voice="alice">' + msg + '</Say>' +
        '</Response>';
    try {
        const call = await client.calls.create({ twiml, to: toNum, from: fromNumber });
        console.log('[Twilio] Call → ' + toNum + ' SID:' + call.sid);
        return { success: true, sid: call.sid, to: toNum };
    } catch (err) {
        console.error('[Twilio] Call to ' + toNum + ' failed: ' + err.message);
        return { success: false, error: err.message, to: toNum };
    }
}

async function smsNumber(toNum, gas, temp, hum) {
    try {
        const msg = await client.messages.create({
            body: buildSMSBody(gas, temp, hum),
            to:   toNum,
            from: fromNumber
        });
        console.log('[Twilio] SMS → ' + toNum + ' SID:' + msg.sid);
        return { success: true, sid: msg.sid, to: toNum };
    } catch (err) {
        console.error('[Twilio] SMS to ' + toNum + ' failed: ' + err.message);
        return { success: false, error: err.message, to: toNum };
    }
}

async function makeTwilioCall(gas, temp, hum) {
    if (!client)     return { success: false, error: 'Twilio not initialized' };
    if (!fromNumber) return { success: false, error: 'TWILIO_FROM_NUMBER not set' };
    const numbers = getNumbers();
    if (numbers.length === 0) return { success: false, error: 'No emergency numbers configured' };
    const results    = await Promise.all(numbers.map(n => callNumber(n, gas, temp, hum)));
    const successful = results.filter(r => r.success);
    console.log('[Twilio] Called ' + successful.length + '/' + numbers.length + ' successfully');
    return successful.length > 0
        ? { success: true, sid: successful[0].sid, to: numbers.join(' & '), results }
        : { success: false, error: results.map(f => f.error).join(', '), results };
}

async function makeTwilioSMS(gas, temp, hum) {
    if (!client)     return { success: false, error: 'Twilio not initialized' };
    if (!fromNumber) return { success: false, error: 'TWILIO_FROM_NUMBER not set' };
    const numbers = getNumbers();
    if (numbers.length === 0) return { success: false, error: 'No emergency numbers configured' };
    const results    = await Promise.all(numbers.map(n => smsNumber(n, gas, temp, hum)));
    const successful = results.filter(r => r.success);
    console.log('[Twilio] SMS sent to ' + successful.length + '/' + numbers.length + ' successfully');
    return successful.length > 0
        ? { success: true, sid: successful[0].sid, to: numbers.join(' & '), results }
        : { success: false, error: results.map(f => f.error).join(', '), results };
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => {
    res.json({ status: 'alive', uptime: process.uptime(), ts: new Date().toISOString() });
});

// ✅ Returns stale:true when ESP32 is disconnected
app.get('/data', (req, res) => {
    res.json({
        ...latestData,
        stale: isDataStale()
    });
});

app.post('/update', async (req, res) => {
    const { gas, temperature, humidity, rssi } = req.body;

    if (gas === undefined || temperature === undefined || humidity === undefined) {
        return res.status(400).json({ error: 'Missing fields: gas, temperature, humidity required' });
    }

    const g = parseFloat(gas);
    const t = parseFloat(temperature);
    const h = parseFloat(humidity);
    const r = parseFloat(rssi) || 0;

    latestData = { gas: g, temperature: t, humidity: h, rssi: r, lastUpdate: new Date().toISOString() };

    console.log('[Data] Gas:' + Math.round(g) + 'ppm  Temp:' + t.toFixed(1) + 'C  Hum:' + h.toFixed(0) + '%  RSSI:' + r);

    if (g >= GAS_DANGER && !autoCallCD.gas) {
        autoCallCD.gas = true;
        console.log('[AutoCall] Gas critical at ' + Math.round(g) + ' ppm — initiating call');
        makeTwilioCall(g, t, h).then(result => console.log('[AutoCall] Result:', JSON.stringify(result)));
        setTimeout(() => { autoCallCD.gas = false; }, 60000);
    }

    if (t >= TEMP_DANGER && !autoCallCD.temp) {
        autoCallCD.temp = true;
        console.log('[AutoCall] Temp critical at ' + t.toFixed(1) + '°C — initiating call');
        makeTwilioCall(g, t, h).then(result => console.log('[AutoCall] Result:', JSON.stringify(result)));
        setTimeout(() => { autoCallCD.temp = false; }, 60000);
    }

    if (h >= HUM_DANGER && !autoCallCD.hum) {
        autoCallCD.hum = true;
        console.log('[AutoCall] Humidity critical at ' + h.toFixed(0) + '% — initiating call');
        makeTwilioCall(g, t, h).then(result => console.log('[AutoCall] Result:', JSON.stringify(result)));
        setTimeout(() => { autoCallCD.hum = false; }, 60000);
    }

    const anyDanger = g >= GAS_DANGER || t >= TEMP_DANGER || h >= HUM_DANGER;
    if (anyDanger && !autoSmsCD.gas) {
        autoSmsCD.gas = true;
        console.log('[AutoSMS] Danger detected — sending SMS');
        makeTwilioSMS(g, t, h).then(result => console.log('[AutoSMS] Result:', JSON.stringify(result)));
        setTimeout(() => { autoSmsCD.gas = false; }, 60000);
    }

    res.json({
        status: 'ok',
        received: latestData,
        gas_status:  levelStr(g, GAS_WARN,  GAS_DANGER),
        temp_status: levelStr(t, TEMP_WARN, TEMP_DANGER),
        hum_status:  levelStr(h, HUM_WARN,  HUM_DANGER)
    });
});

app.post('/call', async (req, res) => {
    const g = req.body.gas         !== undefined ? parseFloat(req.body.gas)         : latestData.gas;
    const t = req.body.temperature !== undefined ? parseFloat(req.body.temperature) : latestData.temperature;
    const h = req.body.humidity    !== undefined ? parseFloat(req.body.humidity)    : latestData.humidity;
    console.log('[ManualCall] Triggered — Gas:' + Math.round(g) + ' Temp:' + t.toFixed(1) + ' Hum:' + h.toFixed(0));
    const result = await makeTwilioCall(g, t, h);
    if (result.success) {
        res.json({ status: 'calling', sid: result.sid, to: result.to });
    } else {
        res.status(500).json({ status: 'error', error: result.error });
    }
});

app.post('/sms', async (req, res) => {
    const g = req.body.gas         !== undefined ? parseFloat(req.body.gas)         : latestData.gas;
    const t = req.body.temperature !== undefined ? parseFloat(req.body.temperature) : latestData.temperature;
    const h = req.body.humidity    !== undefined ? parseFloat(req.body.humidity)    : latestData.humidity;
    console.log('[ManualSMS] Triggered — Gas:' + Math.round(g) + ' Temp:' + t.toFixed(1) + ' Hum:' + h.toFixed(0));
    const result = await makeTwilioSMS(g, t, h);
    if (result.success) {
        res.json({ status: 'sent', sid: result.sid, to: result.to });
    } else {
        res.status(500).json({ status: 'error', error: result.error });
    }
});

app.post('/alert', async (req, res) => {
    const g = req.body.gas         !== undefined ? parseFloat(req.body.gas)         : latestData.gas;
    const t = req.body.temperature !== undefined ? parseFloat(req.body.temperature) : latestData.temperature;
    const h = req.body.humidity    !== undefined ? parseFloat(req.body.humidity)    : latestData.humidity;
    console.log('[FullAlert] SMS + Call triggered — Gas:' + Math.round(g));
    const [callResult, smsResult] = await Promise.all([
        makeTwilioCall(g, t, h),
        makeTwilioSMS(g, t, h)
    ]);
    const anySuccess = callResult.success || smsResult.success;
    if (anySuccess) {
        res.json({ status: 'ok', call: callResult, sms: smsResult });
    } else {
        res.status(500).json({ status: 'error', call: callResult, sms: smsResult });
    }
});

// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════');
    console.log(' InduShield Railway Server  port:' + PORT);
    console.log('═══════════════════════════════════════');
    console.log('[Twilio] FROM   : ' + (fromNumber || 'NOT SET ⚠'));
    console.log('[Twilio] TO (1) : ' + (toNumber1  || 'NOT SET ⚠'));
    console.log('[Twilio] TO (2) : ' + (toNumber2  || 'NOT SET (optional)'));
    console.log('[Twilio] SID    : ' + (accountSid ? accountSid.slice(0, 10) + '…' : 'NOT SET ⚠'));
    console.log('[Thresholds] Gas warn/danger : ' + GAS_WARN + '/' + GAS_DANGER + ' ppm');
    console.log('[Thresholds] Temp warn/danger: ' + TEMP_WARN + '/' + TEMP_DANGER + ' °C');
    console.log('[Thresholds] Hum  warn/danger: ' + HUM_WARN  + '/' + HUM_DANGER  + ' %');
    console.log('[Watchdog] Stale timeout     : ' + DATA_TIMEOUT_MS/1000 + 's');
    console.log('───────────────────────────────────────');
    console.log('[Routes] GET  /ping  /data');
    console.log('[Routes] POST /update  /call  /sms  /alert');
    console.log('═══════════════════════════════════════');
});
