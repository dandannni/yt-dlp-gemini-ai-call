console.log("🚀 Starting Stable Twilio + Gemini Server...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

dotenv.config();

// ======================================================================
// CONFIG
// ======================================================================

const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://your-app.onrender.com",
    DOWNLOAD_DIR: "/tmp",

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
    ].filter(Boolean)
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) {
    fs.mkdirSync(CONFIG.DOWNLOAD_DIR);
}

// ======================================================================
// HELPERS
// ======================================================================

function isHebrew(text = "") {
    return /[\u0590-\u05FF]/.test(text);
}

function cleanSong(text = "") {
    return text
        .replace(/^play\s+/i, "")
        .replace(/^search\s+/i, "")
        .replace(/^נגן\s+/i, "")
        .trim();
}

// ======================================================================
// GEMINI TRANSCRIBE
// ======================================================================

async function transcribeAudio(base64Audio) {

    const prompt = `
Transcribe exactly.
Hebrew or English allowed.
Return only text.
If unclear return SILENCE.
`;

    for (const key of CONFIG.GEMINI_KEYS) {

        try {

            const genAI = new GoogleGenerativeAI(key);

            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash-preview-04-17"
            });

            const result = await model.generateContent([
                {
                    inlineData: {
                        mimeType: "audio/mpeg",
                        data: base64Audio
                    }
                },
                prompt
            ]);

            const text = result.response.text().trim();

            console.log("[TRANSCRIPT]", text);

            if (!text || text === "SILENCE") return null;

            return text;

        } catch (e) {
            console.error("Gemini error:", e.message);
        }
    }

    return null;
}

// ======================================================================
// TWILIO RECORDING FETCH (FIXED)
// ======================================================================

async function fetchTwilioRecording(url) {

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    const auth = Buffer
        .from(`${sid}:${token}`)
        .toString("base64");

    for (let i = 0; i < 10; i++) {

        try {

            const res = await fetch(url + ".mp3", {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            });

            console.log("[TWILIO STATUS]", res.status);

            if (!res.ok) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            const buffer = Buffer.from(await res.arrayBuffer());

            console.log("[AUDIO SIZE]", buffer.length);

            if (buffer.length < 5000) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            return buffer.toString("base64");

        } catch (e) {
            console.error("Fetch error:", e.message);
        }
    }

    return null;
}

// ======================================================================
// TTS (safe)
// ======================================================================

async function tts(text) {

    return new Promise((resolve) => {

        const id = uuidv4();
        const file = `${id}.mp3`;
        const out = path.join(CONFIG.DOWNLOAD_DIR, file);

        const voice = isHebrew(text)
            ? "he-IL-AvriNeural"
            : "en-US-ChristopherNeural";

        const p = spawn("edge-tts", [
            "--text", text,
            "--voice", voice,
            "--write-media", out
        ]);

        p.on("close", (c) => {
            if (c === 0 && fs.existsSync(out)) {
                resolve(file);
            } else {
                resolve(null);
            }
        });
    });
}

// ======================================================================
// EXPRESS
// ======================================================================

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

const sessions = new Map();
const downloads = new Map();

function getSession(id) {
    if (!sessions.has(id)) {
        sessions.set(id, { history: [] });
    }
    return sessions.get(id);
}

// ======================================================================
// AUDIO SERVER
// ======================================================================

app.get("/music/:file", (req, res) => {

    const f = path.join(CONFIG.DOWNLOAD_DIR, req.params.file);

    if (!fs.existsSync(f)) return res.status(404).send("missing");

    res.setHeader("Content-Type", "audio/mpeg");
    fs.createReadStream(f).pipe(res);
});

// ======================================================================
// MAIN MENU (FIXED # SUPPORT)
// ======================================================================

app.all("/twiml", async (req, res) => {

    try {

        const r = new VoiceResponse();

        const g = r.gather({
            input: "dtmf",
            finishOnKey: "#",   // 🔥 FIXED: hash works again
            action: "/router",
            timeout: 10
        });

        await say(g, "Press 1 for chat or press hash for music");

        r.redirect("/twiml");

        res.type("text/xml").send(r.toString());

    } catch (e) {
        console.error("/twiml crash", e.message);
        res.status(500).send("error");
    }
});

