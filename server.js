// ==============================================================================
// 🚀 VOICE OS: THE ULTIMATE EDITION (CHAT, MUSIC, PODCASTS, NEWS, FFMPEG PLAYER)
// ==============================================================================
console.log("🚀 Starting Voice OS: MASTER EDITION...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { MongoClient } from "mongodb";
import RSSParser from "rss-parser";

dotenv.config();
const VoiceResponse = twilio.twiml.VoiceResponse;
const rssParser = new RSSParser();

// ==============================================================================
// 💾 MONGODB CLOUD DATABASE
// ==============================================================================
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let usersCol;

async function connectDB() {
    try {
        await mongoClient.connect();
        usersCol = mongoClient.db("VoiceOS").collection("users");
        console.log("✅ MongoDB Connected!");
    } catch (err) { console.error("❌ MongoDB Error:", err); }
}
connectDB();

async function getUser(phone) {
    let user = await usersCol.findOne({ phone: phone });
    if (!user) {
        user = { phone, music_history: [], chat_history: [], likes: [], settings: { chat_voice: 'he-IL-HilaNeural', search_engine: 'scsearch1:' } };
        await usersCol.insertOne(user);
    }
    return user;
}
async function updateUser(phone, updateQuery) { await usersCol.updateOne({ phone }, updateQuery); }

// ==============================================================================
// ⚙️ SYSTEM CONFIG & IN-MEMORY PLAYER STATE
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    VERIFIED_CALLERS: ["+972548498889", "+972554402506", "+972525585720", "+972528263032", "+972583230268"],
    GEMINI_KEYS: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(k => k)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);
function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

// The Player State tracks where you are in a song/podcast so you can pause & fast-forward
const activeCalls = new Map(); 
function getCallState(callSid) {
    if (!activeCalls.has(callSid)) activeCalls.set(callSid, { mode: null, offset: 0, startTime: 0, fileUrl: null, isPodcast: false, isPaused: false, playlist: [], playlistIndex: 0 });
    return activeCalls.get(callSid);
}

// ==============================================================================
// 🔊 AUDIO ENGINE (TTS & FFMPEG STREAMING)
// ==============================================================================
async function generateFreeTTS(text, forceVoice = null) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        const voice = forceVoice || (isHebrewText(safeText) ? 'he-IL-HilaNeural' : 'en-US-ChristopherNeural');
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 300000);
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

