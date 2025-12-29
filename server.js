console.log("🚀 Starting Server with 'Please Wait' Loop...");

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
// 🔄 DOWNLOAD QUEUE (To fix the 15s Timeout)
// ---------------------------------------------------------
// Stores the status of downloads: 'pending', 'done', or 'error'
const downloadQueue = new Map(); 

// ---------------------------------------------------------
// 📝 LOGGING
// ---------------------------------------------------------
const logBuffer = [];
const MAX_LOGS = 100;
function addToLog(type, args) {
    try {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const logLine = `[${timestamp}] [${type}] ${msg}`;
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
    res.send(`<html><head><title>Logs</title><meta http-equiv="refresh" content="2"><style>body{background:#111;color:#0f0;font-family:monospace;padding:10px;}</style></head><body><h3>📜 Live Logs</h3><pre>${logBuffer.join("\n")}</pre></body></html>`);
});

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send("File deleted or not found");
});

// 🧠 SESSION STORAGE
const sessions = new Map();

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
// 🎵 DOWNLOAD LOGIC (SoundCloud - Async)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
    console.log(`🎵 [Background] Starting download for: "${query}"`);
    
    // Set status to PENDING
    downloadQueue.set(callSid, { status: 'pending' });

    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // Using SoundCloud because it's faster and doesn't block
    const command = `yt-dlp "scsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 -o "${outputTemplate}"`;

    exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
            console.error("🚨 Download Error:", stderr);
            downloadQueue.set(callSid, { status: 'error' });
            return;
        }
        
        // Success! Update the queue
        console.log("✅ Download finished in background.");
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
    });
}

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
    const gather = response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/music-process", timeout: 5, bargeIn: true });
    gather.say("What song?"); 
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE: MUSIC PROCESS (Starts Download)
// ---------------------------------------------------------
app.post("/music-process", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") { response.redirect("/twiml"); return res.type("text/xml").send(response.toString()); }

    // 🕹️ History Controls
    if (["4", "5", "6"].includes(digits)) {
        if (session.musicHistory.length === 0) {
            response.say("No history.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }
        if (digits === "4" && session.index > 0) session.index--; 
        if (digits === "6" && session.index < session.musicHistory.length - 1) session.index++; 

        const song = session.musicHistory[session.index];
        response.say(`Playing ${song.title}`);
        const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
        gather.play(song.url);
        response.redirect("/music-mode"); 
        return res.type("text/xml").send(response.toString());
    }

    // 🔍 New Search
    if (userText) {
        // 1. Start download in BACKGROUND (do not await)
        startDownload(callSid, userText);
        
        // 2. Tell Twilio to wait and check status
        response.say("Searching...");
        response.redirect("/music-check-status"); // Go to loop
        return res.type("text/xml").send(response.toString());
    }

    response.say("Say a song name.");
    response.redirect("/music-mode");
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🔄 ROUTE: CHECK STATUS LOOP
// ---------------------------------------------------------
app.post("/music-check-status", (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    
    const download = downloadQueue.get(callSid);

    // If no download found (weird error), go back
    if (!download) {
        response.say("Error finding download.");
        response.redirect("/music-mode");
        return res.type("text/xml").send(response.toString());
    }

    // CASE 1: Still Downloading -> Wait 2 seconds and ask again
    if (download.status === 'pending') {
        // Play 2 seconds of silence (or a ticking sound)
        response.pause({ length: 2 });
        // Loop back to this same route
        response.redirect("/music-check-status");
        return res.type("text/xml").send(response.toString());
    }

    // CASE 2: Error
    if (download.status === 'error') {
        response.say("Sorry, the download failed.");
        downloadQueue.delete(callSid); // Cleanup
        response.redirect("/music-mode");
        return res.type("text/xml").send(response.toString());
    }

    // CASE 3: Done!
    if (download.status === 'done') {
        const session = getSession(callSid);
        
        // Add to history
        session.musicHistory.push({ title: download.title, url: download.url });
        session.index = session.musicHistory.length - 1;

        response.say(`Playing ${download.title}`);
