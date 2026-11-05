// ==============================================================================
// Voice OS Master Server v10.0
// Universal Telephony AI Assistant, Streaming Music Engine, Podcasts & Ynet News
// ==============================================================================
import express from "express";
import path from "path";
import fs from "fs";
import { CONFIG } from "./src/config.js";
import { initDB } from "./src/db.js";

// Core Services
import {
    handleStreamAudio,
    handlePlayerPlay,
    handlePlayerAction,
    handlePlayerVolume,
    handlePlayerSave
} from "./src/services/player.js";

// Route Modules
import mainMenuRoutes from "./src/routes/mainMenu.js";
import geminiChatRoutes from "./src/routes/geminiChat.js";
import musicRoutes from "./src/routes/musicRoutes.js";
import podcastRoutes from "./src/routes/podcastRoutes.js";
import newsRoutes from "./src/routes/newsRoutes.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Universal Request Logger for Render
app.use((req, res, next) => {
    if (!req.path.startsWith("/audio") && !req.path.startsWith("/music")) {
        const caller = req.body?.From || req.query?.From || "web";
        const digits = req.body?.Digits !== undefined ? `[DTMF: "${req.body.Digits}"]` : "";
        console.log(`[HTTP] 📲 ${req.method} ${req.originalUrl} | Caller: ${caller} ${digits}`);
    }
    next();
});

// ------------------------------------------------------------------------------
// Health Check & Uptime Monitor
// ------------------------------------------------------------------------------
app.get("/", (req, res) => {
    res.send("🚀 Voice OS v10.0 Enterprise Online! Connected and ready.");
});

// ------------------------------------------------------------------------------
// Static Audio File Server (TTS and Downloaded Tracks)
// ------------------------------------------------------------------------------
function serveAudioFile(req, res) {
    const filename = req.params.filename;
    const filePath = path.resolve(CONFIG.DOWNLOAD_DIR, filename);

    if (fs.existsSync(filePath)) {
        res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": fs.statSync(filePath).size,
            "Accept-Ranges": "bytes"
        });
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).send("File not found or expired");
    }
}

app.get("/audio/:filename", serveAudioFile);
app.get("/music/:filename", serveAudioFile); // backward compatibility alias

// ------------------------------------------------------------------------------
// Universal Streaming & Seeking Player Engine (FFmpeg -ss offset)
// ------------------------------------------------------------------------------
app.get("/stream-audio", handleStreamAudio);
app.all("/player-play", handlePlayerPlay);
app.all("/player-action", handlePlayerAction);
app.all("/player-volume-action", handlePlayerVolume);
app.all("/player-save-menu", handlePlayerSave);
app.all("/player-post-finish", (req, res) => {
    res.redirect(`${CONFIG.BASE_URL}/twiml`);
});

// ------------------------------------------------------------------------------
// Mount Modular IVR Subsystems
// ------------------------------------------------------------------------------
app.use("/", mainMenuRoutes);         // /twiml, /main-menu-router
app.use("/chat", geminiChatRoutes);   // /chat/menu, /chat/process-speech, /chat/settings...
app.use("/music", musicRoutes);       // /music/menu, /music/process-search, /music/browse...
app.use("/podcasts", podcastRoutes); // /podcasts/menu, /podcasts/browse...
app.use("/news", newsRoutes);         // /news/menu, /news/read, /news/action...

// Global Star (*) fallback redirect
app.all("/interrupt-router", (req, res) => {
    res.redirect(`${CONFIG.BASE_URL}/twiml`);
});

// ------------------------------------------------------------------------------
// Server Startup
// ------------------------------------------------------------------------------
async function startServer() {
    await initDB();
    app.listen(CONFIG.PORT, () => {
        console.log(`====================================================`);
        console.log(`🚀 Voice OS v10.0 running on Port ${CONFIG.PORT}`);
        console.log(`🌐 Base URL: ${CONFIG.BASE_URL}`);
        console.log(`====================================================`);
    });
}

startServer();
