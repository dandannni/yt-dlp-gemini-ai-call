import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

export const CONFIG = {
    PORT: process.env.PORT || 3000,
    BASE_URL: (process.env.RENDER_EXTERNAL_URL || "https://yt-dlp-gemini-ai-call.onrender.com").replace(/\/$/, ""),
    DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || (process.platform === "win32" ? "tmp" : "/tmp"),
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
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
        process.env.GEMINI_API_KEY_3
    ].filter(Boolean),
    MONGODB_URI: process.env.MONGODB_URI || "mongodb+srv://daniellevyil_db_user:7vR9tmgRNhnsVKnu@cluster0.4puoaho.mongodb.net"
};

if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) {
    try {
        fs.mkdirSync(CONFIG.DOWNLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create DOWNLOAD_DIR:", e.message);
    }
}

export function isHebrewText(text) {
    return /[\u0590-\u05FF]/.test(text || "");
}
