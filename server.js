console.log("🚀 Starting Server: HASH KEY FIXED + MASTER BUILD...");

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
// ⚙️ SETTINGS
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://yt-dlp-gemini-ai-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    DATA_FILE: "/tmp/liked_songs.json",
    
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
        WELCOME: "Hello! Gemini AI is online. Press 1 to chat, 2 to type, or Hash for music.",
        MUSIC_MENU: "Music Mode. 1 to Search. 2 for Liked Songs. Controls: 5 Pause, Star for Options.",
        PAUSED: "Paused. Press 5 to resume.",
        RESUMING: "Resuming...",
        SAVED: "Saved.",
        REMOVED: "Removed.",
        EMPTY: "No liked songs yet.",
        T9_MODE: "Start typing. 1 separates letters. 0 is space. Star to send."
    }
};

// ==============================================================================
// 💾 DATABASE & UTILS
// ==============================================================================
function getLikedSongs() {
    if (!fs.existsSync(CONFIG.DATA_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(CONFIG.DATA_FILE)); } catch { return []; }
}
function saveLikedSong(title) {
    const list = getLikedSongs();
    if (!list.includes(title)) { list.push(title); fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(list)); }
}
function removeLikedSong(title) {
    let list = getLikedSongs();
    list = list.filter(t => t !== title);
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(list));
}

const KEYMAPS = { en: { '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl', '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz', '0': ' ' } };
function parseT9(digits, lang = 'en') {
    let result = "", currentGroup = "", lastKey = "";
    const map = KEYMAPS[lang];
    const decode = (grp, key) => {
        if (key === '0') return " ";
        if (!map[key]) return "";
        return map[key][(grp.length - 1) % map[key].length];
    };
    for (const char of digits) {
        if (char === '1') { if (currentGroup) result += decode(currentGroup, lastKey); currentGroup = ""; lastKey = ""; continue; }
        if (char !== lastKey) { if (currentGroup) result += decode(currentGroup, lastKey); currentGroup = char; lastKey = char; } 
        else { currentGroup += char; }
    }
    if (currentGroup) result += decode(currentGroup, lastKey);
    return result;
}

// ==============================================================================
// 🛠️ SESSION & FFMPEG UTILS
// ==============================================================================
const sessions = new Map();
const downloadQueue = new Map();

const getSession = (callSid) => {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, { 
            chatHistory: [], 
            t9Buffer: "",
            currentSong: null, 
            playStartTime: 0, 
            pausedAt: 0,      
            mode: "normal",
            likedIndex: 0
        });
    }
    return sessions.get(callSid);
};

async function sliceMp3(originalFilename, startSeconds) {
    return new Promise((resolve) => {
        const inputPath = path.join(CONFIG.DOWNLOAD_DIR, originalFilename);
        const newFilename = `resume_${Math.floor(startSeconds)}_${originalFilename}`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, newFilename);
        const args = ['-ss', String(startSeconds), '-i', inputPath, '-c', 'copy', '-y', outputPath];
        const child = spawn('ffmpeg', args);
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) resolve(newFilename);
            else resolve(null);
        });
    });
}

// ==============================================================================
// 🤖 CORE SERVICES
// ==============================================================================
async function askGemini(session, text) {
    if (CONFIG.GEMINI_KEYS.length === 0) return "No Keys.";
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: "Keep answers short." });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(text);
            return result.response.text();
        } catch (e) {}
    }
    return "Error.";
}

async function searchAndDownload(callSid, query, attempt = 1) {
    if (attempt === 1) downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    let args = [];
    if (attempt === 1) {
        args = [`scsearch10:${query}`, '--match-filter', 'duration > 60', '-I', '1', '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    } else {
        args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    }
    const child = spawn('yt-dlp', args);
    child.on('close', (code) => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id));
        if (found) {
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, title: query, filename: found });
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else {
            if (attempt === 1) searchAndDownload(callSid, query, 2);
            else downloadQueue.set(callSid, { status: 'error' });
        }
    });
}

