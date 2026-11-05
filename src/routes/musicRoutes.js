import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { gatherPlayOrSay, playInterruptible } from "../services/tts.js";
import { getPlayerSession } from "../services/player.js";
import { searchAndDownloadMusic, musicQueue } from "../services/music.js";
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

    const prompt = "מוזיקה: 1 לחיפוש שיר, 2 להיסטוריה, 3 לשירים שמורים, 4 לפלייליסטים, 5 להגדרות, כוכבית לתפריט הראשי.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/music/menu-action`,
        1,
        8,
        { voice: user.settings?.hebrew_voice }
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
    const browse = getBrowseSession(req.body.CallSid);
    const key = req.body.Digits;

    if (key === "1") {
        // Search song via voice recording
        await playInterruptible(r, "אמור את שם השיר או האמן לאחר הצפצוף.", `${CONFIG.BASE_URL}/music/record-search`, { voice: user.settings?.hebrew_voice });
        r.record({
            action: `${CONFIG.BASE_URL}/music/process-search`,
            method: "POST",
            maxLength: 15,
            playBeep: true,
            timeout: 3
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // History
        browse.type = "history";
        browse.list = user.music_history || [];
        browse.index = 0;
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Saved songs
        browse.type = "likes";
        browse.list = await getLikedSongs(caller);
        browse.index = 0;
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
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Toggle search engine setting
        const current = user.settings?.search_engine || "scsearch1:";
        const newEngine = current.startsWith("scsearch") ? "ytsearch1:" : "scsearch1:";
        await updateUserSettings(caller, { search_engine: newEngine });
        const name = newEngine.startsWith("scsearch") ? "סאונדקלאוד" : "יוטיוב";
        await playInterruptible(r, `מנוע החיפוש הוגדר ל${name}.`, `${CONFIG.BASE_URL}/music/menu`, { voice: user.settings?.hebrew_voice });
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
    const recordingUrl = req.body.RecordingUrl;

    if (!recordingUrl) {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    let base64Audio = null;
    try {
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const fetchRes = await fetch(recordingUrl + ".mp3", { headers: { Authorization: authHeader } });
        if (fetchRes.ok) {
            base64Audio = Buffer.from(await fetchRes.arrayBuffer()).toString("base64");
        }
    } catch (e) {}

    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
    const query = intentData?.query || "Israel popular songs";
    const isLong = intentData?.intent === "music_long";

    await saveMusicHistory(caller, query);
    searchAndDownloadMusic(req.body.CallSid, query, {
        isLong,
        engine: user.settings?.search_engine || "scsearch1:"
    });

    await playInterruptible(r, `מחפש את ${query}`, `${CONFIG.BASE_URL}/music/wait-loop`, { voice: user.settings?.hebrew_voice });
    r.redirect(`${CONFIG.BASE_URL}/music/wait-loop`);
    res.type("text/xml").send(r.toString());
});

/**
 * Music Download Polling Loop: /music/wait-loop
 */
router.all("/wait-loop", async (req, res) => {
    const r = new VoiceResponse();
    const task = musicQueue.get(req.body.CallSid);

    if (!task) {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (task.status === "done") {
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

    if (task.status === "error" || (Date.now() - task.startTime > 45000)) {
        await playInterruptible(r, "שגיאה במציאת השיר. אנא נסה שוב.", `${CONFIG.BASE_URL}/music/menu`);
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    r.pause({ length: 2 });
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
    const browse = getBrowseSession(req.body.CallSid);

    if (!browse.list || browse.list.length === 0) {
        await playInterruptible(r, "הרשימה ריקה.", `${CONFIG.BASE_URL}/music/menu`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    const currentItem = browse.list[browse.index];
    let prompt = `${currentItem}. לחץ 5 להשמעה, 6 להבא, 4 לקודם.`;
    if (browse.type === "likes") prompt += " 9 למחיקה.";
    prompt += " כוכבית לחזרה.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/music/browse-action`,
        1,
        10,
        { voice: user.settings?.hebrew_voice }
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
    const browse = getBrowseSession(req.body.CallSid);
    const key = req.body.Digits;

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/music/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Play selected item
        const selected = browse.list[browse.index];
        searchAndDownloadMusic(req.body.CallSid, selected, { engine: user.settings?.search_engine || "scsearch1:" });
        await playInterruptible(r, `מנגן את ${selected}`, `${CONFIG.BASE_URL}/music/wait-loop`, { voice: user.settings?.hebrew_voice });
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
        await playInterruptible(r, "השיר הוסר.", `${CONFIG.BASE_URL}/music/browse`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/music/browse`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/music/browse`);
    res.type("text/xml").send(r.toString());
});

export default router;
