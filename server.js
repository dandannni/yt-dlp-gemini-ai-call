console.log("🚀 Starting Server with Real-Time Progress Logs...");
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
// 📝 LIVE LOGGING SYSTEM
// ---------------------------------------------------------
const logBuffer = [];
const MAX_LOGS = 200;
function addToLog(type, args) {
try {
const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
code
Code
// Clean up yt-dlp progress bars to avoid messy logs
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
else console.log(✅ Loaded ${GEMINI_KEYS.length} Gemini Keys.);
const VERIFIED_CALLERS = [
"+972548498889",
"+972554402506",
"+972525585720",
"+972528263032",
"+972583230268"
];
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || http://localhost:${PORT};
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
// 🕵️ LOG PAGE (Auto-Refresh every 1 second)
// ---------------------------------------------------------
app.get("/logs", (req, res) => {
if (req.query.pwd !== "1234") return res.status(403).send("🚫 Access Denied.");
res.send(<html><head><title>Logs</title> <meta http-equiv="refresh" content="1">  <style>body{background:#111;color:#0f0;font-family:monospace;padding:10px;font-size:12px;}</style> </head><body><h3>📜 Live Logs</h3><pre>${logBuffer.join("\n")}</pre></body></html>);
});
// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
const filePath = path.resolve(DOWNLOAD_DIR, req.params.filename);
if (!fs.existsSync(filePath)) return res.status(404).send("File deleted or not found");
code
Code
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
console.error(⚠️ Key ${i + 1} Failed: ${error.message});
}
}
return "Sorry, I am having trouble connecting to the servers.";
}
// ---------------------------------------------------------
// 🎵 DOWNLOAD LOGIC (REAL-TIME LOGS + SOUNDCLOUD)
// ---------------------------------------------------------
async function startDownload(callSid, query) {
console.log(🎵 [Start] Downloading: "${query}");
downloadQueue.set(callSid, { status: 'pending' });
code
Code
const uniqueId = uuidv4();
const filename = `${uniqueId}.mp3`;
const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

// Using scsearch1 (SoundCloud) to avoid blocking
const args = [
    `scsearch1:${query}`, 
    '-x', 
    '--audio-format', 'mp3', 
    '--no-playlist', 
    '--force-ipv4', 
    '-o', outputTemplate
];

const child = spawn('yt-dlp', args);

// Stream logs
child.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('[download]') || line.includes('%')) {
        console.log(`🔹 ${line}`);
    }
});

child.stderr.on('data', (data) => {
    const line = data.toString().trim();
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
            title: query
        });
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
const caller = req.body.From;
console.log(📞 Call from: ${caller});
code
Code
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
code
Code
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
// 🎵 ROUTE: MUSIC PROCESS
// ---------------------------------------------------------
app.post("/music-process", async (req, res) => {
const response = new VoiceResponse();
const callSid = req.body.CallSid;
const digits = req.body.Digits;
const userText = req.body.SpeechResult;
const session = getSession(callSid);
code
Code
if (digits === "0") { response.redirect("/twiml"); return res.type("text/xml").send(response.toString()); }

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

if (userText) {
    startDownload(callSid, userText); // Start Background Download
    
    response.say("Searching...");
    response.redirect("/music-check-status"); // Go to Loop
    return res.type("text/xml").send(response.toString());
}

response.say("Say a song name.");
response.redirect("/music-mode");
res.type("text/xml").send(response.toString());
});
// ---------------------------------------------------------
// 🔄 ROUTE: WAIT LOOP
// ---------------------------------------------------------
app.post("/music-check-status", (req, res) => {
const response = new VoiceResponse();
const callSid = req.body.CallSid;
const download = downloadQueue.get(callSid);
code
Code
if (!download) {
    response.say("Error.");
    response.redirect("/music-mode");
    return res.type("text/xml").send(response.toString());
}

if (download.status === 'pending') {
    response.pause({ length: 3 }); // Wait 3s
    response.redirect("/music-check-status"); // Loop
    return res.type("text/xml").send(response.toString());
}

if (download.status === 'error') {
    response.say("Download failed.");
    downloadQueue.delete(callSid);
    response.redirect("/music-mode");
    return res.type("text/xml").send(response.toString());
}

if (download.status === 'done') {
    const session = getSession(callSid);
    session.musicHistory.push({ title: download.title, url: download.url });
    session.index = session.musicHistory.length - 1;

    response.say(`Playing ${download.title}`);
    const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
    gather.play(download.url);
    
    downloadQueue.delete(callSid);
    response.redirect("/music-mode");
    return res.type("text/xml").send(response.toString());
}
});
app.listen(PORT, () => console.log(🚀 Server running on ${PORT}));