// ==============================================================================
// 🚀 ROUTING
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("Gone");
});

// 1. MAIN MENU (HASH FIX APPLIED)
app.all("/twiml", (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    sessions.delete(req.body.CallSid);
    const r = new VoiceResponse();
    
    // 🛠️ FIX: finishOnKey="" tells Twilio to NOT treat '#' as 'Enter'.
    const g = r.gather({ 
        input: "dtmf", 
        numDigits: 1, 
        action: "/router", 
        timeout: 10, 
        bargeIn: true,
        finishOnKey: "" // <--- THIS SAVES THE # KEY
    });
    g.say(CONFIG.MESSAGES.WELCOME);
    
    r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

app.all("/router", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    
    // 🔍 Debugging log to confirm '#' is received
    console.log(`[Router] Digit received: ${d}`);

    if (d === "1") r.redirect("/voice-mode");      
    else if (d === "2") r.redirect("/t9-mode");    
    else if (d === "#") r.redirect("/music-mode"); 
    else r.redirect("/twiml");
    res.type("text/xml").send(r.toString());
});

// 2. VOICE & T9
app.all("/voice-mode", (req, res) => {
    const r = new VoiceResponse();
    r.play({ digits: "w" }); 
    r.gather({ input: "speech", action: "/voice-process", timeout: 4 });
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
    g.say("1 to speak. 0 menu.");
    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {
    const r = new VoiceResponse();
    const text = req.body.SpeechResult;
    if (text) {
        const reply = await askGemini(getSession(req.body.CallSid), text);
        r.say(reply);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
        g.say("1 reply. 2 type. Hash music.");
    } else r.redirect("/voice-mode");
    res.type("text/xml").send(r.toString());
});

app.all("/t9-mode", (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", action: "/t9-process", finishOnKey: "*", numDigits: 50, timeout: 15 });
    if (!getSession(req.body.CallSid).t9Buffer) g.say(CONFIG.MESSAGES.T9_MODE);
    res.type("text/xml").send(r.toString());
});

app.all("/t9-process", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);
    if (d) session.t9Buffer += d;
    const text = parseT9(session.t9Buffer, 'en');

    if (text.length > 0) {
        const reply = await askGemini(session, text);
        session.t9Buffer = ""; 
        r.say(reply);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/router", finishOnKey: "" });
        g.say("1 speak. 2 type.");
    } else r.redirect("/t9-mode");
    res.type("text/xml").send(r.toString());
});

