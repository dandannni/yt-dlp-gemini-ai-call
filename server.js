// ==============================================================================
// 1. IMPORTS & SETUP
// ==============================================================================
console.log("🚀 Starting Server v7.2: FIXED APPLICATION ERROR + PERMANENT MEMORY...");

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
// 2. GEMINI SYSTEM PROMPTS
// ==============================================================================
const PROMPTS = {
    ROUTER: `You are a smart voice routing engine. Listen to the audio. 
    1. If the user asks for a song, figure out the actual song name/artist (correcting slang or mispronunciations) and output intent 'music'.
    2. If the user asks for a PODCAST, a FULL SET, or a long mix, output intent 'music_long'.
    3. If they ask a question or want to talk, output intent 'chat'.
    CRITICAL: Extract the query in the EXACT language they used (strongly support Hebrew). Do not translate Hebrew to English.`,

    CHAT: `You are a highly intelligent phone assistant with access to Google Search. 
    Conduct research to find accurate answers. Synthesize your findings into a natural, conversational response. 
    Keep it concise enough for a phone call. Never output URLs or markdown. 
    CRITICAL: Respond STRICTLY in the language the user asked in. If they speak Hebrew, you MUST reply in Hebrew.`
};

// ==============================================================================
// 3. DATABASE (JSON MEMORY SYSTEM)
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
        return { users: {}, likes: {} };
    }
}

function writeDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { }
}

function getUser(phone) {
    const db = readDB();
    if (!db.users[phone]) {
        db.users[phone] = { music_history: [], chat_history: [] };
        writeDB(db);
    }
    return db.users[phone];
}

function saveMusicHistory(phone, songQuery) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    db.users[phone].music_history = db.users[phone].music_history.filter(s => s !== songQuery);
    db.users[phone].music_history.unshift(songQuery); 
    if (db.users[phone].music_history.length > 10) db.users[phone].music_history.pop();
    writeDB(db);
}

function saveChatHistory(phone, role, text) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    db.users[phone].chat_history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
    if (db.users[phone].chat_history.length > 10) {
        db.users[phone].chat_history = db.users[phone].chat_history.slice(-10);
    }
    writeDB(db);
}

function clearChatHistory(phone) {
    const db = readDB();
    if (db.users[phone]) {
        db.users[phone].chat_history = [];
        writeDB(db);
    }
}

function saveLikedSong(phone, songQuery) {
    const db = readDB();
    if (!db.likes[phone]) db.likes[phone] = [];
    if (!db.likes[phone].includes(songQuery)) {
        db.likes[phone].unshift(songQuery);
        writeDB(db);
    }
}

function removeLikedSong(phone, songQuery) {
    const db = readDB();
    if (db.likes[phone]) {
        db.likes[phone] = db.likes[phone].filter(s => s !== songQuery);
        writeDB(db);
    }
}

function getLikedSongs(phone) {
    return readDB().likes[phone] || [];
}

// ==============================================================================
// 4. CONFIGURATION & QUEUES
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp",
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    VERIFIED_CALLERS: ["+972548498889", "+972554402506", "+972525585720", "+972528263032", "+972583230268"],
    GEMINI_KEYS: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);
function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

const downloadQueue = new Map();
const chatQueue = new Map();
const sessions = new Map(); 

function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { browseType: null, browseIndex: 0, browseList: [] });
    return sessions.get(callSid);
}

// ==============================================================================
// 5. GEMINI AI LOGIC
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
                                intent: { type: "STRING", description: "'music', 'music_long', or 'chat'" },
                                query: { type: "STRING", description: "Song name or chat question." }
                            },
                            required: ["intent", "query"]
                        }
                    }]
                }],
                systemInstruction: PROMPTS.ROUTER
            }); 
            const result = await model.generateContent([{ inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
            const call = result.response.functionCalls()?.[0];
            if (call && call.name === "route_request") return call.args;
        } catch (e) {}
    }
    return null;
}

async function chatWithGemini(phone, userInputText) {
    saveChatHistory(phone, 'user', userInputText); 
    const userHistory = getUser(phone).chat_history; 

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }],
                systemInstruction: PROMPTS.CHAT
            });
            
            const history = userHistory.slice(0, -1);
            const chat = model.startChat({ history });
            
            const result = await chat.sendMessage(userInputText);
            const replyText = result.response.text().replace(/\*/g, ''); 
            
            saveChatHistory(phone, 'model', replyText);
            return replyText;
        } catch (e) {}
    }
    return "Sorry, I had a problem looking that up.";
}

// ==============================================================================
// 6. AUDIO & DOWNLOADING
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

async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { return null; }
}

async function searchAndDownloadYTDLP(callSid, query, isLong) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now(), query: query });
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    let args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    if (!isLong) args.splice(4, 0, '--match-filter', 'duration < 600');
    
    const child = spawn('yt-dlp', args);
    child.on('close', () => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        
        if (found) {
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, query: query });
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else { 
            downloadQueue.set(callSid, { status: 'error', query: query }); 
        }
    });
}

// ==============================================================================
// 7. EXPRESS WEB SERVER & TWILIO ROUTES
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

app.get("/", (req, res) => res.send("Bot is awake!"));

app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// TWILIO FIX: Two specific helper functions to prevent nested <Gather> crashes!

