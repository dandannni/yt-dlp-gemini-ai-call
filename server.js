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
// 🔒 CONFIGURATION: VERIFIED CALLERS
// ---------------------------------------------------------
// Put the phone numbers inside the quotes (e.g., "+972500000000")
const VERIFIED_CALLERS = [
    "+972548498889",  // Your Number
    "+972554402506",               // Caller 2
    "+972525585720",               // Caller 3
    "+972528263032",               // Caller 4
    "+972583230268",               // Caller 5
    ""                // Caller 6
].filter(num => num !== ""); // This removes empty lines automatically

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;

// 🤖 GEMINI SETUP (Only for Main Chat)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", 
    systemInstruction: "You are a helpful phone assistant. Keep answers short. If user asks for music, say 'Press hash'.",
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 SERVE AUDIO FILES
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
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
// 🎵 HELPER: DOWNLOAD SONG (Fixed Command)
// ---------------------------------------------------------
// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG (Fixed for Render Blocking)
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching: "${query}"...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // 🛠️ FIX: Use Android Client to bypass "Sign in to confirm not a bot"
    // We removed the generic "Mozilla" user-agent and used the internal Android API instead.
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 --extractor-args "youtube:player_client=android" -o "${outputTemplate}"`;

    console.log(`🚀 Running: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 40000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 Download Error (Details):");
                console.error(stderr);
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
// 📞 ROUTE 1: START / RESET
// ---------------------------------------------------------
app.post("/twiml", (req, res) => {
    const caller = req.body.From;
    console.log(`📞 Incoming Call from: ${caller}`);

    // 🔒 SECURITY CHECK
    if (!VERIFIED_CALLERS.includes(caller)) {
        console.log("⛔ Unverified Caller - Rejecting");
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    // Reset Session
    sessions.delete(req.body.CallSid);
    getSession(req.body.CallSid); 

    const response = new VoiceResponse();
    response.say("Connected. Ask Gemini, or press Pound for music.");

    response.gather({
        input: "speech dtmf",
        numDigits: 1,
        finishOnKey: "", // Fix for # key
        action: "/main-gather",
        method: "POST",
        timeout: 5,
        bargeIn: true
    });

    res.type("text/xml").send(response.toString());
});

// ---------------------------------------------------------
// 📞 ROUTE 2: MAIN MENU (Gemini Only)
// ---------------------------------------------------------
app.post("/main-gather", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    const session = getSession(callSid);

    // 🔴 Switch Modes
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

    // 🤖 Gemini Logic
    try {
        const result = await session.gemini.sendMessage(userText);
        response.say(result.response.text());
    } catch (e) {
        console.error("Gemini Error:", e);
        response.say("Gemini is not responding.");
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
// 🎵 ROUTE 4: MUSIC PROCESS (NO AI HERE)
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

    // 🕹️ CONTROLS: 4 (Back), 5 (Replay), 6 (Next)
    if (["4", "5", "6"].includes(digits)) {
        
        if (session.history.length === 0) {
            response.say("History empty. Say a song name.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }

        if (digits === "4") { // BACK
            if (session.index > 0) session.index--; 
            else response.say("First song.");
        }
        else if (digits === "6") { // NEXT
            if (session.index < session.history.length - 1) session.index++; 
            else response.say("Last song.");
        }
        // 5 = Replay (just plays current index)

        const song = session.history[session.index];
        response.say(`Playing ${song.title}`);
        
        const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
        gather.play(song.url);
        
        response.redirect("/music-mode"); 
        return res.type("text/xml").send(response.toString());
    }

    // 🔍 DIRECT SEARCH (Raw Text -> yt-dlp)
    if (userText) {
        try {
            // Pass the exact spoken text to yt-dlp
            const songData = await downloadSong(userText);
            
            // Add to history
            session.history.push(songData);
            session.index = session.history.length - 1; 

            response.say(`Playing ${userText}`);
            
            const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
            gather.play(songData.url);

            response.redirect("/music-mode"); 

        } catch (err) {
            console.error("Music Error:", err);
            response.say("Download failed. Try another song.");
            response.redirect("/music-mode");
        }
        return res.type("text/xml").send(response.toString());
    }

    response.say("Say a song name.");
    response.redirect("/music-mode");
    res.type("text/xml").send(response.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
