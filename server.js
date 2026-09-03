// ==============================================================================
// 1. IMPORTS & SETUP (Loading the tools we need to run the server)
// ==============================================================================
console.log("🚀 Starting Server v7.1: STAR KEY CANCEL + HEAVILY COMMENTED...");

import express from "express";               // The web server framework that talks to Twilio
import dotenv from "dotenv";                 // Loads secret variables (like API keys)
import twilio from "twilio";                 // The Twilio phone call library
import { GoogleGenerativeAI } from "@google/generative-ai"; // The Gemini AI library
import path from "path";                     // Helps find file paths on the server
import fs from "fs";                         // "File System" - lets us read/write files (like our JSON DB)
import { spawn } from "child_process";       // Lets us run command-line tools like yt-dlp and edge-tts
import { v4 as uuidv4 } from "uuid";         // Generates random unique IDs for our downloaded files

dotenv.config(); // Activates the hidden environment variables

// ==============================================================================
// 2. GEMINI SYSTEM PROMPTS (The AI's "Brain Rules")
// ==============================================================================
const PROMPTS = {
    // ROUTER: This prompt is for the FIRST AI. Its only job is to figure out what you want.
    ROUTER: `You are a smart voice routing engine. Listen to the audio. 
    1. If the user asks for a song, figure out the actual song name/artist (correcting slang or mispronunciations) and output intent 'music'.
    2. If the user asks for a PODCAST, a FULL SET, or a long mix, output intent 'music_long'.
    3. If they ask a question or want to talk, output intent 'chat'.
    CRITICAL: Extract the query in the EXACT language they used (strongly support Hebrew). Do not translate Hebrew to English.`,

    // CHAT: This prompt is for the SECOND AI. Its job is to answer your questions.
    CHAT: `You are a highly intelligent phone assistant with access to Google Search. 
    Conduct research to find accurate answers. Synthesize your findings into a natural, conversational response. 
    Keep it concise enough for a phone call. Never output URLs or markdown. 
    CRITICAL: Respond STRICTLY in the language the user asked in. If they speak Hebrew, you MUST reply in Hebrew.`
};

// ==============================================================================
// 3. DATABASE (The JSON Memory System)
// ==============================================================================
const DB_FILE = 'bot_database.json'; // The file where all memory is saved

// Reads the JSON file. If it doesn't exist, it creates a blank one.
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

// Writes data back into the JSON file to save it permanently
function writeDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { }
}

// Gets a specific user's history based on their phone number
function getUser(phone) {
    const db = readDB();
    if (!db.users[phone]) {
        db.users[phone] = { music_history: [], chat_history: [] };
        writeDB(db);
    }
    return db.users[phone];
}

// Saves a song to the user's "Recent History" list (keeps maximum of 10)
function saveMusicHistory(phone, songQuery) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    // Removes the song if it's already there, then puts it at the very top of the list
    db.users[phone].music_history = db.users[phone].music_history.filter(s => s !== songQuery);
    db.users[phone].music_history.unshift(songQuery); 
    
    // If the list gets bigger than 10, delete the oldest one
    if (db.users[phone].music_history.length > 10) db.users[phone].music_history.pop();
    writeDB(db);
}

// Saves the ongoing conversation so the AI remembers what you just said
function saveChatHistory(phone, role, text) {
    const db = readDB();
    if (!db.users[phone]) db.users[phone] = { music_history: [], chat_history: [] };
    
    // 'role' is either 'user' (you) or 'model' (the AI)
    db.users[phone].chat_history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
    
    // Keep only the last 10 messages so the AI doesn't run out of memory
    if (db.users[phone].chat_history.length > 10) {
        db.users[phone].chat_history = db.users[phone].chat_history.slice(-10);
    }
    writeDB(db);
}

// Erases the conversation when you go back to the Main Menu
function clearChatHistory(phone) {
    const db = readDB();
    if (db.users[phone]) {
        db.users[phone].chat_history = [];
        writeDB(db);
    }
}

// Adds a song to the "Favorites/Likes" array
function saveLikedSong(phone, songQuery) {
    const db = readDB();
    if (!db.likes[phone]) db.likes[phone] = [];
    if (!db.likes[phone].includes(songQuery)) {
        db.likes[phone].unshift(songQuery);
        writeDB(db);
    }
}

// Removes a song from the "Favorites/Likes" array
function removeLikedSong(phone, songQuery) {
    const db = readDB();
    if (db.likes[phone]) {
        db.likes[phone] = db.likes[phone].filter(s => s !== songQuery);
        writeDB(db);
    }
}

// Retrieves all favorite songs
function getLikedSongs(phone) {
    return readDB().likes[phone] || [];
}

// ==============================================================================
// 4. SERVER CONFIGURATION & QUEUES
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp", // Where audio files are temporarily stored
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    VERIFIED_CALLERS: ["+972548498889", "+972554402506", "+972525585720", "+972528263032", "+972583230268"],
    GEMINI_KEYS: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k)
};

// Creates the temporary download folder if it doesn't exist yet
if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

