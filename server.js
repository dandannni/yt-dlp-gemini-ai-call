console.log("🚀 Starting Server: Gemini 2.5 Flash + Optimized Audio...");

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
// 📝 LOGGING SYSTEM
// ---------------------------------------------------------
const logBuffer = [];
const MAX_LOGS = 200;

function addToLog(type, args) {
    try {
        const msg = args.map(a => {
            if (a instanceof Error) return a.message + '\n' + a.stack;
            if (typeof a === 'object') return JSON.stringify(a);
            return String(a);
        }).join(' ');

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        // Clean logs
        const cleanMsg = msg.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '');

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
        <html><head><title>Bot Logs</title>
        <meta http-equiv="refresh" content="2">
        <style>body{background:#111;color:#0f0;font-family:monospace;padding:10px;font-size:12px;}</style>
        </head><body><h3>📜 System Logs</h3><pre>${logBuffer.join("\n")}</pre></body></html>
    `);
});

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.resolve(DOWNLOAD_DIR, req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File deleted or not found");
    }

    const stat = fs.statSync(filePath);
    // Explicit headers are crucial for Twilio stability
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': stat.size
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
});

// 🧠 STATE MANAGEMENT
const sessions = new Map();
const downloadQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC (2.5 Flash)
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            // ⚡ UPDATED TO GEMINI 2.5 FLASH
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash", 
                systemInstruction: "You are a witty phone assistant. Keep answers brief (max 2 sentences). If the user asks for music or songs, explicitly tell them to 'Press Hash'.",
            });

            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const text = result.response.text();

            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: text }] });
            return text;
        } catch (error) {
            console.error(`⚠️ Key ${i + 1} Error: ${error.message}`);
        }
    }
    return "I'm having a bit of a headache right now. Try again later.";
}

// ---------------------------------------------------------
// 🎵 DOWNLOAD LOGIC (Optimization Fix)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Queue] Request: "${query}"`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // 🛠 AUDIO FIX:
    // scsearch1: SoundCloud is faster/safer than YouTube
    // -ac 1: Convert to Mono (smaller file)
    // -ar 16000: Convert to 16kHz (phone quality, downloads 4x faster)
    const args = [
        `scsearch1:${query}`,
        '-x',
        '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', 
        '--no-playlist',
        '--force-ipv4',
        '-o', outputTemplate
    ];

    const child = spawn('yt-dlp', args);

    child.on('close', (code) => {
        if (code === 0) {
            console.log(`✅ [Ready] ${query} -> ${filename}`);
            downloadQueue.set(callSid, {
                status: 'done',
                url: `${BASE_URL}/music/${filename}`,
                title: query,
                filename: filename
            });

            // Cleanup after 10 mins
            setTimeout(() => {
                if (fs.existsSync(path.join(DOWNLOAD_DIR, filename))) fs.unlinkSync(path.join(DOWNLOAD_DIR, filename));
            }, 600000);
        } else {
            console.error(`🚨 [Fail] Exit Code: ${code}`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ---------------------------------------------------------
// 📞 ROUTE: INCOMING CALL
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    const caller = req.body.From;
    console.log(`📞 Incoming: ${caller}`);

    if (!VERIFIED_CALLERS.includes(caller)) {
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid);

    const r = new VoiceResponse();
    r.say("System Online. Speak to Gemini, or press Pound for music.");
    r.gather({ input: "speech dtmf", numDigits: 1, action: "/main-gather", method: "POST", timeout: 5, bargeIn: true });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE: CONVERSATION HANDLER
// ---------------------------------------------------------
app.post("/main-gather", async (req, res) => {
    const r = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }
    if (digits === "#") { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (!userText) {
        r.gather({ input: "speech dtmf", numDigits: 1, action: "/main-gather" });
        return res.type("text/xml").send(r.toString());
    }

    const reply = await getGeminiResponse(session, userText);
    r.say(reply);
    r.gather({ input: "speech dtmf", numDigits: 1, action: "/main-gather", timeout: 5 });
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC MENU
// ---------------------------------------------------------
app.post("/music-mode", (req, res) => {
    const r = new VoiceResponse();
    const gather = r.gather({ input: "speech dtmf", numDigits: 1, action: "/music-logic", timeout: 5, bargeIn: true });
    gather.say("Music Mode. Name a song.");
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC PROCESSOR
// ---------------------------------------------------------
app.post("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }

    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            r.say("History empty.");
            r.redirect("/music-mode");
            return res.type("text/xml").send(r.toString());
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

    if (userText) {
        startDownload(callSid, userText);
        r.say("Searching SoundCloud...");
        r.redirect("/music-wait-loop"); 
        return res.type("text/xml").send(r.toString());
    }

    r.say("I didn't catch that.");
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🔄 ROUTE: THE POLLING LOOP
// ---------------------------------------------------------
app.post("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const callSid = req.body.CallSid;
    const dl = downloadQueue.get(callSid);

    if (!dl) {
        r.say("Session lost.");
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (Date.now() - dl.startTime > 60000) {
        r.say("Search timed out.");
        downloadQueue.delete(callSid);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'pending') {
        r.pause({ length: 2 });
        r.redirect("/music-wait-loop");
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'error') {
        r.say("I couldn't download that song.");
        downloadQueue.delete(callSid);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'done') {
        const session = getSession(callSid);
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
