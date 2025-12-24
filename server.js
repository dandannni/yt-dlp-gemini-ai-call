import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// 🔒 CONFIGURATION
const ALLOWED_NUMBER = "+972554402506"; 
const PORT = process.env.PORT || 3000;

// 🌍 AUTO-DETECT URL
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// 📂 STORAGE
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---------------------------------------------------------
// 🤖 GEMINI SETUP
// ---------------------------------------------------------
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", 
    systemInstruction: "You are a helpful phone assistant. Keep answers short. If user asks for music, say 'Press hash'.",
    tools: [{ googleSearch: {} }]
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send("File not found");
});

// 🧠 SESSION STORAGE (Chat + Music History)
// Structure: callSid -> { gemini: chatObj, history: [{title, url}], index: number }
const sessions = new Map();

// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching: ${query}...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist -o "${outputTemplate}"`;

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 20000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("Download failed:", stderr);
                return reject(error);
            }
            console.log("✅ Download complete");
            resolve({
                title: query,
                url: `${BASE_URL}/music/${filename}`
            });
        });
    });
}

// ---------------------------------------------------------
// 🛠️ HELPER: INIT SESSION
// ---------------------------------------------------------
function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, {
            gemini: model.startChat({ history: [] }),
            history: [], // Stores list of songs
            index: -1    // Current song position
        });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 📞 ROUTE 1: START / RESET
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    console.log("📞 Start / Reset");

    if (req.body.From !== ALLOWED_NUMBER) {
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    // Reset everything on new call or '0'
    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); // Init new session

    const response = new VoiceResponse();
    response.say("Main Menu. Ask me anything, or press Pound for music.");

    response.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/main-gather",
        method: "POST",
        timeout: 5,
        bargeIn: true
    });

    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE 2: MAIN MENU (Gemini)
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
        response.gather({ input: "speech dtmf", numDigits: 1, action: "/main-gather" });
        return res.type("text/xml").send(response.toString());
    }

    try {
        const result = await session.gemini.sendMessage(userText);
        response.say(result.response.text());
    } catch (e) {
        console.error("Gemini Error:", e);
        response.say("Error.");
    }

    response.gather({ input: "speech dtmf", numDigits: 1, action: "/main-gather" });
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
        action: "/music-process", 
        timeout: 5,
        bargeIn: true
    });
    // 🗣️ SPOKEN MESSAGE ADDED HERE
    gather.say("What song do you want to hear?"); 

    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 🎵 ROUTE 4: MUSIC PROCESS (Logic for 4, 5, 6 & Search)
// ---------------------------------------------------------
app.post("/music-process", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    
    const session = getSession(callSid);

    // 🛑 RESET
    if (digits === "0") {
        response.redirect("/twiml");
        return res.type("text/xml").send(response.toString());
    }

    // 🕹️ CONTROLS: 4 (Prev), 5 (Replay), 6 (Next)
    if (["4", "5", "6"].includes(digits)) {
        
        if (session.history.length === 0) {
            response.say("No history yet. Say a song name.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }

        if (digits === "4") { // BACK
            if (session.index > 0) session.index--; 
            else response.say("This is the first song.");
        }
        else if (digits === "6") { // NEXT
            if (session.index < session.history.length - 1) session.index++; 
            else response.say("This is the latest song.");
        }
        // 5 is just Replay (index stays same)

        // Play the song at current index
        const song = session.history[session.index];
        response.say(`Playing ${song.title}`);
        
        const gather = response.gather({ input: "dtmf", numDigits: 1, action: "/music-process" });
        gather.play(song.url);
        
        response.redirect("/music-mode"); // Loop when done
        return res.type("text/xml").send(response.toString());
    }

    // 🔍 NEW SONG SEARCH (Voice Input)
    if (userText) {
        try {
            const songData = await downloadSong(userText);
            
            // Add to history
            session.history.push(songData);
            session.index = session.history.length - 1; // Move pointer to end

            response.say(`Playing ${userText}`);
            
            // Allow interruption with 4, 5, 6, 0 during play
            const gather = response.gather({ input: "dtmf", numDigits: 1, action: "/music-process" });
            gather.play(songData.url);

            response.redirect("/music-mode"); // Loop when done

        } catch (err) {
            console.error(err);
            response.say("Download failed. Try again.");
            response.redirect("/music-mode");
        }
        return res.type("text/xml").send(response.toString());
    }

    // If nothing heard
    response.say("I didn't hear that.");
    response.redirect("/music-mode");
    res.type("text/xml").send(response.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
