console.log("🚀 Starting Server: FAST FLASH AI + SMART ROUTING + FIXED LIKES...");

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
// 💾 DATABASE INITIALIZATION (JSON MEMORY)
// ==============================================================================
const DB_FILE = 'bot_database.json';

function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initData = { users: {}, likes: {} };
            fs.writeFileSync(DB_FILE, JSON.stringify(initData, null, 2));
            return initData;
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        console.error("DB Read Error:", e);
        return { users: {}, likes: {} };
    }
}

function writeDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } 
    catch (e) { console.error("DB Write Error:", e); }
}

function saveUserHistory(phone, type, query, response = null) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { last_chat_query: null, last_chat_response: null, last_music_query: null };
    
    if (type === 'chat') {
        db.users[phone].last_chat_query = query;
        db.users[phone].last_chat_response = response;
    } else if (type === 'music') {
        db.users[phone].last_music_query = query;
    }
    writeDB(db);
}

function getUser(phone) {
    return readDB().users[phone] || null;
}

function saveLikedSong(phone, songQuery) {
    const db = readDB();
    if (!db.likes[phone]) db.likes[phone] = [];
    
    // Prevent duplicates
    if (!db.likes[phone].some(item => item.song_query === songQuery)) {
        db.likes[phone].push({ song_query: songQuery });
        writeDB(db);
        console.log(`✅ [DB] Saved liked song: ${songQuery} for ${phone}`);
    }
}

function getLikedSongs(phone) {
    return readDB().likes[phone] || [];
}

// ==============================================================================
// ⚙️ CONFIGURATION
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    VERIFIED_CALLERS: ["+972548498889", "+972554402506", "+972525585720", "+972528263032", "+972583230268"],
    GEMINI_KEYS: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4].filter(k => k)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

// ==============================================================================
// 🧠 GEMINI AI
// ==============================================================================
async function analyzeAudioIntent(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{
                    functionDeclarations: [{
                        name: "route_request",
                        description: "Routes user request.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                intent: { type: "STRING", description: "Either 'music' or 'chat'" },
                                query: { type: "STRING", description: "The song name or chat question." }
                            },
                            required: ["intent", "query"]
                        }
                    }]
                }],
                systemInstruction: "You are a smart voice routing engine. Listen to the audio. If the user asks for a song, figure out the ACTUAL song name and artist they mean (correcting slang or mispronunciations) and output intent 'music' and the corrected song name in the language they used. If they ask a question, output intent 'chat' and extract the exact text of their question."
            }); 
            const result = await model.generateContent([{ inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
            const call = result.response.functionCalls()?.[0];
            if (call && call.name === "route_request") return call.args;
        } catch (e) { console.error(`❌ [INTENT] Key Failed: ${e.message}`); }
    }
    return null;
}

async function chatWithGemini(userInputText) {
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            // Reverted to FLASH for stability and speed. Pro fails frequently on free tier tools.
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }],
                systemInstruction: "You are a highly intelligent phone assistant with access to Google Search. Conduct research to find accurate answers. Synthesize your findings into a natural, conversational response. Keep it concise enough for a phone call (2-3 sentences). Never output URLs or markdown. Respond strictly in the language the user asked in."
            });
            const result = await model.generateContent(userInputText);
            return result.response.text().replace(/\*/g, '');
        } catch (e) { console.error(`❌ [CHAT] Key Failed: ${e.message}`); }
    }
    return "Sorry, I had a problem looking that up right now.";
}

// ==============================================================================
// 🔊 TEXT-TO-SPEECH (Edge-TTS) & HELPERS
// ==============================================================================
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

