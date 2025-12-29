console.log("🚀 Starting SoundCloud Streaming Server...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawn } from "child_process"; 
import { v4 as uuidv4 } from "uuid";

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
        // Clean up logs
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

// 🧠 SESSION STORAGE
const sessions = new Map();
const streamMap = new Map(); // Maps ID -> Song Name

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash", 
                systemInstruction: "You are a helpful phone assistant. Keep answers short. If user asks for music, say 'Press hash'.",
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
    return "Sorry, I am having trouble connecting to the servers.";
}

// ---------------------------------------------------------
// 🌊 LIVE STREAMING ENDPOINT (SoundCloud -> Twilio)
// ---------------------------------------------------------
app.get("/stream/:id", (req, res) => {
    const query = streamMap.get(req.params.id);
    if (!query) return res.status(404).end();

    console.log(`🎵 STREAMING START: ${query}`);

    // Header tells Twilio "This is MP3 audio"
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked'
    });

    // 1. YT-DLP (SoundCloud Source)
    // -o - means "Output to Standard Out (Console)" so we can grab it
    const ytArgs = [
        `scsearch1:${query}`, // SoundCloud Search
        '-o', '-',            // Pipe output
        '-f', 'mp3',          // Format
        '--no-playlist',
        '--force-ipv4'
    ];

    const yt = spawn('yt-dlp', ytArgs);

    // 2. FFMPEG (Converter)
    // Converts whatever yt-dlp sends into a phone-friendly MP3 stream
    const ffmpegArgs = [
        '-i', 'pipe:0',       // Read from yt-dlp
        '-f', 'mp3',          // Output MP3
        '-ac', '1',           // Mono channel (faster)
        '-ar', '8000',        // 8000Hz (Phone quality, loads fast)
        'pipe:1'              // Send to response
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // 🔗 PIPE CHAIN: yt-dlp -> ffmpeg -> Twilio
    yt.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    // Logging
    yt.stderr.on('data', d => {
        const msg = d.toString();
        // Only show errors or download progress
        if(msg.includes('ERROR') || msg.includes('[download]')) console.log(`🔹 ${msg.trim()}`);
    });

    // Cleanup if phone hangs up
    req.on('close', () => {
        console.log("🛑 Call ended / Stream closed.");
        yt.kill();
        ffmpeg.kill();
    });
});

// ---------------------------------------------------------
// 📞 ROUTE: START
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    const caller = req.body.From;
    console.log(`📞 Call from: ${caller}`);

    if (!VERIFIED_CALLERS.includes(caller)) {
        console.log(`⛔ Blocked Caller: ${caller}`);
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); 

    const response = new VoiceResponse();
    response.say("Connected. Ask Gemini, or press Pound for music.");
    response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather", method: "POST", timeout: 5, bargeIn: true });
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE: MAIN GATHER
// ---------------------------------------------------------
app.post("/main-gather", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") { response.redirect("/twiml"); return res.type("text/xml").send(response.toString()); }
    if (digits === "#") { response.redirect("/music-mode"); return res.type("text/xml").send(response.toString()); }

    if (!userText) {
        response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
        return res.type("text/xml").send(response.toString());
    }

    const reply = await getGeminiResponse(session, userText);
    response.say(reply);
    response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC ENTRY
// ---------------------------------------------------------
app.post("/music-mode", (req, res) => {
    const response = new VoiceResponse();
    const gather = response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic", timeout: 5, bargeIn: true });
    gather.say("What song?"); 
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC LOGIC (Direct Stream)
// ---------------------------------------------------------
app.post("/music-logic", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") { response.redirect("/twiml"); return res.type("text/xml").send(response.toString()); }

    // 🕹️ Controls (4, 5, 6)
    let playQuery = null;

    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            response.say("No history.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }
        if (digits === "4" && session.index > 0) session.index--; 
        if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++; 

        playQuery = session.musicHistory[session.index];
    }
    // 🔍 New Search
    else if (userText) {
        playQuery = userText;
        session.musicHistory.push(userText);
        session.index = session.musicHistory.length - 1;
    }

    if (playQuery) {
        // Generate a unique ID for this specific stream
        const streamId = uuidv4();
        streamMap.set(streamId, playQuery);

        console.log(`🎵 Setup Stream for: ${playQuery}`);
        response.say(`Playing ${playQuery}`);
        
        // 🌊 DIRECT STREAMING (No waiting!)
        const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
        gather.play(`${BASE_URL}/stream/${streamId}`);
        
        response.redirect("/music-mode"); // Loop when done
    } else {
        response.say("Say a song name.");
        response.redirect("/music-mode");
    }

    res.type("text/xml").send(response.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
