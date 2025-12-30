console.log("🚀 Starting STABLE Server (Download + Wait Loop)...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { exec } from "child_process"; 
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ---------------------------------------------------------
// 📝 LOGGING
// ---------------------------------------------------------
const logBuffer = [];
function addToLog(type, args) {
    try {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const line = `[${time}] [${type}] ${msg}`;
        logBuffer.push(line);
        if (logBuffer.length > 100) logBuffer.shift(); 
        process.stdout.write(line + '\n');
    } catch (e) {}
}
console.log = (...args) => addToLog("INFO", args);
console.error = (...args) => addToLog("ERROR", args);

// ---------------------------------------------------------
// 🔐 CONFIGURATION
// ---------------------------------------------------------
// Fallback to Gemini Pro if Flash fails, or use Pro directly to fix 404
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2
].filter(key => key); 

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

// Twilio Setup
const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 🧠 STATE MANAGEMENT
const sessions = new Map();
const downloadQueue = new Map(); // Tracks download status: 'pending', 'done', 'error'

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 GEMINI LOGIC (Reverted to 'gemini-pro' for stability)
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_KEYS[i]);
            // Using standard 'gemini-pro' to fix your 404 error
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const text = result.response.text();
            
            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: text }] });
            return text;
        } catch (error) {
            console.error(`⚠️ AI Error (Key ${i+1}): ${error.message}`);
        }
    }
    return "I am having trouble thinking right now.";
}

// ---------------------------------------------------------
// 🎵 BACKGROUND DOWNLOADER (SoundCloud)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Start] Downloading: "${query}"`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // Using SoundCloud (scsearch1) - Fast & Reliable
    const command = `yt-dlp "scsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 -o "${outputTemplate}"`;

    exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
            console.error("🚨 Download Error:", stderr);
            downloadQueue.set(callSid, { status: 'error' });
            return;
        }
        
        console.log("✅ Download Finished.");
        downloadQueue.set(callSid, { 
            status: 'done', 
            url: `${BASE_URL}/music/${filename}`,
            title: query,
            path: path.join(DOWNLOAD_DIR, filename)
        });

        // Cleanup after 10 mins
        setTimeout(() => {
            const f = path.join(DOWNLOAD_DIR, filename);
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }, 600000); 
    });
}

// ---------------------------------------------------------
// 📂 FILE SERVER
// ---------------------------------------------------------
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        // Send correct headers so Twilio accepts it
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': stat.size
        });
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
    } else {
        res.status(404).send("Not found");
    }
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
// 🎵 ROUTE: MUSIC LOGIC (Start Download)
// ---------------------------------------------------------
app.post("/music-logic", async (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const digits = req.body.Digits;
    const text = req.body.SpeechResult;
    const session = getSession(sid);

    if (digits === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }

    // 🕹️ Controls
    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            r.say("No history."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
        }
        if (digits === "4" && session.index > 0) session.index--; 
        if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++; 
        
        // Instant Replay (File already downloaded)
        const song = session.musicHistory[session.index];
        r.say(`Playing ${song.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic" });
        g.play(song.url);
        r.redirect("/music-mode");
        return res.type("text/xml").send(r.toString());
    }

    // 🔍 New Search
    if (text) {
        startDownload(sid, text); // Start in background
        r.say("Searching...");
        r.redirect("/music-wait"); // Go to Wait Loop
        return res.type("text/xml").send(r.toString());
    }

    r.say("Say a song name.");
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// ---------------------------------------------------------
// 🔄 ROUTE: WAIT LOOP (The Safety Net)
// ---------------------------------------------------------
app.post("/music-wait", (req, res) => {
    const r = new VoiceResponse();
    const sid = req.body.CallSid;
    const dl = downloadQueue.get(sid);

    if (!dl) {
        r.say("Error."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
    }

    // 1. Still Downloading? -> Wait 2 seconds, check again
    if (dl.status === 'pending') {
        // If it takes too long (> 60s), give up
        if (Date.now() - dl.startTime > 60000) {
            r.say("Took too long."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
        }
        
        r.pause({ length: 2 });
        r.redirect("/music-wait"); // Loop back
        return res.type("text/xml").send(r.toString());
    }

    // 2. Error?
    if (dl.status === 'error') {
        r.say("Download failed."); r.redirect("/music-mode"); return res.type("text/xml").send(r.toString());
    }

    // 3. Done? -> Play!
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

// LOGS PAGE
app.get("/logs", (req, res) => {
    if(req.query.pwd!=="1234") return res.status(403).end();
    res.send(`<pre>${logBuffer.join("\n")}</pre><meta http-equiv="refresh" content="2">`);
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
