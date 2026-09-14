// ==============================================================================
// 1. IMPORTS & SETUP (Loading the tools we need)
// ==============================================================================
console.log("🚀 Starting Server v8.0: HILA VOICE + ANTI-CRASH + REAL NAVIGATION...");

import express from "express";               // Web server framework for communicating with Twilio
import dotenv from "dotenv";                 // Loads secret variables from Render
import twilio from "twilio";                 // Twilio library for phone routing
import { GoogleGenerativeAI } from "@google/generative-ai"; // Google's AI brain
import path from "path";                     // Helps locate files on the server
import fs from "fs";                         // Allows us to read/write the database file
import { spawn } from "child_process";       // Allows us to run background tools (like downloading songs)
import { v4 as uuidv4 } from "uuid";         // Creates random names for audio files so they don't overwrite

dotenv.config(); // Turns on the environment variables

// ==============================================================================
// 2. GEMINI SYSTEM PROMPTS (The AI's Brain Rules)
// ==============================================================================
const PROMPTS = {
    // Tells the first AI how to direct traffic.
    ROUTER: `You are a smart voice routing engine. Listen to the audio. 
    1. If the user asks for a song, correct any slang/mispronunciations and output intent 'music'.
    2. If they ask for a PODCAST, FULL SET, or long mix, output intent 'music_long'.
    3. If they ask a question, output intent 'chat'.
    CRITICAL: Output the query in the EXACT language they used. If they speak Hebrew, the query MUST be in Hebrew text.`,

    // Tells the chat AI how to talk to you.
    CHAT: `You are a highly intelligent phone assistant with access to Google Search. 
    Conduct research and answer naturally. Keep it short (2-4 sentences). 
    CRITICAL: Respond STRICTLY in the language the user asked in. Strongly enforce Hebrew if requested.`
};

// ==============================================================================
// 3. DATABASE (JSON Memory System)
// ==============================================================================
const DB_FILE = 'bot_database.json'; // The file name where history is stored

// Reads the database file. If it doesn't exist, it creates a blank one.
function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initData = { users: {}, likes: {} };
            fs.writeFileSync(DB_FILE, JSON.stringify(initData, null, 2));
            return initData;
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        return { users: {}, likes: {} }; // If error, return blank data
    }
}

// Writes data permanently to the JSON file
function writeDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { }
}

// Gets a user's data based on their phone number
function getUser(phone) {
    const db = readDB();
    if (!db.users[phone]) {
        db.users[phone] = { music_history: [], chat_history: [] };
        writeDB(db);
    }
    return db.users[phone];
}

// Saves a played song to history, moving it to the top of the list (Max 10)
function saveMusicHistory(phone, songQuery) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    // Remove the song if it's already in the list, then put it at the very top (Index 0)
    db.users[phone].music_history = db.users[phone].music_history.filter(s => s !== songQuery);
    db.users[phone].music_history.unshift(songQuery); 
    
    if (db.users[phone].music_history.length > 10) db.users[phone].music_history.pop();
    writeDB(db);
}

// Saves chat messages so the AI remembers the conversation context
function saveChatHistory(phone, role, text) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    db.users[phone].chat_history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
    if (db.users[phone].chat_history.length > 10) {
        db.users[phone].chat_history = db.users[phone].chat_history.slice(-10); // Keeps last 10 messages
    }
    writeDB(db);
}

// Adds a song to Favorites
function saveLikedSong(phone, songQuery) {
    const db = readDB();
    if (!db.likes[phone]) db.likes[phone] = [];
    if (!db.likes[phone].includes(songQuery)) {
        db.likes[phone].unshift(songQuery); // Adds to the top of favorites
        writeDB(db);
    }
}

// Removes a song from Favorites (when you press 9)
function removeLikedSong(phone, songQuery) {
    const db = readDB();
    if (db.likes[phone]) {
        db.likes[phone] = db.likes[phone].filter(s => s !== songQuery);
        writeDB(db);
    }
}

// Gets the list of favorites
function getLikedSongs(phone) {
    return readDB().likes[phone] || [];
}

// ==============================================================================
// 4. SERVER SETTINGS & QUEUES
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

// Checks if the text contains Hebrew characters
function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

// Queues that hold data while tasks run in the background
const downloadQueue = new Map();
const chatQueue = new Map();
const sessions = new Map(); 

// Gets the user's temporary menu session (used for pressing 4 and 6 to browse)
function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { browseType: null, browseIndex: 0, browseList: [] });
    return sessions.get(callSid);
}

// ==============================================================================
// 5. GOOGLE GEMINI AI
// ==============================================================================
// Listens to the raw audio and decides what to do
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

// Chats with Google Search enabled, remembering past history
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
            
            const history = userHistory.slice(0, -1); // Load all messages except the newest one
            const chat = model.startChat({ history }); // Give the AI the history
            
            const result = await chat.sendMessage(userInputText); // Ask the new question
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
// Converts text to an MP3 using the new Female Hebrew voice (Hila)
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        // SWITCHED TO 'HilaNeural' (Female Israeli Voice)
        const voice = isHebrewText(safeText) ? 'he-IL-HilaNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000); // Delete after 5 min
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

