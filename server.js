console.log("🚀 Starting Server: GEMINI 2.5 + TWILIO AUTH + ABSOLUTE ROUTING...");

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
    
    // ⚠️ CRITICAL: Twilio Auth for downloading recordings
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,

    VERIFIED_CALLERS:[
        "+972548498889", "+972554402506", "+972525585720", 
        "+972528263032", "+972583230268"
    ],
    
    GEMINI_KEYS:[
        process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4
    ].filter(key => key)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// ==============================================================================
// 🧠 GEMINI 2.5 MODELS
// ==============================================================================

async function transcribeAudio(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;

    console.log(`[GEMINI] Sending audio to Google Gemini 2.5 Flash...`);
    const prompt = `You are a strict transcriber. Listen to the audio and extract the exact text spoken. It can be Hebrew or English. Remove hesitations. Output ONLY the clean text. If the audio is silent or unintelligible, output the word "SILENCE". Do not add ANY conversational text.`;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
            
            const result = await model.generateContent([
                prompt, 
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);
            
            const text = result.response.text().trim();
            console.log(`[GEMINI] Successful Transcript: "${text}"`);
            
            if (text.includes("SILENCE") || text.length < 2 || text.includes("I can help")) return null;
            return text;
        } catch (e) {
            console.error(`❌ [GEMINI] Key Failed: ${e.message}`);
        }
    }
    return null;
}

async function chatWithGemini(session, userInputText) {
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
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
// 🔊 ZERO-COST TEXT-TO-SPEECH (Edge-TTS)
// ==============================================================================
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        console.log(`[TTS] Generating audio for: "${safeText}"`);
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else {
                console.error(`❌ [TTS] Failed to generate audio for text: ${safeText}`);
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
        sessions.set(callSid, { chatHistory:[], currentSong: null, mode: "normal" });
    }
    return sessions.get(callSid);
}

async function searchAndDownloadYTDLP(callSid, query) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });
    console.log(`[YTDLP] Starting download for: "${query}"`);
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    const args =[`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    
    const child = spawn('yt-dlp', args);
    child.on('close', () => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        if (found) {
            console.log(`[YTDLP] Download Success! File: ${found}`);
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, title: query, filename: found });
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else {
            console.error(`❌ [YTDLP] Failed to download: "${query}"`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ⚠️ THE TWILIO AUTH FIX IS HERE
async function fetchTwilioRecording(recordingUrl) {
    console.log(`[TWILIO] Fetching MP3 with Auth from: ${recordingUrl}.mp3`);
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Construct Twilio Basic Auth Header
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");

        const audioRes = await fetch(recordingUrl + ".mp3", {
            headers: { "Authorization": authHeader }
        });
        
        if (!audioRes.ok) {
            console.error(`❌ [TWILIO] HTTP Status ${audioRes.status}`);
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
// 🚀 ROUTING & EXPRESS SERVER
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
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    sessions.delete(req.body.CallSid);
    const r = new VoiceResponse();
    
    const g = r.gather({ 
        input: "dtmf", numDigits: 1, 
        action: `${CONFIG.BASE_URL}/router`, // ⚠️ ABSOLUTE URL
        method: "POST", 
        timeout: 10, finishOnKey: "" 
    });
    await playOrSay(g, "Main menu. Press 1 for chat, or hash for music.");
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/router", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    if (d === "1") r.redirect(`${CONFIG.BASE_URL}/voice-mode`);      
    else if (d === "#") r.redirect(`${CONFIG.BASE_URL}/music-mode`); 
    else r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// VOICE CHAT
// ------------------------------------------------------------------------------
app.all("/voice-mode", async (req, res) => {
    const r = new VoiceResponse();
    await playOrSay(r, "Please speak after the beep, then press hash.");
    
    r.record({ 
        action: `${CONFIG.BASE_URL}/voice-process`, // ⚠️ ABSOLUTE URL
        method: "POST", 
        finishOnKey: "#", maxLength: 60, playBeep: true, timeout: 5 
    });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    const r = new VoiceResponse();
    
    if (!req.body.RecordingUrl) {
        await playOrSay(r, "No audio received from Twilio.");
        r.redirect(`${CONFIG.BASE_URL}/voice-mode`);
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

    const g = r.gather({ 
        input: "dtmf", numDigits: 1, 
        action: `${CONFIG.BASE_URL}/router`, method: "POST", finishOnKey: "" 
    });
    await playOrSay(g, "Press 1 to speak again, or hash for music.");
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// MUSIC MODE
// ------------------------------------------------------------------------------
app.all("/music-mode", async (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ 
        input: "dtmf", numDigits: 1, 
        action: `${CONFIG.BASE_URL}/music-logic`, method: "POST", timeout: 10, finishOnKey: "" 
    });
    await playOrSay(g, "Music mode. Press 1 to search for a song.");
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        await playOrSay(r, "Say the song name, then press hash.");
        r.record({ 
            action: `${CONFIG.BASE_URL}/music-search`, // ⚠️ ABSOLUTE URL
            method: "POST", 
            maxLength: 15, playBeep: true, finishOnKey: "#", timeout: 5 
        });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    console.log("========== MUSIC SEARCH STARTED ==========");
    const r = new VoiceResponse();

    if (!req.body.RecordingUrl) {
        console.error("❌ ERROR: Twilio did not send a RecordingUrl!");
        await playOrSay(r, "No audio was recorded. Make sure to speak after the beep.");
        r.redirect(`${CONFIG.BASE_URL}/music-mode`);
        return res.type("text/xml").send(r.toString());
    }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    if (base64Audio && base64Audio !== "FETCH_FAILED") {
        const cleanQuery = await transcribeAudio(base64Audio);
        if (!cleanQuery) {
            console.error("❌ ERROR: Gemini returned null for transcript!");
            await playOrSay(r, "I could not understand the song name. Let's try again.");
            r.redirect(`${CONFIG.BASE_URL}/music-mode`);
            return res.type("text/xml").send(r.toString());
        }

        searchAndDownloadYTDLP(req.body.CallSid, cleanQuery);
        const searchString = isHebrewText(cleanQuery) ? `מחפש את ${cleanQuery}` : `Searching for ${cleanQuery}`;
        await playOrSay(r, searchString);
        
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
        return res.type("text/xml").send(r.toString());
    }

    console.error("❌ ERROR: Fetch completely failed.");
    await playOrSay(r, "There was a network error fetching your audio. Please try again.");
    r.redirect(`${CONFIG.BASE_URL}/music-mode`);
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// MUSIC WAIT LOOP
// ------------------------------------------------------------------------------
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/music-mode`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const g = r.gather({ 
            input: "dtmf", numDigits: 1, 
            action: `${CONFIG.BASE_URL}/router`, method: "POST", bargeIn: true, finishOnKey: "" 
        });
        g.play(dl.url);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);

    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSay(r, "Error downloading the song from the internet.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/music-mode`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
