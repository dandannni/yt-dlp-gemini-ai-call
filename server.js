console.log("🚀 Starting Server: ZERO-COST AUDIO + DUAL GEMINI + YTDLP...");

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
    // ⚠️ IMPORTANT: Change this to your actual Render URL!
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    
    VERIFIED_CALLERS:[
        "+972548498889", "+972554402506", "+972525585720", 
        "+972528263032", "+972583230268"
    ],
    
    // Multiple keys for maximum free tier!
    GEMINI_KEYS:[
        process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4
    ].filter(key => key)
};

// Ensure temp directory exists
if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

// ==============================================================================
// 🧠 GEMINI MODELS (FREE TIER)
// ==============================================================================

// MODEL 1: THE TRANSCRIBER (Filters stutters, extracts exact query)
async function transcribeAudio(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;
    
    const prompt = `You are a transcriber. Listen to the audio and extract the exact text. 
    It could be Hebrew or English. Remove all hesitations, stutters, and filler words. 
    Output ONLY the final clean text. If no speech is detected, output "SILENCE".`;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent([
                prompt, 
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);
            const text = result.response.text().trim();
            return text.includes("SILENCE") ? null : text;
        } catch (e) {
            console.error("Transcriber Key Failed, trying next...");
        }
    }
    return null;
}

// MODEL 2: THE CHAT BOT (Conversational)
async function chatWithGemini(session, userInputText) {
    if (CONFIG.GEMINI_KEYS.length === 0) return "No API keys configured.";
    
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: "You are a friendly, helpful phone assistant. Answer briefly. If the user speaks Hebrew, answer in Hebrew. If English, answer in English."
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userInputText);
            return result.response.text();
        } catch (e) {
            console.error("Chat Key Failed, trying next...");
        }
    }
    return "שגיאה בתקשורת. Sorry, I had a problem processing that.";
}

// ==============================================================================
// 🔊 ZERO-COST TEXT-TO-SPEECH (Edge-TTS)
// ==============================================================================
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        
        // Remove quotes/newlines that could break the bash command
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        // Auto-detect Hebrew characters vs English
        const isHebrew = /[\u0590-\u05FF]/.test(safeText);
        const voice = isHebrew ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';

        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                // Delete file after 5 minutes to keep server clean
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else {
                resolve(null);
            }
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
            // Cleanup song after 20 minutes
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else {
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// Downloads the audio from Twilio and forces it into an MP3 buffer for Gemini
async function fetchTwilioRecording(recordingUrl) {
    try {
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

// Serve audio files directly to Twilio
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else {
        res.status(404).send("File Gone");
    }
});

// 1. MAIN MENU
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    sessions.delete(req.body.CallSid);
    const r = new VoiceResponse();
    
    const menuTTS = await generateFreeTTS("Hello! Press 1 to chat, or Hash for music. שלום, לחץ 1 לשיחה או סולמית למוזיקה.");
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", timeout: 10, finishOnKey: "" });
    if (menuTTS) g.play(`${CONFIG.BASE_URL}/music/${menuTTS}`);
    else g.say("Press 1 for chat, hash for music."); 
    
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
    const beepTTS = await generateFreeTTS("דבר אחרי הצפצוף. לסיום לחץ סולמית. Speak after the beep. Press hash to finish.");
    if (beepTTS) r.play(`${CONFIG.BASE_URL}/music/${beepTTS}`);
    
    r.record({ action: "/voice-process", finishOnKey: "#", maxLength: 60, playBeep: true });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    const r = new VoiceResponse();
    
    if (req.body.RecordingUrl) {
        const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
        if (base64Audio) {
            const cleanText = await transcribeAudio(base64Audio);
            console.log(`[Chat - Transcribed]: ${cleanText}`);
            
            if (cleanText) {
                const replyText = await chatWithGemini(getSession(req.body.CallSid), cleanText);
                console.log(`[Chat - AI Reply]: ${replyText}`);
                
                const ttsFilename = await generateFreeTTS(replyText);
                if (ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
            } else {
                const errorTts = await generateFreeTTS("לא שמעתי כלום. I didn't hear anything.");
                if (errorTts) r.play(`${CONFIG.BASE_URL}/music/${errorTts}`);
            }
        }
    }
    
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
    const loopTTS = await generateFreeTTS("לחץ 1 להמשך שיחה, או סולמית למוזיקה. Press 1 to keep talking, or Hash for music.");
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
        const promptTts = await generateFreeTTS("תגיד את שם השיר אחרי הצפצוף, ולסיום לחץ סולמית. Say the song name, then press Hash.");
        if (promptTts) r.play(`${CONFIG.BASE_URL}/music/${promptTts}`);
        
        r.record({ action: "/music-search", maxLength: 15, playBeep: true, finishOnKey: "#" });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    const r = new VoiceResponse();

    if (req.body.RecordingUrl) {
        const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
        if (base64Audio) {
            const cleanQuery = await transcribeAudio(base64Audio);
            console.log(`[Music - Searching]: ${cleanQuery}`);

            if (cleanQuery) {
                searchAndDownloadYTDLP(req.body.CallSid, cleanQuery);
                const waitTts = await generateFreeTTS(`מחפש את ${cleanQuery}`);
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
        const playTts = await generateFreeTTS("משמיע כעת. Playing now.");
        if (playTts) r.play(`${CONFIG.BASE_URL}/music/${playTts}`);
        
        // This plays the actual yt-dlp song, and if you press a button it exits
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", bargeIn: true, finishOnKey: "" });
        g.play(dl.url);
        
        r.redirect("/twiml");

    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        const failTts = await generateFreeTTS("שגיאה בהורדת השיר. Error downloading.");
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
