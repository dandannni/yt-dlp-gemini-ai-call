console.log("🚀 Starting Stable GPT Phone Server...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL:
        process.env.RENDER_EXTERNAL_URL ||
        "https://gpt-phone-call.onrender.com",

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

function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text);
}

function cleanSongQuery(text) {

    if (!text) return null;

    return text
        .replace(/^play\s+/i, "")
        .replace(/^search\s+/i, "")
        .replace(/^find\s+/i, "")
        .replace(/^נגן\s+/i, "")
        .replace(/^שים\s+/i, "")
        .replace(/^תשים\s+/i, "")
        .trim();
}

// ======================================================================
// GEMINI TRANSCRIPTION
// ======================================================================

async function transcribeAudio(base64Audio) {

    const prompt = `
Transcribe exactly what is spoken.
Audio may be Hebrew or English.
Do not translate.
Do not explain.
Return only the spoken text.
If audio is unclear return SILENCE.
`;

    for (const key of CONFIG.GEMINI_KEYS) {

        try {

            const genAI =
                new GoogleGenerativeAI(key);

            const model =
                genAI.getGenerativeModel({
                    model:
                        "gemini-2.5-flash-preview-04-17"
                });

            console.log(
                `[GEMINI] Sending audio ${base64Audio.length}`
            );

            const result =
                await model.generateContent([
                    {
                        inlineData: {
                            mimeType: "audio/mpeg",
                            data: base64Audio
                        }
                    },
                    prompt
                ]);

            const text =
                result.response.text().trim();

            console.log(
                `[TRANSCRIPT RAW] ${text}`
            );

            if (
                !text ||
                text === "SILENCE" ||
                text.length < 2
            ) {
                return null;
            }

            return text;

        } catch (e) {

            console.error(
                `❌ Gemini transcription failed: ${e.message}`
            );
        }
    }

    return null;
}

// ======================================================================
// GEMINI CHAT
// ======================================================================

async function chatWithGemini(session, text) {

    for (const key of CONFIG.GEMINI_KEYS) {

        try {

            const genAI =
                new GoogleGenerativeAI(key);

            const model =
                genAI.getGenerativeModel({
                    model:
                        "gemini-2.5-flash-preview-04-17",

                    systemInstruction:
                        "You are a phone assistant. " +
                        "Reply briefly. " +
                        "Never mix Hebrew and English."
                });

            const chat =
                model.startChat({
                    history: session.chatHistory
                });

            const result =
                await chat.sendMessage(text);

            return result.response.text();

        } catch (e) {

            console.error(
                `❌ Gemini chat failed: ${e.message}`
            );
        }
    }

    return "Sorry, something went wrong.";
}

// ======================================================================
// EDGE TTS
// ======================================================================

