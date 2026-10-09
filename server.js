// ==============================================================================
// 1. IMPORTS & SETUP (Loading the modules needed for the Voice OS)
// ==============================================================================
console.log("🚀 Starting Voice OS Phase 1: MONGODB + NEW MAIN MENU + YNET NEWS...");

import express from "express";               // Web server framework for Twilio webhooks
import dotenv from "dotenv";                 // Loads environment variables (like MONGODB_URI)
import twilio from "twilio";                 // Twilio SDK for generating voice responses
import { GoogleGenerativeAI } from "@google/generative-ai"; // Google's AI brain
import path from "path";                     // Node.js tool to find file paths
import fs from "fs";                         // Node.js tool to read/write temp files
import { spawn } from "child_process";       // Allows us to run yt-dlp and edge-tts in the background
import { v4 as uuidv4 } from "uuid";         // Generates random IDs for audio files
import { MongoClient } from "mongodb";       // NEW: Connects to your free cloud database!
import RSSParser from "rss-parser";          // NEW: Parses XML files from Ynet News

dotenv.config(); // Activate the hidden variables

// ==============================================================================
// 2. MONGODB CLOUD DATABASE INITIALIZATION
// ==============================================================================
// We create a new MongoDB client using the URI you put in Render
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db; // This will hold our database connection
let usersCol; // This will hold the "Users" table (collection)

// This function connects to the cloud database when the server starts
async function connectDB() {
    try {
        await mongoClient.connect(); // Actually connects over the internet
        db = mongoClient.db("VoiceOS"); // Creates/opens a database named "VoiceOS"
        usersCol = db.collection("users"); // Creates/opens a table named "users"
        console.log("✅ MongoDB Connected Successfully!");
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err);
    }
}
connectDB(); // Run the connection immediately

// ------------------------------------------------------------------------------
// DATABASE HELPER FUNCTIONS (Now Async because Cloud DB takes milliseconds to reply)
// ------------------------------------------------------------------------------

// Fetches a user from Mongo. If they don't exist, it creates a blank profile.
async function getUser(phone) {
    let user = await usersCol.findOne({ phone: phone });
    if (!user) {
        user = { phone, music_history: [], chat_history: [], likes: [], settings: {} };
        await usersCol.insertOne(user);
    }
    return user;
}

// Saves a song to history (keeps last 10)
async function saveMusicHistory(phone, songQuery) {
    let user = await getUser(phone);
    user.music_history = user.music_history.filter(s => s !== songQuery); // Remove duplicates
    user.music_history.unshift(songQuery); // Add to the front
    if (user.music_history.length > 10) user.music_history.pop(); // Keep only 10
    await usersCol.updateOne({ phone }, { $set: { music_history: user.music_history } }); // Save to cloud
}

// Saves a chat message to history (keeps last 10)
async function saveChatHistory(phone, role, text) {
    let user = await getUser(phone);
    user.chat_history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
    if (user.chat_history.length > 10) user.chat_history = user.chat_history.slice(-10);
    await usersCol.updateOne({ phone }, { $set: { chat_history: user.chat_history } });
}

// ==============================================================================
// 3. SERVER SETTINGS & IN-MEMORY QUEUES
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000, // Render sets the port automatically
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com", 
    DOWNLOAD_DIR: "/tmp", // Temporary folder for downloaded mp3s
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    VERIFIED_CALLERS: ["+972548498889", "+972554402506", "+972525585720", "+972528263032", "+972583230268"],
    GEMINI_KEYS: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k)
};

// Create the temporary download folder if it doesn't exist
if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_DIR);

function isHebrewText(text) { return /[\u0590-\u05FF]/.test(text); }

// These variables just hold temporary data while a phone call is active (they reset when call ends)
const downloadQueue = new Map();
const chatQueue = new Map();
const sessions = new Map(); 

function getSession(callSid) {
    if (!sessions.has(callSid)) sessions.set(callSid, { browseType: null, browseIndex: 0, browseList: [] });
    return sessions.get(callSid);
}

// ==============================================================================
// 4. AUDIO TOOLS (Text-to-Speech & Downloading)
// ==============================================================================
// Converts Text into a spoken MP3 file using Edge-TTS
async function generateFreeTTS(text) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n]/g, ' ').trim();
        if (!safeText) return resolve(null);
        
        const voice = isHebrewText(safeText) ? 'he-IL-HilaNeural' : 'en-US-ChristopherNeural';
        const child = spawn('edge-tts',['--text', safeText, '--voice', voice, '--write-media', outputPath]);
        
        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) }, 300000); // Erase after 5 min
                resolve(filename);
            } else { resolve(null); }
        });
    });
}

// Downloads the user's voice recording from Twilio's servers
async function fetchTwilioRecording(recordingUrl) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(recordingUrl + ".mp3", { headers: { "Authorization": authHeader } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString('base64'); // Converts audio to text string so Gemini can read it
    } catch (e) { return null; }
}

// ==============================================================================
// 5. YNET NEWS (MIVZAKIM) RSS PARSER - PHASE 1
// ==============================================================================
const rssParser = new RSSParser();

// Fetches the live XML feed from Ynet and converts it to JavaScript Objects
async function fetchYnetNews() {
    try {
        // Ynet's Mivzakim URL
        const feed = await rssParser.parseURL('https://www.ynet.co.il/Integration/StoryRss3082.xml');
        return feed.items; // Returns an array of news articles
    } catch (e) {
        console.error("RSS Fetch Error:", e);
        return [];
    }
}

// ==============================================================================
// 6. EXPRESS WEB SERVER & CALL ROUTES
// ==============================================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const VoiceResponse = twilio.twiml.VoiceResponse;

