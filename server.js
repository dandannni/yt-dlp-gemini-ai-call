import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ---------------------------------------------------------
// 🍪 SETUP COOKIES (THE FIX FOR BLOCKED DOWNLOADS)
// ---------------------------------------------------------
// We write the cookies from the Environment Variable to a temporary file
const COOKIE_PATH = "/tmp/cookies.txt";

if (process.env.YOUTUBE_COOKIES) {
    try {
        fs.writeFileSync(COOKIE_PATH, process.env.YOUTUBE_COOKIES);
        console.log("✅ Cookies loaded successfully from Environment.");
    } catch (e) {
        console.error("❌ Failed to write cookies file:", e);
    }
} else {
    console.warn("⚠️ WARNING: No YOUTUBE_COOKIES found in Render Environment!");
}

// ---------------------------------------------------------
// 🔐 CONFIGURATION: API KEYS (FALLBACK SYSTEM)
// ---------------------------------------------------------
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4
].filter(key => key); 

if (GEMINI_KEYS.length === 0) {
    console.error("❌ NO GEMINI API KEYS FOUND!");
} else {
    console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini Keys.`);
}

// ---------------------------------------------------------
// 🔒 CONFIGURATION: VERIFIED CALLERS
// ---------------------------------------------------------
const VERIFIED_CALLERS = [
    "+972548498889", 
    "+972554402506", 
    "+972525585720", 
    "+972528263032", 
    "+972583230268", 
    "" 
].filter(num => num !== "");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("File deleted or not found");
    }
});

// 🧠 SESSION STORAGE
const sessions = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, {
            chatHistory: [], 
            musicHistory: [], 
            index: -1    
        });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🤖 HELPER: GEMINI WITH FALLBACK LOGIC
// ---------------------------------------------------------
async function getGeminiResponse(session, userText) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const currentKey = GEMINI_KEYS[i];
        try {
            const genAI = new GoogleGenerativeAI(currentKey);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash", 
                systemInstruction: "You are a helpful phone assistant. Keep answers short. If user asks for music, say 'Press hash'.",
            });

            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(userText);
            const responseText = result.response.text();

            session.chatHistory.push({ role: "user", parts: [{ text: userText }] });
            session.chatHistory.push({ role: "model", parts: [{ text: responseText }] });
            
            return responseText;

        } catch (error) {
            console.error(`⚠️ Key ${i + 1} Failed: ${error.message}`);
        }
    }
    return "Sorry, I am having trouble connecting to the servers.";
}

// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG (WITH COOKIES)
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching: "${query}"...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // 🛠️ COMMAND WITH COOKIES
    // We point --cookies to the file we created at the top of the script
    let command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 -o "${outputTemplate}"`;

    if (fs.existsSync(COOKIE_PATH)) {
        command += ` --cookies "${COOKIE_PATH}"`;
        console.log("🍪 Using Cookies for authentication.");
    } else {
        console.log("⚠️ No cookies file found, trying without...");
    }

    console.log(`🚀 Running: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 40000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 Download Error:");
                console.error(stderr);
                return reject(error);
            }

            // 🗑️ AUTO-DELETE (10 Minutes)
            const filePath = path.join(DOWNLOAD_DIR, filename);
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlink(filePath, (err) => {
                        if (err) console.error("Error deleting file:", err);
                        else console.log(`🗑️ Auto-deleted: ${filename}`);
                    });
                }
            }, 600000); 

            console.log("✅ Download complete");
            resolve({
                title: query,
                url: `${BASE_URL}/music/${filename}`
            });
        });
    });
}

// ---------------------------------------------------------
// 📞 ROUTE 1: START / RESET
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    const caller = req.body.From;
    console.log(`📞 Incoming Call from: ${caller}`);

    if (!VERIFIED_CALLERS.includes(caller)) {
        console.log("⛔ Unverified Caller - Rejecting");
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); 

    const response = new VoiceResponse();
    response.say("Connected. Ask Gemini, or press Pound for music.");

    response.gather({
        input: "speech dtmf",
        numDigits: 1,
        finishOnKey: "", 
        action: "/main-gather",
        method: "POST",
        timeout: 5,
        bargeIn: true
    });

    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE 2: MAIN MENU
// ---------------------------------------------------------
app.post("/main-gather", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") {
        response.redirect("/twiml");
        return res.type("text/xml").send(response.toString());
    }
    if (digits === "#") {
        response.redirect("/music-mode");
        return res.type("text/xml").send(response.toString());
    }

    if (!userText) {
        response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
        return res.type("text/xm
