// ==============================================================================
// 🚀 VOICE OS v10.0 MASTER: FLAWLESS, FAST & HIGHLY DURABLE
// ==============================================================================
import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { MongoClient, ObjectId } from "mongodb";
import RSSParser from "rss-parser";

dotenv.config();

const VoiceResponse = twilio.twiml.VoiceResponse;
const rssParser = new RSSParser();

// ------------------------------------------------------------------------------
// ⚙️ CONFIGURATION & SECURITY
// ------------------------------------------------------------------------------
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: (process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com").replace(/\/$/, ""),
    DOWNLOAD_DIR: "/tmp/voice_os_media",
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
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
        process.env.GEMINI_API_KEY_3
    ].filter(Boolean)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) {
    fs.mkdirSync(CONFIG.DOWNLOAD_DIR, { recursive: true });
}

// ------------------------------------------------------------------------------
// 💾 MONGODB DATABASE LAYER
// ------------------------------------------------------------------------------
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db, usersCol, podcastsCol;

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("VoiceOS_v10");
        usersCol = db.collection("users");
        podcastsCol = db.collection("podcasts_cache");
        console.log("✅ MongoDB Connected Successfully.");
        await syncPodcasts();
    } catch (err) {
        console.error("❌ MongoDB Connection Fatal Error:", err);
    }
}
connectDB();

async function getUser(phone) {
    let user = await usersCol.findOne({ phone });
    if (!user) {
        user = {
            phone,
            active_chat_id: null,
            chats: [], // [{ id, title, isSaved: false, turns: [{ role, text }] }]
            music_history: [],
            likes: [],
            playlists: { "Favorites": [] }, // { playlistName: [songQuery] }
            settings: {
                voice_he: "he-IL-HilaNeural",
                voice_en: "en-US-ChristopherNeural",
                search_engine: "scsearch1:", // "scsearch1:" (Soundcloud) or "ytsearch1:" (YouTube)
                system_prompt_id: "default"   // "default", "concise", "scholar", "creative"
            }
        };
        await usersCol.insertOne(user);
    }
    return user;
}

async function updateUser(phone, updateQuery) {
    return await usersCol.updateOne({ phone }, updateQuery);
}

// ------------------------------------------------------------------------------
// 🧠 GEMINI MULTI-KEY ROTATION & HELPERS
// ------------------------------------------------------------------------------
const SYSTEM_PROMPTS = {
    default: "You are a fast, intelligent phone voice assistant. Keep answers natural, accurate, and concise (2-4 sentences max). Respond in the exact language spoken.",
    concise: "Answer in strictly ONE punchy sentence. No introductory filler words. Respond in the exact language spoken.",
    scholar: "You are an encyclopedic expert. Deliver deep, accurate, intellectual explanations in 3-5 sentences.",
    creative: "You are a witty, charismatic assistant with clever insights and humor. Keep replies conversational."
};

async function executeGeminiWithFailover(apiTask) {
    for (let i = 0; i < CONFIG.GEMINI_KEYS.length; i++) {
        const key = CONFIG.GEMINI_KEYS[i];
        try {
            const genAI = new GoogleGenerativeAI(key);
            return await apiTask(genAI);
        } catch (err) {
            console.warn(`⚠️ Gemini Key [${i}] error: ${err.message}. Failing over...`);
        }
    }
    throw new Error("All configured Gemini API keys exhausted or rate-limited.");
}

