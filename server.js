console.log("🚀 Starting Server: STABLE MULTILINGUAL BUILD...");

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
// CONFIG
// ==============================================================================

const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://gpt-phone-call.onrender.com",
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

// ==============================================================================
// HELPERS
// ==============================================================================

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

function cleanSongQuery(text) {

    if (!text) return null;

    return text
        .replace(/^play\s+/i, '')
        .replace(/^search\s+/i, '')
        .replace(/^find\s+/i, '')
        .replace(/^put\s+/i, '')
        .replace(/^שים\s+/i, '')
        .replace(/^תשים\s+/i, '')
        .replace(/^נגן\s+/i, '')
        .trim();
}

// ==============================================================================
// GEMINI TRANSCRIPTION
// ==============================================================================

async function transcribeAudio(base64Audio) {

    if (CONFIG.GEMINI_KEYS.length === 0) {
        console.error("❌ No Gemini API keys found");
        return null;
    }

    const prompt = `
You are a multilingual transcription engine.

Rules:
- Transcribe EXACTLY what is spoken.
- Audio may be Hebrew or English.
- Do NOT translate.
- Do NOT summarize.
- Do NOT explain.
- Return ONLY the spoken text.
- If audio is silent or unclear return ONLY:
SILENCE
`;

    for (const key of CONFIG.GEMINI_KEYS) {

        try {

            console.log(`[GEMINI] Sending audio (${base64Audio.length} bytes)`);

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

            console.log(`[GEMINI RAW]: "${text}"`);

            if (
                !text ||
                text === "SILENCE" ||
                text.length < 2
            ) {
                return null;
            }

            return text;

        } catch (e) {

            console.error(`❌ Gemini transcription failed: ${e.message}`);

        }
    }

    return null;
}

// ==============================================================================
// GEMINI CHAT
// ==============================================================================

async function chatWithGemini(session, userInputText) {

    for (const key of CONFIG.GEMINI_KEYS) {

        try {

            const genAI = new GoogleGenerativeAI(key);

            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash-preview-04-17",
                systemInstruction:
                    "You are a phone assistant. " +
                    "Reply briefly. " +
                    "Never mix Hebrew and English. " +
                    "If user speaks Hebrew reply ONLY Hebrew. " +
                    "If user speaks English reply ONLY English."
            });

            const chat = model.startChat({
                history: session.chatHistory
            });

            const result = await chat.sendMessage(userInputText);

            return result.response.text();

        } catch (e) {

            console.error(`❌ Gemini chat failed: ${e.message}`);

        }
    }

    return "Sorry, I had a problem processing that.";
}

// ==============================================================================
// MICROSOFT EDGE TTS
// ==============================================================================