// 3. MUSIC MODE
app.all("/music-mode", (req, res) => {
    const r = new VoiceResponse();
    // Also adding finishOnKey="" here just in case you use # for something else later
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-logic", timeout: 10, bargeIn: true, finishOnKey: "" });
    g.say(CONFIG.MESSAGES.MUSIC_MENU);
    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);

    if (d === "0") { r.redirect("/twiml"); return res.type("text/xml").send(r.toString()); }
    
    if (d === "1") {
        session.mode = "normal";
        r.say("Say song.");
        r.gather({ input: "speech", action: "/music-search", timeout: 4 });
        return res.type("text/xml").send(r.toString());
    }
    if (d === "2") {
        session.mode = "liked";
        const likes = getLikedSongs();
        if (likes.length === 0) { r.say(CONFIG.MESSAGES.EMPTY); r.redirect("/music-mode"); } 
        else {
            session.likedIndex = 0;
            searchAndDownload(req.body.CallSid, likes[0]);
            r.say(`Loading ${likes[0]}`);
            r.redirect("/music-wait-loop");
        }
        return res.type("text/xml").send(r.toString());
    }
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

app.all("/music-search", (req, res) => {
    const r = new VoiceResponse();
    const text = req.body.SpeechResult;
    if (text) {
        searchAndDownload(req.body.CallSid, text);
        r.say(CONFIG.MESSAGES.SEARCHING);
        r.redirect("/music-wait-loop");
    } else r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

// 4. PLAYER & PAUSE/RESUME
app.all("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    
    if (!dl) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        const session = getSession(req.body.CallSid);
        session.currentSong = { title: dl.title, url: dl.url, filename: dl.filename };
        session.playStartTime = Date.now(); 
        
        r.say(`Playing ${dl.title}`);
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-controls", bargeIn: true, finishOnKey: "" });
        g.play(dl.url);
        
        if (session.mode === "liked") r.redirect("/music-next-liked");
        else r.redirect("/music-mode");

    } else if (dl.status === 'error' || Date.now() - dl.startTime > 90000) {
        r.say("Failed.");
        downloadQueue.delete(req.body.CallSid);
        r.redirect("/music-mode");
    } else {
        r.pause({ length: 2 });
        r.redirect("/music-wait-loop");
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-controls", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);

    if (d === "5") {
        const now = Date.now();
        const playedMs = now - session.playStartTime;
        const totalPlayedSecs = (playedMs / 1000) + (session.pausedAt || 0);
        session.pausedAt = totalPlayedSecs; 
        
        r.say(CONFIG.MESSAGES.PAUSED);
        r.redirect("/music-pause-loop"); 
        return res.type("text/xml").send(r.toString());
    }

    if (d === "*") {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-options", finishOnKey: "" });
        g.say("4 Like. 6 Remove.");
        return res.type("text/xml").send(r.toString());
    }

    if (session.mode === "liked") {
        if (d === "6") { r.redirect("/music-next-liked"); return res.type("text/xml").send(r.toString()); }
        if (d === "4") { session.likedIndex = Math.max(0, session.likedIndex - 1); r.redirect("/music-play-liked"); return res.type("text/xml").send(r.toString()); }
    }
    r.redirect("/music-mode");
    res.type("text/xml").send(r.toString());
});

app.all("/music-pause-loop", (req, res) => {
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-resume", timeout: 20, finishOnKey: "" });
    g.pause({ length: 20 });
    r.redirect("/music-pause-loop");
    res.type("text/xml").send(r.toString());
});

app.all("/music-resume", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);
    
    if (d === "5" && session.currentSong) {
        r.say(CONFIG.MESSAGES.RESUMING);
        const newFilename = await sliceMp3(session.currentSong.filename, session.pausedAt);
        if (newFilename) {
            const newUrl = `${CONFIG.BASE_URL}/music/${newFilename}`;
            session.playStartTime = Date.now(); 
            const g = r.gather({ input: "dtmf", numDigits: 1, action: "/music-controls", bargeIn: true, finishOnKey: "" });
            g.play(newUrl);
            if (session.mode === "liked") r.redirect("/music-next-liked");
            else r.redirect("/music-mode");
        } else {
            r.say("Error.");
            r.redirect("/music-mode");
        }
    } else {
        r.redirect("/music-pause-loop");
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-options", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getSession(req.body.CallSid);

    if (d === "4" && session.currentSong) {
        saveLikedSong(session.currentSong.title);
        r.say(CONFIG.MESSAGES.SAVED);
    } else if (d === "6" && session.currentSong) {
        removeLikedSong(session.currentSong.title);
        r.say(CONFIG.MESSAGES.REMOVED);
    }
    r.redirect("/music-resume?Digits=5");
    res.type("text/xml").send(r.toString());
});

app.all("/music-next-liked", (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const likes = getLikedSongs();
    session.likedIndex++;
    if (session.likedIndex >= likes.length) session.likedIndex = 0; 
    r.redirect("/music-play-liked");
    res.type("text/xml").send(r.toString());
});

app.all("/music-play-liked", (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const likes = getLikedSongs();
    if (likes.length === 0) { r.redirect("/music-mode"); return res.type("text/xml").send(r.toString()); }
    searchAndDownload(req.body.CallSid, likes[session.likedIndex]);
    r.say(`Loading ${likes[session.likedIndex]}`);
    r.redirect("/music-wait-loop");
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online on Port ${CONFIG.PORT}`));
