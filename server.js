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
const VERIFIED_CALLERS = [
    "+972548498889",  // Your Number
    "+972554402506",  // Caller 2
    "+972525585720",  // Caller 3
    "+972528263032",  // Caller 4
    "+972583230268",  // Caller 5
    ""                // Caller 6 (Empty is ignored)
].filter(num => num !== "");

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
        res.status(404).send("File deleted or not found");
    }
});

// 🧠 SESSION STORAGE (Stores Chat + Music History)
const sessions = new Map();

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, {
            gemini: model.startChat({ history: [] }),
            history: [], // List of songs played
            index: -1    // Current song position
        });
    }
    return sessions.get(callSid);
}

// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG (With Auto-Delete)
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching: "${query}"...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // Android Client Command (Bypasses Bot Check)
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 --extractor-args "youtube:player_client=android" -o "${outputTemplate}"`;

    console.log(`🚀 Running: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 40000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 Download Error:");
                console.error(stderr);
                return reject(error);
            }

            // 🗑️ AUTO-DELETE: Deletes file after 10 minutes
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
        finishOnKey: "", 
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
// 🎵 ROUTE 4: MUSIC PROCESS (Controls + Download)
// ---------------------------------------------------------
app.post("/music-process", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const digits = req.body.Digits;
    const userText = req.body.SpeechResult;
    
    const session = getSession(callSid);

    // 🛑 RESET (0)
    if (digits === "0") {
        response.redirect("/twiml");
        return res.type("text/xml").send(response.toString());
    }

    // 🕹️ HISTORY CONTROLS: 4 (Back), 5 (Replay), 6 (Next)
    if (["4", "5", "6"].includes(digits)) {
        
        if (session.history.length === 0) {
            response.say("History empty. Say a song name.");
            response.redirect("/music-mode");
            return res.type("text/xml").send(response.toString());
        }

        // Logic to move the index pointer
        if (digits === "4") { // BACK
            if (session.index > 0) session.index--; 
            else response.say("First song.");
        }
        else if (digits === "6") { // NEXT
            if (session.index < session.history.length - 1) session.index++; 
            else response.say("Last song.");
        }
        // 5 falls through here (index doesn't change = Replay)

        // Play the song at the current index
        const song = session.history[session.index];
        response.say(`Playing ${song.title}`);
        
        // Use <Gather> around <Play> so you can interrupt with 4,5,6 again
        const gather = response.gather({ input: "dtmf", numDigits: 1, finishOnKey: "", action: "/music-process" });
        gather.play(song.url);
        
        response.redirect("/music-mode"); 
        return res.type("text/xml").send(response.toString());
    }

    // 🔍 DIRECT SEARCH (Voice -> Download)
    if (userText) {
        try {
            const songData = await downloadSong(userText);
            
            // Add new song to history list
            session.history.push(songData);
            session.index = session.history.length - 1; // Set pointer to newest song

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