async function generateFreeTTS(text) {

    return new Promise((resolve) => {

        try {

            const id = uuidv4();

            const filename =
                `tts_${id}.mp3`;

            const outputPath =
                path.join(
                    CONFIG.DOWNLOAD_DIR,
                    filename
                );

            const safeText =
                text
                    .replace(/["'\n]/g, " ")
                    .trim();

            if (!safeText) {
                return resolve(null);
            }

            const voice =
                isHebrewText(safeText)
                    ? "he-IL-AvriNeural"
                    : "en-US-ChristopherNeural";

            const child = spawn(
                "edge-tts",
                [
                    "--text",
                    safeText,
                    "--voice",
                    voice,
                    "--write-media",
                    outputPath
                ]
            );

            child.on("close", (code) => {

                if (
                    code === 0 &&
                    fs.existsSync(outputPath)
                ) {

                    resolve(filename);

                } else {

                    console.error(
                        "❌ TTS generation failed"
                    );

                    resolve(null);
                }
            });

        } catch (e) {

            console.error(
                `❌ TTS exception: ${e.message}`
            );

            resolve(null);
        }
    });
}

async function playOrSay(r, text) {

    try {

        const tts =
            await generateFreeTTS(text);

        if (tts) {

            r.play(
                `${CONFIG.BASE_URL}/music/${tts}`
            );

        } else {

            r.say(
                {
                    language:
                        isHebrewText(text)
                            ? "he-IL"
                            : "en-US"
                },
                text
            );
        }

    } catch (e) {

        console.error(
            `❌ playOrSay error: ${e.message}`
        );

        r.say(text);
    }
}

// ======================================================================
// TWILIO RECORDING FETCH
// ======================================================================

async function fetchTwilioRecording(recordingUrl) {

    try {

        const accountSid =
            process.env.TWILIO_ACCOUNT_SID;

        const authToken =
            process.env.TWILIO_AUTH_TOKEN;

        const auth =
            "Basic " +
            Buffer
                .from(
                    `${accountSid}:${authToken}`
                )
                .toString("base64");

        for (let attempt = 1; attempt <= 10; attempt++) {

            console.log(
                `[TWILIO] Attempt ${attempt}`
            );

            const response =
                await fetch(
                    recordingUrl + ".mp3",
                    {
                        headers: {
                            Authorization: auth
                        }
                    }
                );

            console.log(
                `[TWILIO STATUS] ${response.status}`
            );

            if (!response.ok) {

                await new Promise(r =>
                    setTimeout(r, 3000)
                );

                continue;
            }

            const arrayBuffer =
                await response.arrayBuffer();

            console.log(
                `[AUDIO SIZE] ${arrayBuffer.byteLength}`
            );

            if (arrayBuffer.byteLength < 5000) {

                await new Promise(r =>
                    setTimeout(r, 3000)
                );

                continue;
            }

            const buffer =
                Buffer.from(arrayBuffer);

            return buffer.toString("base64");
        }

        return "FETCH_FAILED";

    } catch (e) {

        console.error(
            `❌ fetchTwilioRecording crash: ${e.message}`
        );

        return "FETCH_FAILED";
    }
}

// ======================================================================
// YT DLP
// ======================================================================

const downloadQueue = new Map();

async function searchAndDownloadYTDLP(callSid, query) {

    downloadQueue.set(callSid, {
        status: "pending",
        startTime: Date.now()
    });

    try {

        const id = uuidv4();

        const outputTemplate =
            path.join(
                CONFIG.DOWNLOAD_DIR,
                `${id}.%(ext)s`
            );

        const args = [
            `ytsearch1:${query}`,
            "-x",
            "--audio-format",
            "mp3",
            "--no-playlist",
            "-o",
            outputTemplate
        ];

        console.log(
            `[YTDLP] ${args.join(" ")}`
        );

        const child =
            spawn("yt-dlp", args);

        child.stderr.on("data", data => {
            console.log(
                `[YTDLP STDERR] ${data}`
            );
        });

        child.on("close", (code) => {

            console.log(
                `[YTDLP EXIT] ${code}`
            );

            const files =
                fs.readdirSync(
                    CONFIG.DOWNLOAD_DIR
                );

            const found =
                files.find(
                    f =>
                        f.startsWith(id) &&
                        f.endsWith(".mp3")
                );

            if (found) {

                downloadQueue.set(callSid, {
                    status: "done",
                    url:
                        `${CONFIG.BASE_URL}/music/${found}`
                });

            } else {

                downloadQueue.set(callSid, {
                    status: "error"
                });
            }
        });

    } catch (e) {

        console.error(
            `❌ yt-dlp crash: ${e.message}`
        );

        downloadQueue.set(callSid, {
            status: "error"
        });
    }
}

// ======================================================================
// EXPRESS
// ======================================================================

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse =
    twilio.twiml.VoiceResponse;

const sessions = new Map();

function getSession(callSid) {

    if (!sessions.has(callSid)) {

        sessions.set(callSid, {
            chatHistory: []
        });
    }

    return sessions.get(callSid);
}

// ======================================================================
// AUDIO ROUTE
// ======================================================================

app.get("/music/:filename", (req, res) => {

    try {

        const filePath =
            path.resolve(
                CONFIG.DOWNLOAD_DIR,
                req.params.filename
            );

        if (!fs.existsSync(filePath)) {
            return res.status(404).send("Missing");
        }

        res.writeHead(200, {
            "Content-Type": "audio/mpeg"
        });

        fs.createReadStream(filePath)
            .pipe(res);

    } catch (e) {

        console.error(
            `❌ Music route error: ${e.message}`
        );

        res.status(500).send("Error");
    }
});

// ======================================================================
// MAIN MENU
// ======================================================================

app.all("/twiml", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        const g =
            r.gather({
                input: "dtmf",
                numDigits: 1,
                action: "/router",
                timeout: 10
            });

        await playOrSay(
            g,
            "Press 1 for chat or hash for music."
        );

        r.redirect("/twiml");

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /twiml crash: ${e.message}`
        );

        res.status(500).send("Error");
    }
});

// ======================================================================
// ROUTER
// ======================================================================

app.all("/router", (req, res) => {

    const r =
        new VoiceResponse();

    const d =
        req.body.Digits;

    if (d === "1") {

        r.redirect("/voice-mode");

    } else if (d === "#") {

        r.redirect("/music-mode");

    } else {

        r.redirect("/twiml");
    }

    res
        .type("text/xml")
        .send(r.toString());
});

// ======================================================================
// VOICE MODE
// ======================================================================

app.all("/voice-mode", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        await playOrSay(
            r,
            "Speak after the beep then press hash."
        );

        r.record({
            action: "/voice-process",
            finishOnKey: "#",
            playBeep: true,
            maxLength: 60
        });

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /voice-mode crash: ${e.message}`
        );

        res.status(500).send("Error");
    }
});

