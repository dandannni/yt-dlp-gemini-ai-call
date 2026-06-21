console.log("🚀 Starting Server: GEMINI 2.5 + LIVE SEARCH + SMS TO SPECIFIC PHONE...");

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

// Initialize Twilio Client for sending SMS
const twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

// ==============================================================================
// 🧠 GEMINI 2.5 MODELS
// ==============================================================================

async function transcribeAudio(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;
    const prompt = `You are a strict transcriber. Listen to the audio and extract the exact text spoken. It can be Hebrew or English. Remove hesitations. Output ONLY the clean text. If the audio is silent or unintelligible, output the word "SILENCE". Do not add ANY conversational text.`;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
            const result = await model.generateContent([ prompt, { inlineData: { mimeType: "audio/mp3", data: base64Audio } } ]);
            const text = result.response.text().trim();
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
                tools: [{ googleSearch: {} }],
                systemInstruction: "You are a helpful phone assistant with access to real-time Google Search. Answer briefly. Never mix English and Hebrew. If Hebrew, reply ONLY in Hebrew. If English, reply ONLY in English. CRITICAL: Do NOT output any URLs, links, or markdown syntax (like **), because your response will be read out loud over a phone call."
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userInputText);
            return result.response.text().replace(/\*/g, '');
        } catch (e) {
            console.error(`❌ [GEMINI CHAT] Key Failed: ${e.message}`);
        }
    }
    return "Sorry, I had a problem processing that.";
}

// ==============================================================================
// 🔊 ZERO-COST TEXT-TO-SPEECH 
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
// 💾 SESSION & ASYNC QUEUES
// ==============================================================================
const sessions = new Map();
const downloadQueue = new Map();
const chatQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory:[], currentSong: null, mode: "normal", lastAIResponse: "" });
    }
    return sessions.get(callSid);
}

async function processChatBackground(callSid, recordingUrl) {
    try {
        const base64Audio = await fetchTwilioRecording(recordingUrl);
        if (base64Audio && base64Audio !== "FETCH_FAILED") {
            const cleanText = await transcribeAudio(base64Audio);
            if (cleanText) {
                const session = getSession(callSid);
                const replyText = await chatWithGemini(session, cleanText);
                
                session.lastAIResponse = replyText; 

                const ttsFilename = await generateFreeTTS(replyText);
                chatQueue.set(callSid, { status: 'done', ttsFilename, replyText });
            } else {
                chatQueue.set(callSid, { status: 'error', message: "I couldn't understand the audio." });
            }
        } else {
            chatQueue.set(callSid, { status: 'error', message: "Error fetching audio from Twilio." });
        }
    } catch (e) {
        console.error("Background Chat Error:", e);
        chatQueue.set(callSid, { status: 'error', message: "An error occurred while searching." });
    }
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
        await new Promise(resolve => setTimeout(resolve, 500));
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const audioRes = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        
        if (!audioRes.ok) return "FETCH_FAILED";
        const arrayBuffer = await audioRes.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    } catch (e) { return "FETCH_FAILED"; }
}

// ==============================================================================
// 🚀 ROUTING
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
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/router`, method: "POST", timeout: 10, finishOnKey: "" });
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
// 📱 SMS & CHAT ROUTER
// ------------------------------------------------------------------------------
app.all("/sms-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);

    if (d === "*") { 
        const textToSend = session.lastAIResponse || "No previous message found to send.";
        const targetPhoneNumber = "+972548498889"; // ⚠️ Hardcoded Destination
        
        try {
            console.log(`[SMS] Sending message to ${targetPhoneNumber}...`);
            await twilioClient.messages.create({
                body: `🤖 Gemini AI:\n\n${textToSend}`,
                from: req.body.To,         // Your Twilio Phone Number
                to: targetPhoneNumber      // Hardcoded Phone Number
            });
            await playOrSay(r, "Message sent to the designated phone successfully.");
        } catch (error) {
            console.error(`❌ [SMS ERROR]:`, error.message);
            await playOrSay(r, "Failed to send the message to the designated phone.");
        }
        r.redirect(`${CONFIG.BASE_URL}/voice-mode`); 
    } 
    else if (d === "1") r.redirect(`${CONFIG.BASE_URL}/voice-mode`);
    else if (d === "#") r.redirect(`${CONFIG.BASE_URL}/music-mode`);
    else r.redirect(`${CONFIG.BASE_URL}/twiml`);
    
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ASYNC VOICE CHAT
// ------------------------------------------------------------------------------
app.all("/voice-mode", async (req, res) => {
    const r = new VoiceResponse();
    await playOrSay(r, "Please speak after the beep, then press hash.");
    r.record({ action: `${CONFIG.BASE_URL}/voice-process`, method: "POST", finishOnKey: "#", maxLength: 60, playBeep: true, timeout: 5 });
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) {
        await playOrSay(r, "No audio received from Twilio.");
        r.redirect(`${CONFIG.BASE_URL}/voice-mode`);
        return res.type("text/xml").send(r.toString());
    }

    chatQueue.set(req.body.CallSid, { status: 'pending' });
    processChatBackground(req.body.CallSid, req.body.RecordingUrl);

    r.say({ language: 'en-US' }, "Let me look that up..."); 
    r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = chatQueue.get(req.body.CallSid);
    
    if (!task) { r.redirect(`${CONFIG.BASE_URL}/voice-mode`); return res.type("text/xml").send(r.toString()); }

    if (task.status === 'done') {
        const g1 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/sms-router`, method: "POST", bargeIn: true, finishOnKey: "" });
        if (task.ttsFilename) g1.play(`${CONFIG.BASE_URL}/music/${task.ttsFilename}`);
        else g1.say({ language: isHebrewText(task.replyText) ? 'he-IL' : 'en-US' }, task.replyText);
        
        const g2 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/sms-router`, method: "POST", finishOnKey: "" });
        await playOrSay(g2, "Press 1 to reply, Star to text this to your phone, or Hash for music.");
        
        chatQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);

    } else if (task.status === 'error') {
        await playOrSay(r, task.message);
        chatQueue.delete(req.body.CallSid);
        r.redirect(`${CONFIG.BASE_URL}/voice-mode`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// MUSIC MODE
// ------------------------------------------------------------------------------
app.all("/music-mode", async (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/music-logic`, method: "POST", timeout: 10, finishOnKey: "" });
    await playOrSay(g, "Music mode. Press 1 to search for a song.");
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") {
        await playOrSay(r, "Say the song name, then press hash.");
        r.record({ action: `${CONFIG.BASE_URL}/music-search`, method: "POST", maxLength: 15, playBeep: true, finishOnKey: "#", timeout: 5 });
        return res.type("text/xml").send(r.toString());
    }
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) {
        await playOrSay(r, "No audio was recorded.");
        r.redirect(`${CONFIG.BASE_URL}/music-mode`);
        return res.type("text/xml").send(r.toString());
    }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    if (base64Audio && base64Audio !== "FETCH_FAILED") {
        const cleanQuery = await transcribeAudio(base64Audio);
        if (!cleanQuery) {
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
    await playOrSay(r, "Network error fetching your audio.");
    r.redirect(`${CONFIG.BASE_URL}/music-mode`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/music-mode`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/router`, method: "POST", bargeIn: true, finishOnKey: "" });
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
