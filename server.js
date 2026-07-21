console.log("🚀 Starting Server: GEMINI 2.5 PRO + ONE-SHOT ROUTING + SOUNDCLOUD...");

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
// ⚙️ CONFIGURATION & SECURITY
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    
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

// Ensure temp directory exists
if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// ==============================================================================
// 🧠 GEMINI AI - MULTIMODAL ROUTING & CHAT
// ==============================================================================

// 1. Analyzes raw audio (Uses FLASH for speed)
async function analyzeAudioIntent(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash", // Fast model for quick intent routing
                tools: [{
                    functionDeclarations: [{
                        name: "route_request",
                        description: "Routes the user's spoken request to either the music player or the AI chat.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                intent: { type: "STRING", description: "Either 'music' or 'chat'" },
                                query: { type: "STRING", description: "The song name to play, or the question to ask the AI. Must be in the original language spoken." }
                            },
                            required: ["intent", "query"]
                        }
                    }]
                }],
                systemInstruction: "You are a fast voice assistant for a phone system. Listen to the audio. If the user asks to play a song or artist, call route_request with intent 'music' and extract the song name. If they ask a question or want to chat, call route_request with intent 'chat' and extract their exact text. Ignore hesitations. Output strictly via the tool call."
            }); 
            
            const result = await model.generateContent([{ inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
            const call = result.response.functionCalls()?.[0];
            
            if (call && call.name === "route_request") return call.args;
        } catch (e) {
            console.error(`❌ [INTENT ROUTER] Key Failed: ${e.message}`);
        }
    }
    return null;
}

// 2. Chat with Google Search Grounding (Uses PRO for high intelligence)
async function chatWithGemini(session, userInputText) {
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-pro", // Upgraded to Pro for maximum reasoning capability
                tools: [{ googleSearch: {} }],
                systemInstruction: "You are a highly intelligent phone assistant with access to real-time Google Search. Answer briefly. Never mix English and Hebrew. If Hebrew, reply ONLY in Hebrew. If English, reply ONLY in English. CRITICAL: Do NOT output any URLs, links, or markdown syntax (like **), because your response will be read out loud over a phone call."
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userInputText);
            return result.response.text().replace(/\*/g, '');
        } catch (e) {
            console.error(`❌ [GEMINI PRO CHAT] Key Failed: ${e.message}`);
        }
    }
    return "Sorry, I had a problem looking that up.";
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
        
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

async function playOrSay(r, text) {
    const ttsFilename = await generateFreeTTS(text);
    if (ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else r.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// ==============================================================================
// 💾 SESSION, QUEUES, & ASYNC WORKERS
// ==============================================================================
const sessions = new Map();
const downloadQueue = new Map();
const chatQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { chatHistory:[], lastAIResponse: "" });
    return sessions.get(callSid);
}

async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const audioRes = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!audioRes.ok) return null;
        return Buffer.from(await audioRes.arrayBuffer()).toString('base64');
    } catch (e) { return null; }
}

async function processChatBackground(callSid, cleanText) {
    try {
        const session = getSession(callSid);
        const replyText = await chatWithGemini(session, cleanText);
        session.lastAIResponse = replyText; 

        const ttsFilename = await generateFreeTTS(replyText);
        chatQueue.set(callSid, { status: 'done', ttsFilename, replyText });
    } catch (e) {
        console.error("Background Chat Error:", e);
        chatQueue.set(callSid, { status: 'error', message: "An error occurred while searching." });
    }
}

async function searchAndDownloadYTDLP(callSid, query) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    // Using SoundCloud to completely avoid Google/YouTube bot-detection and region blocks
    const args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    
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

// ==============================================================================
// 🚀 ROUTING (ONE-SHOT ARCHITECTURE)
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

// Serve MP3s
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// 1. Initial Entry Point - Audio Intake
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    sessions.delete(req.body.CallSid); // Reset session on new call
    const r = new VoiceResponse();
    
    await playOrSay(r, "Welcome. Ask a question, or request a song after the beep.");
    r.record({ action: `${CONFIG.BASE_URL}/process-intent`, method: "POST", maxLength: 15, playBeep: true, timeout: 5 });
    
    res.type("text/xml").send(r.toString());
});

// 2. Multimodal Processor (Replaces DTMF Router)
app.all("/process-intent", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) {
        await playOrSay(r, "No audio heard. Let's try again.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;

    if (!intentData) {
        await playOrSay(r, "I didn't quite catch that. Let's try again.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    // Route to Music
    if (intentData.intent === 'music') {
        searchAndDownloadYTDLP(req.body.CallSid, intentData.query);
        const searchString = isHebrewText(intentData.query) ? `מחפש את ${intentData.query}` : `Finding ${intentData.query}`;
        await playOrSay(r, searchString);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } 
    // Route to Chat
    else {
        chatQueue.set(req.body.CallSid, { status: 'pending' });
        processChatBackground(req.body.CallSid, intentData.query);
        r.say({ language: 'en-US' }, "Let me look that up..."); 
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// ⏳ WAIT LOOPS & POST-ACTION MENUS
// ==============================================================================

app.all("/chat-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = chatQueue.get(req.body.CallSid);
    if (!task) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (task.status === 'done') {
        // Play AI Response
        if (task.ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${task.ttsFilename}`);
        else r.say({ language: isHebrewText(task.replyText) ? 'he-IL' : 'en-US' }, task.replyText);
        
        chatQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/post-action`);
    } else if (task.status === 'error') {
        await playOrSay(r, task.message);
        chatQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        r.play(dl.url);
        downloadQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/post-action`);
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSay(r, "Error downloading the song.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// Post-action menu - No SMS, just loop or hang up
app.all("/post-action", async (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-action-router`, method: "POST", timeout: 8, finishOnKey: "" });
    await playOrSay(g, "To ask something else, press 1. Otherwise, simply hang up.");
    
    r.hangup();
    res.type("text/xml").send(r.toString());
});

app.all("/post-action-router", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`); 
    } else {
        r.hangup();
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
