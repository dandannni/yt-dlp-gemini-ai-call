import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const log = (msg) => { process.stdout.write(`[LOG] ${msg}\n`); };
const err = (msg) => { process.stderr.write(`[ERR] ${msg}\n`); };

log("🚀 SERVER STARTING...");

const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com",
    DOWNLOAD_DIR: "/tmp",
    VERIFIED_CALLERS: [
        "+972548498889", "+972554402506", "+972525585720",
        "+972528263032", "+972583230268"
    ],
    GEMINI_KEYS: [
        process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4
    ].filter(k => k),
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
};

log(`BASE_URL: ${CONFIG.BASE_URL}`);
log(`GEMINI_KEYS count: ${CONFIG.GEMINI_KEYS.length}`);
log(`TWILIO_ACCOUNT_SID present: ${!!CONFIG.TWILIO_ACCOUNT_SID}`);
log(`TWILIO_AUTH_TOKEN present: ${!!CONFIG.TWILIO_AUTH_TOKEN}`);

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// ==============================================================================
// TRANSCRIBER
// ==============================================================================
async function transcribeAudio(base64Audio) {
    log(`TRANSCRIBER: received ${base64Audio.length} base64 chars`);
    if (CONFIG.GEMINI_KEYS.length === 0) { err("TRANSCRIBER: No Gemini keys!"); return null; }

    const prompt = `You are a transcription machine. Listen to the audio and write down exactly what you hear.
- The audio may be Hebrew or English. Transcribe in whatever language is spoken.
- Output ONLY the spoken words. Nothing else. No punctuation needed.
- Do NOT say "I cannot", "I'm unable", or anything conversational.
- If Hebrew: write Hebrew. If English: write English. Just the raw words.`;

    for (let i = 0; i < CONFIG.GEMINI_KEYS.length; i++) {
        const key = CONFIG.GEMINI_KEYS[i];
        try {
            log(`TRANSCRIBER: trying key ${i + 1}...`);
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent([
                prompt,
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);
            const text = result.response.text().trim();
            log(`TRANSCRIBER: key ${i + 1} returned: "${text}"`);
            if (text && text.length > 0) return text;
        } catch (e) {
            err(`TRANSCRIBER: key ${i + 1} failed: ${e.message}`);
        }
    }
    err("TRANSCRIBER: all keys failed, returning null");
    return null;
}

// ==============================================================================
// CHAT
// ==============================================================================
async function chatWithGemini(session, userInputText) {
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: "gemini-1.5-flash",
                systemInstruction: "You are a helpful phone assistant. Answer briefly. Never mix English and Hebrew. If Hebrew, reply ONLY in Hebrew. If English, reply ONLY in English."
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userInputText);
            return result.response.text();
        } catch (e) {
            err(`CHAT: key failed: ${e.message}`);
        }
    }
    return "Sorry, I had a problem processing that.";
}

// ==============================================================================
// TTS
// ==============================================================================
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        log(`TTS: voice=${voice} text="${safeText}"`);
        const child = spawn('edge-tts', ['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        child.stderr.on('data', (d) => err(`TTS STDERR: ${d.toString().trim()}`));
        child.on('close', (code) => {
            log(`TTS: edge-tts exited code ${code}`);
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 300000);
                resolve(filename);
            } else {
                err(`TTS: FAILED for "${safeText}"`);
                resolve(null);
            }
        });
    });
}

async function playOrSay(r, text) {
    const f = await generateFreeTTS(text);
    if (f) {
        r.play(`${CONFIG.BASE_URL}/music/${f}`);
    } else {
        log(`FALLBACK SAY: "${text}"`);
        r.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
    }
}

// ==============================================================================
// SESSIONS & DOWNLOAD
// ==============================================================================
const sessions = new Map();
const downloadQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { chatHistory: [], currentSong: null });
    return sessions.get(callSid);
}

