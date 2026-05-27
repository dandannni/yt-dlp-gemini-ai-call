console.log("🚀 Starting Server: DEEP DEBUG MODE & FAILSAFES...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ==============================================================================
// ⚙️ CONFIGURATION
// ==============================================================================
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
    ].filter(key => key),

    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
};

console.log(`[CONFIG] BASE_URL: ${CONFIG.BASE_URL}`);
console.log(`[CONFIG] GEMINI_KEYS loaded: ${CONFIG.GEMINI_KEYS.length}`);
console.log(`[CONFIG] TWILIO_ACCOUNT_SID present: ${!!CONFIG.TWILIO_ACCOUNT_SID}`);
console.log(`[CONFIG] TWILIO_AUTH_TOKEN present: ${!!CONFIG.TWILIO_AUTH_TOKEN}`);

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// ==============================================================================
// 🧠 GEMINI - TRANSCRIBER (Hebrew & English, raw output only)
// ==============================================================================
async function transcribeAudio(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) {
        console.error("❌ ERROR: No Gemini API Keys found.");
        return null;
    }

    console.log(`[TRANSCRIBER] Sending ${base64Audio.length} chars of base64 audio to Gemini...`);

    // ✅ BULLETPROOF PROMPT: raw transcript only, Hebrew or English, no interpretation
    const prompt = `You are a transcription machine. Your only job is to write down exactly what you hear in the audio file.
Rules:
- The audio may be in Hebrew or English. Transcribe in whatever language is spoken.
- Output ONLY the words that were spoken. Nothing else.
- Do NOT say "I cannot", "I'm unable", "SILENCE", or anything conversational.
- Do NOT add punctuation, explanations, or any extra words.
- If you hear Hebrew, write Hebrew. If you hear English, write English.
- Just the raw words. That is all.`;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

            const result = await model.generateContent([
                prompt,
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);

            const text = result.response.text().trim();
            console.log(`[TRANSCRIBER] Raw output from Gemini: "${text}"`);

            // Only reject if truly empty
            if (!text || text.length < 1) {
                console.error(`[TRANSCRIBER] Empty response from Gemini.`);
                return null;
            }

            return text;
        } catch (e) {
            console.error(`❌ [TRANSCRIBER] Key Failed: ${e.message}`);
        }
    }
    return null;
}

// ==============================================================================
// 🧠 GEMINI - CHAT (separate function, never used for music)
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
            console.error(`❌ [GEMINI CHAT] Key Failed: ${e.message}`);
        }
    }
    return "Sorry, I had a problem processing that.";
}

// ==============================================================================
// 🔊 ZERO-COST TEXT-TO-SPEECH (Hebrew & English auto-detect)
// ==============================================================================
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);

        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);

        // ✅ Auto-detect Hebrew or English and pick the right voice
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        console.log(`[TTS] Voice: ${voice} | Text: "${safeText}"`);

        const child = spawn('edge-tts', ['--text', safeText, '--voice', voice, '--write-media', outputPath]);

        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`[TTS] Success: ${filename}`);
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 300000);
                resolve(filename);
            } else {
                console.error(`❌ [TTS] Failed for: "${safeText}"`);
                resolve(null);
            }
        });
    });
}

async function playOrSay(r, text) {
    const ttsFilename = await generateFreeTTS(text);
    if (ttsFilename) {
        r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    } else {
        console.log(`[TWILIO FALLBACK] Saying: "${text}"`);
        r.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
    }
}

// ==============================================================================
// 💾 SESSION & DOWNLOAD LOGIC
// ==============================================================================
const sessions = new Map();
const downloadQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], currentSong: null, mode: "normal" });
    }
    return sessions.get(callSid);
}

