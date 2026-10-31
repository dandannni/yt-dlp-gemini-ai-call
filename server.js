// ==============================================================================
// 🚀 VOICE OS v10.5 ENTERPRISE: COMPLETE SUITE (ALL FEATURES + ALL-HEBREW)
// ==============================================================================
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

// ------------------------------------------------------------------------------
// ⚙️ CONFIGURATION & COOKIES
// ------------------------------------------------------------------------------
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: (process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com").replace(/\/$/, ""),
    DOWNLOAD_DIR: "/tmp/voice_os_media",
    COOKIES_FILE: "/tmp/voice_os_media/cookies.txt",
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
    ].filter(Boolean),
    GEMINI_MODELS: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) {
    fs.mkdirSync(CONFIG.DOWNLOAD_DIR, { recursive: true });
}

// Decode YouTube Cookies if provided via Environment Variable
if (process.env.YTDLP_COOKIES_B64) {
    try {
        const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64").toString("utf-8");
        fs.writeFileSync(CONFIG.COOKIES_FILE, decoded);
        console.log("🍪 [COOKIES] YouTube cookies successfully written to:", CONFIG.COOKIES_FILE);
    } catch (err) {
        console.error("❌ [COOKIES] Failed to decode YTDLP_COOKIES_B64:", err.message);
    }
}

// ------------------------------------------------------------------------------
// 💾 MONGODB DATABASE
// ------------------------------------------------------------------------------
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let usersCol, podcastsCol;

async function connectDB() {
    try {
        await mongoClient.connect();
        const db = mongoClient.db("VoiceOS_v10");
        usersCol = db.collection("users");
        podcastsCol = db.collection("podcasts_cache");
        console.log("✅ [DB] Connected to MongoDB Atlas.");
        syncPodcasts();
    } catch (err) {
        console.error("❌ [DB ERROR]:", err.message);
    }
}
connectDB();

async function getUser(phone) {
    try {
        let user = await usersCol.findOne({ phone });
        if (!user) {
            user = {
                phone,
                active_chat_id: null,
                chats: [],
                music_history: [],
                likes: [],
                playlists: { "מועדפים": [] },
                settings: {
                    voice_he: "he-IL-HilaNeural",
                    voice_en: "en-US-ChristopherNeural",
                    search_engine: "ytsearch1:",
                    system_prompt_id: "default"
                }
            };
            await usersCol.insertOne(user);
        }
        return user;
    } catch (e) {
        console.warn("⚠️ [DB] Fallback user profile:", e.message);
        return {
            phone,
            chats: [],
            music_history: [],
            likes: [],
            playlists: { "מועדפים": [] },
            settings: { voice_he: "he-IL-HilaNeural", voice_en: "en-US-ChristopherNeural", search_engine: "ytsearch1:", system_prompt_id: "default" }
        };
    }
}

async function updateUser(phone, updateQuery, options = {}) {
    try {
        await usersCol.updateOne({ phone }, updateQuery, options);
    } catch (e) {
        console.error("❌ [DB UPDATE ERROR]:", e.message);
    }
}

// ------------------------------------------------------------------------------
// 🔊 AUDIO ENGINE: EDGE-TTS
// ------------------------------------------------------------------------------
function isHebrew(text) { 
    return /[\u0590-\u05FF]/.test(text); 
}