// Checks if the text has Hebrew letters in it (used to switch the TTS voice)
function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

// These temporary maps hold data while a song is downloading or an AI is thinking
const downloadQueue = new Map();
const chatQueue = new Map();
const sessions = new Map(); 

// Gets a user's temporary menu session (used for browsing history)
function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { browseType: null, browseIndex: 0, browseList: [] });
    return sessions.get(callSid);
}

// ==============================================================================
// 5. AI LOGIC (Connecting to Google Gemini)
// ==============================================================================

// AI 1: Analyzes your raw voice recording and figures out what you want
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
                systemInstruction: PROMPTS.ROUTER // Uses the rulebook from the top
            }); 
            
            // Sends the audio to the AI
            const result = await model.generateContent([{ inlineData: { mimeType: "audio/mp3", data: base64Audio } }]);
            const call = result.response.functionCalls()?.[0];
            if (call && call.name === "route_request") return call.args; // Returns { intent, query }
        } catch (e) {}
    }
    return null;
}

// AI 2: The conversational assistant that searches Google
async function chatWithGemini(phone, userInputText) {
    saveChatHistory(phone, 'user', userInputText); // Save what you asked
    const userHistory = getUser(phone).chat_history; // Load previous context

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }],
                systemInstruction: PROMPTS.CHAT // Uses the chat rulebook from the top
            });
            
            // We pass the history to the AI so it remembers what we are talking about
            const history = userHistory.slice(0, -1);
            const chat = model.startChat({ history });
            
            // Get the AI's answer
            const result = await chat.sendMessage(userInputText);
            const replyText = result.response.text().replace(/\*/g, ''); 
            
            saveChatHistory(phone, 'model', replyText); // Save the AI's answer
            return replyText;
        } catch (e) {}
    }
    return "Sorry, I had a problem looking that up.";
}

// ==============================================================================
// 6. AUDIO TOOLS (Text-to-Speech & Song Downloading)
// ==============================================================================

// Converts text into an MP3 file using Microsoft Edge's free voice AI
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        // Pick the Israeli voice if Hebrew, American voice if English
        const voice = isHebrewText(safeText) ? 'he-IL-AvriNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                // Delete the voice file after 5 minutes to save server space
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000);
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

// Downloads the MP3 recording of your voice from Twilio
async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500)); // Short pause to let Twilio process
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { return null; }
}

// Searches SoundCloud and downloads the song using yt-dlp
async function searchAndDownloadYTDLP(callSid, query, isLong) {
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now(), query: query });
    const id = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);
    
    // Command line instructions for yt-dlp
    let args = [`scsearch1:${query}`, '-x', '--audio-format', 'mp3', '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', '--no-playlist', '--force-ipv4', '-o', outputTemplate];
    
    // If it's a normal song (not a podcast), ignore files longer than 10 minutes (600 seconds)
    if (!isLong) {
        args.splice(4, 0, '--match-filter', 'duration < 600');
    }
    
    const child = spawn('yt-dlp', args);
    child.on('close', () => {
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(id) && f.endsWith('.mp3'));
        
        if (found) {
            downloadQueue.set(callSid, { status: 'done', url: `${CONFIG.BASE_URL}/music/${found}`, query: query });
            // Delete song after 20 minutes to save server space
            setTimeout(() => { if (fs.existsSync(path.join(CONFIG.DOWNLOAD_DIR, found))) fs.unlinkSync(path.join(CONFIG.DOWNLOAD_DIR, found)); }, 1200000);
        } else { 
            downloadQueue.set(callSid, { status: 'error', query: query }); 
        }
    });
}

// ==============================================================================
// 7. EXPRESS WEB SERVER & PHONE CALL ROUTING
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

// A simple endpoint to keep the server awake via UptimeRobot
app.get("/", (req, res) => res.send("Bot is awake!"));