async function searchAndDownloadYTDLP(callSid, query) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });
    console.log(`[YTDLP] Starting download for: "${query}"`);
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    const args = [
        `scsearch1:${query}`, '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
        '--no-playlist', '--force-ipv4', '-o', outputTemplate
    ];

    const child = spawn('yt-dlp', args);
    child.stdout.on('data', (d) => console.log(`[YTDLP] ${d.toString().trim()}`));
    child.stderr.on('data', (d) => console.error(`[YTDLP ERR] ${d.toString().trim()}`));

    child.on('close', (code) => {
        console.log(`[YTDLP] Process exited with code ${code}`);
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        if (found) {
            console.log(`[YTDLP] Download Success! File: ${found}`);
            downloadQueue.set(callSid, {
                status: 'done',
                url: `${CONFIG.BASE_URL}/music/${found}`,
                title: query,
                filename: found
            });
            setTimeout(() => {
                const fp = path.join(CONFIG.DOWNLOAD_DIR, found);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }, 1200000);
        } else {
            console.error(`❌ [YTDLP] No MP3 found after download for: "${query}"`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ✅ Fetch with Twilio Basic Auth
async function fetchTwilioRecording(recordingUrl) {
    const url = recordingUrl + ".mp3";
    console.log(`[TWILIO] Fetching MP3 from: ${url}`);

    if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
        console.error("❌ [TWILIO] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in env vars!");
        return "FETCH_FAILED";
    }

    try {
        await new Promise(resolve => setTimeout(resolve, 1500));

        const credentials = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
        const audioRes = await fetch(url, {
            headers: { 'Authorization': `Basic ${credentials}` }
        });

        console.log(`[TWILIO] HTTP Status: ${audioRes.status}`);

        if (!audioRes.ok) {
            console.error(`❌ [TWILIO] Bad HTTP status: ${audioRes.status}`);
            return "FETCH_FAILED";
        }

        const arrayBuffer = await audioRes.arrayBuffer();
        console.log(`[TWILIO] Successfully downloaded ${arrayBuffer.byteLength} bytes.`);
        return Buffer.from(arrayBuffer).toString('base64');
    } catch (e) {
        console.error(`❌ [TWILIO] Network Fetch Error: ${e.message}`);
        return "FETCH_FAILED";
    }
}

// ==============================================================================
// 🚀 EXPRESS SERVER & ROUTES
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) {
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
    const r = new VoiceResponse();
    const d = req.body.Digits;
    if (d === "1") r.redirect("/voice-mode");
    else if (d === "#") r.redirect("/music-mode");
    else r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

// VOICE CHAT
app.all("/voice-mode", async (req, res) => {
    const r = new VoiceResponse();
    await playOrSay(r, "Please speak after the beep, then press hash.");
    r.record({ action: "/voice-process", finishOnKey: "#", maxLength: 60, playBeep: true, timeout: 5 });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
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
            const replyText = await chatWithGemini(getSession(req.body.CallSid), cleanText);
            await playOrSay(r, replyText);
        } else {
            await playOrSay(r, "I couldn't understand the audio. Please speak clearly.");
        }
    } else {
        await playOrSay(r, "Error fetching audio from Twilio.");
    }

    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
    await playOrSay(g, "Press 1 to speak again, or hash for music.");
    res.type("text/xml").send(r.toString());
});

// MUSIC MODE
app.all("/music-mode", async (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic", timeout: 10, finishOnKey: "" });
    await playOrSay(g, "Music mode. Press 1 to search for a song.");
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        await playOrSay(r, "Say the song name, then press hash.");
        r.record({ action: "/music-search", maxLength: 15, playBeep: true, finishOnKey: "#", timeout: 5 });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    console.log("========== MUSIC SEARCH STARTED ==========");
    const r = new VoiceResponse();

    if (!req.body.RecordingUrl) {
        console.error("❌ No RecordingUrl from Twilio!");
        await playOrSay(r, "No audio was recorded. Please try again.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    console.log(`[MUSIC-SEARCH] RecordingUrl: ${req.body.RecordingUrl}`);

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);

    if (!base64Audio || base64Audio === "FETCH_FAILED") {
        console.error("❌ Failed to fetch audio from Twilio.");
        await playOrSay(r, "Could not download your audio. Please try again.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    const transcript = await transcribeAudio(base64Audio);

    // ✅ Send straight to yt-dlp regardless — no validation, no rejection
    if (transcript) {
        console.log(`[MUSIC-SEARCH] Transcript: "${transcript}" → Sending to yt-dlp`);
        searchAndDownloadYTDLP(req.body.CallSid, transcript);

        // ✅ System message in same language as transcript
        const searchString = isHebrewText(transcript)
            ? `מחפש את ${transcript}`
            : `Searching for ${transcript}`;
        await playOrSay(r, searchString);
    } else {
        // Transcriber got nothing at all — still try with empty fallback or notify
        console.error("❌ Transcriber returned null — audio may have been completely silent.");
        await playOrSay(r, "I did not hear anything. Please try again.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    r.redirect("/music-wait-loop");
    res.type("text/xml").send(r.toString());
});

// MUSIC WAIT LOOP
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);

    if (!dl) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", bargeIn: true, finishOnKey: "" });
        g.play(dl.url);
        r.redirect("/twiml");
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSay(r, "Error downloading the song. Please try again.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect("/music-mode");
    } else {
        r.pause({ length: 3 });
        r.redirect("/music-wait-loop");
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