async function generateFreeTTS(text) {

    return new Promise((resolve) => {

        const id = uuidv4();

        const filename = `tts_${id}.mp3`;

        const outputPath = path.join(CONFIG.DOWNLOAD_DIR, filename);

        const safeText = text.replace(/["'\n]/g, " ").trim();

        if (!safeText) return resolve(null);

        console.log(`[TTS] "${safeText}"`);

        const voice = isHebrewText(safeText)
            ? "he-IL-AvriNeural"
            : "en-US-ChristopherNeural";

        const child = spawn("edge-tts", [
            "--text",
            safeText,
            "--voice",
            voice,
            "--write-media",
            outputPath
        ]);

        child.on("close", (code) => {

            if (code === 0 && fs.existsSync(outputPath)) {

                console.log(`[TTS SUCCESS] ${filename}`);

                setTimeout(() => {

                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                    }

                }, 300000);

                resolve(filename);

            } else {

                console.error("❌ TTS failed");

                resolve(null);

            }
        });
    });
}

async function playOrSay(r, text) {

    const ttsFile = await generateFreeTTS(text);

    if (ttsFile) {

        r.play(`${CONFIG.BASE_URL}/music/${ttsFile}`);

    } else {

        r.say({
            language: isHebrewText(text)
                ? "he-IL"
                : "en-US"
        }, text);

    }
}

// ==============================================================================
// SESSIONS
// ==============================================================================

const sessions = new Map();
const downloadQueue = new Map();

function getSession(callSid) {

    if (!sessions.has(callSid)) {

        sessions.set(callSid, {
            chatHistory: [],
            currentSong: null,
            mode: "normal"
        });
    }

    return sessions.get(callSid);
}

// ==============================================================================
// TWILIO RECORDING FETCH
// ==============================================================================

async function fetchTwilioRecording(recordingUrl) {

    console.log(`[TWILIO] Fetching ${recordingUrl}.mp3`);

    for (let attempt = 1; attempt <= 5; attempt++) {

        try {

            console.log(`[TWILIO] Attempt ${attempt}`);

            const response = await fetch(recordingUrl + ".mp3");

            if (!response.ok) {

                console.error(`❌ HTTP ${response.status}`);

                await new Promise(r => setTimeout(r, 2000));

                continue;
            }

            const contentType = response.headers.get("content-type");

            console.log(`[CONTENT TYPE] ${contentType}`);

            const arrayBuffer = await response.arrayBuffer();

            console.log(`[AUDIO SIZE] ${arrayBuffer.byteLength}`);

            if (arrayBuffer.byteLength < 5000) {

                console.error("❌ Audio too small");

                await new Promise(r => setTimeout(r, 2000));

                continue;
            }

            const buffer = Buffer.from(arrayBuffer);

            const debugPath =
                `/tmp/debug-${Date.now()}.mp3`;

            fs.writeFileSync(debugPath, buffer);

            console.log(`[DEBUG SAVED] ${debugPath}`);

            return buffer.toString("base64");

        } catch (e) {

            console.error(`❌ Fetch error: ${e.message}`);

        }

        await new Promise(r => setTimeout(r, 2000));
    }

    return "FETCH_FAILED";
}

// ==============================================================================
// YT-DLP
// ==============================================================================

async function searchAndDownloadYTDLP(callSid, query) {

    downloadQueue.set(callSid, {
        status: "pending",
        startTime: Date.now()
    });

    console.log(`[YTDLP] Searching: ${query}`);

    const id = uuidv4();

    const outputTemplate =
        path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    const args = [
        `ytsearch1:${query}`,
        "-x",
        "--audio-format",
        "mp3",
        "--postprocessor-args",
        "ffmpeg:-ac 1 -ar 16000",
        "--no-playlist",
        "--force-ipv4",
        "-o",
        outputTemplate
    ];

    const child = spawn("yt-dlp", args);

    child.stderr.on("data", data => {
        console.log(`[YTDLP STDERR] ${data}`);
    });

    child.stdout.on("data", data => {
        console.log(`[YTDLP STDOUT] ${data}`);
    });

    child.on("close", () => {

        const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);

        const found = files.find(
            f => f.startsWith(id) && f.endsWith(".mp3")
        );

        if (found) {

            console.log(`[YTDLP SUCCESS] ${found}`);

            downloadQueue.set(callSid, {
                status: "done",
                url: `${CONFIG.BASE_URL}/music/${found}`,
                title: query,
                filename: found
            });

            setTimeout(() => {

                const filePath =
                    path.join(CONFIG.DOWNLOAD_DIR, found);

                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }

            }, 1200000);

        } else {

            console.error("❌ YTDLP failed");

            downloadQueue.set(callSid, {
                status: "error"
            });

        }
    });
}

// ==============================================================================
// EXPRESS
// ==============================================================================

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// ==============================================================================
// AUDIO ROUTE
// ==============================================================================

app.get("/music/:filename", (req, res) => {

    const filePath =
        path.resolve(CONFIG.DOWNLOAD_DIR, req.params.filename);

    if (!fs.existsSync(filePath)) {

        return res.status(404).send("Missing file");

    }

    res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": fs.statSync(filePath).size
    });

    fs.createReadStream(filePath).pipe(res);
});

// ==============================================================================
// MAIN MENU
// ==============================================================================

app.all("/twiml", async (req, res) => {

    const caller = req.body.From;

    if (!CONFIG.VERIFIED_CALLERS.includes(caller)) {

        const r = new VoiceResponse();

        r.reject();

        return res
            .type("text/xml")
            .send(r.toString());
    }

    sessions.delete(req.body.CallSid);

    const r = new VoiceResponse();

    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: "/router",
        timeout: 10,
        finishOnKey: ""
    });

    await playOrSay(
        g,
        "Main menu. Press 1 for chat. Press hash for music."
    );

    r.redirect("/twiml");

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// ROUTER
// ==============================================================================

