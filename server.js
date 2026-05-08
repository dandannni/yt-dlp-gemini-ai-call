console.log("🚀 Starting Server: STRICT STT + NATIVE ACCENTS + STABLE AUDIO...");

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

// ==============================================================================
// 🧠 GEMINI MODELS (STRICTLY SEPARATED)
// ==============================================================================

// Helper to detect language for Voice selection
function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// MODEL 1: THE TRANSCRIBER (Strict API mode, NO hallucinations)
async function transcribeAudio(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            // System instruction forces it to act ONLY as an STT engine
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: "You are an automated Speech-to-Text API. Your ONLY function is to transcribe audio into text. DO NOT add conversational replies. DO NOT say 'I can help with that'. If the audio is silent, contains only background noise, or is unintelligible, you MUST output exactly the word 'SILENCE' and nothing else."
            });
            
            const result = await model.generateContent([
                "Transcribe the following audio exactly as spoken.", 
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);
            
            const text = result.response.text().trim();
            // If it outputs SILENCE, or hallucinates "I need help", catch it
            if (text.includes("SILENCE") || text.includes("I can help") || text.length < 2) return null;
            return text;
        } catch (e) {
            console.error("Transcriber Key Failed, trying next...");
        }
    }
    return null;
}

// MODEL 2: THE CHAT BOT (Fluent Language Forced)
async function chatWithGemini(session, userInputText) {
    if (CONFIG.GEMINI_KEYS.length === 0) return "No API keys configured.";
    
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                // Forcing the model to never mix languages so Edge-TTS doesn't give a weird accent
                systemInstruction: "You are a helpful phone assistant. Answer briefly. IMPORTANT: Never mix English and Hebrew in the same response. If the user speaks Hebrew, reply ONLY in Hebrew. If English, reply ONLY in English."
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userInputText);
            return result.response.text();
        } catch (e) {
            console.error("Chat Key Failed, trying next...");
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
        
        // Pure Israeli voice for Hebrew, Pure American voice for English
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';

        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else resolve(null);
        });
    });
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
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    const args =[`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    
    const child = spawn('yt-dlp', args);
    child.on('close', () => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        if (found) {
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, title: query, filename: found });
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else {
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

async function fetchTwilioRecording(recordingUrl) {
    try {
        // 500ms delay to ensure Twilio is fully done encoding the MP3 to prevent corrupted files
        await new Promise(resolve => setTimeout(resolve, 500));
        const audioRes = await fetch(recordingUrl + ".mp3");
        const arrayBuffer = await audioRes.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    } catch (e) {
        console.error("Failed to fetch Twilio recording:", e);
        return null;
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

// 1. MAIN MENU
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    sessions.delete(req.body.CallSid);
    const r = new VoiceResponse();
    
    // Single language to prevent accents (translate this string to Hebrew if you want it all in Hebrew)
    const menuTTS = await generateFreeTTS("Main menu. Press 1 for chat, or hash for music.");
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", timeout: 10, finishOnKey: "" });
    if (menuTTS) g.play(`${CONFIG.BASE_URL}/music/${menuTTS}`);
    
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

// 2. VOICE CHAT (Zero-Cost STT)
app.all("/voice-mode", async (req, res) => {
    const r = new VoiceResponse();
    const beepTTS = await generateFreeTTS("Please speak after the beep, then press hash.");
    if (beepTTS) r.play(`${CONFIG.BASE_URL}/music/${beepTTS}`);
    
    // Added timeout="5" and trim="trim-silence" to fix empty audio loops
    r.record({ action: "/voice-process", finishOnKey: "#", maxLength: 60, playBeep: true, trim: "trim-silence", timeout: 5 });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    const r = new VoiceResponse();
    
    if (req.body.RecordingUrl) {
        const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
        if (base64Audio && base64Audio.length > 1000) { // Verify audio isn't completely empty
            const cleanText = await transcribeAudio(base64Audio);
            console.log(`[Chat - Transcribed]: ${cleanText}`);
            
            if (cleanText) {
                const replyText = await chatWithGemini(getSession(req.body.CallSid), cleanText);
                console.log(`[Chat - AI Reply]: ${replyText}`);
                
                const ttsFilename = await generateFreeTTS(replyText);
                if (ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
            }
        }
    }
    
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
    const loopTTS = await generateFreeTTS("Press 1 to speak again, or hash for music.");
    if (loopTTS) g.play(`${CONFIG.BASE_URL}/music/${loopTTS}`);
    
    res.type("text/xml").send(r.toString());
});

// 3. MUSIC MODE
app.all("/music-mode", async (req, res) => {
    const r = new VoiceResponse();
    const menuTTS = await generateFreeTTS("Music mode. Press 1 to search for a song.");
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic", timeout: 10, finishOnKey: "" });
    if (menuTTS) g.play(`${CONFIG.BASE_URL}/music/${menuTTS}`);
    
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        const promptTts = await generateFreeTTS("Say the song name, then press hash.");
        if (promptTts) r.play(`${CONFIG.BASE_URL}/music/${promptTts}`);
        
        // Added timeout="5" and trim="trim-silence"
        r.record({ action: "/music-search", maxLength: 15, playBeep: true, finishOnKey: "#", trim: "trim-silence", timeout: 5 });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    const r = new VoiceResponse();

    if (req.body.RecordingUrl) {
        const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
        if (base64Audio && base64Audio.length > 1000) {
            const cleanQuery = await transcribeAudio(base64Audio);
            console.log(`[Music - Searching]: ${cleanQuery}`);

            if (cleanQuery) {
                searchAndDownloadYTDLP(req.body.CallSid, cleanQuery);
                
                // Matches the language of the query!
                const searchString = isHebrewText(cleanQuery) ? `מחפש את ${cleanQuery}` : `Searching for ${cleanQuery}`;
                const waitTts = await generateFreeTTS(searchString);
                
                if (waitTts) r.play(`${CONFIG.BASE_URL}/music/${waitTts}`);
                r.redirect("/music-wait-loop");
                return res.type("text/xml").send(r.toString());
            }
        }
    }
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// 4. MUSIC PLAYER WAIT LOOP
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    
    if (!dl) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", bargeIn: true, finishOnKey: "" });
        g.play(dl.url);
        r.redirect("/twiml");

    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        const failTts = await generateFreeTTS("Error downloading the song.");
        if (failTts) r.play(`${CONFIG.BASE_URL}/music/${failTts}`);
        downloadQueue.delete(req.body.CallSid);
        r.redirect("/music-mode");
    } else {
        r.pause({ length: 3 });
        r.redirect("/music-wait-loop");
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