async function transcribeAndAnswer(phone, base64Audio, chatId = null) {
    const user = await getUser(phone);
    const systemInstruction = SYSTEM_PROMPTS[user.settings?.system_prompt_id || "default"];

    let session = user.chats.find(c => c.id === chatId);
    if (!session) {
        session = { id: uuidv4(), title: "New Conversation", isSaved: false, createdAt: new Date(), turns: [] };
        await updateUser(phone, { $push: { chats: session }, $set: { active_chat_id: session.id } });
    }

    return await executeGeminiWithFailover(async (genAI) => {
        // Step 1: Transcribe user audio
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const sttPrompt = "Transcribe the exact spoken words from this audio. If silent or unintelligible, reply 'SILENCE'.";
        const sttResult = await model.generateContent([
            sttPrompt, 
            { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
        ]);
        const userText = sttResult.response.text().trim();

        if (userText === "SILENCE" || !userText) {
            return { userText: null, replyText: "I could not hear anything. Please try again." };
        }

        // Step 2: Append user turn
        session.turns.push({ role: "user", text: userText });
        if (session.turns.length === 1) {
            session.title = userText.slice(0, 35);
        }

        // Step 3: Run grounded conversational model
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: [{ googleSearch: {} }],
            systemInstruction
        });

        const formattedHistory = session.turns.slice(0, -1).map(t => ({
            role: t.role === "user" ? "user" : "model",
            parts: [{ text: t.text }]
        }));

        const chat = chatModel.startChat({ history: formattedHistory });
        const response = await chat.sendMessage(userText);
        const replyText = response.response.text().replace(/\*/g, "").trim();

        session.turns.push({ role: "model", text: replyText });

        // Keep last 16 turns per session for performance
        if (session.turns.length > 16) {
            session.turns = session.turns.slice(-16);
        }

        await updateUser(phone, { 
            $set: { 
                "chats.$[elem].turns": session.turns,
                "chats.$[elem].title": session.title 
            } 
        }, { arrayFilters: [{ "elem.id": session.id }] });

        return { userText, replyText, session };
    });
}

// ------------------------------------------------------------------------------
// 🔊 AUDIO ENGINE: EDGE-TTS & FFMPEG
// ------------------------------------------------------------------------------
function isHebrew(text) { 
    return /[\u0590-\u05FF]/.test(text); 
}

async function generateTTS(text, userSettings = {}) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = text.replace(/["'\n\r]/g, " ").trim();
        if (!safeText) return resolve(null);

        const voice = isHebrew(safeText)
            ? (userSettings.voice_he || "he-IL-HilaNeural")
            : (userSettings.voice_en || "en-US-ChristopherNeural");

        const child = spawn("edge-tts", ["--text", safeText, "--voice", voice, "--write-media", outputPath]);

        child.on("close", (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                // Auto cleanup after 5 minutes
                setTimeout(() => {
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                }, 300000);
                resolve(filename);
            } else {
                resolve(null);
            }
        });
    });
}

async function playSay(twimlResponse, text, userSettings = {}) {
    const filename = await generateTTS(text, userSettings);
    if (filename) {
        twimlResponse.play(`${CONFIG.BASE_URL}/audio/${filename}`);
    } else {
        twimlResponse.say({ language: isHebrew(text) ? "he-IL" : "en-US" }, text);
    }
}