// Serves the saved MP3 files back to Twilio so they can be played over the phone
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// A special helper function: Plays audio, but allows you to interrupt it by pressing a key
async function playOrSayInterruptible(r, text, actionUrl) {
    const ttsFilename = await generateFreeTTS(text);
    // <Gather> tells Twilio to listen for keypad presses while the audio plays
    const g = r.gather({ input: "dtmf", numDigits: 1, action: actionUrl, method: "POST", timeout: 0 });
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else g.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// ------------------------------------------------------------------------------
// ROUTE: THE MAIN MENU (When you first call)
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    // Security check: Only allow your hardcoded numbers
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    clearChatHistory(caller); // You reached the main menu, so clear previous chat memory
    const r = new VoiceResponse();
    
    // Listen for '0' to go to the History menu
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/zero-menu-router`, method: "POST", timeout: 3 });
    const ttsFilename = await generateFreeTTS("Menu. Zero for history, Star at any time to go back, or speak after the beep.");
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else g.say("Menu. Zero for history, Star at any time to go back, or speak after the beep.");
    
    // Start recording audio. Max length 5 mins, stops if you are silent for 10 seconds.
    r.record({ action: `${CONFIG.BASE_URL}/process-intent`, method: "POST", maxLength: 300, playBeep: true, timeout: 10 });
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: THE GLOBAL INTERRUPT (The Star Key `*`)
// ------------------------------------------------------------------------------
app.all("/interrupt-router", (req, res) => {
    const r = new VoiceResponse();
    // If you press STAR (*), it kills everything and sends you to the Main Menu
    if (req.body.Digits === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        // If you pressed something else by accident, it ignores it.
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// ROUTE: HISTORY MENUS
// ------------------------------------------------------------------------------
app.all("/zero-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "0") {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/history-entry`, method: "POST", timeout: 8 });
        // Notice we pass "/interrupt-router", so if they press '*', they go to main menu
        await playOrSayInterruptible(g, "History. Press 2 for previous songs, 3 for favorites, or Star to go back.", `${CONFIG.BASE_URL}/interrupt-router`);
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
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Star goes back
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// The list browser (Where you press 4 and 6 to move through songs)
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

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/browse-action`, method: "POST", timeout: 10 });
    await playOrSayInterruptible(g, menuText, `${CONFIG.BASE_URL}/interrupt-router`);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/browse-action", (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const d = req.body.Digits;

    if (d === "*") { 
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Star goes back to main menu
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--; // Move array index backwards
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++; // Move array index forwards
        r.redirect(`${CONFIG.BASE_URL}/browse-menu`);
    } else if (d === "5") {
        searchAndDownloadYTDLP(req.body.CallSid, session.browseList[session.browseIndex], false);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`); // Play the song
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
// ROUTE: PROCESSING YOUR VOICE RECORDING
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
        const isLong = intentData.intent === 'music_long'; // Checks if you asked for a podcast
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
// ROUTE: CHAT WAIT LOOP (Keeps the phone connected while AI thinks)
// ------------------------------------------------------------------------------
app.all("/chat-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = chatQueue.get(req.body.CallSid);
    if (!task) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (task.status === 'done') {
        // Play AI Response inside a Gather so '*' can stop it mid-sentence
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/interrupt-router`, method: "POST", timeout: 1 });
        if (task.ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${task.ttsFilename}`);
        else g.say({ language: isHebrewText(task.replyText) ? 'he-IL' : 'en-US' }, task.replyText);
        
        // After AI finishes speaking, immediately record again to keep the conversation going!
        r.record({ action: `${CONFIG.BASE_URL}/process-chat-reply`, method: "POST", maxLength: 300, playBeep: true, timeout: 10 });
        
    } else if (task.status === 'error') {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 }); // Pause 3 seconds and check again to avoid Twilio timeouts
        r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// Handles continuous conversation
app.all("/process-chat-reply", async (req, res) => {
    const r = new VoiceResponse();
    if (!req.body.RecordingUrl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    const base64Audio = await fetchTwilioRecording(req.body.RecordingUrl);
    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
    
    // If you were silent, go back to main menu
    if (!intentData) {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    // Pass the new voice clip to the AI (it remembers the previous context!)
    chatQueue.set(req.body.CallSid, { status: 'pending' });
    chatWithGemini(req.body.From, intentData.query).then(async (replyText) => {
        const ttsFilename = await generateFreeTTS(replyText);
        chatQueue.set(req.body.CallSid, { status: 'done', ttsFilename, replyText });
    }).catch(() => chatQueue.set(req.body.CallSid, { status: 'error' }));

    r.redirect(`${CONFIG.BASE_URL}/chat-wait-loop`);
    res.type("text/xml").send(r.toString());
});


// ------------------------------------------------------------------------------
// ROUTE: MUSIC WAIT LOOP (Keeps the phone connected while song downloads)
// ------------------------------------------------------------------------------
app.all("/music-wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const dl = downloadQueue.get(req.body.CallSid);
    if (!dl) { r.redirect(`${CONFIG.BASE_URL}/twiml`); return res.type("text/xml").send(r.toString()); }

    if (dl.status === 'done') {
        // Play the song inside a Gather! If you press STAR during the song, it cuts it off and goes to main menu.
        const g1 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/interrupt-router`, method: "POST", timeout: 0 });
        g1.play(dl.url);
        
        // Post-song menu (Happens after the song naturally finishes)
        const g2 = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/post-music-action`, method: "POST", timeout: 8 });
        await playOrSayInterruptible(g2, "Press 2 to favorite, or Star for menu.", `${CONFIG.BASE_URL}/interrupt-router`);
        
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else if (dl.status === 'error' || Date.now() - dl.startTime > 60000) {
        await playOrSayInterruptible(r, "Error downloading.", `${CONFIG.BASE_URL}/interrupt-router`);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.pause({ length: 3 }); // Pause 3 seconds and check again
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// Action when the song finishes naturally
app.all("/post-music-action", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "2") {
        const dl = downloadQueue.get(req.body.CallSid);
        if (dl && dl.query) saveLikedSong(req.body.From, dl.query);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Handles STAR (*) or any other button
    }
    res.type("text/xml").send(r.toString());
});

// Turn on the server!
app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
