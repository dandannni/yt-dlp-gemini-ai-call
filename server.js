console.log("🚀 Starting Server: Friendly Mode + Hash Fix...");

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
// 📝 LOGGING (Debug Mode)
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

const VERIFIED_CALLERS = [
    "+972548498889",
    "+972554402506",
    "+972525585720",
    "+972528263032",
    "+972583230268"
];

const PORT = process.env.PORT || 3000;
// We use a Relative Path strategy now (Safer for Render)
const BASE_URL = process.env.RENDER_EXTERNAL_URL || ""; 
const DOWNLOAD_DIR = "/tmp";

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
// 🤖 GEMINI LOGIC (2.5 Flash)
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    if (GEMINI_KEYS.length === 0) return "Configuration error. No API keys.";
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash", 
                systemInstruction: "You are a helpful phone assistant. Keep answers short (1-2 sentences). If asked for music, say 'Press hash'.",
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
    return "I am having trouble connecting to the brain. Please try again.";
}

// ---------------------------------------------------------
// 🎵 DOWNLOAD LOGIC (Mono/16k Optimization)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Download Start] ${query}`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    const args = [
        `scsearch1:${query}`,
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', // Small, fast file
        '--no-playlist', '--force-ipv4', '-o', outputTemplate
    ];

    const child = spawn('yt-dlp', args);

    child.on('close', (code) => {
        if (code === 0) {
            console.log(`✅ [Download Done] ${filename}`);
            // Construct Full URL for Playback
            const host = BASE_URL || `https://localhost:${PORT}`; // Fallback if env missing
            downloadQueue.set(callSid, {
                status: 'done',
                url: `${host}/music/${filename}`,
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
// Using app.all to handle both GET/POST (fixes Redirect bugs)
app.all("/twiml", (req, res) => {
    try {
        const caller = req.body.From;
        console.log(`📞 [Incoming] From: ${caller}`);

        if (!VERIFIED_CALLERS.includes(caller)) {
            const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString());
        }

        sessions.delete(req.body.CallSid);
        const r = new VoiceResponse();
        
        // 👋 NEW CHEERFUL MESSAGE
        r.say("Hello! I am your AI assistant. You can ask me anything, or press the Hash key to play music.");
        
        // 🔧 THE FIX: finishOnKey="" ensures '#' is treated as a digit, not 'Enter'
        r.gather({ 
            input: "speech dtmf", 
            numDigits: 1, 
            finishOnKey: "", 
            action: "/main-gather", 
            method: "POST", 
            timeout: 5,
            bargeIn: true
        });
        
        res.type("text/xml").send(r.toString());
    } catch (e) {
        console.error("CRASH /twiml:", e);
        res.status(500).send(e.toString());
    }
});

// ---------------------------------------------------------
// 📞 ROUTE: MAIN GATHER (The Chat)
// ---------------------------------------------------------
app.all("/main-gather", async (req, res) => {
    try {
        const r = new VoiceResponse();
        const callSid = req.body.CallSid;
        const digits = req.body.Digits;
        const userText = req.body.SpeechResult;
        const session = getSession(callSid);

        console.log(`📝 [Main Gather] Digits: "${digits}" | Speech: "${userText}"`);

        // #️⃣ DETECT HASH KEY
        if (digits === "#") { 
            console.log("🔀 User pressed #. Redirecting to Music Mode...");
            r.redirect("/music-mode"); 
            return res.type("text/xml").send(r.toString()); 
        }

        if (!userText && !digits) {
            console.log("🤔 Silence. Listening again.");
            r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
            return res.type("text/xml").send(r.toString());
        }

        // 🤖 AI REPLY
        const reply = await getGeminiResponse(session, userText);
        console.log(`🤖 AI: ${reply}`);
        r.say(reply);
        r.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
        
        res.type("text/xml").send(r.toString());

    } catch (e) {
        console.error("CRASH /main-gather:", e);
        const r = new VoiceResponse(); r.say("System error."); res.type("text/xml").send(r.toString());
    }
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC MODE
// ---------------------------------------------------------
app.all("/music-mode", (req, res) => {
    try {
        console.log("🎵 [Music Mode] Menu.");
        const r = new VoiceResponse();
        const gather = r.gather({ 
            input: "speech dtmf", 
            numDigits: 1, 
            finishOnKey: "", 
            action: "/music-logic", 
            timeout: 5, 
            bargeIn: true 
        });
        gather.say("Music Mode. Name a song.");
        res.type("text/xml").send(r.toString());
    } catch (e) {
        console.error("CRASH /music-mode:", e);
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

        if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }

        // Controls
        if (["4", "5", "6"].includes(digits)) {
            if (session.musicHistory.length === 0) {
                r.say("No history."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
            }
            if (digits === "4" && session.index > 0) session.index--;
            if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++;
            
            const song = session.musicHistory[session.index];
            r.say(`Playing ${song.title}`);
            const g = r.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
            g.play(song.url);
            r.redirect("/music-mode");
            return res.type("text/xml").send(r.toString());
        }

        // New Search
        if (userText) {
            startDownload(callSid, userText);
            r.say("Searching...");
            r.redirect("/music-wait-loop");
            return res.type("text/xml").send(r.toString());
        }

        r.say("I didn't catch that.");
        r.redirect("/music-mode");
        res.type("text/xml").send(r.toString());
    } catch (e) { console.error("CRASH /music-logic:", e); }
});

// ---------------------------------------------------------
// 🔄 ROUTE: WAIT LOOP
// ---------------------------------------------------------
app.all("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const callSid = req.body.CallSid;
    const dl = downloadQueue.get(callSid);

    if (!dl) { r.say("Session lost."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const session = getSession(callSid);
        session.musicHistory.push({ title: dl.title, url: dl.url });
        session.index = session.musicHistory.length - 1;

        r.say(`Playing ${dl.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-logic" });
        g.play(dl.url);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        r.say("Failed."); downloadQueue.delete(callSid); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
    }

    r.pause({ length: 2 });
    r.redirect("/music-wait-loop");
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