app.all("/router", (req, res) => {

    const r = new VoiceResponse();

    const d = req.body.Digits;

    if (d === "1") {

        r.redirect("/voice-mode");

    } else if (d === "#") {

        r.redirect("/music-mode");

    } else {

        r.redirect("/twiml");

    }

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// CHAT MODE
// ==============================================================================

app.all("/voice-mode", async (req, res) => {

    const r = new VoiceResponse();

    await playOrSay(
        r,
        "Speak after the beep then press hash."
    );

    r.record({
        action: "/voice-process",
        finishOnKey: "#",
        maxLength: 60,
        playBeep: true,
        timeout: 5
    });

    res.type("text/xml").send(r.toString());
});

app.all("/voice-process", async (req, res) => {

    const r = new VoiceResponse();

    if (!req.body.RecordingUrl) {

        await playOrSay(
            r,
            "No recording received."
        );

        r.redirect("/voice-mode");

        return res
            .type("text/xml")
            .send(r.toString());
    }

    const base64Audio =
        await fetchTwilioRecording(req.body.RecordingUrl);

    if (
        base64Audio &&
        base64Audio !== "FETCH_FAILED"
    ) {

        const transcript =
            await transcribeAudio(base64Audio);

        console.log(`[CHAT TRANSCRIPT] ${transcript}`);

        if (transcript) {

            const reply =
                await chatWithGemini(
                    getSession(req.body.CallSid),
                    transcript
                );

            await playOrSay(r, reply);

        } else {

            await playOrSay(
                r,
                "I could not understand you."
            );
        }

    } else {

        await playOrSay(
            r,
            "Error fetching recording."
        );
    }

    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: "/router",
        finishOnKey: ""
    });

    await playOrSay(
        g,
        "Press 1 for chat or hash for music."
    );

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// MUSIC MODE
// ==============================================================================

app.all("/music-mode", async (req, res) => {

    const r = new VoiceResponse();

    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: "/music-logic",
        timeout: 10,
        finishOnKey: ""
    });

    await playOrSay(
        g,
        "Music mode. Press 1 to search for a song."
    );

    res.type("text/xml").send(r.toString());
});

app.all("/music-logic", async (req, res) => {

    const r = new VoiceResponse();

    if (req.body.Digits === "1") {

        await playOrSay(
            r,
            "Say the song name after the beep then press hash."
        );

        r.record({
            action: "/music-search",
            maxLength: 15,
            playBeep: true,
            finishOnKey: "#",
            timeout: 5
        });

        return res
            .type("text/xml")
            .send(r.toString());
    }

    r.redirect("/twiml");

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// MUSIC SEARCH
// ==============================================================================

app.all("/music-search", async (req, res) => {

    console.log("========== MUSIC SEARCH ==========");

    const r = new VoiceResponse();

    if (!req.body.RecordingUrl) {

        await playOrSay(
            r,
            "No recording received."
        );

        r.redirect("/music-mode");

        return res
            .type("text/xml")
            .send(r.toString());
    }

    const base64Audio =
        await fetchTwilioRecording(req.body.RecordingUrl);

    if (
        !base64Audio ||
        base64Audio === "FETCH_FAILED"
    ) {

        await playOrSay(
            r,
            "Error downloading recording."
        );

        r.redirect("/music-mode");

        return res
            .type("text/xml")
            .send(r.toString());
    }

    const transcript =
        await transcribeAudio(base64Audio);

    console.log(`[TRANSCRIPT] ${transcript}`);

    const cleanQuery =
        cleanSongQuery(transcript);

    console.log(`[CLEAN QUERY] ${cleanQuery}`);

    if (!cleanQuery) {

        await playOrSay(
            r,
            "I could not understand the song name."
        );

        r.redirect("/music-mode");

        return res
            .type("text/xml")
            .send(r.toString());
    }

    searchAndDownloadYTDLP(
        req.body.CallSid,
        cleanQuery
    );

    const searchMessage =
        isHebrewText(cleanQuery)
            ? `מחפש את ${cleanQuery}`
            : `Searching for ${cleanQuery}`;

    await playOrSay(r, searchMessage);

    r.redirect("/music-wait-loop");

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// MUSIC WAIT LOOP
// ==============================================================================

app.all("/music-wait-loop", async (req, res) => {

    const r = new VoiceResponse();

    const dl =
        downloadQueue.get(req.body.CallSid);

    if (!dl) {

        r.redirect("/music-mode");

        return res
            .type("text/xml")
            .send(r.toString());
    }

    if (dl.status === "done") {

        const g = r.gather({
            input: "dtmf",
            numDigits: 1,
            action: "/router",
            bargeIn: true,
            finishOnKey: ""
        });

        g.play(dl.url);

        r.redirect("/twiml");

    } else if (
        dl.status === "error" ||
        Date.now() - dl.startTime > 60000
    ) {

        await playOrSay(
            r,
            "Error downloading song."
        );

        downloadQueue.delete(req.body.CallSid);

        r.redirect("/music-mode");

    } else {

        r.pause({ length: 3 });

        r.redirect("/music-wait-loop");
    }

    res.type("text/xml").send(r.toString());
});

// ==============================================================================
// START SERVER
// ==============================================================================

app.listen(CONFIG.PORT, () => {

    console.log(`🚀 Server running on port ${CONFIG.PORT}`);

});
