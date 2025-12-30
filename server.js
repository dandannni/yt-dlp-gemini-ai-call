console.log("🚀 Starting Server (Fixed Logger + Safe Downloader)...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process"; 
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ---------------------------------------------------------
// 📝 LOGGING SYSTEM (FIXED)
// ---------------------------------------------------------
const logBuffer = [];
const MAX_LOGS = 200; 

function addToLog(type, args) {
    try {
        const msg = args.map(a => {
            if (a instanceof Error) return a.message + '\n' + a.stack; // Properly print Errors
            if (typeof a === 'object') return JSON.stringify(a);
            return String(a);
        }).join(' ');

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        // Clean up yt-dlp progress bars to keep logs clean
        const cleanMsg = msg.replace(/\r/g, ''); 

        const logLine = `[${timestamp}] [${type}] ${cleanMsg}`;
        logBuffer.push(logLine);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift(); 
        
        process.stdout.write(logLine + '\n');
    } catch (e) { process.stdout.write('Log Error\n'); }
}

console.log = (...args) => addToLog("INFO", args);
console.error = (...args) => addToLog("ERROR", args);
console.warn = (...args) => addToLog("WARN", args);

// ---------------------------------------------------------
// 🔐 CONFIGURATION
// ---------------------------------------------------------
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4
].filter(key => key); 

if (GEMINI_KEYS.length === 0) console.error("❌ NO GEMINI API KEYS FOUND!");
else console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini Keys.`);

const VERIFIED_CALLERS = [
    "+972548498889", 
    "+972554402506", 
    "+972525585720", 
    "+972528263032", 
    "+972583230268"
];

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------
// 🕵️ LOG PAGE
// ---------------------------------------------------------
app.get("/logs", (req, res) => {
    if (req.query.pwd !== "1234") return res.status(403).send("🚫 Access Denied.");
    res.send(`
        <html><head><title>Logs</title>
        <meta http-equiv="refresh" content="1"> 
        <style>body{background:#111;color:#0f0;font-family:monospace;padding:10px;font-size:12px;}</style>
        </head><body><h3>📜 Live Logs</h3><pre>${logBuffer.join("\n")}</pre></body></html>
    `);
});

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.resolve(DOWNLOAD_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File deleted or not found");

    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
});

// 🧠 SESSION STORAGE
const sessions = new Map();
const downloadQueue = new Map(); 

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC (1.5 FLASH - STABLE)
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            // ⚡ USING 1.5 FLASH (Fast & Reliable)
            const model = genAI.getGenerativeModel({ 
                model: "gemini-1.5-flash",
                systemInstruction: "You are a helpful phone assistant. Keep answers short (1 sentence). If user asks for music, say 'Press hash'.",
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const text = result.response.text();
            
            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: text }] });
            return text;
        } catch (error) {
            console.error(`⚠️ Key ${i+1} Failed: ${error.message}`);
        }
    }
    return "I am having trouble thinking right now.";
}

// ---------------------------------------------------------
// 🎵 DOWNLOAD LOGIC (SAFE SPAWN + SOUNDCLOUD)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Start] Downloading: "${query}"`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // SoundCloud (scsearch1) - Using spawn to avoid shell errors
    const args = [
        `scsearch1:${query}`, 
        '-x', 
        '--audio-format', 'mp3', 
        '--no-playlist', 
        '--force-ipv4', 
        '-o', outputTemplate
    ];

    const child = spawn('yt-dlp', args);

    // Stream logs so we see what happens
    child.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('[download]') || line.includes('%')) {
            console.log(`🔹 ${line}`);
        }
    });

    child.stderr.on('data', (data) => {
        const line = data.toString().trim();
        // Log errors but ignore common warnings
        if (!line.includes('WARNING')) {
            console.error(`🔸 ${line}`);
        }
    });

    child.on('close', (code) => {
        if (code === 0) {
            console.log("✅ Download Finished Successfully.");
            downloadQueue.set(callSid, { 
                status: 'done', 
                url: `${BASE_URL}/music/${filename}`,
                title: query,
                filename: filename
            });
            
            // Auto-delete after 10 mins
            setTimeout(() => {
                if (fs.existsSync(path.join(DOWNLOAD_DIR, filename))) fs.unlinkSync(path.join(DOWNLOAD_DIR, filename));
            }, 600000); 
        } else {
            console.error(`🚨 Download failed with exit code ${code}`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ---------------------------------------------------------
// 📞 ROUTE: START
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    if (!VERIFIED_CALLERS.includes(req.body.From)) {
        const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString());
    }
    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); 
    
    const r = new VoiceResponse();
    r.say("Connected. Press Pound for music.");
    r.gather({ input: "speech dtmf", numDigits: 1, action: "/gather", method: "POST", timeout: 5 });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE: MAIN GATHER
// ---------------------------------------------------------
app.post("/gather", async (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const digits = req.body.Digits;
    const text = req.body.SpeechResult;
    const session = getSession(sid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }
    if (digits === "#") { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (!text) {
        r.gather({ input: "speech dtmf", numDigits: 1, action: "/gather" });
        return res.type("text/xml").send(r.toString());
    }

    const reply = await getGeminiResponse(session, text);
    r.say(reply);
    r.gather({ input: "speech dtmf", numDigits: 1, action: "/gather" });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC ENTRY
// ---------------------------------------------------------
app.post("/music-mode", (req, res) => {
    const r = new VoiceResponse();
    const gather = r.gather({ input: "speech dtmf", numDigits: 1, action: "/music-logic", timeout: 5 });
    gather.say("What song?"); 
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC LOGIC
// ---------------------------------------------------------
app.post("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const digits = req.body.Digits;
    const text = req.body.SpeechResult;
    const session = getSession(sid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }

    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            r.say("No history."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
        }
        if (digits === "4" && session.index > 0) session.index--; 
        if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++; 
        
        const song = session.musicHistory[session.index];
        r.say(`Playing ${song.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic" });
        g.play(song.url);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (text) {
        startDownload(sid, text); 
        r.say("Searching...");
        r.redirect("/music-wait"); 
        return res.type("text/xml").send(r.toString());
    }

    r.say("Say a song name.");
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🔄 ROUTE: WAIT LOOP
// ---------------------------------------------------------
app.post("/music-wait", (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const dl = downloadQueue.get(sid);

    if (!dl) { r.say("Error."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'pending') {
        if (Date.now() - dl.startTime > 60000) {
            r.say("Took too long."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
        }
        r.pause({ length: 2 });
        r.redirect("/music-wait"); 
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'error') {
        r.say("Download failed."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'done') {
        const session = getSession(sid);
        session.musicHistory.push({ title: dl.title, url: dl.url });
        session.index = session.musicHistory.length - 1;

        r.say(`Playing ${dl.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic" });
        g.play(dl.url);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
