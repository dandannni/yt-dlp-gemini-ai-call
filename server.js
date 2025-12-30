console.log("🚀 Starting Debug Server (Verbose Logs + HTTPS Fix)...");

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
// 📝 LOGGING (Now prints EVERYTHING)
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
        // Clean formatting
        const cleanMsg = msg.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '');

        const logLine = `[${timestamp}] [${type}] ${cleanMsg}`;
        logBuffer.push(logLine);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift();

        // Force write to stdout so Render captures it
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

const VERIFIED_CALLERS = [
    "+972548498889",
    "+972554402506",
    "+972525585720",
    "+972528263032",
    "+972583230268"
];

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = "/tmp";

// 🌍 CRITICAL: Force HTTPS URL
// Render sets RENDER_EXTERNAL_URL automatically. We use it to ensure Twilio doesn't get 301 Redirected.
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `https://localhost:${PORT}`;

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------
// 📂 AUDIO SERVER
// ---------------------------------------------------------
app.get("/music/:filename", (req, res) => {
    const filePath = path.resolve(DOWNLOAD_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
});

// 🧠 SESSION
const sessions = new Map();
const downloadQueue = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    // Safety check for empty keys
    if (GEMINI_KEYS.length === 0) return "Configuration error. No API keys.";

    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash", // ⚠️ If this model doesn't exist yet, it will fail to catch block
                systemInstruction: "You are a phone assistant. Keep answers short.",
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const text = result.response.text();
            
            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: text }] });
            return text;
        } catch (error) {
            console.error(`⚠️ Key ${i + 1} Error: ${error.message}`);
            if (i === GEMINI_KEYS.length - 1) return "I'm having trouble thinking. Please try again.";
        }
    }
}

