console.log("🚀 Starting Server: Final Production Build...");

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
// ⚙️ SETTINGS & CONFIGURATION
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    
    // 🟢 YOUR EXACT RENDER URL
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://yt-dlp-gemini-ai-call.onrender.com", 

    DOWNLOAD_DIR: "/tmp",
    
    VERIFIED_CALLERS: [
        "+972548498889", 
        "+972554402506", 
        "+972525585720", 
        "+972528263032", 
        "+972583230268"
    ],
    
    GEMINI_KEYS: [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY_4
    ].filter(key => key),

    MESSAGES: {
        WELCOME: "Hello! Speak to Gemini, or press Hash for music.",
        MUSIC_WELCOME: "Music Mode. Name a song.",
        SEARCHING: "Searching SoundCloud...",
        NO_HISTORY: "No history yet.",
    }
};

// ==============================================================================
// 🛠️ SERVICES (THE LOGIC)
// ==============================================================================

// 1. LOGGING SERVICE
const logBuffer = [];
const addToLog = (type, args) => {
    try {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const line = `[${time}] [${type}] ${msg.replace(/\r/g, '')}`;
        logBuffer.push(line);
        if (logBuffer.length > 200) logBuffer.shift();
        process.stdout.write(line + '\n');
    } catch (e) {}
};
console.log = (...args) => addToLog("INFO", args);
console.error = (...args) => addToLog("ERROR", args);

// 2. SESSION MANAGER
const sessions = new Map();
const downloadQueue = new Map();
const getSession = (callSid) => {
    if (!sessions.has(callSid)) sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    return sessions.get(callSid);
};

// 3. AI SERVICE (GEMINI 2.5)
async function askGemini(session, text) {
    if (CONFIG.GEMINI_KEYS.length === 0) return "No API Keys configured.";
    
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                systemInstruction: "You are a helpful phone assistant. Keep answers short (1-2 sentences). If asked for music, say 'Press hash'.",
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(text);
            const response = result.response.text();
            
            session.chatHistory.push({ role: "user", parts: [{ text }] });
            session.chatHistory.push({ role: "model", parts: [{ text: response }] });
            return response;
        } catch (e) {
            console.error(`⚠️ AI Key Failed: ${e.message}`);
        }
    }
    return "I cannot connect to my brain right now.";
}