// Downloads the user's voice from Twilio safely
async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { return null; }
}

// Uses yt-dlp to search and download the song from SoundCloud
async function searchAndDownloadYTDLP(callSid, query, isLong) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now(), query: query });
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    let args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    if (!isLong) args.splice(4, 0, '--match-filter', 'duration < 600'); // Block songs longer than 10 mins unless requested
    
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
// 7. EXPRESS SERVER & TWILIO CALL ROUTES
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

// UptimeRobot pings this to keep the server awake
app.get("/", (req, res) => res.send("Bot is awake!"));

// Serves the music files back to Twilio over the internet
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// Helper: Plays text, but stops if you press a button
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
    
    const r = new VoiceResponse();
    // Shorter welcome message!
    await gatherPlayOrSay(r, "Main menu. Press zero for history, or speak after the beep.", `${CONFIG.BASE_URL}/zero-menu-router`, 3);
    
    // Starts recording user voice
    r.record({ action: `${CONFIG.BASE_URL}/process-intent`, method: "POST", maxLength: 300, playBeep: true, timeout: 10 });
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: HISTORY MENUS
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

// Selects which list to browse
app.all("/history-entry", (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const session = getSession(req.body.CallSid);
    
    if (req.body.Digits === "2") {
        session.browseType = 'history';
        session.browseList = getUser(phone).music_history;
        session.browseIndex = 0; // Starts at the newest song
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (req.body.Digits === "3") {
        session.browseType = 'likes';
        session.browseList = getLikedSongs(phone);
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Star or anything else goes to main menu
    }
    res.type("text/xml").send(r.toString());
});

// The list browser (Press 4 and 6 to move up and down the list)
app.all("/browse-menu", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    
    if (!session.browseList || session.browseList.length === 0) {
        await gatherPlayOrSay(r, "The list is empty.", `${CONFIG.BASE_URL}/twiml`, 1);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const currentItem = session.browseList[session.browseIndex];
    let menuText = `${currentItem}. Press 5 to play, 4 for newer, 6 for older.`;
    if (session.browseType === 'likes') menuText += " 9 to remove.";

    await gatherPlayOrSay(r, menuText, `${CONFIG.BASE_URL}/browse-action`, 10);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

// Handles the 4 and 6 button presses logically
app.all("/browse-action", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const d = req.body.Digits;

    if (d === "4") {
        if (session.browseIndex > 0) {
            session.browseIndex--; // Move to a newer song
            r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
        } else {
            await gatherPlayOrSay(r, "This is the newest song.", `${CONFIG.BASE_URL}/browse-menu`, 1);
            r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
        }
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) {
            session.browseIndex++; // Move to an older song
            r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
        } else {
            await gatherPlayOrSay(r, "End of list.", `${CONFIG.BASE_URL}/browse-menu`, 1);
            r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
        }
    } else if (d === "5") {
        searchAndDownloadYTDLP(req.body.CallSid, session.browseList[session.browseIndex], false);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`); 
    } else if (d === "9" && session.browseType === 'likes') {
        removeLikedSong(req.body.From, session.browseList[session.browseIndex]);
        session.browseList = getLikedSongs(req.body.From);
        session.browseIndex = 0; 
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Any other key goes to main menu
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
        
        await gatherPlayOrSay(r, `Finding ${intentData.query}`, `${CONFIG.BASE_URL}/interrupt-router`, 0);
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
// ROUTE: AI CHAT WAIT LOOP
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
// ROUTE: MUSIC WAIT LOOP & LIKES LOGIC
// ------------------------------------------------------------------------------
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        // Play the song. The 'action' routes ANY key pressed to the post-music logic
        const g1 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-music-action`, method: "POST", timeout: 0 });
        g1.play(dl.url);
        
        // This triggers if the song finishes without the user pressing anything
        const g2 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-music-action`, method: "POST", timeout: 8 });
        await gatherPlayOrSay(g2, "Press 2 to favorite, or Star for menu.", `${CONFIG.BASE_URL}/post-music-action`, 8);
        
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await gatherPlayOrSay(r, "Error downloading.", `${CONFIG.BASE_URL}/twiml`, 1);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 }); 
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// The master route for interrupting a song OR liking a song
app.all("/post-music-action", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "2") {
        const dl = downloadQueue.get(req.body.CallSid);
        if (dl && dl.query) {
            saveLikedSong(req.body.From, dl.query); // Saves it!
            
            // Generate audio saying "Saved" and immediately go to Main Menu
            const ttsFilename = await generateFreeTTS("Saved.");
            if (ttsFilename) r.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
            else r.say("Saved.");
        }
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        // If they pressed Star or anything else, go straight to Main Menu
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// Global cancel key route
app.all("/interrupt-router", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "*") { r.redirect(`${CONFIG.BASE_URL}/twiml`); } 
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 8. ANTI-CRASH SHIELDS & SERVER START
// ==============================================================================
// These three lines prevent random Node.js errors from crashing the server
// This stops Render from resetting the hard drive, preserving your database!
process.on('uncaughtException', (err) => console.error('Caught exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