// Helper to play menu TTS
async function gatherPlayOrSay(r, text, actionUrl, timeoutVal, voice = null) {
    const ttsFilename = await generateFreeTTS(text, voice);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: actionUrl, method: "POST", timeout: timeoutVal });
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/temp-audio/${ttsFilename}`);
    else g.say(text);
}

async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        return res.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : null;
    } catch (e) { return null; }
}

// ==============================================================================
// 🧠 GEMINI AI
// ==============================================================================
async function chatWithGemini(phone, userInputText) {
    let user = await getUser(phone);
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }],
                systemInstruction: "You are a helpful phone AI. Answer briefly. Keep it conversational."
            });
            const chat = model.startChat({ history: user.chat_history.slice(0, -1) });
            const result = await chat.sendMessage(userInputText);
            const reply = result.response.text().replace(/\*/g, '');
            
            user.chat_history.push({ role: 'model', parts: [{ text: reply }] });
            await updateUser(phone, { $set: { chat_history: user.chat_history.slice(-10) } });
            return reply;
        } catch (e) {}
    }
    return "API Error.";
}

// ==============================================================================
// 🚀 EXPRESS ROUTES (THE OPERATING SYSTEM)
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.send("Voice OS Online"));

// Serves Standard TTS Audio
app.get("/temp-audio/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.setHeader('Content-Type', 'audio/mpeg');
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// FFMPEG STREAMING ENGINE (Enables Pause, Fast-Forward, Rewind)
app.get("/stream-audio", (req, res) => {
    const fileUrl = req.query.url;   // Can be local file or external Podcast URL!
    const offset = parseFloat(req.query.offset) || 0;
    
    res.setHeader('Content-Type', 'audio/mpeg');
    if (offset > 0) {
        // Uses FFmpeg to jump to the exact second instantly
        const child = spawn('ffmpeg', ['-ss', offset.toString(), '-i', fileUrl, '-c', 'copy', '-f', 'mp3', 'pipe:1']);
        child.stdout.pipe(res);
    } else {
        if (fileUrl.startsWith('http')) {
            // Stream external podcast direct to phone
            const child = spawn('ffmpeg', ['-i', fileUrl, '-c', 'copy', '-f', 'mp3', 'pipe:1']);
            child.stdout.pipe(res);
        } else {
            // Serve local file normally
            fs.createReadStream(fileUrl).pipe(res);
        }
    }
});

// ------------------------------------------------------------------------------
// GLOBAL CANCEL (*)
// ------------------------------------------------------------------------------
app.all("/interrupt", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "*") r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// THE MAIN MENU (BOOT)
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    const r = new VoiceResponse();
    const menu = "Voice O.S. Press 1 for Chat. 2 for Music. 3 for Podcasts. 4 for News.";
    await gatherPlayOrSay(r, menu, `${CONFIG.BASE_URL}/main-router`, 5);
    res.type("text/xml").send(r.toString());
});

app.all("/main-router", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    if (d === "1") r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    else if (d === "2") r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    else if (d === "3") r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    else if (d === "4") r.redirect(`${CONFIG.BASE_URL}/news-init`);
    else r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// SYSTEM 1: AI CHAT
// ------------------------------------------------------------------------------
app.all("/chat-menu", async (req, res) => {
    const r = new VoiceResponse();
    await gatherPlayOrSay(r, "Chat. 1 for New, 2 to Continue, 4 for Voice Settings.", `${CONFIG.BASE_URL}/chat-router`, 5);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-router", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    if (req.body.Digits === "1") {
        await updateUser(phone, { $set: { chat_history: [] } }); // Clear history
        await gatherPlayOrSay(r, "New chat. Speak after beep.", `${CONFIG.BASE_URL}/interrupt`, 0);
        r.record({ action: `${CONFIG.BASE_URL}/chat-process`, maxLength: 60, playBeep: true, timeout: 5 });
    } else if (req.body.Digits === "2") {
        await gatherPlayOrSay(r, "Continuing. Speak after beep.", `${CONFIG.BASE_URL}/interrupt`, 0);
        r.record({ action: `${CONFIG.BASE_URL}/chat-process`, maxLength: 60, playBeep: true, timeout: 5 });
    } else if (req.body.Digits === "4") {
        let user = await getUser(phone);
        const newVoice = user.settings.chat_voice === 'he-IL-HilaNeural' ? 'he-IL-AvriNeural' : 'he-IL-HilaNeural';
        await updateUser(phone, { $set: { "settings.chat_voice": newVoice } });
        await gatherPlayOrSay(r, "Voice changed.", `${CONFIG.BASE_URL}/chat-menu`, 1, newVoice);
    } else { r.redirect(`${CONFIG.BASE_URL}/chat-menu`); }
    res.type("text/xml").send(r.toString());
});

app.all("/chat-process", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    
    // Quick routing using Flash
    const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_KEYS[0]);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = "Extract EXACT text spoken. If silent, output SILENCE.";
    const result = await model.generateContent([prompt, { inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
    const query = result.response.text().trim();

    if (query === "SILENCE") { r.redirect(`${CONFIG.BASE_URL}/chat-menu`); return res.type("text/xml").send(r.toString()); }

    // Save user message, get AI reply
    let user = await getUser(phone);
    user.chat_history.push({ role: 'user', parts: [{ text: query }] });
    await updateUser(phone, { $set: { chat_history: user.chat_history } });
    
    const reply = await chatWithGemini(phone, query);
    
    // Play reply and listen for next message
    await gatherPlayOrSay(r, reply, `${CONFIG.BASE_URL}/interrupt`, 1, user.settings.chat_voice);
    r.record({ action: `${CONFIG.BASE_URL}/chat-process`, maxLength: 60, playBeep: true, timeout: 5 });
    
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// SYSTEM 2: MUSIC & THE SPOTIFY PLAYER
// ------------------------------------------------------------------------------
app.all("/music-menu", async (req, res) => {
    const r = new VoiceResponse();
    await gatherPlayOrSay(r, "Music. 1 Search. 2 History. 3 Saved. 4 Playlists. 5 Settings.", `${CONFIG.BASE_URL}/music-router`, 5);
    res.type("text/xml").send(r.toString());
});

app.all("/music-router", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const d = req.body.Digits;

    if (d === "1") {
        await gatherPlayOrSay(r, "Say song name.", `${CONFIG.BASE_URL}/interrupt`, 0);
        r.record({ action: `${CONFIG.BASE_URL}/music-search-process`, maxLength: 10, playBeep: true, timeout: 3 });
    } else if (d === "2") {
        let user = await getUser(phone);
        getCallState(req.body.CallSid).playlist = user.music_history;
        r.redirect(`${CONFIG.BASE_URL}/playlist-browser`);
    } else if (d === "3") {
        let user = await getUser(phone);
        getCallState(req.body.CallSid).playlist = user.likes;
        r.redirect(`${CONFIG.BASE_URL}/playlist-browser`);
    } else if (d === "4") {
        // Auto-play saved songs
        let user = await getUser(phone);
        const state = getCallState(req.body.CallSid);
        state.playlist = user.likes.sort(() => 0.5 - Math.random()); // Shuffle
        state.playlistIndex = 0;
        state.mode = 'playlist_auto';
        r.redirect(`${CONFIG.BASE_URL}/music-download-init`);
    } else if (d === "5") {
        let user = await getUser(phone);
        const newEngine = user.settings.search_engine === 'scsearch1:' ? 'ytsearch1:' : 'scsearch1:';
        await updateUser(phone, { $set: { "settings.search_engine": newEngine } });
        await gatherPlayOrSay(r, `Engine set to ${newEngine.replace('1:','')}`, `${CONFIG.BASE_URL}/music-menu`, 1);
    } else { r.redirect(`${CONFIG.BASE_URL}/music-menu`); }
    res.type("text/xml").send(r.toString());
});

app.all("/music-search-process", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    
    const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_KEYS[0]);
    const result = await genAI.getGenerativeModel({ model: "gemini-2.5-flash" }).generateContent(["Extract song name spoken exactly.", { inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
    const query = result.response.text().trim();

    await saveMusicHistory(phone, query);
    const state = getCallState(req.body.CallSid);
    state.playlist = [query];
    state.playlistIndex = 0;
    state.mode = 'single';
    
    await gatherPlayOrSay(r, `Finding ${query}`, `${CONFIG.BASE_URL}/interrupt`, 0);
    r.redirect(`${CONFIG.BASE_URL}/music-download-init`);
    res.type("text/xml").send(r.toString());
});

// Downloads the song and preps the player
app.all("/music-download-init", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const state = getCallState(req.body.CallSid);
    let user = await getUser(phone);
    const query = state.playlist[state.playlistIndex];
    
    if (!query) { r.redirect(`${CONFIG.BASE_URL}/music-menu`); return res.type("text/xml").send(r.toString()); }

    const id = uuidv4();
    const outputPath = path.join(CONFIG.DOWNLOAD_DIR, `${id}.mp3`);
    const args = [`${user.settings.search_engine}${query}`, '-x', '--audio-format', 'mp3', '--match-filter', 'duration < 600', '-o', outputPath];
    
    spawn('yt-dlp', args).on('close', () => {
        if (fs.existsSync(outputPath)) {
            state.fileUrl = outputPath;
            state.isPodcast = false;
            state.offset = 0;
            state.isPaused = false;
            // Hack to trigger playback via wait loop
            fs.writeFileSync(path.join(CONFIG.DOWNLOAD_DIR, `READY_${req.body.CallSid}`), "done");
        }
    });

    r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const readyFile = path.join(CONFIG.DOWNLOAD_DIR, `READY_${req.body.CallSid}`);
    
    if (fs.existsSync(readyFile)) {
        fs.unlinkSync(readyFile);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// THE MASTER MEDIA PLAYER (Controls Twilio playback)
// ------------------------------------------------------------------------------
app.all("/player-play", (req, res) => {
    const r = new VoiceResponse();
    const state = getCallState(req.body.CallSid);
    
    if (state.isPaused) {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/player-action`, timeout: 3600 }); // Wait 1 hr for unpause
        g.say("Paused. Press 5 to resume.");
    } else {
        state.startTime = Date.now(); // Mark when playback started
        const streamUrl = `${CONFIG.BASE_URL}/stream-audio?url=${encodeURIComponent(state.fileUrl)}&offset=${state.offset}`;
        
        // Play the stream. If user presses a button, it interrupts and goes to /player-action
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/player-action`, timeout: 0 });
        g.play(streamUrl);
        
        // If the song finishes naturally without buttons pressed
        r.redirect(`${CONFIG.BASE_URL}/player-finished`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/player-action", async (req, res) => {
    const r = new VoiceResponse();
    const state = getCallState(req.body.CallSid);
    const d = req.body.Digits;
    const phone = req.body.From;

    // Calculate how much time passed before they pressed a button
    if (!state.isPaused) {
        const elapsed = (Date.now() - state.startTime) / 1000;
        state.offset += elapsed;
    }

    if (d === "*") { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }
    else if (d === "5") state.isPaused = !state.isPaused;
    else if (d === "6") state.offset += 60;
    else if (d === "4") state.offset = Math.max(0, state.offset - 60);
    else if (d === "3") state.offset += 20;
    else if (d === "1") state.offset = Math.max(0, state.offset - 20);
    else if (d === "8") {
        let user = await getUser(phone);
        const currentSong = state.playlist[state.playlistIndex];
        if (currentSong && !user.likes.includes(currentSong)) {
            user.likes.push(currentSong);
            await updateUser(phone, { $set: { likes: user.likes } });
        }
    }

    r.redirect(`${CONFIG.BASE_URL}/player-play`); // Resume with new offset/pause state
    res.type("text/xml").send(r.toString());
});

app.all("/player-finished", (req, res) => {
    const r = new VoiceResponse();
    const state = getCallState(req.body.CallSid);
    
    if (state.mode === 'playlist_auto') {
        state.playlistIndex++;
        if (state.playlistIndex < state.playlist.length) {
            r.redirect(`${CONFIG.BASE_URL}/music-download-init`); // Play next song
        } else {
            r.redirect(`${CONFIG.BASE_URL}/music-menu`); // Playlist over
        }
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// SYSTEM 3: PODCASTS (Apple iTunes API + RSS)
// ------------------------------------------------------------------------------
const PODCASTS = [
    { name: "Osim Historia", term: "עושים+היסטוריה" },
    { name: "B'zman She'avadtem", term: "בזמן+שעבדתם" },
    { name: "Echad Ba'yom", term: "אחד+ביום" },
    { name: "Osim Technologia", term: "עושים+טכנולוגיה" },
    { name: "Ha'tshuva", term: "התשובה" }
];

app.all("/podcast-menu", async (req, res) => {
    const r = new VoiceResponse();
    let msg = "Podcasts. ";
    PODCASTS.forEach((p, i) => msg += `Press ${i+1} for ${p.name}. `);
    await gatherPlayOrSay(r, msg, `${CONFIG.BASE_URL}/podcast-fetch`, 10);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-fetch", async (req, res) => {
    const r = new VoiceResponse();
    const index = parseInt(req.body.Digits) - 1;
    if (!PODCASTS[index]) { r.redirect(`${CONFIG.BASE_URL}/podcast-menu`); return res.type("text/xml").send(r.toString()); }

    await gatherPlayOrSay(r, "Fetching latest episode...", `${CONFIG.BASE_URL}/interrupt`, 0);

    try {
        // Find RSS feed via iTunes API
        const itunesRes = await fetch(`https://itunes.apple.com/search?term=${PODCASTS[index].term}&entity=podcast`);
        const itunesData = await itunesRes.json();
        const feedUrl = itunesData.results[0].feedUrl;
        
        // Parse RSS Feed for newest episode MP3
        const feed = await rssParser.parseURL(feedUrl);
        const latestEp = feed.items[0];
        
        // Send directly to Player Engine (No downloading required!)
        const state = getCallState(req.body.CallSid);
        state.fileUrl = latestEp.enclosure.url; // Direct MP3 Link
        state.isPodcast = true;
        state.offset = 0;
        state.isPaused = false;
        state.mode = 'single';
        
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
    } catch (e) {
        r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// SYSTEM 4: YNET NEWS (MIVZAKIM)
// ------------------------------------------------------------------------------
app.all("/news-init", async (req, res) => {
    const r = new VoiceResponse();
    try {
        const feed = await rssParser.parseURL('https://www.ynet.co.il/Integration/StoryRss3082.xml');
        const state = getCallState(req.body.CallSid);
        state.playlist = feed.items;
        state.playlistIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    } catch (e) { r.redirect(`${CONFIG.BASE_URL}/twiml`); }
    res.type("text/xml").send(r.toString());
});

app.all("/news-browser", async (req, res) => {
    const r = new VoiceResponse();
    const state = getCallState(req.body.CallSid);
    const article = state.playlist[state.playlistIndex];
    
    await gatherPlayOrSay(r, `News. ${article.title}. 6 Next. 4 Prev. 8 Details.`, `${CONFIG.BASE_URL}/news-action`, 10);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/news-action", async (req, res) => {
    const r = new VoiceResponse();
    const state = getCallState(req.body.CallSid);
    const d = req.body.Digits;

    if (d === "*") r.redirect(`${CONFIG.BASE_URL}/twiml`);
    else if (d === "6" && state.playlistIndex < state.playlist.length - 1) { state.playlistIndex++; r.redirect(`${CONFIG.BASE_URL}/news-browser`); }
    else if (d === "4" && state.playlistIndex > 0) { state.playlistIndex--; r.redirect(`${CONFIG.BASE_URL}/news-browser`); }
    else if (d === "8") {
        await gatherPlayOrSay(r, state.playlist[state.playlistIndex].contentSnippet || "No details.", `${CONFIG.BASE_URL}/interrupt`, 1);
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    } else { r.redirect(`${CONFIG.BASE_URL}/news-browser`); }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ANTI-CRASH SHIELDS & START
// ------------------------------------------------------------------------------
process.on('uncaughtException', (err) => console.error('Caught:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
app.listen(CONFIG.PORT, () => console.log(`🚀 Master OS Online: PORT ${CONFIG.PORT}`));