async function playOrSay(r, text) {
    const ttsFilename = await generateFreeTTS(text);
    if (ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else r.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// Queue Maps
const downloadQueue = new Map();
const chatQueue = new Map();

async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { return null; }
}

async function searchAndDownloadYTDLP(callSid, query) {
    // FIX: Ensure 'query' is stored during the pending phase so the Like button can find it later
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now(), query: query });
    
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    const args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--match-filter', 'duration < 600', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    
    const child = spawn('yt-dlp', args);
    child.on('close', () => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        if (found) {
            // FIX: Keep the query data intact when transitioning to 'done' status
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, query: query });
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else { 
            downloadQueue.set(callSid, { status: 'error', query: query }); 
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

// Keeps the app awake if you hit this URL via UptimeRobot
app.get("/", (req, res) => res.send("Bot is awake!"));

app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// 1. HYBRID ENTRY MENU
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    const r = new VoiceResponse();
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/zero-menu-router`, method: "POST", timeout: 3 });
    await playOrSay(g, "Welcome. Press zero for your history, or wait for the beep to ask a question or request a song.");
    
    r.record({ action: `${CONFIG.BASE_URL}/process-intent`, method: "POST", maxLength: 15, playBeep: true, timeout: 5 });
    res.type("text/xml").send(r.toString());
});

// 2. THE 'ZERO' HISTORY MENU
app.all("/zero-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "0") {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/history-action`, method: "POST", timeout: 8 });
        await playOrSay(g, "History menu. Press 1 for your last chat, 2 for your last song, or 3 to browse your liked songs.");
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/history-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = getUser(phone);

    if (d === "1") {
        if (user && user.last_chat_response) {
            await playOrSay(r, `Your last question was about: ${user.last_chat_query}. Here is the answer:`);
            await playOrSay(r, user.last_chat_response);
        } else { await playOrSay(r, "No chat history found."); }
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } 
    else if (d === "2") {
        if (user && user.last_music_query) {
            await playOrSay(r, `Playing your last song: ${user.last_music_query}.`);
            searchAndDownloadYTDLP(req.body.CallSid, user.last_music_query);
            r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
        } else { 
            await playOrSay(r, "No music history found."); 
            r.redirect(`${CONFIG.BASE_URL}/twiml`);
        }
    } 
    else if (d === "3") {
        const likes = getLikedSongs(phone);
        if (likes.length === 0) {
            await playOrSay(r, "You have no liked songs yet.");
            r.redirect(`${CONFIG.BASE_URL}/twiml`);
        } else {
            let menuText = "Your favorites. ";
            likes.forEach((l, i) => menuText += `Press ${i+1} for ${l.song_query}. `);
            const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/play-favorite`, method: "POST", timeout: 10 });
            await playOrSay(g, menuText);
        }
    } else { r.redirect(`${CONFIG.BASE_URL}/twiml`); }
    
    return res.type("text/xml").send(r.toString());
});

app.all("/play-favorite", async (req, res) => {
    const r = new VoiceResponse();
    const index = parseInt(req.body.Digits) - 1;
    const likes = getLikedSongs(req.body.From);
    
    if (likes[index]) {
        await playOrSay(r, `Playing ${likes[index].song_query}.`);
        searchAndDownloadYTDLP(req.body.CallSid, likes[index].song_query);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } else {
        await playOrSay(r, "Invalid selection.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// 3. MULTIMODAL ROUTER (New Queries)
app.all("/process-intent", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;

    if (!intentData) {
        await playOrSay(r, "I didn't quite catch that.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (intentData.intent === 'music') {
        saveUserHistory(req.body.From, 'music', intentData.query);
        searchAndDownloadYTDLP(req.body.CallSid, intentData.query);
        await playOrSay(r, `Finding ${intentData.query}`);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } else {
        chatQueue.set(req.body.CallSid, { status: 'pending' });
        r.say({ language: 'en-US' }, "Let me look that up...");
        
        chatWithGemini(intentData.query).then(async (replyText) => {
            saveUserHistory(req.body.From, 'chat', intentData.query, replyText);
            const ttsFilename = await generateFreeTTS(replyText);
            chatQueue.set(req.body.CallSid, { status: 'done', ttsFilename, replyText });
        }).catch(() => chatQueue.set(req.body.CallSid, { status: 'error' }));

        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// 4. WAIT LOOPS & POST-ACTION MENUS
app.all("/chat-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = chatQueue.get(req.body.CallSid);
    if (!task) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (task.status === 'done') {
        if (task.ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${task.ttsFilename}`);
        else r.say({ language: isHebrewText(task.replyText) ? 'he-IL' : 'en-US' }, task.replyText);
        
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-action-router`, method: "POST", timeout: 5 });
        await playOrSay(g, "Press 1 to ask something else, or hang up.");
        r.hangup();
    } else if (task.status === 'error') {
        await playOrSay(r, "Error fetching answer.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        r.play(dl.url);
        
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-music-action`, method: "POST", timeout: 8 });
        await playOrSay(g, "Press 2 to save this song to your favorites, 1 to search again, or hang up.");
        r.hangup();
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSay(r, "Error downloading the song.");
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 });
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/post-music-action", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "2") {
        const dl = downloadQueue.get(req.body.CallSid);
        if (dl && dl.query) {
            saveLikedSong(req.body.From, dl.query);
            await playOrSay(r, "Song saved to favorites.");
        }
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } 
    else if (req.body.Digits === "1") r.redirect(`${CONFIG.BASE_URL}/twiml`);
    else r.hangup();
    
    res.type("text/xml").send(r.toString());
});

app.all("/post-action-router", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "1") r.redirect(`${CONFIG.BASE_URL}/twiml`);
    else r.hangup();
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
