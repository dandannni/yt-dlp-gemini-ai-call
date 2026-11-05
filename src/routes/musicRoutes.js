import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { gatherPlayOrSay, playInterruptible, generateTTS } from "../services/tts.js";
import { getPlayerSession } from "../services/player.js";
import { searchAndDownloadMusic, musicQueue, normalizeMusicQuery } from "../services/music.js";
import { analyzeAudioIntent } from "../services/gemini.js";
import {
    getUser,
    saveMusicHistory,
    getLikedSongs,
    removeLikedSong,
    getPlaylists,
    updateUserSettings
} from "../db.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const musicBrowserSessions = new Map();

function getBrowseSession(callSid) {
    if (!musicBrowserSessions.has(callSid)) {
        musicBrowserSessions.set(callSid, { type: "history", list: [], index: 0 });
    }
    return musicBrowserSessions.get(callSid);
}

/**
 * Music Main Menu: /music/menu
 */
router.all("/menu", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";

    console.log(`[Music] 🎵 [Call: ${req.body.CallSid}] Opening Music Menu (Lang: ${isEn ? "English" : "Hebrew"})`);

    const prompt = isEn
        ? "Music Menu. Press 1 to search for a song, 2 for history, 3 for saved songs, 4 for playlists, Star for main menu."
        : "מוזיקה: 1 לחיפוש שיר, 2 להיסטוריה, 3 לשירים שמורים, 4 לפלייליסטים, כוכבית לתפריט הראשי.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/music/menu-action`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Music Menu Router: /music/menu-action
 */
router.all("/menu-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const browse = getBrowseSession(req.body.CallSid);
    const key = req.body.Digits;

    console.log(`[Music] 🔘 [Call: ${req.body.CallSid}] Music menu key: "${key}"`);

    if (key === "1") {
        // High-speed voice search with Twilio telecom ASR and # key
        const speakPrompt = isEn 
            ? "Say the song name or artist, then press pound." 
            : "אמור את שם השיר או האמן, ולחץ סולמית.";
        
        const g = r.gather({
            input: "speech dtmf",
            action: `${CONFIG.BASE_URL}/music/process-search`,
            method: "POST",
            finishOnKey: "#",
            speechTimeout: "auto",
            timeout: 8,
            language: isEn ? "en-US" : "he-IL"
        });

        const promptFile = await generateTTS(speakPrompt, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
            isDynamic: false
        });

        if (promptFile) {
            g.play(`${CONFIG.BASE_URL}/audio/${promptFile}`);
        } else {
            g.say({ language: isEn ? "en-US" : "he-IL" }, speakPrompt);
        }

        // Secondary fallback to recording if user didn't speak during gather
        r.record({
            action: `${CONFIG.BASE_URL}/music/process-search`,
            method: "POST",
            maxLength: 30,
            playBeep: false,
            timeout: 10,
            finishOnKey: "#"
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // History
        browse.type = "history";
        browse.list = user.music_history || [];
        browse.index = 0;
        console.log(`[Music] 📜 [Call: ${req.body.CallSid}] Browsing music history (${browse.list.length} tracks)`);
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Saved songs
        browse.type = "likes";
        browse.list = await getLikedSongs(caller);
        browse.index = 0;
        console.log(`[Music] ❤️ [Call: ${req.body.CallSid}] Browsing saved songs (${browse.list.length} tracks)`);
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // Playlists
        browse.type = "playlist";
        const playlists = await getPlaylists(caller);
        const allSongs = Object.values(playlists).flat();
        browse.list = allSongs.sort(() => Math.random() - 0.5); // Shuffle
        browse.index = 0;
        console.log(`[Music] 🔀 [Call: ${req.body.CallSid}] Browsing shuffled playlist (${browse.list.length} tracks)`);
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        await updateUserSettings(caller, { search_engine: "ytsearch1:" });
        const msg = isEn ? "High-speed YouTube engine is active." : "מנוע יוטיוב המהיר פעיל.";
        await playInterruptible(r, msg, `${CONFIG.BASE_URL}/music/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Process Voice Search for Music
 */
router.all("/process-search", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const recordingUrl = req.body.RecordingUrl;
    let query = req.body.SpeechResult || null;
    let isLong = false;

    // Check DTMF star (*) abort
    if (req.body.Digits === "*") {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (!query && recordingUrl) {
        let base64Audio = null;
        try {
            const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
            const fetchRes = await fetch(recordingUrl + ".mp3", { headers: { Authorization: authHeader } });
            if (fetchRes.ok) {
                base64Audio = Buffer.from(await fetchRes.arrayBuffer()).toString("base64");
            }
        } catch (e) {
            console.error(`[Music] ❌ Recording download error:`, e.message);
        }

        const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
        if (intentData && intentData.query) {
            query = intentData.query;
            isLong = intentData.intent === "music_long";
        }
    }

    if (query) {
        query = normalizeMusicQuery(query);
    }

    if (!query) {
        console.warn(`[Music] ⚠️ [Call: ${req.body.CallSid}] No speech recognized`);
        const failMsg = isEn ? "Could not understand speech. Please try again." : "לא הצלחתי לזהות דיבור. אנא נסה שוב.";
        await playInterruptible(r, failMsg, `${CONFIG.BASE_URL}/music/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    console.log(`[Music] 🔍 [Call: ${req.body.CallSid}] Song search query: "${query}" (Source: ${req.body.SpeechResult ? "Twilio ASR" : "Audio Model"})`);

    await saveMusicHistory(caller, query);
    searchAndDownloadMusic(req.body.CallSid, query, { isLong });

    // Static pre-cached transition prompt (0 ms TTS latency!)
    const searchPrompt = isEn ? "Searching for your song now..." : "מחפש את השיר כעת...";
    await playInterruptible(r, searchPrompt, `${CONFIG.BASE_URL}/music/wait-loop`, {
        voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
    });
    r.redirect(`${CONFIG.BASE_URL}/music/wait-loop`);
    res.type("text/xml").send(r.toString());
});

/**
 * Music Download Polling Loop: /music/wait-loop
 */
router.all("/wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const task = musicQueue.get(req.body.CallSid);

    if (!task) {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    // Fast-path: wait up to 2.5s in 250ms increments to catch immediate completion
    for (let i = 0; i < 10; i++) {
        if (task.status === "done" || task.status === "error") break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (task.status === "done") {
        console.log(`[Music] 🚀 [Call: ${req.body.CallSid}] Handing off to Player Engine: ${task.url}`);
        const playerState = getPlayerSession(req.body.CallSid);
        playerState.type = "music";
        playerState.title = task.query;
        playerState.fileUrl = task.url;
        playerState.offset = 0;
        playerState.isPaused = false;
        playerState.volume = 1.0;
        playerState.returnUrl = `${CONFIG.BASE_URL}/music/menu`;

        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (task.status === "error" || (Date.now() - task.startTime > 35000)) {
        console.warn(`[Music] ❌ [Call: ${req.body.CallSid}] Song resolution error or timeout: "${task.query}"`);
        const errPrompt = isEn ? "Could not find the song. Please try another search." : "שגיאה במציאת השיר. אנא נסה שוב.";
        await playInterruptible(r, errPrompt, `${CONFIG.BASE_URL}/music/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    r.pause({ length: 1 });
    r.redirect(`${CONFIG.BASE_URL}/music/wait-loop`);
    res.type("text/xml").send(r.toString());
});

/**
 * Browse Music (History / Likes / Playlists)
 */
router.all("/browse", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const browse = getBrowseSession(req.body.CallSid);

    if (!browse.list || browse.list.length === 0) {
        const emptyMsg = isEn ? "The list is empty." : "הרשימה ריקה.";
        await playInterruptible(r, emptyMsg, `${CONFIG.BASE_URL}/music/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    const currentItem = browse.list[browse.index];
    let prompt = isEn
        ? `${currentItem}. Press 5 to play, 6 for next, 4 for previous.`
        : `${currentItem}. לחץ 5 להשמעה, 6 להבא, 4 לקודם.`;

    if (browse.type === "likes") {
        prompt += isEn ? " 9 to remove." : " 9 למחיקה.";
    }
    prompt += isEn ? " Star to return." : " כוכבית לחזרה.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/music/browse-action`,
        1,
        10,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/music/menu`);
    res.type("text/xml").send(r.toString());
});

/**
 * Action on Browse Item
 */
router.all("/browse-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const browse = getBrowseSession(req.body.CallSid);
    const key = req.body.Digits;

    console.log(`[Music] 🔘 [Call: ${req.body.CallSid}] Browse action key: "${key}"`);

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Play selected item
        const selected = browse.list[browse.index];
        console.log(`[Music] ▶️ [Call: ${req.body.CallSid}] Selected item to play: "${selected}"`);
        searchAndDownloadMusic(req.body.CallSid, selected, { engine: user.settings?.search_engine || "ytsearch1:" });
        const playMsg = isEn ? `Playing ${selected}` : `מנגן את ${selected}`;
        await playInterruptible(r, playMsg, `${CONFIG.BASE_URL}/music/wait-loop`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/wait-loop`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        if (browse.index < browse.list.length - 1) browse.index++;
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        if (browse.index > 0) browse.index--;
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "9" && browse.type === "likes") {
        const itemToRemove = browse.list[browse.index];
        await removeLikedSong(caller, itemToRemove);
        browse.list = await getLikedSongs(caller);
        browse.index = 0;
        console.log(`[Music] 🗑️ [Call: ${req.body.CallSid}] Removed from likes: "${itemToRemove}"`);
        const remMsg = isEn ? "Track removed from favorites." : "השיר הוסר.";
        await playInterruptible(r, remMsg, `${CONFIG.BASE_URL}/music/browse`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/music/browse`);
    res.type("text/xml").send(r.toString());
});

export default router;