async function searchAndDownloadYTDLP(callSid, query) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });
    log(`YTDLP: starting download for "${query}"`);
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    const args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
        '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    const child = spawn('yt-dlp', args);
    child.stdout.on('data', (d) => log(`YTDLP: ${d.toString().trim()}`));
    child.stderr.on('data', (d) => err(`YTDLP ERR: ${d.toString().trim()}`));
    child.on('close', (code) => {
        log(`YTDLP: exited code ${code}`);
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        if (found) {
            log(`YTDLP: success! file=${found}`);
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, filename: found });
            setTimeout(() => { const fp = path.join(CONFIG.DOWNLOAD_DIR, found); if (fs.existsSync(fp)) fs.unlinkSync(fp); }, 1200000);
        } else {
            err(`YTDLP: no mp3 found for "${query}"`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

async function fetchTwilioRecording(recordingUrl) {
    const url = recordingUrl + ".mp3";
    log(`TWILIO FETCH: ${url}`);
    if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
        err("TWILIO FETCH: missing SID or TOKEN in env vars!");
        return "FETCH_FAILED";
    }
    try {
        await new Promise(r => setTimeout(r, 1500));
        const creds = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
        const audioRes = await fetch(url, { headers: { 'Authorization': `Basic ${creds}` } });
        log(`TWILIO FETCH: HTTP status ${audioRes.status}`);
        if (!audioRes.ok) { err(`TWILIO FETCH: bad status ${audioRes.status}`); return "FETCH_FAILED"; }
        const buf = await audioRes.arrayBuffer();
        log(`TWILIO FETCH: got ${buf.byteLength} bytes`);
        return Buffer.from(buf).toString('base64');
    } catch (e) {
        err(`TWILIO FETCH: exception: ${e.message}`);
        return "FETCH_FAILED";
    }
}

// ==============================================================================
// EXPRESS
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

// Health check — visit this URL in browser to confirm server is alive
app.get("/health", (req, res) => {
    log("HEALTH CHECK HIT");
    res.json({
        status: "ok",
        geminiKeys: CONFIG.GEMINI_KEYS.length,
        twilioSid: !!CONFIG.TWILIO_ACCOUNT_SID,
        twilioToken: !!CONFIG.TWILIO_AUTH_TOKEN,
        baseUrl: CONFIG.BASE_URL
    });
});

app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

app.all("/twiml", async (req, res) => {
    log(`TWIML: caller=${req.body.From}`);
    if (!CONFIG.VERIFIED_CALLERS.includes(req.body.From)) {
        const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString());
    }
    sessions.delete(req.body.CallSid);
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", timeout: 10, finishOnKey: "" });
    await playOrSay(g, "Main menu. Press 1 for chat, or hash for music.");
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/router", (req, res) => {
    log(`ROUTER: digits=${req.body.Digits}`);
    const r = new VoiceResponse();
    const d = req.body.Digits;
    if (d === "1") r.redirect("/voice-mode");
    else if (d === "#") r.redirect("/music-mode");
    else r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/voice-mode", async (req, res) => {
    const r = new VoiceResponse();
    await playOrSay(r, "Please speak after the beep, then press hash.");
    r.record({ action: `${CONFIG.BASE_URL}/voice-process`, finishOnKey: "#", maxLength: 60, playBeep: true, timeout: 5 });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    log("VOICE-PROCESS: started");
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) {
        await playOrSay(r, "No audio received from Twilio.");
        r.redirect("/voice-mode");
        return res.type("text/xml").send(r.toString());
    }
    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    if (base64Audio && base64Audio !== "FETCH_FAILED") {
        const cleanText = await transcribeAudio(base64Audio);
        if (cleanText) {
            const reply = await chatWithGemini(getSession(req.body.CallSid), cleanText);
            await playOrSay(r, reply);
        } else {
            await playOrSay(r, "I could not understand. Please speak clearly.");
        }
    } else {
        await playOrSay(r, "Error fetching audio from Twilio.");
    }
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
    await playOrSay(g, "Press 1 to speak again, or hash for music.");
    res.type("text/xml").send(r.toString());
});

app.all("/music-mode", async (req, res) => {
    log("MUSIC-MODE: entered");
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic", timeout: 10, finishOnKey: "" });
    await playOrSay(g, "Music mode. Press 1 to search for a song.");
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {
    log(`MUSIC-LOGIC: digits=${req.body.Digits}`);
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        await playOrSay(r, "Say the song name, then press hash.");
        r.record({ action: `${CONFIG.BASE_URL}/music-search`, maxLength: 15, playBeep: true, finishOnKey: "#", timeout: 5 });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    log("========== MUSIC-SEARCH STARTED ==========");
    log(`MUSIC-SEARCH: body=${JSON.stringify(req.body)}`);
    const r = new VoiceResponse();

    if (!req.body.RecordingUrl) {
        err("MUSIC-SEARCH: no RecordingUrl!");
        await playOrSay(r, "No audio was recorded. Please try again.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    log(`MUSIC-SEARCH: RecordingUrl=${req.body.RecordingUrl}`);
    log(`MUSIC-SEARCH: RecordingDuration=${req.body.RecordingDuration}`);

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    log(`MUSIC-SEARCH: fetch result = ${base64Audio === "FETCH_FAILED" ? "FETCH_FAILED" : base64Audio.length + " chars"}`);

    if (!base64Audio || base64Audio === "FETCH_FAILED") {
        err("MUSIC-SEARCH: fetch failed, looping back");
        await playOrSay(r, "Could not download your audio. Please try again.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    const transcript = await transcribeAudio(base64Audio);
    log(`MUSIC-SEARCH: transcript="${transcript}"`);

    if (transcript && transcript.length > 0) {
        log(`MUSIC-SEARCH: sending to yt-dlp: "${transcript}"`);
        searchAndDownloadYTDLP(req.body.CallSid, transcript);
        const msg = isHebrewText(transcript) ? `מחפש את ${transcript}` : `Searching for ${transcript}`;
        await playOrSay(r, msg);
        r.redirect("/music-wait-loop");
    } else {
        err("MUSIC-SEARCH: transcript was null/empty");
        await playOrSay(r, "Sorry, I could not understand the song name. Please try again.");
        r.redirect("/music-mode");
    }

    res.type("text/xml").send(r.toString());
});

app.all("/music-wait-loop", async (req, res) => {
    log(`MUSIC-WAIT-LOOP: callSid=${req.body.CallSid}`);
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    log(`MUSIC-WAIT-LOOP: download status=${dl ? dl.status : "NOT FOUND"}`);

    if (!dl) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        log(`MUSIC-WAIT-LOOP: playing ${dl.url}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", bargeIn: true, finishOnKey: "" });
        g.play(dl.url);
        r.redirect("/twiml");
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        err("MUSIC-WAIT-LOOP: download error or timeout");
        await playOrSay(r, "Error downloading the song. Please try again.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect("/music-mode");
    } else {
        log("MUSIC-WAIT-LOOP: still pending, waiting 3s...");
        r.pause({ length: 3 });
        r.redirect("/music-wait-loop");
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => log(`🚀 Server Online on PORT ${CONFIG.PORT}`));
