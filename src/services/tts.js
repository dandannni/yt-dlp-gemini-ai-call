import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
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
 * Generate speech file using Edge-TTS with persistent static prompt caching
 */
export async function generateTTS(text, options = {}) {
    const cleanText = (text || "").replace(/["'\n\r*]/g, " ").trim();
    if (!cleanText) return null;

    const isHeb = isHebrewText(cleanText);
    const voice = options.voice || (isHeb ? (options.hebrew_voice || VOICES.HEBREW.Hila) : (options.english_voice || VOICES.ENGLISH.Christopher));
    const rate = options.rate || "+0%";
    const isDynamic = options.isDynamic || false;

    // 1. Static Prompt Cache: Re-use pre-generated audio for identical text (0 ms response!)
    if (!isDynamic) {
        const hash = crypto.createHash("md5").update(`${cleanText}_${voice}_${rate}`).digest("hex").slice(0, 16);
        const cachedFilename = `prompt_${hash}.mp3`;
        const cachedPath = path.resolve(CONFIG.DOWNLOAD_DIR, cachedFilename);

        if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 1000) {
            return cachedFilename;
        }

        return new Promise((resolve) => {
            console.log(`[TTS] 🎙️ Pre-rendering prompt (${voice}): "${cleanText.slice(0, 50)}..."`);
            const args = ["--text", cleanText, "--voice", voice, "--rate", rate, "--write-media", cachedPath];
            const child = spawn("edge-tts", args);

            child.on("close", (code) => {
                if (code === 0 && fs.existsSync(cachedPath)) {
                    console.log(`[TTS] ✅ Prompt cached permanently: ${cachedFilename}`);
                    resolve(cachedFilename);
                } else {
                    console.warn(`[TTS] ⚠️ Failed caching prompt with code ${code}`);
                    resolve(null);
                }
            });

            child.on("error", (err) => {
                console.error("[TTS] ❌ edge-tts spawn error:", err.message);
                resolve(null);
            });
        });
    }

    // 2. Dynamic Conversational Audio (unique Gemini answers)
    return new Promise((resolve) => {
        const id = uuidv4();
        const filename = `tts_${id}.mp3`;
        const outputPath = path.resolve(CONFIG.DOWNLOAD_DIR, filename);

        console.log(`[TTS] 🎙️ Generating conversational speech (${voice}): "${cleanText.slice(0, 50)}..."`);

        const args = ["--text", cleanText, "--voice", voice, "--rate", rate, "--write-media", outputPath];
        const child = spawn("edge-tts", args);

        child.on("close", (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                // Auto-cleanup dynamic files after 6 minutes
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
            console.error("[TTS] ❌ edge-tts spawn error:", err.message);
            resolve(null);
        });
    });
}

/**
 * Twilio Helper: Plays audio/TTS with DTMF gathering to avoid nested Gather crashes
 */
export async function gatherPlayOrSay(r, text, actionUrl, numDigits = 1, timeout = 5, userOptions = {}) {
    const ttsFile = await generateTTS(text, { ...userOptions, isDynamic: false });
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
    const ttsFile = await generateTTS(text, { ...userOptions, isDynamic: false });
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

/**
 * Pre-cache standard IVR prompts on startup so callers get instant 0ms responses
 */
export async function warmupStaticPrompts() {
    console.log("[TTS] ⚡ Warming up static prompt audio cache in background...");
    const englishPrompts = [
        "Welcome to Voice OS. Press 1 for AI Assistant, 2 for Music, 3 for Podcasts, 4 for News, or 0 for Settings.",
        "Music Menu. Press 1 to search for a song, 2 for history, 3 for saved songs, 4 for playlists, Star for main menu.",
        "AI Assistant. Press 1 for a new chat, 2 to continue recent chat, 3 for saved chats, 4 for settings, Star for main menu.",
        "Podcasts. Press 1 for Osim Historia, 2 for Bizman Sheavadtem, 3 for Ehad Bayom, 4 for Osim Technologia, 5 for Hateshuva, Star for main menu.",
        "Say the song name or artist after the beep, then press pound.",
        "Speak after the tone. Press pound when finished.",
        "Searching for your song now...",
        "Finished. Press 8 to save, or Star for menu.",
        "Paused. Press 5 to resume, or Star for menu.",
        "Could not find the song. Please try another search.",
        "Could not understand speech. Please try again.",
        "1 to continue, 3 to save, 4 for previous turn, 6 for next turn, 7 for summary, Star for menu.",
        "Song saved to favorites."
    ];

    const hebrewPrompts = [
        "שלום. 1 לשיחה עם בינה מלאכותית, 2 למוזיקה, 3 לפודקאסטים, 4 למבזקי חדשות, או 0 להגדרות.",
        "מוזיקה: 1 לחיפוש שיר, 2 להיסטוריה, 3 לשירים שמורים, 4 לפלייליסטים, כוכבית לתפריט הראשי.",
        "שיחה עם בינה מלאכותית: 1 לשיחה חדשה, 2 להמשך שיחה מהיסטוריה, 3 לשיחות שמורות, 4 להגדרות, כוכבית לתפריט הראשי.",
        "פודקאסטים: 1 לעושים היסטוריה, 2 לבזמן שעבדתם, 3 לאחד ביום, 4 לעושים טכנולוגיה, 5 לתשובה, כוכבית לתפריט הראשי.",
        "אמור את שם השיר או האמן לאחר הצפצוף, ולחץ סולמית.",
        "דבר לאחר הצפצוף, ולחץ סולמית לסיום.",
        "מחפש את השיר כעת...",
        "ההשמעה הסתיימה. לחץ 8 לשמירה, או כוכבית לתפריט.",
        "מושהה. לחץ 5 להמשך, או כוכבית לתפריט.",
        "שגיאה במציאת השיר. אנא נסה שוב.",
        "לא הצלחתי לזהות דיבור. אנא נסה שוב.",
        "1 להמשך, 3 לשמירה, 4 לקודם, 6 להבא, 7 לסיכום, כוכבית לתפריט.",
        "השיר נשמר במועדפים."
    ];

    for (const p of englishPrompts) {
        try {
            await generateTTS(p, { isDynamic: false, voice: VOICES.ENGLISH.Christopher });
        } catch (e) {}
    }

    for (const p of hebrewPrompts) {
        try {
            await generateTTS(p, { isDynamic: false, voice: VOICES.HEBREW.Hila });
        } catch (e) {}
    }

    console.log("[TTS] ✅ Core prompts ready in cache (English + Hebrew)!");
}