async function generateTTS(text, userSettings = {}) {
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);
        const safeText = (text || "").replace(/["'\n\r]/g, " ").trim();
        if (!safeText) return resolve(null);

        const voice = isHebrew(safeText)
            ? (userSettings?.voice_he || "he-IL-HilaNeural")
            : (userSettings?.voice_en || "en-US-ChristopherNeural");

        console.log(`🗣️ [TTS] (${voice}): "${safeText.slice(0, 45)}..."`);

        const child = spawn("python3", ["-m", "edge_tts", "--text", safeText, "--voice", voice, "--write-media", outputPath]);

        child.on("error", (err) => {
            console.warn("⚠️ [TTS] edge-tts spawn error:", err.message);
            resolve(null);
        });

        child.on("close", (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 300000);
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
    console.log(`📥 [TWILIO] Downloading audio from: ${url}.mp3`);
    try {
        await new Promise(r => setTimeout(r, 600));
        let headers = {};
        if (CONFIG.TWILIO_ACCOUNT_SID && CONFIG.TWILIO_AUTH_TOKEN) {
            headers["Authorization"] = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        }
        const res = await fetch(`${url}.mp3`, { headers });
        if (!res.ok) {
            console.error(`❌ [TWILIO] Download failed HTTP ${res.status}`);
            return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        console.log(`✅ [TWILIO] Audio ready: ${buffer.length} bytes`);
        return buffer.toString("base64");
    } catch (e) {
        console.error("❌ [TWILIO] Error fetching audio:", e.message);
        return null;
    }
}

// ------------------------------------------------------------------------------
// 🧠 GEMINI ENGINE WITH PROMPT PERSONAS & MULTI-MODEL FAILOVER
// ------------------------------------------------------------------------------
const SYSTEM_PERSONAS = {
    default: "אתה עוזר טלפוני חכם, מדויק ואדיב. ענה תמיד בעברית טבעית וברורה. ענה בקצרה (2 עד 3 משפטים בלבד) כדי שהמשתמש יוכל להאזין בנוחות בטלפון.",
    concise: "ענה אך ורק במשפט אחד קצר, מדויק ולעניין. ללא מילות פתיחה או ברכות מיותרות.",
    scholar: "אתה איש אשכולות ומלומד. ספק תשובות מעמיקות, מדויקות ואינטלקטואליות ב-3 עד 4 משפטים.",
    creative: "אתה עוזר שנון, מצחיק ומלא הומור. ענה בצורה משעשעת וחכמה."
};

async function executeGeminiWithFailover(apiTask) {
    for (const key of CONFIG.GEMINI_KEYS) {
        const genAI = new GoogleGenerativeAI(key);
        for (const modelName of CONFIG.GEMINI_MODELS) {
            try {
                return await apiTask(genAI, modelName);
            } catch (err) {
                console.warn(`⚠️ [GEMINI] Failover from ${modelName}: ${err.message}`);
            }
        }
    }
    throw new Error("All configured Gemini API keys and models exhausted!");
}

async function transcribeAndAnswer(phone, base64Audio, chatId = null) {
    const user = await getUser(phone);
    const systemPrompt = SYSTEM_PERSONAS[user.settings?.system_prompt_id || "default"];

    let session = user.chats.find(c => c.id === chatId);
    if (!session) {
        session = { id: uuidv4(), title: "שיחה חדשה", isSaved: false, createdAt: new Date(), turns: [] };
        user.chats.push(session);
    }

    return await executeGeminiWithFailover(async (genAI, modelName) => {
        console.log(`🤖 [GEMINI] Transcribing speech using ${modelName}...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        
        const sttResult = await model.generateContent([
            "תמלל במדויק את המילים שנאמרו בהקלטה זו. ענה אך ורק בטקסט הנאמר, ללא שום מילים נוספות, הסברים או מרכאות. אם שקט, כתוב SILENCE.", 
            { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
        ]);
        const userText = sttResult.response.text().trim();
        console.log(`🗣️ [GEMINI] Spoken text: "${userText}"`);

        if (userText === "SILENCE" || !userText) {
            return { userText: null, replyText: "לא הצלחתי לשמוע אותך. אנא נסה שוב." };
        }

        session.turns.push({ role: "user", text: userText });
        if (session.turns.length === 1) session.title = userText.slice(0, 32);

        const chatModel = genAI.getGenerativeModel({
            model: modelName,
            tools: [{ googleSearch: {} }],
            systemInstruction: systemPrompt
        });

        const history = session.turns.slice(0, -1).map(t => ({
            role: t.role === "user" ? "user" : "model",
            parts: [{ text: t.text }]
        }));

        const chat = chatModel.startChat({ history });
        const response = await chat.sendMessage(userText);
        const replyText = response.response.text().replace(/\*/g, "").trim();
        console.log(`🤖 [GEMINI] AI Reply: "${replyText.slice(0, 50)}..."`);

        session.turns.push({ role: "model", text: replyText });
        if (session.turns.length > 20) session.turns = session.turns.slice(-20);

        await updateUser(phone, { $set: { chats: user.chats, active_chat_id: session.id } });
        return { userText, replyText, session };
    });
}

// ------------------------------------------------------------------------------
// 📻 IN-MEMORY CALL SESSIONS
// ------------------------------------------------------------------------------
const callSessions = new Map();

function getCall(callSid) {
    if (!callSessions.has(callSid)) {
        callSessions.set(callSid, {
            chatId: null,
            chatTurnIdx: 0,
            browseType: null,
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
// 🎙️ PODCAST AUTO-UPDATER
// ------------------------------------------------------------------------------
const PODCAST_REGISTRY = [
    { id: 1, name: "עושים היסטוריה עם ערן ניצן", term: "עושים+היסטוריה" },
    { id: 2, name: "בזמן שעבדתם", term: "בזמן+שעבדתם" },
    { id: 3, name: "אחד ביום", term: "אחד+ביום" },
    { id: 4, name: "עושים טכנולוגיה", term: "עושים+טכנולוגיה" },
    { id: 5, name: "התשובה עם דורון פישלר", term: "התשובה" }
];

async function syncPodcasts() {
    console.log("🔄 [PODCASTS] Syncing Israeli podcast feeds...");
    for (const pod of PODCAST_REGISTRY) {
        try {
            const itunes = await fetch(`https://itunes.apple.com/search?term=${pod.term}&entity=podcast`);
            const data = await itunes.json();
            if (!data.results?.[0]?.feedUrl) continue;

            const feed = await rssParser.parseURL(data.results[0].feedUrl);
            const episodes = (feed.items || []).slice(0, 10).map(item => ({
                title: item.title,
                pubDate: item.pubDate,
                enclosureUrl: item.enclosure?.url
            })).filter(ep => ep.enclosureUrl);

            await podcastsCol?.updateOne(
                { podcastId: pod.id },
                { $set: { podcastId: pod.id, name: pod.name, episodes, lastUpdated: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            console.warn(`⚠️ [PODCASTS] Could not update ${pod.name}:`, err.message);
        }
    }
    console.log("✅ [PODCASTS] All feeds synced.");
}
setInterval(syncPodcasts, 30 * 60 * 1000);

// ------------------------------------------------------------------------------
// 🌐 EXPRESS APP & AUDIO STREAMER
// ------------------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.send("🚀 Voice OS v10.5 ENTERPRISE Online."));

app.get("/audio/:filename", (req, res) => {
    const filePath = path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.setHeader("Content-Type", "audio/mpeg");
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).send("File expired");
    }
});

app.get("/stream-audio", (req, res) => {
    const fileUrl = req.query.url;
    const offset = Math.max(0, parseFloat(req.query.offset) || 0);
    const volume = parseFloat(req.query.vol) || 1.0;

    console.log(`📻 [STREAM] Streaming: offset=${offset}s, vol=${volume}, src=${fileUrl?.slice(0, 40)}...`);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");

    const ffmpegArgs = [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    child.stderr.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes("Error") || msg.includes("Failed")) {
            console.error("❌ [FFMPEG ERROR]:", msg);
        }
    });

    req.on("close", () => {
        child.kill("SIGKILL");
    });
});

// ------------------------------------------------------------------------------
// 🎛️ MAIN HEBREW ROUTER
// ------------------------------------------------------------------------------
app.all("/twiml", async (req, res) => {
    console.log(`📞 [CALL] Incoming call from: ${req.body.From}`);
    const caller = req.body.From;
    const r = new VoiceResponse();

    if (CONFIG.VERIFIED_CALLERS.length && !CONFIG.VERIFIED_CALLERS.includes(caller)) {
        console.warn(`🚫 [CALL] Rejected caller: ${caller}`);
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    const user = await getUser(caller);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/main-router`, timeout: 6 });
    await playSay(g, "תפריט ראשי. 1 לשיחה עם בינה מלאכותית. 2 לשירים ומוזיקה. 3 לפודקאסטים. 4 למבזקי חדשות.", user.settings);
    
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
// 🧠 SYSTEM 1: GEMINI AI CHAT (WITH SETTINGS, VOICE SEARCH & DELETION)
// ==============================================================================
app.all("/chat-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-menu-router`, timeout: 6 });
    await playSay(g, "שיחה קולית. 1 לשיחה חדשה. 2 להיסטוריה. 3 לשיחות שמורות. 4 להגדרות.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const user = await getUser(req.body.From);
    const session = getCall(req.body.CallSid);

    if (d === "1") {
        session.chatId = uuidv4();
        await playSay(r, "אמור את שאלתך לאחר הצליל. בסיום הקש סולמית.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/chat-input-handler`, finishOnKey: "#", maxLength: 90, playBeep: true });
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
        await playSay(r, "עיבוד הקול נכשל. אנא נסה שוב.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    try {
        const result = await transcribeAndAnswer(phone, base64, session.chatId);
        if (!result.userText) {
            await playSay(r, "לא זוהה דיבור.", user.settings);
            r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
            return res.type("text/xml").send(r.toString());
        }

        session.chatId = result.session.id;
        const modelTurns = result.session.turns.filter(t => t.role === "model");
        session.chatTurnIdx = modelTurns.length - 1;

        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } catch (err) {
        console.error("❌ [CHAT ERROR]:", err.message);
        await playSay(r, "שגיאה בתקשורת עם הבינה המלאכותית.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/chat-turn-player", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const session = getCall(req.body.CallSid);

    const chat = user.chats.find(c => c.id === session.chatId);
    const modelTurns = chat ? chat.turns.filter(t => t.role === "model") : [];
    const reply = modelTurns[session.chatTurnIdx]?.text || "סוף שיחה.";

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-turn-action`, timeout: 7 });
    await playSay(g, reply, user.settings);
    await playSay(g, "1 להמשך השיחה, 3 לשמירה, 4 לתשובה קודמת, 6 לתשובה הבאה, 5 לחזרה.", user.settings);

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
        r.record({ action: `${CONFIG.BASE_URL}/chat-input-handler`, finishOnKey: "#", maxLength: 90, playBeep: true });
    } else if (d === "3") {
        await updateUser(phone, { $set: { "chats.$[elem].isSaved": true } }, { arrayFilters: [{ "elem.id": session.chatId }] });
        await playSay(r, "השיחה נשמרה במועדפים.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "4" && session.chatTurnIdx > 0) {
        session.chatTurnIdx--;
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "6" && session.chatTurnIdx < modelTurns.length - 1) {
        session.chatTurnIdx++;
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "5") {
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/chat-browser", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const session = getCall(req.body.CallSid);

    if (!session.browseList.length) {
        await playSay(r, "אין שיחות ברשימה זו.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const currentChat = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-browse-action`, timeout: 8 });
    await playSay(g, `שיחה: ${currentChat.title}. 5 להיכנס, 4 לחדש יותר, 6 לישן יותר, 7 לחיפוש קולי, 9 למחיקה.`, user.settings);

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
        session.chatId = session.browseList[session.browseIndex].id;
        const chat = user.chats.find(c => c.id === session.chatId);
        const modelTurns = chat ? chat.turns.filter(t => t.role === "model") : [];
        session.chatTurnIdx = Math.max(0, modelTurns.length - 1);
        r.redirect(`${CONFIG.BASE_URL}/chat-turn-player`);
    } else if (d === "4" && session.browseIndex > 0) {
        session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "6" && session.browseIndex < session.browseList.length - 1) {
        session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    } else if (d === "7") {
        // Voice Search through chats
        await playSay(r, "אמור מילת מפתח לחיפוש בשיחות העבר.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/chat-voice-search-exec`, maxLength: 8, playBeep: true });
    } else if (d === "9") {
        // Delete chat
        const targetId = session.browseList[session.browseIndex].id;
        await updateUser(phone, { $pull: { chats: { id: targetId } } });
        await playSay(r, "השיחה נמחקה.", user.settings);
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

app.all("/chat-voice-search-exec", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const session = getCall(req.body.CallSid);
    const user = await getUser(phone);
    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);

    if (base64) {
        try {
            const query = await executeGeminiWithFailover(async (genAI, modelName) => {
                const m = genAI.getGenerativeModel({ model: modelName });
                const res = await m.generateContent(["חלץ אך ורק את מילת החיפוש שנאמרה.", { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
                return res.response.text().trim().toLowerCase();
            });

            console.log(`🔍 [CHAT SEARCH] Searching past chats for: "${query}"`);
            const matches = user.chats.filter(c => 
                c.title.toLowerCase().includes(query) || 
                c.turns.some(t => t.text.toLowerCase().includes(query))
            );

            if (matches.length > 0) {
                session.browseList = matches;
                session.browseIndex = 0;
                await playSay(r, `נמצאו ${matches.length} שיחות מתאימות.`, user.settings);
                r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
                return res.type("text/xml").send(r.toString());
            }
        } catch (e) {
            console.error("❌ [CHAT SEARCH ERROR]:", e.message);
        }
    }

    await playSay(r, "לא נמצאו שיחות מתאימות.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/chat-browser`);
    res.type("text/xml").send(r.toString());
});

// Chat Settings Menu
app.all("/chat-settings-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/chat-settings-router`, timeout: 6 });
    await playSay(g, "הגדרות צ'אט. 1 להחלפת קול בעברית. 2 להחלפת קול באנגלית. 3 להחלפת סגנון העוזר.", user.settings);
    r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/chat-settings-router", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const phone = req.body.From;
    const user = await getUser(phone);

    if (d === "1") {
        const nextVoice = user.settings.voice_he === "he-IL-HilaNeural" ? "he-IL-AvriNeural" : "he-IL-HilaNeural";
        await updateUser(phone, { $set: { "settings.voice_he": nextVoice } });
        user.settings.voice_he = nextVoice;
        await playSay(r, `הקול העברי שונה ל${nextVoice.includes("Hila") ? "הילה" : "אברי"}.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else if (d === "2") {
        const enVoices = ["en-US-ChristopherNeural", "en-US-JennyNeural", "en-US-GuyNeural"];
        const curIdx = enVoices.indexOf(user.settings.voice_en);
        const nextVoice = enVoices[(curIdx + 1) % enVoices.length];
        await updateUser(phone, { $set: { "settings.voice_en": nextVoice } });
        user.settings.voice_en = nextVoice;
        await playSay(r, `English voice updated.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else if (d === "3") {
        const personas = ["default", "concise", "scholar", "creative"];
        const curIdx = personas.indexOf(user.settings.system_prompt_id);
        const nextPersona = personas[(curIdx + 1) % personas.length];
        await updateUser(phone, { $set: { "settings.system_prompt_id": nextPersona } });
        user.settings.system_prompt_id = nextPersona;
        const labels = { default: "רגיל", concise: "תמציתי", scholar: "מלומד", creative: "משעשע" };
        await playSay(r, `סגנון השיחה שונה ל${labels[nextPersona]}.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/chat-settings-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/chat-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 🎵 SYSTEM 2: MUSIC OS (SEARCH, HISTORY, LIKES, PLAYLISTS & SETTINGS)
// ==============================================================================
app.all("/music-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/music-router`, timeout: 6 });
    await playSay(g, "מוזיקה. 1 לחיפוש שיר. 2 להיסטוריה. 3 לשירים שמורים. 4 לפלייליסטים. 5 להגדרות מנוע.", user.settings);
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
        await playSay(r, "אמור את שם השיר והאמן לאחר הצליל.", user.settings);
        r.record({ action: `${CONFIG.BASE_URL}/music-search-exec`, maxLength: 8, playBeep: true });
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
        // Toggle Search Engine (YouTube vs SoundCloud)
        const curEngine = user.settings.search_engine || "ytsearch1:";
        const nextEngine = curEngine.startsWith("yt") ? "scsearch1:" : "ytsearch1:";
        await updateUser(phone, { $set: { "settings.search_engine": nextEngine } });
        user.settings.search_engine = nextEngine;
        await playSay(r, `מנוע החיפוש שונה ל${nextEngine.includes("yt") ? "יוטיוב" : "סאונדקלאוד"}.`, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-search-exec", async (req, res) => {
    const r = new VoiceResponse();
    const phone = req.body.From;
    const user = await getUser(phone);
    const base64 = await fetchTwilioRecording(req.body.RecordingUrl);

    if (!base64) {
        await playSay(r, "הקלטת השיר נכשלה.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
        return res.type("text/xml").send(r.toString());
    }

    try {
        const songQuery = await executeGeminiWithFailover(async (genAI, modelName) => {
            const m = genAI.getGenerativeModel({ model: modelName });
            const prompt = "חלץ אך ורק את שם השיר והזמר שנאמרו בהקלטה. החזר אך ורק את מילות החיפוש ללא שום מילים נוספות, הסברים או מרכאות. דוגמה: ישי ריבו סיבה לכל דבר";
            const res = await m.generateContent([prompt, { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
            return res.response.text().trim();
        });

        console.log(`🎵 [MUSIC] Raw extracted search query: "${songQuery}"`);

        await updateUser(phone, {
            $push: { music_history: { $each: [songQuery], $position: 0, $slice: 20 } }
        });

        const session = getCall(req.body.CallSid);
        session.player.title = songQuery;
        session.player.isPodcast = false;
        session.player.offset = 0;
        session.player.volume = 1.0;

        await playSay(r, `מחפש את ${songQuery}`, user.settings);
        initiateMusicDownload(req.body.CallSid, songQuery, user.settings.search_engine);

        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } catch (err) {
        console.error("❌ [MUSIC SEARCH ERROR]:", err.message);
        await playSay(r, "שגיאה בזיהוי שם השיר.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    }
    res.type("text/xml").send(r.toString());
});

function initiateMusicDownload(callSid, query, engine = "ytsearch1:") {
    const fileId = uuidv4();
    const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${fileId}.%(ext)s`);
    const marker = path.join(CONFIG.DOWNLOAD_DIR, `READY_${callSid}`);

    console.log(`🎵 [MUSIC] Running yt-dlp: "${engine}${query}"`);

    const args = [
        `${engine}${query}`,
        "-x",
        "--audio-format", "mp3",
        "--match-filter", "duration < 900",
        "--force-ipv4",
        "-o", outputTemplate
    ];

    if (fs.existsSync(CONFIG.COOKIES_FILE)) {
        args.push("--cookies", CONFIG.COOKIES_FILE);
    }

    const child = spawn("yt-dlp", args);

    child.on("close", (code) => {
        console.log(`🎵 [MUSIC] yt-dlp exited with code: ${code}`);
        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const found = files.find(f => f.startsWith(fileId) && f.endsWith(".mp3"));

        if (found) {
            const actualPath = path.join(CONFIG.DOWNLOAD_DIR, found);
            console.log(`✅ [MUSIC] Download successful: ${actualPath}`);
            const session = getCall(callSid);
            session.player.url = actualPath;
            fs.writeFileSync(marker, "ready");
            setTimeout(() => { if (fs.existsSync(actualPath)) fs.unlinkSync(actualPath); }, 1800000);
        } else {
            console.error("❌ [MUSIC] Song file not found after download!");
            fs.writeFileSync(marker, "error");
        }
    });
}

app.all("/music-wait-loop", (req, res) => {
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
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/music-browser", async (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (!session.browseList?.length) {
        await playSay(r, "הרשימה ריקה.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
        return res.type("text/xml").send(r.toString());
    }

    const song = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/music-browse-action`, timeout: 8 });
    await playSay(g, `${song}. 5 להשמעה, 4 לחדש יותר, 6 לישן יותר, 8 לשמירה, 9 למחיקה.`, user.settings);

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
        session.player.title = currentSong;
        session.player.offset = 0;
        session.player.volume = 1.0;
        initiateMusicDownload(req.body.CallSid, currentSong, user.settings.search_engine);
        r.redirect(`${CONFIG.BASE_URL}/music-wait-loop`);
    } else if (d === "4" && session.browseIndex > 0) {
        session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "6" && session.browseIndex < session.browseList.length - 1) {
        session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "8") {
        await updateUser(phone, { $addToSet: { likes: currentSong } });
        await playSay(r, "נוסף לשירים השמורים.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else if (d === "9") {
        if (session.browseType === "music_likes") {
            await updateUser(phone, { $pull: { likes: currentSong } });
        } else {
            await updateUser(phone, { $pull: { music_history: currentSong } });
        }
        const updated = await getUser(phone);
        session.browseList = session.browseType === "music_likes" ? updated.likes : updated.music_history;
        session.browseIndex = 0;
        await playSay(r, "השיר הוסר.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/music-browser`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/music-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// Custom Playlists Subsystem
app.all("/playlist-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/playlist-router`, timeout: 6 });
    await playSay(g, "פלייליסטים. 1 להשמעת פלייליסט. 2 ליצירת פלייליסט חדש.", user.settings);
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
            await playSay(r, "אין פלייליסטים קיימים.", user.settings);
            r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
        } else {
            let msg = "בחר פלייליסט: ";
            names.forEach((name, i) => { msg += `הקש ${i + 1} עבור ${name}. `; });
            const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/playlist-select-play`, timeout: 8 });
            await playSay(g, msg, user.settings);
        }
    } else if (d === "2") {
        await playSay(r, "אמור את שם הפלייליסט החדש לאחר הצליל.", user.settings);
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
        try {
            const name = await executeGeminiWithFailover(async (genAI, modelName) => {
                const m = genAI.getGenerativeModel({ model: modelName });
                const res = await m.generateContent(["חלץ אך ורק את השם שנאמר לפלייליסט.", { inlineData: { mimeType: "audio/mp3", data: base64 } }]);
                return res.response.text().trim();
            });

            await updateUser(phone, { $set: { [`playlists.${name}`]: [] } });
            await playSay(r, `הפלייליסט ${name} נוצר בהצלחה.`, user.settings);
        } catch (e) {
            console.error("❌ [PLAYLIST CREATE ERROR]:", e.message);
        }
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
        // Random / Shuffled playback
        session.player.playlist = [...user.playlists[names[idx]]].sort(() => 0.5 - Math.random());
        session.player.playlistIdx = 0;
        session.player.title = session.player.playlist[0];
        initiateMusicDownload(req.body.CallSid, session.player.title, user.settings.search_engine);
        r.redirect(`${CONFIG.BASE_URL}/music-download-wait-loop`);
    } else {
        await playSay(r, "הפלייליסט ריק משירים.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/playlist-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 🎛️ UNIVERSAL MEDIA PLAYER ENGINE (HEBREW CONTROLS)
// ==============================================================================
app.all("/media-player-play", (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const p = session.player;

    if (p.isPaused) {
        const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/media-player-action`, timeout: 3600 });
        g.say({ language: "he-IL" }, "ההשמעה מושהית. הקש 5 להמשך.");
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
    const session = getCall(req.body.CallSid);
    const p = session.player;

    if (!p.isPaused) {
        p.offset += (Date.now() - p.startTime) / 1000;
    }

    if (d === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (d === "5") {
        p.isPaused = !p.isPaused;
    } else if (d === "8") {
        // In-flight save menu
        r.redirect(`${CONFIG.BASE_URL}/player-save-menu`);
        return res.type("text/xml").send(r.toString());
    } else if (d === "2") {
        // In-flight volume menu
        r.redirect(`${CONFIG.BASE_URL}/player-volume-menu`);
        return res.type("text/xml").send(r.toString());
    }

    // Seeking
    if (p.isPodcast) {
        if (d === "4") p.offset = Math.max(0, p.offset - 300); // 5 min back
        else if (d === "6") p.offset += 300;                  // 5 min forward
        else if (d === "1") p.offset = Math.max(0, p.offset - 30);
        else if (d === "3") p.offset += 30;
    } else {
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
    await playSay(g, "הקש 1 לשמירה במועדפים. 2 להוספה לפלייליסט.", user.settings);
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
        await playSay(r, "נשמר במועדפים.", user.settings);
    } else if (d === "2") {
        const names = Object.keys(user.playlists || {});
        if (names.length) {
            await updateUser(phone, { $addToSet: { [`playlists.${names[0]}`]: currentTitle } });
            await playSay(r, `נוסף לפלייליסט ${names[0]}.`, user.settings);
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
    await playSay(g, "ווליום. 4 להחלשה. 6 להגברה.", user.settings);
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
// 🎙️ SYSTEM 3: PODCASTS (HEBREW MENU & DIRECT STREAMING)
// ==============================================================================
app.all("/podcast-menu", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    let msg = "פודקאסטים. ";
    PODCAST_REGISTRY.forEach((p) => { msg += `הקש ${p.id} עבור ${p.name}. `; });

    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/podcast-episodes-browser`, timeout: 8 });
    await playSay(g, msg, user.settings);
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-episodes-browser", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    const podId = parseInt(req.body.Digits);
    const podData = await podcastsCol?.findOne({ podcastId: podId });

    if (!podData?.episodes?.length) {
        await playSay(r, "טוען פרקים, אנא נסה שוב בעוד מספר שניות.", user.settings);
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
    await playSay(g, `${ep.title}. הקש 5 להשמעה, 4 לחדש יותר, 6 לישן יותר.`, user.settings);

    r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    res.type("text/xml").send(r.toString());
});

app.all("/podcast-browse-action", (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getCall(req.body.CallSid);

    if (d === "5") {
        const ep = session.browseList[session.browseIndex];
        const p = session.player;
        p.url = ep.enclosureUrl;
        p.title = ep.title;
        p.isPodcast = true;
        p.offset = 0;
        p.volume = 1.0;
        p.isPaused = false;
        console.log(`🎙️ [PODCAST] Streaming: "${ep.title}" -> ${ep.enclosureUrl}`);
        r.redirect(`${CONFIG.BASE_URL}/media-player-play`);
    } else if (d === "4" && session.browseIndex > 0) {
        session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/podcast-turn-browser`);
    } else if (d === "6" && session.browseIndex < session.browseList.length - 1) {
        session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/podcast-turn-browser`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/podcast-menu`);
    }
    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// 📰 SYSTEM 4: YNET BREAKING NEWS ("MIVZAKIM" IN HEBREW)
// ==============================================================================
app.all("/news-init", async (req, res) => {
    const r = new VoiceResponse();
    const user = await getUser(req.body.From);
    console.log("📰 [NEWS] Fetching Ynet Mivzakim feed...");
    try {
        const feed = await rssParser.parseURL("https://www.ynet.co.il/Integration/StoryRss3082.xml");
        const session = getCall(req.body.CallSid);
        session.browseList = feed.items || [];
        session.browseIndex = 0;

        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } catch (e) {
        console.error("❌ [NEWS ERROR]:", e.message);
        await playSay(r, "טעינת המבזקים נכשלה.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

app.all("/news-reader", async (req, res) => {
    const r = new VoiceResponse();
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (!session.browseList?.length) {
        await playSay(r, "אין מבזקים זמינים כרגע.", user.settings);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const item = session.browseList[session.browseIndex];
    const g = r.gather({ input: "dtmf", numDigits: 1, action: `${CONFIG.BASE_URL}/news-action`, timeout: 9 });
    await playSay(g, `מבזק. ${item.title}. הקש 6 למבזק הבא, 4 למבזק הקודם, 8 לפרטים מלאים, כוכבית לתפריט הראשי.`, user.settings);

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

app.all("/news-action", async (req, res) => {
    const r = new VoiceResponse();
    const d = req.body.Digits;
    const session = getCall(req.body.CallSid);
    const user = await getUser(req.body.From);

    if (d === "6" && session.browseIndex < session.browseList.length - 1) {
        session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else if (d === "4" && session.browseIndex > 0) {
        session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else if (d === "8") {
        const item = session.browseList[session.browseIndex];
        const dateStr = item.pubDate ? new Date(item.pubDate).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "";
        const author = item.creator || item.author || "כתב ווינט";
        const cleanContent = (item.contentSnippet || item.content || "אין פירוט נוסף").replace(/<[^>]*>/g, "").trim();
        const details = `פורסם בשעה ${dateStr} על ידי ${author}. ${cleanContent}. הקש 4 או 6 כדי להמשיך למבזקים אחרים.`;

        await playSay(r, details, user.settings);
        r.redirect(`${CONFIG.BASE_URL}/news-reader`);
    } else {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
    }
    res.type("text/xml").send(r.toString());
});

// ------------------------------------------------------------------------------
// 🛡️ SERVER CRASH GUARDS
// ------------------------------------------------------------------------------
process.on("uncaughtException", (err) => console.error("💥 [FATAL CRASH]:", err));
process.on("unhandledRejection", (reason) => console.error("💥 [UNHANDLED REJECTION]:", reason));

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 [SYSTEM ONLINE] Voice OS Master v10.5 ENTERPRISE on port ${CONFIG.PORT}`);
});