// 4. MUSIC SERVICE (DOWNLOADER)
async function searchAndDownload(callSid, query) {
    console.log(`🎵 [Download Request] ${query}`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const id = uuidv4();
    const filename = `${id}.mp3`;
    const outputPath = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    // Anti-Preview Command (Filters < 60s, mono audio)
    const args = [
        `scsearch5:${query}`,
        '--match-filter', 'duration > 60',
        '-I', '1',
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
        '--no-playlist', '--force-ipv4', '-o', outputPath
    ];

    const child = spawn('yt-dlp', args);

    child.on('close', (code) => {
        if (code === 0) {
            // Construct the EXACT Public URL
            const fileUrl = `${CONFIG.BASE_URL}/music/${filename}`;
            console.log(`✅ [Ready] ${filename}`);
            console.log(`🔗 [Sending URL] ${fileUrl}`); 

            downloadQueue.set(callSid, {
                status: 'done',
                url: fileUrl,
                title: query
            });

            // Cleanup 10m
            setTimeout(() => {
                const f = path.join(CONFIG.DOWNLOAD_DIR, filename);
                if (fs.existsSync(f)) fs.unlinkSync(f);
            }, 600000);
        } else {
            console.error(`🚨 [Failed] Code ${code}`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ==============================================================================
// 🚀 SERVER SETUP
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

// Serve Audio Files
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (!fs.existsSync(f)) return res.status(404).send("File missing");
    
    // Explicit Headers for Twilio Stability
    const stat = fs.statSync(f);
    res.writeHead(200, { 
        'Content-Type': 'audio/mpeg', 
        'Content-Length': stat.size 
    });
    fs.createReadStream(f).pipe(res);
});

// Logs Page
app.get("/logs", (req, res) => {
    if (req.query.pwd !== "1234") return res.status(403).send("No.");
    res.send(`<html><meta http-equiv="refresh" content="2"><body style="background:#111;color:#0f0;font-family:monospace"><pre>${logBuffer.join("\n")}</pre></body></html>`);
});

// ==============================================================================
// 📞 ROUTE HANDLERS
// ==============================================================================

// 1. INCOMING CALL
app.all("/twiml", (req, res) => {
    try {
        const caller = req.body.From;
        console.log(`📞 [New Call] ${caller}`);

        if (!CONFIG.VERIFIED_CALLERS.includes(caller)) {
            const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString());
        }

        sessions.delete(req.body.CallSid);
        const r = new VoiceResponse();
        r.say(CONFIG.MESSAGES.WELCOME);
        r.gather({ 
            input: "speech dtmf", numDigits: 1, finishOnKey: "", 
            action: "/main-gather", method: "POST", timeout: 5, bargeIn: true 
        });
        res.type("text/xml").send(r.toString());
    } catch (e) { console.error(e); res.status(500).send("Err"); }
});

// 2. MAIN CONVERSATION LOOP
app.all("/main-gather", async (req, res) => {
    try {
        const r = new VoiceResponse();
        const { CallSid, Digits, SpeechResult } = req.body;
        
        if (Digits === "#") {
            console.log("🔀 Switching to Music Mode");
            r.redirect("/music-mode");
            return res.type("text/xml").send(r.toString());
        }

        if (!SpeechResult && !Digits) {
            r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
            return res.type("text/xml").send(r.toString());
        }

        const reply = await askGemini(getSession(CallSid), SpeechResult);
        console.log(`🤖 AI: ${reply}`);
        r.say(reply);
        r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
        res.type("text/xml").send(r.toString());
    } catch (e) { console.error(e); }
});

// 3. MUSIC MENU
app.all("/music-mode", (req, res) => {
    const r = new VoiceResponse();
    console.log("🎵 Music Mode Active");
    const g = r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic", timeout: 5, bargeIn: true });
    g.say(CONFIG.MESSAGES.MUSIC_WELCOME);
    res.type("text/xml").send(r.toString());
});

// 4. MUSIC CONTROLS & SEARCH
app.all("/music-logic", (req, res) => {
    const r = new VoiceResponse();
    const { CallSid, Digits, SpeechResult } = req.body;
    const session = getSession(CallSid);

    if (Digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }

    if (["4", "5", "6"].includes(Digits)) {
        if (session.musicHistory.length === 0) {
            r.say(CONFIG.MESSAGES.NO_HISTORY);
            r.redirect("/music-mode");
            return res.type("text/xml").send(r.toString());
        }
        if (Digits === "4" && session.index > 0) session.index--;
        if (Digits === "6" && session.index < session.musicHistory.length - 1) session.index++;
        
        const song = session.musicHistory[session.index];
        r.say(`Playing ${song.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
        g.play(song.url);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (SpeechResult) {
        searchAndDownload(CallSid, SpeechResult);
        r.say(CONFIG.MESSAGES.SEARCHING);
        r.redirect("/music-wait-loop");
        return res.type("text/xml").send(r.toString());
    }

    r.say("I didn't catch that.");
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// 5. WAIT LOOP (POLLING)
app.all("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);

    if (!dl) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const session = getSession(req.body.CallSid);
        session.musicHistory.push({ title: dl.title, url: dl.url });
        session.index = session.musicHistory.length - 1;

        r.say(`Playing ${dl.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
        
        // Uses the CORRECT base URL now
        g.play(dl.url); 
        
        r.redirect("/music-mode");
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        r.say("Download failed.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect("/music-mode");
    } else {
        r.pause({ length: 2 });
        r.redirect("/music-wait-loop");
    }
    res.type("text/xml").send(r.toString());
});

// 🟢 MAKE SURE YOU COPY THIS LAST LINE!
app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online on Port ${CONFIG.PORT}`));