// Helper 1: Plays text but allows interruption by the Global Star (*) Key
async function playOrSayInterruptible(r, text, actionUrl) {
    const ttsFilename = await generateFreeTTS(text);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: actionUrl, method: "POST", timeout: 0 });
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else g.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// Helper 2: Plays text to announce a menu, and waits for you to press a button
async function gatherPlayOrSay(r, text, actionUrl, timeoutVal) {
    const ttsFilename = await generateFreeTTS(text);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: actionUrl, method: "POST", timeout: timeoutVal });
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else g.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// ------------------------------------------------------------------------------
// ROUTE: THE MAIN MENU
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    // I turned off the memory eraser! The AI will remember your chats permanently now.
    // clearChatHistory(caller); 
    
    const r = new VoiceResponse();
    await gatherPlayOrSay(r, "Menu. Zero for history, Star at any time to go back, or speak after the beep.", `${CONFIG.BASE_URL}/zero-menu-router`, 3);
    
    r.record({ action: `${CONFIG.BASE_URL}/process-intent`, method: "POST", maxLength: 300, playBeep: true, timeout: 10 });
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: GLOBAL CANCEL KEY (*)
// ------------------------------------------------------------------------------
app.all("/interrupt-router", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "*") { r.redirect(`${CONFIG.BASE_URL}/twiml`); } 
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: HISTORY & FAVORITES MENUS
// ------------------------------------------------------------------------------
app.all("/zero-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "0") {
        await gatherPlayOrSay(r, "History. Press 2 for previous songs, 3 for favorites, or Star to go back.", `${CONFIG.BASE_URL}/history-entry`, 8);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/history-entry", (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const session = getSession(req.body.CallSid);
    
    if (req.body.Digits === "2") {
        session.browseType = 'history';
        session.browseList = getUser(phone).music_history;
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (req.body.Digits === "3") {
        session.browseType = 'likes';
        session.browseList = getLikedSongs(phone);
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (req.body.Digits === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/browse-menu", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    
    if (!session.browseList || session.browseList.length === 0) {
        await playOrSayInterruptible(r, "The list is empty.", `${CONFIG.BASE_URL}/interrupt-router`);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const currentItem = session.browseList[session.browseIndex];
    let menuText = `${currentItem}. Press 5 to play, 4 for previous, 6 for next.`;
    if (session.browseType === 'likes') menuText += " 9 to remove.";

    await gatherPlayOrSay(r, menuText, `${CONFIG.BASE_URL}/browse-action`, 10);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/browse-action", (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const d = req.body.Digits;

    if (d === "*") { 
        r.redirect(`${CONFIG.BASE_URL}/twiml`); 
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--; 
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++; 
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (d === "5") {
        searchAndDownloadYTDLP(req.body.CallSid, session.browseList[session.browseIndex], false);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`); 
    } else if (d === "9" && session.browseType === 'likes') {
        removeLikedSong(req.body.From, session.browseList[session.browseIndex]);
        session.browseList = getLikedSongs(req.body.From);
        session.browseIndex = 0; 
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: PROCESSING AUDIO REQUESTS
// ------------------------------------------------------------------------------
app.all("/process-intent", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;

    if (!intentData) {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (intentData.intent.startsWith('music')) {
        const isLong = intentData.intent === 'music_long'; 
        saveMusicHistory(req.body.From, intentData.query);
        searchAndDownloadYTDLP(req.body.CallSid, intentData.query, isLong);
        
        await playOrSayInterruptible(r, `Finding ${intentData.query}`, `${CONFIG.BASE_URL}/interrupt-router`);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } else {
        chatQueue.set(req.body.CallSid, { status: 'pending' });
        
        chatWithGemini(req.body.From, intentData.query).then(async (replyText) => {
            const ttsFilename = await generateFreeTTS(replyText);
            chatQueue.set(req.body.CallSid, { status: 'done', ttsFilename, replyText });
        }).catch(() => chatQueue.set(req.body.CallSid, { status: 'error' }));

        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: AI CHAT WAIT LOOP & CONVERSATION
// ------------------------------------------------------------------------------
app.all("/chat-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = chatQueue.get(req.body.CallSid);
    if (!task) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (task.status === 'done') {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/interrupt-router`, method: "POST", timeout: 1 });
        if (task.ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${task.ttsFilename}`);
        else g.say({ language: isHebrewText(task.replyText) ? 'he-IL' : 'en-US' }, task.replyText);
        
        r.record({ action: `${CONFIG.BASE_URL}/process-chat-reply`, method: "POST", maxLength: 300, playBeep: true, timeout: 10 });
        
    } else if (task.status === 'error') {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 }); 
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/process-chat-reply", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
    
    if (!intentData) {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    chatQueue.set(req.body.CallSid, { status: 'pending' });
    chatWithGemini(req.body.From, intentData.query).then(async (replyText) => {
        const ttsFilename = await generateFreeTTS(replyText);
        chatQueue.set(req.body.CallSid, { status: 'done', ttsFilename, replyText });
    }).catch(() => chatQueue.set(req.body.CallSid, { status: 'error' }));

    r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: MUSIC WAIT LOOP
// ------------------------------------------------------------------------------
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        // Play the song. If you press *, it goes back to menu!
        const g1 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/interrupt-router`, method: "POST", timeout: 0 });
        g1.play(dl.url);
        
        // After song ends naturally, prompt for favorites menu
        await gatherPlayOrSay(r, "Press 2 to favorite, or Star for menu.", `${CONFIG.BASE_URL}/post-music-action`, 8);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSayInterruptible(r, "Error downloading.", `${CONFIG.BASE_URL}/interrupt-router`);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 }); 
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/post-music-action", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "2") {
        const dl = downloadQueue.get(req.body.CallSid);
        if (dl && dl.query) saveLikedSong(req.body.From, dl.query);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
