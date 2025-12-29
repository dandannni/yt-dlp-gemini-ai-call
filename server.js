console.log("🚀 Starting Real-Time Streaming Server...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawn } from "child_process"; 
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

dotenv.config();

// ---------------------------------------------------------
// 📝 LIVE LOGGING SYSTEM
// ---------------------------------------------------------
const logBuffer = [];
const MAX_LOGS = 200; 

function addToLog(type, args) {
    try {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
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
const streamMap = new Map(); 

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC (FASTER MODEL)
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            // ⚡ SWITCHED TO 1.5-FLASH FOR SPEED
            const model = genAI.getGenerativeModel({
                model: "gemini-1.5-flash", 
                systemInstruction: "You are a helpful phone assistant. Keep answers short (1 sentence). If user asks for music, say 'Press hash'.",
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const responseText = result.response.text();
            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: responseText }] });
            return responseText;
        } catch (error) {
            console.error(`⚠️ Key ${i + 1} Failed: ${error.message}`);
        }
    }
    return "Sorry, connection error.";
}

// ---------------------------------------------------------
// 🌊 STREAMING ENDPOINT (THE FIX IS HERE)
// ---------------------------------------------------------
app.get("/stream/:id", (req, res) => {
    const query = streamMap.get(req.params.id);
    if (!query) return res.status(404).end();

    console.log(`🎵 STARTING STREAM: ${query}`);

    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked'
    });

    // 1. YT-DLP (SoundCloud Source)
    const ytArgs = [
        `scsearch1:${query}`, 
        '-o', '-',            
        '-f', 'mp3',          
        '--no-playlist',
        '--force-ipv4'
    ];

    const yt = spawn('yt-dlp', ytArgs);

    // 2. FFMPEG (Throttled to Real-Time)
    const ffmpegArgs = [
        '-re',                // 🛑 CRITICAL FIX: Read input at native frame rate (prevents closing too fast)
        '-i', 'pipe:0',       
        '-f', 'mp3',          
        '-ac', '1',           
        '-ar', '8000',        
        'pipe:1'              
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // 🔗 PIPE CHAIN
    yt.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    yt.stderr.on('data', d => {
        const msg = d.toString();
        if(msg.includes('ERROR') || msg.includes('[download]')) console.log(`🔹 ${msg.trim()}`);
    });

    req.on('close', () => {
        console.log("🔴 Stream closed by user.");
        yt.kill();
        ffmpeg.kill();
    });
});

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
    r.say("Connected. Ask Gemini, or press Pound for music.");
    r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather", method: "POST", timeout: 5, bargeIn: true });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE: MAIN GATHER
// ---------------------------------------------------------
app.post("/main-gather", async (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const digits = req.body.Digits;
    const text = req.body.SpeechResult;
    const session = getSession(sid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }
    if (digits === "#") { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (!text) {
        r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
        return res.type("text/xml").send(r.toString());
    }

    const reply = await getGeminiResponse(session, text);
    r.say(reply);
    r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC ENTRY
// ---------------------------------------------------------
app.post("/music-mode", (req, res) => {
    const r = new VoiceResponse();
    const gather = r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic", timeout: 5, bargeIn: true });
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

    // 🕹️ Controls
    let playQuery = null;
    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            r.say("No history."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
        }
        if (digits === "4" && session.index > 0) session.index--; 
        if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++; 
        playQuery = session.musicHistory[session.index]; 
    } 
    else if (text) {
        playQuery = text;
        session.musicHistory.push(text);
        session.index = session.musicHistory.length - 1;
    }

    if (playQuery) {
        const streamId = uuidv4();
        streamMap.set(streamId, playQuery);
        
        console.log(`🎵 Setup Stream for: ${playQuery}`);
        r.say(`Playing ${playQuery}`);
        
        const gather = r.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
        gather.play(`${BASE_URL}/stream/${streamId}`);
        
        r.redirect("/music-mode"); 
    } else {
        r.say("Say a song name.");
        r.redirect("/music-mode");
    }

    res.type("text/xml").send(r.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
