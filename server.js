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

const missingVars = [];
if (!accountSid) missingVars.push('TWILIO_ACCOUNT_SID');
if (!authToken)  missingVars.push('TWILIO_AUTH_TOKEN');
if (!fromNumber) missingVars.push('TWILIO_FROM_NUMBER');
if (!toNumber1)  missingVars.push('EMERGENCY_TO_NUMBER');

if (missingVars.length > 0) {
    console.warn('[Twilio] Missing env vars: ' + missingVars.join(', '));
    console.warn('[Twilio] Voice calls disabled — server will still run');
}

let client = null;
try {
    if (accountSid && authToken) {
        client = twilio(accountSid, authToken);
        console.log('[Twilio] Client initialized');
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

let autoCallCooldown = false;

function buildVoiceMessage(gas, temp, hum) {
    return 'Alert! Alert! This is an automated emergency call from the InduShield monitoring system in the GIOE Lab. ' +
           'A dangerous situation has been detected and immediate action is required. ' +
           'Gas concentration is ' + Math.round(gas) + ' parts per million. ' +
           'Temperature is ' + parseFloat(temp).toFixed(1) + ' degrees Celsius. ' +
           'Humidity is ' + parseFloat(hum).toFixed(0) + ' percent. ' +
           'Please evacuate the lab immediately and contact the lab supervisor. ' +
           'This message will now repeat.';
}

async function callNumber(toNumber, gas, temp, hum) {
    var message = buildVoiceMessage(gas, temp, hum);
    var twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
                '<Response>' +
                '<Pause length="1"/>' +
                '<Say voice="alice">' + message + '</Say>' +
                '<Pause length="1"/>' +
                '<Say voice="alice">' + message + '</Say>' +
                '</Response>';
    try {
        var call = await client.calls.create({
            twiml: twiml,
            to:    toNumber,
            from:  fromNumber
        });
        console.log('[Twilio] Call initiated to ' + toNumber + ' SID: ' + call.sid);
        return { success: true, sid: call.sid, to: toNumber };
    } catch (err) {
        console.error('[Twilio] Call to ' + toNumber + ' failed: ' + err.message);
        return { success: false, error: err.message, to: toNumber };
    }
}

async function makeTwilioCall(gas, temp, hum) {
    if (!client) {
        console.error('[Twilio] Client not available');
        return { success: false, error: 'Twilio not initialized' };
    }
    if (!fromNumber) {
        return { success: false, error: 'TWILIO_FROM_NUMBER not set' };
    }

    var numbers = [];
    if (toNumber1) numbers.push(toNumber1);
    if (toNumber2) numbers.push(toNumber2);

    if (numbers.length === 0) {
        return { success: false, error: 'No emergency numbers configured' };
    }

    var results = await Promise.all(
        numbers.map(function(num) {
            return callNumber(num, gas, temp, hum);
        })
    );

    var successful = results.filter(function(r) { return r.success; });
    var failed     = results.filter(function(r) { return !r.success; });

    console.log('[Twilio] Called ' + successful.length + '/' + numbers.length + ' numbers successfully');

    if (successful.length > 0) {
        return { success: true, sid: successful[0].sid, to: numbers.join(' & '), results: results };
    } else {
        return { success: false, error: failed.map(function(f) { return f.error; }).join(', ') };
    }
}

app.get('/ping', function(req, res) {
    res.json({ status: 'alive', uptime: process.uptime() });
});

app.get('/data', function(req, res) {
    res.json(latestData);
});

app.post('/update', async function(req, res) {
    var gas         = req.body.gas;
    var temperature = req.body.temperature;
    var humidity    = req.body.humidity;
    var rssi        = req.body.rssi;

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

    console.log('[Data] Gas:' + Math.round(gas) + 'ppm Temp:' + parseFloat(temperature).toFixed(1) + 'C Hum:' + parseFloat(humidity).toFixed(0) + '%');

    if (parseFloat(gas) >= 3000 && !autoCallCooldown) {
        autoCallCooldown = true;
        console.log('[AutoCall] Gas critical at ' + Math.round(gas) + ' ppm');
        makeTwilioCall(gas, temperature, humidity).then(function(result) {
            console.log('[AutoCall] Result:', result);
        });
        setTimeout(function() { autoCallCooldown = false; }, 30000);
    }

    res.json({ status: 'ok', received: latestData });
});

app.post('/call', async function(req, res) {
    var gas  = req.body.gas         !== undefined ? req.body.gas         : latestData.gas;
    var temp = req.body.temperature !== undefined ? req.body.temperature : latestData.temperature;
    var hum  = req.body.humidity    !== undefined ? req.body.humidity    : latestData.humidity;

    console.log('[ManualCall] Triggered — Gas:' + Math.round(gas) + 'ppm');

    var result = await makeTwilioCall(gas, temp, hum);

    if (result.success) {
        res.json({ status: 'calling', sid: result.sid, to: result.to });
    } else {
        res.status(500).json({ status: 'error', error: result.error });
    }
});

app.listen(PORT, '0.0.0.0', function() {
    console.log('InduShield Railway Server listening on port ' + PORT);
    console.log('[Twilio] FROM   : ' + (fromNumber || 'NOT SET'));
    console.log('[Twilio] TO (1) : ' + (toNumber1  || 'NOT SET'));
    console.log('[Twilio] TO (2) : ' + (toNumber2  || 'NOT SET'));
    console.log('[Twilio] SID    : ' + (accountSid ? accountSid.slice(0, 10) + '...' : 'NOT SET'));
});