app.get("/", (req, res) => res.send("Voice OS is awake!")); // Keeps server alive for UptimeRobot

// Serves generated MP3 files back to Twilio
app.get("/music/:filename", (req, res) => {
    const f = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
    } else res.status(404).send("File Gone");
});

// A helper to play TTS audio but allow the user to press a button to interrupt it
async function gatherPlayOrSay(r, text, actionUrl, timeoutVal) {
    const ttsFilename = await generateFreeTTS(text);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: actionUrl, method: "POST", timeout: timeoutVal });
    if (ttsFilename) g.play(`${CONFIG.BASE_URL}/music/${ttsFilename}`);
    else g.say({ language: isHebrewText(text) ? 'he-IL' : 'en-US' }, text);
}

// ------------------------------------------------------------------------------
// NEW MAIN MENU (The Gateway to the OS)
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    // Reject unknown callers for security
    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) { const r = new VoiceResponse(); r.reject(); return res.type("text/xml").send(r.toString()); }
    
    const r = new VoiceResponse();
    // Welcome message offering the 4 systems. (Star to cancel at any time).
    const menuText = "Welcome to the system. Press 1 for AI Chat. Press 2 for Music. Press 3 for Podcasts. Press 4 for News. Or press Star at any time to return here.";
    
    await gatherPlayOrSay(r, menuText, `${CONFIG.BASE_URL}/main-menu-router`, 5);
    res.type("text/xml").send(r.toString());
});

// Routes the user based on which button (1-4) they pressed
app.all("/main-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;

    if (d === "1") {
        // AI SYSTEM (Temporary redirect until Phase 4)
        await gatherPlayOrSay(r, "AI System. Please speak your question after the beep.", `${CONFIG.BASE_URL}/twiml`, 0);
        r.record({ action: `${CONFIG.BASE_URL}/process-intent-chat`, method: "POST", maxLength: 300, playBeep: true, timeout: 5 });
    } 
    else if (d === "2") {
        // MUSIC SYSTEM (Temporary redirect until Phase 2)
        await gatherPlayOrSay(r, "Music System. Please speak the song name after the beep.", `${CONFIG.BASE_URL}/twiml`, 0);
        r.record({ action: `${CONFIG.BASE_URL}/process-intent-music`, method: "POST", maxLength: 300, playBeep: true, timeout: 5 });
    } 
    else if (d === "3") {
        // PODCAST SYSTEM (Placeholder until Phase 3)
        await gatherPlayOrSay(r, "Podcasts are coming soon in Phase 3. Returning to menu.", `${CONFIG.BASE_URL}/twiml`, 1);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    } 
    else if (d === "4") {
        // NEWS SYSTEM (Live!)
        await gatherPlayOrSay(r, "Fetching latest news...", `${CONFIG.BASE_URL}/twiml`, 0);
        r.redirect(`${CONFIG.BASE_URL}/news-init`);
    } 
    else {
        // Any other button goes back to Main Menu
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// YNET NEWS LOGIC (PHASE 1 FEATURE)
// ------------------------------------------------------------------------------
// This fetches the news and sets up the user's session
app.all("/news-init", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    
    const articles = await fetchYnetNews(); // Downloads the RSS Feed
    if (articles.length === 0) {
        await gatherPlayOrSay(r, "Could not fetch news right now. Returning.", `${CONFIG.BASE_URL}/twiml`, 1);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    // Save the articles to the user's temporary call session
    session.browseType = 'news';
    session.browseList = articles;
    session.browseIndex = 0; // Start at the newest article (index 0)
    
    r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    res.type("text/xml").send(r.toString());
});

// Reads the headline and prompts for next actions
app.all("/news-browser", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const article = session.browseList[session.browseIndex];

    // Menu options for news
    const menuText = `Mivzak. ${article.title}. Press 6 for next. Press 4 for previous. Press 8 for details.`;
    
    // Listen for their button press (4, 6, 8, or *)
    await gatherPlayOrSay(r, menuText, `${CONFIG.BASE_URL}/news-action`, 10);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`); // Failsafe if they do nothing
    res.type("text/xml").send(r.toString());
});

// Handles the logic when they press 4, 6, or 8 in the News app
app.all("/news-action", async (req, res) => {
    const r = new VoiceResponse();
    const session = getSession(req.body.CallSid);
    const d = req.body.Digits;

    if (d === "*") { 
        r.redirect(`${CONFIG.BASE_URL}/twiml`); // Star = Exit to Main Menu
    } 
    else if (d === "6") {
        // Go to next (older) article
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++; 
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    } 
    else if (d === "4") {
        // Go to previous (newer) article
        if (session.browseIndex > 0) session.browseIndex--; 
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    } 
    else if (d === "8") {
        // Read full details of the current article
        const article = session.browseList[session.browseIndex];
        const detailsText = `Details. ${article.contentSnippet || "No further details available."}. Returning to headline.`;
        
        await gatherPlayOrSay(r, detailsText, `${CONFIG.BASE_URL}/news-action`, 1);
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    } 
    else {
        r.redirect(`${CONFIG.BASE_URL}/news-browser`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// GLOBAL CANCEL (The Star Key *)
// ------------------------------------------------------------------------------
app.all("/interrupt-router", (req, res) => {
    const r = new VoiceResponse();
    if (req.body.Digits === "*") { r.redirect(`${CONFIG.BASE_URL}/twiml`); } 
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 7. ANTI-CRASH SHIELDS & START SERVER
// ==============================================================================
// These shields prevent the entire server from crashing if a random error occurs
process.on('uncaughtException', (err) => console.error('Caught exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(CONFIG.PORT, () => console.log(`🚀 Server Online: PORT ${CONFIG.PORT}`));