// ---------------------------------------------------------
// 🎵 DOWNLOAD LOGIC
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Download Start] ${query}`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // Using SoundCloud + Mono/16k optimization
    const args = [
        `scsearch1:${query}`,
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
        '--no-playlist', '--force-ipv4', '-o', outputTemplate
    ];

    const child = spawn('yt-dlp', args);

    child.on('close', (code) => {
        if (code === 0) {
            console.log(`✅ [Download Done] ${filename}`);
            downloadQueue.set(callSid, {
                status: 'done',
                url: `${BASE_URL}/music/${filename}`, // Uses HTTPS URL
                title: query
            });
            setTimeout(() => { if (fs.existsSync(path.join(DOWNLOAD_DIR, filename))) fs.unlinkSync(path.join(DOWNLOAD_DIR, filename)); }, 600000);
        } else {
            console.error(`🚨 [Download Fail] Code: ${code}`);
            downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ---------------------------------------------------------
// 📞 ROUTE: START (/twiml)
// ---------------------------------------------------------
app.all("/twiml", (req, res) => {
    try {
        const caller = req.body.From;
        console.log(`📞 [Incoming] From: ${caller}`);

        if (!VERIFIED_CALLERS.includes(caller)) {
            console.warn("⛔ Blocked.");
            const r = new VoiceResponse(); r.reject(); 
            return res.type("text/xml").send(r.toString());
        }

        sessions.delete(req.body.CallSid);
        const r = new VoiceResponse();
        r.say("Connected.");
        // ACTION uses BASE_URL to prevent redirect errors
        r.gather({ input: "speech dtmf", numDigits: 1, action: `${BASE_URL}/main-gather`, method: "POST", timeout: 5 });
        
        res.type("text/xml").send(r.toString());
    } catch (e) {
        console.error("CRASH in /twiml:", e);
        res.status(500).send(e.toString());
    }
});

// ---------------------------------------------------------
// 📞 ROUTE: MAIN GATHER (Where # is pressed)
// ---------------------------------------------------------
app.all("/main-gather", async (req, res) => {
    try {
        console.log(`📝 [Main Gather] Digits: ${req.body.Digits} | Speech: ${req.body.SpeechResult}`);
        
        const r = new VoiceResponse();
        const callSid = req.body.CallSid;
        const digits = req.body.Digits;
        const userText = req.body.SpeechResult;
        const session = getSession(callSid);

        // 🟢 THE REDIRECT FIX: Use absolute URL
        if (digits === "#") { 
            console.log("🔀 Redirecting to Music Mode...");
            r.redirect(`${BASE_URL}/music-mode`); 
            return res.type("text/xml").send(r.toString()); 
        }

        if (!userText) {
            console.log("🤔 No input, listening again.");
            r.gather({ input: "speech dtmf", numDigits: 1, action: `${BASE_URL}/main-gather` });
            return res.type("text/xml").send(r.toString());
        }

        const reply = await getGeminiResponse(session, userText);
        console.log(`🤖 AI Reply: ${reply}`);
        r.say(reply);
        r.gather({ input: "speech dtmf", numDigits: 1, action: `${BASE_URL}/main-gather` });
        
        res.type("text/xml").send(r.toString());

    } catch (e) {
        console.error("🚨 CRASH in /main-gather:", e);
        const r = new VoiceResponse();
        r.say("System Error.");
        res.type("text/xml").send(r.toString());
    }
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC MODE (The previously invisible crash)
// ---------------------------------------------------------
app.all("/music-mode", (req, res) => {
    try {
        console.log("🎵 [Music Mode] Entered."); // <--- THIS WILL NOW SHOW IN LOGS
        
        const r = new VoiceResponse();
        const gather = r.gather({ 
            input: "speech dtmf", 
            numDigits: 1, 
            action: `${BASE_URL}/music-logic`, // Absolute URL
            timeout: 5, 
            bargeIn: true 
        });
        gather.say("Music Mode. Name a song.");
        
        console.log("🎵 [Music Mode] Sending TwiML...");
        res.type("text/xml").send(r.toString());
    } catch (e) {
        console.error("🚨 CRASH in /music-mode:", e);
        res.status(500).send("Error");
    }
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC LOGIC
// ---------------------------------------------------------
app.all("/music-logic", async (req, res) => {
    try {
        const r = new VoiceResponse();
        const callSid = req.body.CallSid;
        const digits = req.body.Digits;
        const userText = req.body.SpeechResult;
        const session = getSession(callSid);

        console.log(`🎵 [Music Logic] Input: ${digits || userText}`);

        if (digits === "0") { r.redirect(`${BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

        if (["4", "5", "6"].includes(digits)) {
            // ... (History controls same as before)
            if (session.musicHistory.length === 0) {
                r.say("No history."); r.redirect(`${BASE_URL}/music-mode`); return res.type("text/xml").send(r.toString());
            }
            if (digits === "4" && session.index > 0) session.index--;
            if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++;
            
            const song = session.musicHistory[session.index];
            r.say(`Playing ${song.title}`);
            const g = r.gather({ input: "dtmf", numDigits: 1, action: `${BASE_URL}/music-logic` });
            g.play(song.url);
            r.redirect(`${BASE_URL}/music-mode`);
            return res.type("text/xml").send(r.toString());
        }

        if (userText) {
            startDownload(callSid, userText);
            r.say("Searching...");
            r.redirect(`${BASE_URL}/music-wait-loop`);
            return res.type("text/xml").send(r.toString());
        }

        r.say("Say a song name.");
        r.redirect(`${BASE_URL}/music-mode`);
        res.type("text/xml").send(r.toString());

    } catch (e) {
        console.error("🚨 CRASH in /music-logic:", e);
        const r = new VoiceResponse(); r.say("Error."); res.type("text/xml").send(r.toString());
    }
});

// ---------------------------------------------------------
// 🔄 ROUTE: WAIT LOOP
// ---------------------------------------------------------
app.all("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const callSid = req.body.CallSid;
    const dl = downloadQueue.get(callSid);

    if (!dl) { r.say("Session lost."); r.redirect(`${BASE_URL}/music-mode`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const session = getSession(callSid);
        session.musicHistory.push({ title: dl.title, url: dl.url });
        session.index = session.musicHistory.length - 1;

        r.say(`Playing ${dl.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${BASE_URL}/music-logic` });
        g.play(dl.url);
        r.redirect(`${BASE_URL}/music-mode`);
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        r.say("Failed."); downloadQueue.delete(callSid); r.redirect(`${BASE_URL}/music-mode`); return res.type("text/xml").send(r.toString());
    }

    // Still pending
    r.pause({ length: 2 });
    r.redirect(`${BASE_URL}/music-wait-loop`);
    return res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🕵️ LOG PAGE
// ---------------------------------------------------------
app.get("/logs", (req, res) => {
    if (req.query.pwd !== "1234") return res.status(403).send("Denied");
    res.send(`<html><meta http-equiv="refresh" content="2"><body style="background:#000;color:#0f0;font-family:monospace"><pre>${logBuffer.join("\n")}</pre></body></html>`);
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
