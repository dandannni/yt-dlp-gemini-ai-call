import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { CONFIG, isHebrewText } from "../config.js";

export const VOICES = {
    HEBREW: {
        Hila: "he-IL-HilaNeural",
        Avri: "he-IL-AvriNeural"
    },
    ENGLISH: {
        Christopher: "en-US-ChristopherNeural",
        Jenny: "en-US-JennyNeural",
        Guy: "en-US-GuyNeural"
    }
};

/**
 * Generate speech file using Edge-TTS
 */
export async function generateTTS(text, options = {}) {
    return new Promise((resolve) => {
        const cleanText = (text || "").replace(/["'\n\r*]/g, " ").trim();
        if (!cleanText) return resolve(null);

        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.resolve(CONFIG.DOWNLOAD_DIR, filename);

        const isHeb = isHebrewText(cleanText);
        const voice = options.voice || (isHeb ? (options.hebrew_voice || VOICES.HEBREW.Hila) : (options.english_voice || VOICES.ENGLISH.Christopher));
        const rate = options.rate || "+0%";

        console.log(`[TTS] 🎙️ Generating speech (${voice}, speed: ${rate}): "${cleanText.slice(0, 60)}..."`);

        const args = ["--text", cleanText, "--voice", voice, "--rate", rate, "--write-media", outputPath];
        const child = spawn("edge-tts", args);

        child.on("close", (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`[TTS] ✅ Speech ready: ${filename}`);
                // Auto-cleanup after 6 minutes
                setTimeout(() => {
                    try {
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    } catch (e) {}
                }, 360000);
                resolve(filename);
            } else {
                console.warn(`[TTS] ⚠️ edge-tts exited with code ${code} for voice ${voice}`);
                resolve(null);
            }
        });

        child.on("error", (err) => {
            console.error("edge-tts spawn error:", err.message);
            resolve(null);
        });
    });
}

/**
 * Twilio Helper: Plays audio/TTS with DTMF gathering to avoid nested Gather crashes
 */
export async function gatherPlayOrSay(r, text, actionUrl, numDigits = 1, timeout = 5, userOptions = {}) {
    const ttsFile = await generateTTS(text, userOptions);
    const g = r.gather({
        input: "dtmf",
        numDigits,
        action: actionUrl,
        method: "POST",
        timeout
    });

    if (ttsFile) {
        g.play(`${CONFIG.BASE_URL}/audio/${ttsFile}`);
    } else {
        g.say({ language: isHebrewText(text) ? "he-IL" : "en-US" }, text);
    }
    return g;
}

/**
 * Twilio Helper: Plays audio/TTS immediately interruptible by DTMF digits
 */
export async function playInterruptible(r, text, actionUrl, userOptions = {}) {
    const ttsFile = await generateTTS(text, userOptions);
    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: actionUrl,
        method: "POST",
        timeout: 0
    });

    if (ttsFile) {
        g.play(`${CONFIG.BASE_URL}/audio/${ttsFile}`);
    } else {
        g.say({ language: isHebrewText(text) ? "he-IL" : "en-US" }, text);
    }
    return g;
}
