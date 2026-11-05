import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { PODCAST_CATALOG, getPodcastEpisodes } from "../services/podcasts.js";
import { gatherPlayOrSay, playInterruptible } from "../services/tts.js";
import { getPlayerSession } from "../services/player.js";
import { getUser } from "../db.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const podcastSessions = new Map();

function getPodcastSession(callSid) {
    if (!podcastSessions.has(callSid)) {
        podcastSessions.set(callSid, { podcastId: 1, episodes: [], epIndex: 0 });
    }
    return podcastSessions.get(callSid);
}

/**
 * Podcasts Catalog Menu: /podcasts/menu
 */
router.all("/menu", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";

    console.log(`[Podcast] 🎙️ [Call: ${req.body.CallSid}] Opening Podcasts Menu (Lang: ${isEn ? "English" : "Hebrew"})`);

    const prompt = isEn
        ? "Podcasts. Press 1 for Osim Historia, 2 for Bizman Sheavadtem, 3 for Ehad Bayom, 4 for Osim Technologia, 5 for Hateshuva, Star for main menu."
        : "פודקאסטים: 1 לעושים היסטוריה, 2 לבזמן שעבדתם, 3 לאחד ביום, 4 לעושים טכנולוגיה, 5 לתשובה, כוכבית לתפריט הראשי.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/podcasts/select`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Podcast Selection: /podcasts/select
 */
router.all("/select", async (req, res) => {
    const r = new VoiceResponse();
    const session = getPodcastSession(req.body.CallSid);
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";
    const key = req.body.Digits;

    console.log(`[Podcast] 🔘 [Call: ${req.body.CallSid}] Podcast selected: "${key}"`);

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const podId = parseInt(key);
    const selected = PODCAST_CATALOG.find(p => p.id === podId);

    if (!selected) {
        r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
        return res.type("text/xml").send(r.toString());
    }

    console.log(`[Podcast] ⏳ [Call: ${req.body.CallSid}] Fetching episodes for "${selected.title}"...`);
    session.podcastId = podId;
    const episodes = await getPodcastEpisodes(podId);

    if (!episodes || episodes.length === 0) {
        console.warn(`[Podcast] ⚠️ [Call: ${req.body.CallSid}] No episodes found for "${selected.title}"`);
        const noEpMsg = isEn ? "No episodes found at this time." : "לא נמצאו פרקים כרגע.";
        await playInterruptible(r, noEpMsg, `${CONFIG.BASE_URL}/podcasts/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
        return res.type("text/xml").send(r.toString());
    }

    console.log(`[Podcast] 📚 [Call: ${req.body.CallSid}] Loaded ${episodes.length} episodes for "${selected.title}"`);
    session.episodes = episodes;
    session.epIndex = 0;
    r.redirect(`${CONFIG.BASE_URL}/podcasts/browse`);
    res.type("text/xml").send(r.toString());
});

/**
 * Episode Browser: /podcasts/browse
 */
router.all("/browse", async (req, res) => {
    const r = new VoiceResponse();
    const session = getPodcastSession(req.body.CallSid);
    const caller = req.body.From;
    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he";

    if (!session.episodes || session.episodes.length === 0) {
        r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
        return res.type("text/xml").send(r.toString());
    }

    const currentEp = session.episodes[session.epIndex];
    const prompt = isEn
        ? `Episode: ${currentEp.title}. Press 5 to play, 6 for next episode, 4 for previous episode, Star for menu.`
        : `פרק: ${currentEp.title}. לחץ 5 להאזנה, 6 לפרק הבא, 4 לקודם, כוכבית לתפריט.`;

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/podcasts/action`,
        1,
        10,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
    res.type("text/xml").send(r.toString());
});

/**
 * Episode Action: /podcasts/action
 */
router.all("/action", async (req, res) => {
    const r = new VoiceResponse();
    const session = getPodcastSession(req.body.CallSid);
    const key = req.body.Digits;

    console.log(`[Podcast] 🔘 [Call: ${req.body.CallSid}] Episode action key: "${key}"`);

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Start streaming podcast
        const currentEp = session.episodes[session.epIndex];
        console.log(`[Podcast] ▶️ [Call: ${req.body.CallSid}] Streaming episode: "${currentEp.title}" -> ${currentEp.audioUrl}`);
        const playerState = getPlayerSession(req.body.CallSid);

        playerState.type = "podcast";
        playerState.title = currentEp.title;
        playerState.fileUrl = currentEp.audioUrl;
        playerState.offset = 0;
        playerState.isPaused = false;
        playerState.volume = 1.0;
        playerState.returnUrl = `${CONFIG.BASE_URL}/podcasts/browse`;

        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        if (session.epIndex < session.episodes.length - 1) session.epIndex++;
        r.redirect(`${CONFIG.BASE_URL}/podcasts/browse`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        if (session.epIndex > 0) session.epIndex--;
        r.redirect(`${CONFIG.BASE_URL}/podcasts/browse`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/podcasts/browse`);
    res.type("text/xml").send(r.toString());
});

export default router;
