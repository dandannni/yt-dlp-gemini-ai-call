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
const ALLOWED_NUMBER = "+972548498889"; 
const PORT = process.env.PORT || 3000;

// 🌍 AUTO-DETECT URL (Render sets RENDER_EXTERNAL_URL automatically)
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// 📂 STORAGE: Use /tmp because Render file system is read-only in some areas
// But /tmp works perfectly for temporary song downloads.
const DOWNLOAD_DIR = "/tmp"; 

// Crash logging
process.on("uncaughtException", err => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("UNHANDLED:", err));

const { twiml } = twilio;
const VoiceResponse = twiml.VoiceResponse;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---------------------------------------------------------
// 🛠️ TOOL DEFINITIONS
// ---------------------------------------------------------
const tools = [
    { googleSearch: {} }, 
    {
        functionDeclarations: [
            {
                name: "play_song",
                description: "Searches for a song on YouTube, downloads it, and plays it.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        query: { type: "STRING", description: "Song name and artist" }
                    },
                    required: ["query"]
                }
            }
        ]
    }
];

const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", 
    systemInstruction: "You are a helpful phone assistant. If the user asks for a song, use the 'play_song' tool. Keep replies very short.",
    tools: tools
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 SERVE AUDIO FILES
// Twilio will request: https://your-app.onrender.com/music/filename.mp3
app.get("/music/:filename", (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("File not found");
    }
});

const sessions = new Map();

// 🎵 HELPER: DOWNLOAD SONG
async function downloadSong(query) {
    console.log(`🎵 Searching: ${query}...`);
    
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    // yt-dlp format: force output to specific filename in /tmp
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // Command: Search 1 result, Extract Audio, Convert to MP3, Save to /tmp
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist -o "${outputTemplate}"`;

    return new Promise((resolve, reject) => {
        // Timeout protection: If download takes > 10s, fail (Twilio will hang otherwise)
        const process = exec(command, { timeout: 12000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("Download failed:", stderr);
                return reject(error);
            }
            console.log("✅ Download complete");
            resolve(`${BASE_URL}/music/${filename}`);
        });
    });
}

// ---------------------------------------------------------
// 📞 ROUTES
// ---------------------------------------------------------

app.post("/twiml", (req, res) => {
    if (req.body.From !== ALLOWED_NUMBER) {
        const r = new VoiceResponse();
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    const response = new VoiceResponse();
    response.say("Gemini is listening.");
    response.gather({ input: "speech", action: "/gather", method: "POST", timeout: 4 });
    res.type("text/xml").send(response.toString());
});

app.post("/gather", async (req, res) => {
    const response = new VoiceResponse();
    const callSid = req.body.CallSid;
    const userText = req.body.SpeechResult;

    if (!userText) {
        response.say("I didn't hear anything.");
        response.gather({ input: "speech", action: "/gather" });
        return res.type("text/xml").send(response.toString());
    }

    let chat = sessions.get(callSid);
    if (!chat) {
        chat = model.startChat({ history: [] });
        sessions.set(callSid, chat);
    }

    try {
        const result = await chat.sendMessage(userText);
        const calls = result.response.functionCalls();
        const textResponse = result.response.text();

        if (calls && calls.length > 0) {
            const call = calls[0];
            if (call.name === "play_song") {
                const songQuery = call.args.query;
                
                try {
                    // Try to download within Twilio's timeout window
                    const audioUrl = await downloadSong(songQuery);
                    
                    response.say(`Playing ${songQuery}`);
                    response.play(audioUrl);
                    
                    // After song ends, gather input again
                    response.gather({ input: "speech", action: "/gather" });

                    // Inform Gemini
                    await chat.sendMessage([{
                        functionResponse: { name: "play_song", response: { status: "success" } }
                    }]);

                } catch (err) {
                    console.error(err);
                    response.say("Sorry, I couldn't grab that song in time.");
                    response.gather({ input: "speech", action: "/gather" });
                }
            }
        } else {
            response.say(textResponse || "Okay.");
            response.gather({ input: "speech", action: "/gather" });
        }

    } catch (e) {
        console.error("Error:", e);
        response.say("System error.");
    }

    res.type("text/xml").send(response.toString());
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