// ======================================================================
// VOICE PROCESS
// ======================================================================

app.all("/voice-process", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        if (!req.body.RecordingUrl) {

            await playOrSay(
                r,
                "No recording found."
            );

            r.redirect("/voice-mode");

            return res
                .type("text/xml")
                .send(r.toString());
        }

        const audio =
            await fetchTwilioRecording(
                req.body.RecordingUrl
            );

        if (
            !audio ||
            audio === "FETCH_FAILED"
        ) {

            await playOrSay(
                r,
                "Error downloading recording."
            );

            r.redirect("/voice-mode");

            return res
                .type("text/xml")
                .send(r.toString());
        }

        const transcript =
            await transcribeAudio(audio);

        console.log(
            `[CHAT TRANSCRIPT] ${transcript}`
        );

        if (!transcript) {

            await playOrSay(
                r,
                "I could not understand you."
            );

            r.redirect("/voice-mode");

            return res
                .type("text/xml")
                .send(r.toString());
        }

        const reply =
            await chatWithGemini(
                getSession(req.body.CallSid),
                transcript
            );

        await playOrSay(r, reply);

        r.redirect("/twiml");

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /voice-process crash: ${e.message}`
        );

        const r =
            new VoiceResponse();

        r.say(
            "An internal server error happened."
        );

        res
            .type("text/xml")
            .send(r.toString());
    }
});

// ======================================================================
// MUSIC MODE
// ======================================================================

app.all("/music-mode", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        const g =
            r.gather({
                input: "dtmf",
                numDigits: 1,
                action: "/music-logic"
            });

        await playOrSay(
            g,
            "Press 1 to search for a song."
        );

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /music-mode crash: ${e.message}`
        );

        res.status(500).send("Error");
    }
});

// ======================================================================
// MUSIC LOGIC
// ======================================================================

app.all("/music-logic", async (req, res) => {

    const r =
        new VoiceResponse();

    if (req.body.Digits === "1") {

        await playOrSay(
            r,
            "Say the song name after the beep then press hash."
        );

        r.record({
            action: "/music-search",
            finishOnKey: "#",
            playBeep: true,
            maxLength: 15
        });

        return res
            .type("text/xml")
            .send(r.toString());
    }

    r.redirect("/twiml");

    res
        .type("text/xml")
        .send(r.toString());
});

// ======================================================================
// MUSIC SEARCH
// ======================================================================

app.all("/music-search", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        const audio =
            await fetchTwilioRecording(
                req.body.RecordingUrl
            );

        if (
            !audio ||
            audio === "FETCH_FAILED"
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
            await transcribeAudio(audio);

        const query =
            cleanSongQuery(transcript);

        console.log(
            `[SONG QUERY] ${query}`
        );

        if (!query) {

            await playOrSay(
                r,
                "I could not understand the song."
            );

            r.redirect("/music-mode");

            return res
                .type("text/xml")
                .send(r.toString());
        }

        searchAndDownloadYTDLP(
            req.body.CallSid,
            query
        );

        await playOrSay(
            r,
            isHebrewText(query)
                ? `מחפש את ${query}`
                : `Searching for ${query}`
        );

        r.redirect("/music-wait-loop");

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /music-search crash: ${e.message}`
        );

        const r =
            new VoiceResponse();

        r.say("Music search failed.");

        res
            .type("text/xml")
            .send(r.toString());
    }
});

// ======================================================================
// MUSIC WAIT LOOP
// ======================================================================

app.all("/music-wait-loop", async (req, res) => {

    try {

        const r =
            new VoiceResponse();

        const dl =
            downloadQueue.get(
                req.body.CallSid
            );

        if (!dl) {

            r.redirect("/music-mode");

            return res
                .type("text/xml")
                .send(r.toString());
        }

        if (dl.status === "done") {

            r.play(dl.url);

            r.redirect("/twiml");

        } else if (
            dl.status === "error"
        ) {

            await playOrSay(
                r,
                "Song download failed."
            );

            r.redirect("/music-mode");

        } else {

            r.pause({ length: 3 });

            r.redirect("/music-wait-loop");
        }

        res
            .type("text/xml")
            .send(r.toString());

    } catch (e) {

        console.error(
            `❌ /music-wait-loop crash: ${e.message}`
        );

        res.status(500).send("Error");
    }
});

// ======================================================================
// START
// ======================================================================

app.listen(CONFIG.PORT, () => {

    console.log(
        `🚀 Server running on ${CONFIG.PORT}`
    );
});