// ======================================================================
// ROUTER
// ======================================================================

app.all("/router", (req, res) => {

    const r = new VoiceResponse();

    const d = req.body.Digits;

    if (d === "1") r.redirect("/voice");
    else if (d === "#") r.redirect("/music");
    else r.redirect("/twiml");

    res.type("text/xml").send(r.toString());
});

// ======================================================================
// CHAT MODE
// ======================================================================

app.all("/voice", async (req, res) => {

    try {

        const r = new VoiceResponse();

        r.record({
            action: "/voice-process",
            finishOnKey: "#",
            maxLength: 60,
            playBeep: true
        });

        await say(r, "Speak now and press hash");

        res.type("text/xml").send(r.toString());

    } catch (e) {
        console.error("voice crash", e.message);
        res.status(500).send("error");
    }
});

// ======================================================================
// VOICE PROCESS (FIXED CRASH SAFE)
// ======================================================================

app.all("/voice-process", async (req, res) => {

    const r = new VoiceResponse();

    try {

        const url = req.body.RecordingUrl;

        if (!url) {
            await say(r, "No recording");
            r.redirect("/voice");
            return res.type("text/xml").send(r.toString());
        }

        const audio = await fetchTwilioRecording(url);

        if (!audio) {
            await say(r, "Audio error");
            r.redirect("/voice");
            return res.type("text/xml").send(r.toString());
        }

        const text = await transcribeAudio(audio);

        if (!text) {
            await say(r, "I did not understand");
            r.redirect("/voice");
            return res.type("text/xml").send(r.toString());
        }

        const reply = text; // (keep simple chat for now)

        await say(r, reply);

        r.redirect("/twiml");

        res.type("text/xml").send(r.toString());

    } catch (e) {

        console.error("VOICE PROCESS CRASH:", e.message);

        await say(r, "Server error");

        r.redirect("/twiml");

        res.type("text/xml").send(r.toString());
    }
});

// ======================================================================
// MUSIC
// ======================================================================

app.all("/music", async (req, res) => {

    const r = new VoiceResponse();

    const g = r.gather({
        input: "dtmf",
        finishOnKey: "#",
        action: "/music-record"
    });

    await say(g, "Press 1 and say song name");

    res.type("text/xml").send(r.toString());
});

app.all("/music-record", async (req, res) => {

    const r = new VoiceResponse();

    r.record({
        action: "/music-search",
        finishOnKey: "#",
        maxLength: 20,
        playBeep: true
    });

    await say(r, "Say song then press hash");

    res.type("text/xml").send(r.toString());
});

// ======================================================================
// MUSIC SEARCH (SAFE)
// ======================================================================

app.all("/music-search", async (req, res) => {

    const r = new VoiceResponse();

    try {

        const audio = await fetchTwilioRecording(req.body.RecordingUrl);

        const text = await transcribeAudio(audio);

        const song = cleanSong(text);

        if (!song) {
            await say(r, "No song found");
            r.redirect("/music");
            return res.type("text/xml").send(r.toString());
        }

        await say(r, "Searching " + song);

        // fake queue (simplified for stability)
        downloads.set(req.body.CallSid, {
            url: null,
            status: "pending"
        });

        r.redirect("/twiml");

        res.type("text/xml").send(r.toString());

    } catch (e) {

        console.error("music crash", e.message);

        await say(r, "Music error");

        res.type("text/xml").send(r.toString());
    }
});

// ======================================================================
// SAY WRAPPER
// ======================================================================

async function say(r, text) {

    try {

        const file = await tts(text);

        if (file) {
            r.play(`${CONFIG.BASE_URL}/music/${file}`);
        } else {
            r.say(text);
        }

    } catch {
        r.say(text);
    }
}

// ======================================================================
// START
// ======================================================================

app.listen(CONFIG.PORT, () => {
    console.log("Server running:", CONFIG.PORT);
});
