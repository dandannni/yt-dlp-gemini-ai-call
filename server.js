import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai"; 
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// 🔒 CONFIGURATION
const ALLOWED_NUMBER = "+972554402506"; 
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;

// 🤖 1. SETUP GEMINI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", 
    systemInstruction: "You are a helpful phone assistant. Keep answers short. If user asks for music, say 'Press hash'.",
    tools: [{ googleSearch: {} }]
});

// 🤖 2. SETUP OPENAI (Backup)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        console.log(`📂 Serving file: ${filePath}`); // Log when Twilio grabs the file
        res.sendFile(filePath);
    } else {
        console.error(`❌ File missing: ${filePath}`);
        res.status(404).send("File not found");
    }
});

// 🧠 SESSION STORAGE
const sessions = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, {
            gemini: model.startChat({ history: [] }),
            history: [], 
            index: -1    
        });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG (WITH DEBUGGING)
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching for: "${query}"...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // 🛠️ CHANGED: Increased timeout to 30s and forced IPv4
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 -o "${outputTemplate}"`;

    console.log(`🚀 Executing Command: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 DOWNLOAD ERROR 🚨");
                console.error("------------------------------------------------");
                console.error("1. Error Message:", error.message);
                console.error("2. STDERR (What went wrong):", stderr);
                console.error("3. STDOUT:", stdout);
                console.error("------------------------------------------------");
                return reject(error);
            }
            
            // Success
            console.log("✅ Download finished successfully.");
            console.log(`💾 Saved to: ${outputTemplate}`);
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
    console.log("📞 Incoming Call / Reset");

    if (req.body.From !== ALLOWED_NUMBER) {
        console.log(`⛔ Blocked call from: ${req.body.From}`);
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); 

    const response = new VoiceResponse();
    response.say("Main Menu. Ask me anything, or press Pound for music.");

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
        return res.type("text/xml").send(response.toString());
    }

    // AI LOGIC
    try {
        console.log(`💬 Gemini User: ${userText}`);
        const result = await session.gemini.sendMessage(userText);
        response.say(result.response.text());

    } catch (geminiError) {
        console.error("⚠️ Gemini Failed:", geminiError.message);
        console.log("🔄 Switching to Backup (OpenAI)...");

        try {
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: "system", content: "You are a helpful phone assistant. Keep answers short." },
                    { role: "user", content: userText }
                ],
                model: "gpt-4o-mini", 
            });
            const backupReply = completion.choices[0].message.content;
            response.say(backupReply);

        } catch (openaiError) {
            console.error("❌ Both AIs failed:", openaiError.message);
            response.say("Sorry, I am having trouble connecting to the brain.");
        }
    }

    response.gather({ input: "speech dtmf", numDigits: 1, finishOnKey: "", action: "/main-gather" });
    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE 3: MUSIC MODE ENTRY
// ---------------------------------------------------------
app.post("/music-mode", (req, res) => {
    const response = new VoiceResponse();
    
    const gather = response.gather({
        input: "speech dtmf",
        numDigits: 1,
        finishOnKey: "", 
        action: "/music-process", 
        timeout: 5,
        bargeIn: true
    });
    gather.say("What song do you want to hear?"); 

    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE 4: MUSIC PROCESS
// ---------------------------------------------------------
app.post("/music-process", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    if (digits === "0") {
        response.redirect("/twiml");
        return res.type("text/xml").send(response.toString());
    }

    // CONTROLS
    if (["4", "5", "6"].includes(digits)) {
        if (session.history.length === 0) {
            response.say("No history yet. Say a song name.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }

        if (digits === "4") {
            if (session.index > 0) session.index--; 
            else response.say("First song.");
        }
        else if (digits === "6") {
            if (session.index < session.history.length - 1) session.index++; 
            else response.say("Latest song.");
        }

        const song = session.history[session.index];
        response.say(`Playing ${song.title}`);
        
        const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
        gather.play(song.url);
        
        response.redirect("/music-mode"); 
        return res.type("text/xml").send(response.toString());
    }

    // NEW SONG
    if (userText) {
        try {
            const songData = await downloadSong(userText);
            
            session.history.push(songData);
            session.index = session.history.length - 1; 

            response.say(`Playing ${userText}`);
            
            const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
            gather.play(songData.url);

            response.redirect("/music-mode"); 

        } catch (err) {
            console.error("❌ Music Processing Error:", err);
            // We do NOT crash the call, we just say sorry
            response.say("I had a problem downloading that specific song. Please try a different one.");
            response.redirect("/music-mode");
        }
        return res.type("text/xml").send(response.toString());
    }

    response.say("I didn't hear that.");
    response.redirect("/music-mode");
    res.type("text/xml").send(response.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