async function fetchTwilioRecording(url) {
    try {
        await new Promise(r => setTimeout(r, 600));
        const auth = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(`${url}.mp3`, { headers: { Authorization: auth } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer()).toString("base64");
    } catch {
        return null;
    }
}

// ------------------------------------------------------------------------------
// 📻 IN-MEMORY CALL & PLAYER SESSIONS
// ------------------------------------------------------------------------------
const callSessions = new Map();

function getCall(callSid) {
    if (!callSessions.has(callSid)) {
        callSessions.set(callSid, {
            mode: null,
            chatId: null,
            chatTurnIdx: 0,
            browseType: null, // "history", "likes", "chats"
            browseIndex: 0,
            browseList: [],
            player: {
                url: null,
                offset: 0,
                volume: 1.0,
                startTime: 0,
                isPaused: false,
                isPodcast: false,
                title: "",
                playlist: [],
                playlistIdx: 0
            }
        });
    }
    return callSessions.get(callSid);
}

// ------------------------------------------------------------------------------
// 🎙️ PODCAST AUTO-UPDATER CRON
// ------------------------------------------------------------------------------
const PODCAST_REGISTRY = [
    { id: 1, name: "עושים היסטוריה", term: "עושים+היסטוריה" },
    { id: 2, name: "בזמן שעבדתם", term: "בזמן+שעבדתם" },
    { id: 3, name: "אחד ביום", term: "אחד+ביום" },
    { id: 4, name: "עושים טכנולוגיה", term: "עושים+טכנולוגיה" },
    { id: 5, name: "התשובה עם דורון פישלר", term: "התשובה" }
];

async function syncPodcasts() {
    console.log("🔄 Background Syncing Top 5 Israeli Podcasts...");
    for (const pod of PODCAST_REGISTRY) {
        try {
            const itunes = await fetch(`https://itunes.apple.com/search?term=${pod.term}&entity=podcast`);
            const data = await itunes.json();
            if (!data.results?.[0]?.feedUrl) continue;

            const feed = await rssParser.parseURL(data.results[0].feedUrl);
            const episodes = (feed.items || []).slice(0, 10).map(item => ({
                title: item.title,
                pubDate: item.pubDate,
                enclosureUrl: item.enclosure?.url,
                duration: item.itunes?.duration || ""
            })).filter(ep => ep.enclosureUrl);

            await podcastsCol.updateOne(
                { podcastId: pod.id },
                { $set: { podcastId: pod.id, name: pod.name, episodes, lastUpdated: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            console.error(`Failed to sync podcast ${pod.name}:`, err.message);
        }
    }
    console.log("✅ Podcasts Cached.");
}
setInterval(syncPodcasts, 30 * 60 * 1000); // Sync every 30 minutes

// ------------------------------------------------------------------------------
// 🌐 EXPRESS WEB SERVER & AUDIO PIPING
// ------------------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.send("🚀 Voice O.S. Master v10 Online."));

// Serve TTS temporary files
app.get("/audio/:filename", (req, res) => {
    const filePath = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.setHeader("Content-Type", "audio/mpeg");
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).send("File expired");
    }
});

// Real-Time Audio Streaming Engine with Offset & Dynamic Volume Transcoding
app.get("/stream-audio", (req, res) => {
    const fileUrl = req.query.url;
    const offset = Math.max(0, parseFloat(req.query.offset) || 0);
    const volume = parseFloat(req.query.vol) || 1.0;

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");

    // Telephony transcode pipe: Mono, 16000Hz MP3 stream with precise offset & volume
    const ffmpegArgs = [
        "-ss", offset.toString(),
        "-i", fileUrl,
        "-filter:a", `volume=${volume}`,
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "libmp3lame",
        "-b:a", "32k",
        "-f", "mp3",
        "pipe:1"
    ];

    const child = spawn("ffmpeg", ffmpegArgs);
    child.stdout.pipe(res);

    req.on("close", () => {
        child.kill("SIGKILL");
    });
});

// ------------------------------------------------------------------------------
// 🎛️ ROOT MAIN MENU
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    const r = new VoiceResponse();

    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) {
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    const user = await getUser(caller);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/main-router`, timeout: 6 });
    await playSay(g, "Main Menu. 1 for Chat. 2 for Music. 3 for Podcasts. 4 for News.", user.settings);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
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

// ==============================================================================
// 🧠 SYSTEM 1: GEMINI AI CONVERSATIONAL OS
// ==============================================================================
app.all("/chat-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-menu-router`, timeout: 6 });
    await playSay(g, "Chat Menu. 1 for New Chat. 2 for History. 3 for Saved Chats. 4 for Settings.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const user = await getUser(req.body.From);
    const session = getCall(req.body.CallSid);

    if (d === "1") {
        // Create new active chat
        const newChatId = uuidv4();
        await updateUser(req.body.From, { $set: { active_chat_id: newChatId } });
        session.chatId = newChatId;

        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/twiml`, timeout: 0 });
        await playSay(g, "Start speaking your question after the tone. Press pound when done.", user.settings);
        r.record({
            action: `${CONFIG.BASE_URL}/chat-input-handler`,
            finishOnKey: "#",
            maxLength: 90,
            playBeep: true
        });
    } else if (d === "2") {
        session.browseType = "chat_history";
        session.browseList = [...user.chats].reverse();
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "3") {
        session.browseType = "chat_saved";
        session.browseList = user.chats.filter(c => c.isSaved).reverse();
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "4") {
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// Chat Recording & AI Generation
app.all("/chat-input-handler", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);

    if (!req.body.RecordingUrl) {
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);
    if (!base64) {
        await playSay(r, "Audio processing failed. Please repeat.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    try {
        const activeId = session.chatId || user.active_chat_id;
        const result = await transcribeAndAnswer(phone, base64, activeId);

        if (!result.userText) {
            await playSay(r, "I did not detect speech.", user.settings);
            r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
            return res.type("text/xml").send(r.toString());
        }

        session.chatId = result.session.id;
        const modelTurns = result.session.turns.filter(t => t.role === "model");
        session.chatTurnIdx = modelTurns.length - 1;

        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } catch (err) {
        console.error("AI Error:", err);
        await playSay(r, "An error occurred with the AI engine.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// Chat Turn Playback with 1 (continue), 3 (save), 4/6 (prev/next turn), 5 (repeat)
app.all("/chat-turn-player", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const session = getCall(req.body.CallSid);

    const chat = user.chats.find(c => c.id === session.chatId);
    if (!chat || !chat.turns.length) {
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const modelTurns = chat.turns.filter(t => t.role === "model");
    const currentReply = modelTurns[session.chatTurnIdx]?.text || "No reply found.";

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-turn-action`, timeout: 7 });
    await playSay(g, currentReply, user.settings);
    await playSay(g, "Press 1 to answer, 3 to save chat, 4 for earlier reply, 6 for next, 5 to replay.", user.settings);

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-turn-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = await getUser(phone);
    const session = getCall(req.body.CallSid);

    const chat = user.chats.find(c => c.id === session.chatId);
    const modelTurns = chat ? chat.turns.filter(t => t.role === "model") : [];

    if (d === "1") {
        // Continue conversational flow
        r.record({
            action: `${CONFIG.BASE_URL}/chat-input-handler`,
            finishOnKey: "#",
            maxLength: 90,
            playBeep: true
        });
    } else if (d === "3") {
        // Star / Mark Chat
        await updateUser(phone, { $set: { "chats.$[elem].isSaved": true } }, { arrayFilters: [{ "elem.id": session.chatId }] });
        await playSay(r, "Chat saved to favorites.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "4") {
        // Previous turn
        if (session.chatTurnIdx > 0) session.chatTurnIdx--;
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "6") {
        // Next turn
        if (session.chatTurnIdx < modelTurns.length - 1) session.chatTurnIdx++;
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "5") {
        // Repeat
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// Chat Browser: History and Saved Chats
app.all("/chat-browser", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const session = getCall(req.body.CallSid);

    if (!session.browseList || !session.browseList.length) {
        await playSay(r, "No chats found in this category.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const currentChat = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-browse-action`, timeout: 8 });
    await playSay(g, `Chat: ${currentChat.title}. Press 5 to enter, 4 for newer, 6 for older, 7 to search, 9 to delete.`, user.settings);
    
    r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-browse-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);

    if (d === "5") {
        // Enter and continue this chat
        session.chatId = session.browseList[session.browseIndex].id;
        const chat = user.chats.find(c => c.id === session.chatId);
        const modelTurns = chat.turns.filter(t => t.role === "model");
        session.chatTurnIdx = Math.max(0, modelTurns.length - 1);
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "7") {
        // Voice Search in Chats
        await playSay(r, "Say the keyword to search your past chats.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/chat-search-process`, maxLength: 8, playBeep: true });
    } else if (d === "9") {
        // Delete chat
        const targetId = session.browseList[session.browseIndex].id;
        await updateUser(phone, { $pull: { chats: { id: targetId } } });
        await playSay(r, "Chat deleted.", user.settings);
        const updated = await getUser(phone);
        session.browseList = session.browseType === "chat_saved" 
            ? updated.chats.filter(c => c.isSaved).reverse()
            : [...updated.chats].reverse();
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/chat-search-process", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);
    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);

    if (base64) {
        const query = await executeGeminiWithFailover(async (genAI) => {
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const res = await model.generateContent(["Extract the single search word or phrase spoken.", { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
            return res.response.text().trim();
        });

        const matches = user.chats.filter(c => 
            c.title.toLowerCase().includes(query.toLowerCase()) || 
            c.turns.some(t => t.text.toLowerCase().includes(query.toLowerCase()))
        );

        if (matches.length > 0) {
            session.browseList = matches;
            session.browseIndex = 0;
            await playSay(r, `Found ${matches.length} matching conversations.`, user.settings);
            r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
            return res.type("text/xml").send(r.toString());
        }
    }

    await playSay(r, "No matching chats found.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    res.type("text/xml").send(r.toString());
});

// Chat Settings: Voice, Model & Persona
app.all("/chat-settings-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-settings-router`, timeout: 6 });
    await playSay(g, "Settings. 1 for Hebrew Voice. 2 for English Voice. 3 for System Persona.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-settings-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = await getUser(phone);

    if (d === "1") {
        // Toggle Hebrew Voice (Hila / Avri)
        const nextHe = user.settings.voice_he === "he-IL-HilaNeural" ? "he-IL-AvriNeural" : "he-IL-HilaNeural";
        await updateUser(phone, { $set: { "settings.voice_he": nextHe } });
        user.settings.voice_he = nextHe;
        await playSay(r, `קול עברי שונה ל${nextHe.includes("Hila") ? "הילה" : "אברי"}`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else if (d === "2") {
        // Cycle English Voice (Christopher / Jenny / Guy)
        const enVoices = ["en-US-ChristopherNeural", "en-US-JennyNeural", "en-US-GuyNeural"];
        const currentIdx = enVoices.indexOf(user.settings.voice_en);
        const nextEn = enVoices[(currentIdx + 1) % enVoices.length];
        await updateUser(phone, { $set: { "settings.voice_en": nextEn } });
        user.settings.voice_en = nextEn;
        await playSay(r, `English voice set.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else if (d === "3") {
        // Toggle Personas
        const personas = ["default", "concise", "scholar", "creative"];
        const curIdx = personas.indexOf(user.settings.system_prompt_id);
        const nextPersona = personas[(curIdx + 1) % personas.length];
        await updateUser(phone, { $set: { "settings.system_prompt_id": nextPersona } });
        user.settings.system_prompt_id = nextPersona;
        await playSay(r, `Persona set to ${nextPersona}.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 🎵 SYSTEM 2: MUSIC OS & PLAYLIST SYSTEM
// ==============================================================================
app.all("/music-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/music-router`, timeout: 6 });
    await playSay(g, "Music. 1 Search. 2 History. 3 Saved Songs. 4 Playlists. 5 Settings.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = await getUser(phone);
    const session = getCall(req.body.CallSid);

    if (d === "1") {
        await playSay(r, "Say the song and artist name.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/music-search-exec`, maxLength: 10, playBeep: true });
    } else if (d === "2") {
        session.browseType = "music_history";
        session.browseList = user.music_history;
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "3") {
        session.browseType = "music_likes";
        session.browseList = user.likes;
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "4") {
        r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
    } else if (d === "5") {
        // Toggle Soundcloud vs YouTube
        const curEngine = user.settings.search_engine || "scsearch1:";
        const nextEngine = curEngine.startsWith("sc") ? "ytsearch1:" : "scsearch1:";
        await updateUser(phone, { $set: { "settings.search_engine": nextEngine } });
        user.settings.search_engine = nextEngine;
        await playSay(r, `Music engine set to ${nextEngine.includes("yt") ? "YouTube" : "SoundCloud"}.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// Search & Fast Download
app.all("/music-search-exec", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);

    if (!base64) {
        await playSay(r, "Could not capture query.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const songQuery = await executeGeminiWithFailover(async (genAI) => {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const res = await model.generateContent(["Extract song name and artist spoken.", { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
        return res.response.text().trim();
    });

    // Save to history
    await updateUser(phone, {
        $push: { music_history: { $each: [songQuery], $position: 0, $slice: 20 } }
    });

    const session = getCall(req.body.CallSid);
    session.player.title = songQuery;
    session.player.isPodcast = false;
    session.player.offset = 0;
    session.player.volume = 1.0;

    await playSay(r, `Searching ${songQuery}`, user.settings);
    initiateMusicDownload(req.body.CallSid, songQuery, user.settings.search_engine);

    r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    res.type("text/xml").send(r.toString());
});

function initiateMusicDownload(callSid, query, engine = "scsearch1:") {
    const fileId = uuidv4();
    const outputPath = path.join(CONFIG.DOWNLOAD_DIR, `${fileId}.mp3`);
    const marker = path.join(CONFIG.DOWNLOAD_DIR, `READY_${callSid}`);

    const args = [
        `${engine}${query}`,
        "-x", "--audio-format", "mp3",
        "--match-filter", "duration < 900",
        "--force-ipv4",
        "-o", outputPath
    ];

    const child = spawn("yt-dlp", args);
    child.on("close", (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
            const session = getCall(callSid);
            session.player.url = outputPath;
            fs.writeFileSync(marker, "ready");
            // Auto purge downloaded mp3 after 30 minutes
            setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 1800000);
        } else {
            fs.writeFileSync(marker, "error");
        }
    });
}

app.all("/music-download-wait-loop", (req, res) => {
    const r = new VoiceResponse();
    const marker = path.join(CONFIG.DOWNLOAD_DIR, `READY_${req.body.CallSid}`);

    if (fs.existsSync(marker)) {
        const status = fs.readFileSync(marker, "utf-8");
        fs.unlinkSync(marker);

        if (status === "ready") {
            r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
        } else {
            r.redirect(`${CONFIG.BASE_URL}/music-menu`);
        }
    } else {
        r.pause({ length: 2 });
        r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

// Music Browsing (History & Likes)
app.all("/music-browser", async (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (!session.browseList || !session.browseList.length) {
        await playSay(r, "Your list is empty.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const item = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/music-browse-action`, timeout: 8 });
    await playSay(g, `${item}. 5 to play. 4 newer. 6 older. 8 save. 9 remove.`, user.settings);
    
    r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/music-browse-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);
    const currentSong = session.browseList[session.browseIndex];

    if (d === "5") {
        // Play
        session.player.title = currentSong;
        session.player.offset = 0;
        session.player.volume = 1.0;
        initiateMusicDownload(req.body.CallSid, currentSong, user.settings.search_engine);
        r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "8") {
        // Save song
        await updateUser(phone, { $addToSet: { likes: currentSong } });
        await playSay(r, "Added to saved songs.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "9") {
        // Remove from list
        if (session.browseType === "music_likes") {
            await updateUser(phone, { $pull: { likes: currentSong } });
        } else {
            await updateUser(phone, { $pull: { music_history: currentSong } });
        }
        const updated = await getUser(phone);
        session.browseList = session.browseType === "music_likes" ? updated.likes : updated.music_history;
        session.browseIndex = 0;
        await playSay(r, "Removed.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// Playlists Subsystem
app.all("/playlist-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/playlist-router`, timeout: 6 });
    await playSay(g, "Playlists. 1 Play a playlist. 2 Create a playlist.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/playlist-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = await getUser(phone);

    if (d === "1") {
        const names = Object.keys(user.playlists || {});
        if (!names.length) {
            await playSay(r, "No playlists found.", user.settings);
            r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
        } else {
            let msg = "Choose playlist: ";
            names.forEach((name, i) => { msg += `Press ${i + 1} for ${name}. `; });
            const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/playlist-select-play`, timeout: 8 });
            await playSay(g, msg, user.settings);
        }
    } else if (d === "2") {
        await playSay(r, "Say the name for your new playlist.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/playlist-create-exec`, maxLength: 6, playBeep: true });
    } else {
        r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/playlist-create-exec", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);

    if (base64) {
        const name = await executeGeminiWithFailover(async (genAI) => {
            const m = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const res = await m.generateContent(["Extract name spoken.", { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
            return res.response.text().trim();
        });

        await updateUser(phone, { $set: { [`playlists.${name}`]: [] } });
        await playSay(r, `Playlist ${name} created.`, user.settings);
    }
    r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/playlist-select-play", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const names = Object.keys(user.playlists || {});
    const idx = parseInt(req.body.Digits) - 1;

    if (names[idx] && user.playlists[names[idx]].length > 0) {
        const session = getCall(req.body.CallSid);
        // Shuffle play
        session.player.playlist = [...user.playlists[names[idx]]].sort(() => 0.5 - Math.random());
        session.player.playlistIdx = 0;
        session.player.title = session.player.playlist[0];
        initiateMusicDownload(req.body.CallSid, session.player.title, user.settings.search_engine);
        r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    } else {
        await playSay(r, "Playlist is empty or invalid.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 🎛️ UNIVERSAL MEDIA PLAYER ENGINE (MUSIC & PODCASTS)
// ==============================================================================
app.all("/media-player-play", (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const p = session.player;

    if (p.isPaused) {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/media-player-action`, timeout: 3600 });
        g.say("Paused. Press 5 to resume.");
    } else {
        p.startTime = Date.now();
        const streamUrl = `${CONFIG.BASE_URL}/stream-audio?url=${encodeURIComponent(p.url)}&offset=${p.offset}&vol=${p.volume}`;
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/media-player-action`, timeout: 0 });
        g.play(streamUrl);
        r.redirect(`${CONFIG.BASE_URL}/media-player-finished`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/media-player-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const p = session.player;

    if (!p.isPaused) {
        p.offset += (Date.now() - p.startTime) / 1000;
    }

    if (d === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    // Controls
    if (d === "5") {
        p.isPaused = !p.isPaused;
    } else if (d === "8") {
        // Save options
        r.redirect(`${CONFIG.BASE_URL}/player-save-menu`);
        return res.type("text/xml").send(r.toString());
    } else if (d === "2") {
        // Volume adjustment
        r.redirect(`${CONFIG.BASE_URL}/player-volume-menu`);
        return res.type("text/xml").send(r.toString());
    }

    // Seeking Logic
    if (p.isPodcast) {
        // Podcast Seek: 4 = -5 min, 6 = +5 min
        if (d === "4") p.offset = Math.max(0, p.offset - 300);
        else if (d === "6") p.offset += 300;
        else if (d === "1") p.offset = Math.max(0, p.offset - 30);
        else if (d === "3") p.offset += 30;
    } else {
        // Music Seek: 1 (-20s), 3 (+20s), 4 (-60s), 6 (+60s)
        if (d === "1") p.offset = Math.max(0, p.offset - 20);
        else if (d === "3") p.offset += 20;
        else if (d === "4") p.offset = Math.max(0, p.offset - 60);
        else if (d === "6") p.offset += 60;
    }

    r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    res.type("text/xml").send(r.toString());
});

// Player In-Flight Save Menu (Keypad 8)
app.all("/player-save-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/player-save-router`, timeout: 6 });
    await playSay(g, "Press 1 to add to Saved Songs. 2 to add to a Playlist.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    res.type("text/xml").send(r.toString());
});

app.all("/player-save-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);
    const currentTitle = session.player.title;

    if (d === "1") {
        await updateUser(phone, { $addToSet: { likes: currentTitle } });
        await playSay(r, "Saved to favorites.", user.settings);
    } else if (d === "2") {
        const names = Object.keys(user.playlists || {});
        if (names.length) {
            await updateUser(phone, { $addToSet: { [`playlists.${names[0]}`]: currentTitle } });
            await playSay(r, `Added to ${names[0]}.`, user.settings);
        }
    }
    r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    res.type("text/xml").send(r.toString());
});

// Player In-Flight Volume Menu (Keypad 2)
app.all("/player-volume-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/player-volume-router`, timeout: 5 });
    await playSay(g, "Volume. Press 4 for softer. 6 for louder.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    res.type("text/xml").send(r.toString());
});

app.all("/player-volume-router", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getCall(req.body.CallSid);
    const p = session.player;

    if (d === "4") p.volume = Math.max(0.3, p.volume - 0.3);
    else if (d === "6") p.volume = Math.min(2.0, p.volume + 0.3);

    r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    res.type("text/xml").send(r.toString());
});

app.all("/media-player-finished", (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const p = session.player;

    // Handle playlist auto-advance
    if (p.playlist.length && p.playlistIdx < p.playlist.length - 1) {
        p.playlistIdx++;
        p.title = p.playlist[p.playlistIdx];
        p.offset = 0;
        initiateMusicDownload(req.body.CallSid, p.title);
        r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 🎙️ SYSTEM 3: ISRAELI PODCASTS (DIRECT CDN STREAMING)
// ==============================================================================
app.all("/podcast-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    let msg = "Podcasts. ";
    PODCAST_REGISTRY.forEach((p) => { msg += `Press ${p.id} for ${p.name}. `; });

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/podcast-episodes-browser`, timeout: 8 });
    await playSay(g, msg, user.settings);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-episodes-browser", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const podId = parseInt(req.body.Digits);
    const podData = await podcastsCol.findOne({ podcastId: podId });

    if (!podData || !podData.episodes?.length) {
        await playSay(r, "Episodes currently updating. Please re-check shortly.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const session = getCall(req.body.CallSid);
    session.browseList = podData.episodes;
    session.browseIndex = 0;

    r.redirect(`${CONFIG.BASE_URL}/podcast-turn-browser`);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-turn-browser", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const session = getCall(req.body.CallSid);
    const ep = session.browseList[session.browseIndex];

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/podcast-browse-action`, timeout: 9 });
    await playSay(g, `${ep.title}. 5 to play. 4 newer. 6 older.`, user.settings);
    
    r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-browse-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getCall(req.body.CallSid);

    if (d === "5") {
        const ep = session.browseList[session.browseIndex];
        const p = session.player;
        p.url = ep.enclosureUrl; // Direct streaming via FFmpeg
        p.title = ep.title;
        p.isPodcast = true;
        p.offset = 0;
        p.volume = 1.0;
        p.isPaused = false;
        r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/podcast-turn-browser`);
    } else if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/podcast-turn-browser`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 📰 SYSTEM 4: YNET BREAKING NEWS ("MIVZAKIM")
// ==============================================================================
app.all("/news-init", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    try {
        const feed = await rssParser.parseURL("https://www.ynet.co.il/Integration/StoryRss3082.xml");
        const session = getCall(req.body.CallSid);
        session.browseList = feed.items || [];
        session.browseIndex = 0;

        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } catch {
        await playSay(r, "Could not fetch breaking news.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/news-reader", async (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (!session.browseList?.length) {
        await playSay(r, "No news items available.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const item = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/news-action`, timeout: 9 });
    await playSay(g, `Mivzak. ${item.title}. Press 6 for older. 4 for newer. 8 for full details.`, user.settings);
    
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/news-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (d === "6") {
        if (session.browseIndex < session.browseList.length - 1) session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else if (d === "4") {
        if (session.browseIndex > 0) session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else if (d === "8") {
        // Detailed Info: Author, Date & Full Content
        const item = session.browseList[session.browseIndex];
        const dateStr = item.pubDate ? new Date(item.pubDate).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "";
        const author = item.creator || item.author || "כתב ynet";
        const cleanContent = (item.contentSnippet || item.content || "אין פירוט נוסף").replace(/<[^>]*>/g, "");
        const details = `פורסם בשעה ${dateStr} על ידי ${author}. ${cleanContent}`;

        await playSay(r, details, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// 🛡️ SERVER CRASH GUARDS & LISTENER
// ------------------------------------------------------------------------------
process.on("uncaughtException", (err) => console.error("Caught Exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Voice OS v10.0 MASTER LIVE on port ${CONFIG.PORT}`);
});
