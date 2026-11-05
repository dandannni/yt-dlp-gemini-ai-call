import { spawn } from "child_process";
import twilio from "twilio";
import { CONFIG, isHebrewText } from "../config.js";
import { gatherPlayOrSay, playInterruptible } from "./tts.js";
import { saveLikedSong, addToPlaylist, getUser } from "../db.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

// Active playback sessions map: callSid -> state object
export const playerSessions = new Map();

export function getPlayerSession(callSid) {
    if (!playerSessions.has(callSid)) {
        playerSessions.set(callSid, {
            type: "music", // 'music' | 'podcast'
            title: "",
            fileUrl: "",
            offset: 0,
            startTime: Date.now(),
            isPaused: false,
            volume: 1.0,
            returnUrl: `${CONFIG.BASE_URL}/twiml`,
            nextTrackCallback: null
        });
    }
    return playerSessions.get(callSid);
}

/**
 * Handle HTTP Streaming of Audio with exact FFmpeg offset, volume, and clean presentation timestamps
 */
export function handleStreamAudio(req, res) {
    const fileUrl = req.query.url;
    const offset = Math.max(0, parseFloat(req.query.offset) || 0);
    const volume = Math.max(0.1, parseFloat(req.query.volume) || 1.0);

    if (!fileUrl) {
        console.warn("[Player] ⚠️ Missing fileUrl in /stream-audio request");
        return res.status(400).send("Missing audio url");
    }

    console.log(`[Player] 🎧 Streaming audio: offset=${offset.toFixed(1)}s, volume=${volume.toFixed(2)}, url=${fileUrl.slice(0, 60)}...`);

    // Strict Anti-Cache Headers so Twilio NEVER plays stale buffers
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Transfer-Encoding", "chunked");

    const ffmpegArgs = [];
    if (offset > 0) {
        ffmpegArgs.push("-ss", offset.toString());
    }

    ffmpegArgs.push("-i", fileUrl);

    // CRITICAL FIX: Re-encode to libmp3lame with telephony format (16kHz mono).
    // This resets Presentation Timestamps (PTS) to 0 at the seek point, ensuring
    // Twilio's audio player plays seamlessly from the exact requested second.
    if (volume !== 1.0) {
        ffmpegArgs.push("-filter:a", `volume=${volume}`);
    }

    ffmpegArgs.push(
        "-c:a", "libmp3lame",
        "-q:a", "4",
        "-ac", "1",
        "-ar", "16000",
        "-f", "mp3",
        "pipe:1"
    );

    const child = spawn("ffmpeg", ffmpegArgs);
    child.stdout.pipe(res);

    child.stderr.on("data", () => {}); // silence buffer diagnostics

    req.on("close", () => {
        try {
            child.kill("SIGKILL");
        } catch (e) {}
    });

    child.on("error", (e) => {
        console.error("[Player] ❌ FFmpeg stream error:", e.message);
    });
}

/**
 * Twilio TwiML Player View
 */
export async function handlePlayerPlay(req, res) {
    const r = new VoiceResponse();
    const session = getPlayerSession(req.body.CallSid);
    const user = await getUser(req.body.From);
    const isEn = user.settings?.language !== "he";

    if (!session.fileUrl) {
        console.warn(`[Player] [Call: ${req.body.CallSid}] No fileUrl found in session. Redirecting to menu.`);
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (session.isPaused) {
        console.log(`[Player] ⏸️ [Call: ${req.body.CallSid}] Playback is paused at ${session.offset.toFixed(1)}s`);
        const pauseMsg = isEn ? "Paused. Press 5 to resume, or Star for menu." : "מושהה. לחץ 5 להמשך, או כוכבית לתפריט.";
        await gatherPlayOrSay(
            r,
            pauseMsg,
            `${CONFIG.BASE_URL}/player-action`,
            1,
            30,
            { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
        );
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    session.startTime = Date.now();
    // Unique cache-busting timestamp query parameter so Twilio never serves a cached segment
    const cb = Date.now();
    const streamUrl = `${CONFIG.BASE_URL}/stream-audio?url=${encodeURIComponent(session.fileUrl)}&offset=${session.offset}&volume=${session.volume || 1.0}&_cb=${cb}`;

    console.log(`[Player] ▶️ [Call: ${req.body.CallSid}] Playing "${session.title}" from ${session.offset.toFixed(1)}s`);

    // Gather wraps Play so any DTMF key immediately sends action to /player-action
    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: `${CONFIG.BASE_URL}/player-action`,
        method: "POST",
        timeout: 0
    });
    g.play(streamUrl);

    // If song/podcast finishes completely without interruption:
    const finishMsg = isEn ? "Finished. Press 8 to save, or Star for menu." : "ההשמעה הסתיימה. לחץ 8 לשמירה, או כוכבית לתפריט.";
    await gatherPlayOrSay(
        r,
        finishMsg,
        `${CONFIG.BASE_URL}/player-post-finish`,
        1,
        5,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );
    r.redirect(session.returnUrl || `${CONFIG.BASE_URL}/twiml`);

    res.type("text/xml").send(r.toString());
}

/**
 * Twilio TwiML Player Action Handler (Keys 1, 3, 4, 5, 6, 2, 8, *)
 */
export async function handlePlayerAction(req, res) {
    const r = new VoiceResponse();
    const session = getPlayerSession(req.body.CallSid);
    const user = await getUser(req.body.From);
    const isEn = user.settings?.language !== "he";
    const key = req.body.Digits;

    const oldOffset = session.offset;

    // Update offset with elapsed playback time
    if (!session.isPaused && session.startTime) {
        const elapsed = (Date.now() - session.startTime) / 1000;
        session.offset = Math.max(0, session.offset + elapsed);
    }

    if (key === "*") {
        console.log(`[Player] ⏹️ [Call: ${req.body.CallSid}] Star (*) pressed: Exiting player back to menu.`);
        session.isPaused = false;
        r.redirect(session.returnUrl || `${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Toggle Pause / Play
        session.isPaused = !session.isPaused;
        console.log(`[Player] ⏯️ [Call: ${req.body.CallSid}] Key 5 pressed: Pause toggled -> isPaused=${session.isPaused} at ${session.offset.toFixed(1)}s`);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "1") {
        // 20 sec backward
        session.offset = Math.max(0, session.offset - 20);
        console.log(`[Player] ⏪ [Call: ${req.body.CallSid}] Key 1 pressed: Rewind 20s (was ${oldOffset.toFixed(1)}s, now ${session.offset.toFixed(1)}s)`);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // 20 sec forward
        session.offset += 20;
        console.log(`[Player] ⏩ [Call: ${req.body.CallSid}] Key 3 pressed: Forward 20s (was ${oldOffset.toFixed(1)}s, now ${session.offset.toFixed(1)}s)`);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // 1 min back for music, 5 min back for podcast
        const jump = session.type === "podcast" ? 300 : 60;
        session.offset = Math.max(0, session.offset - jump);
        console.log(`[Player] ⏮️ [Call: ${req.body.CallSid}] Key 4 pressed: Jump back ${jump}s (was ${oldOffset.toFixed(1)}s, now ${session.offset.toFixed(1)}s)`);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        // 1 min forward for music, 5 min forward for podcast
        const jump = session.type === "podcast" ? 300 : 60;
        session.offset += jump;
        console.log(`[Player] ⏭️ [Call: ${req.body.CallSid}] Key 6 pressed: Jump forward ${jump}s (was ${oldOffset.toFixed(1)}s, now ${session.offset.toFixed(1)}s)`);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Volume adjustment sub-menu
        console.log(`[Player] 🔊 [Call: ${req.body.CallSid}] Key 2 pressed: Opening volume sub-menu`);
        const volPrompt = isEn 
            ? "Volume menu. Press 4 for louder, 6 for softer, 5 to resume."
            : "תפריט עוצמה. לחץ 4 להגברה, 6 להנמכה, 5 להמשך השמעה.";
        await gatherPlayOrSay(
            r,
            volPrompt,
            `${CONFIG.BASE_URL}/player-volume-action`,
            1,
            6,
            { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
        );
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "8") {
        // Save sub-menu
        console.log(`[Player] ⭐ [Call: ${req.body.CallSid}] Key 8 pressed: Opening save sub-menu`);
        const savePrompt = isEn
            ? "Save menu. Press 1 for favorites, 2 for playlists, Star to cancel."
            : "תפריט שמירה. לחץ 1 למועדפים, 2 לפלייליסט, כוכבית לביטול.";
        await gatherPlayOrSay(
            r,
            savePrompt,
            `${CONFIG.BASE_URL}/player-save-menu`,
            1,
            6,
            { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
        );
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    // Default: resume playing
    r.redirect(`${CONFIG.BASE_URL}/player-play`);
    res.type("text/xml").send(r.toString());
}

/**
 * Volume Sub-menu Action
 */
export async function handlePlayerVolume(req, res) {
    const r = new VoiceResponse();
    const session = getPlayerSession(req.body.CallSid);
    const key = req.body.Digits;

    if (key === "4") {
        session.volume = Math.min(2.5, (session.volume || 1.0) + 0.25);
        console.log(`[Player] 🔊 [Call: ${req.body.CallSid}] Volume increased to ${session.volume.toFixed(2)}`);
    } else if (key === "6") {
        session.volume = Math.max(0.25, (session.volume || 1.0) - 0.25);
        console.log(`[Player] 🔉 [Call: ${req.body.CallSid}] Volume decreased to ${session.volume.toFixed(2)}`);
    }

    r.redirect(`${CONFIG.BASE_URL}/player-play`);
    res.type("text/xml").send(r.toString());
}

/**
 * Save / Favorite Sub-menu Action
 */
export async function handlePlayerSave(req, res) {
    const r = new VoiceResponse();
    const session = getPlayerSession(req.body.CallSid);
    const phone = req.body.From;
    const user = await getUser(phone);
    const isEn = user.settings?.language !== "he";
    const key = req.body.Digits;

    if (key === "1") {
        if (session.title) {
            await saveLikedSong(phone, session.title);
            console.log(`[Player] ❤️ [Call: ${req.body.CallSid}] Saved to favorites: "${session.title}"`);
            const msg = isEn ? "Saved to favorites." : "השיר נשמר במועדפים.";
            await playInterruptible(r, msg, `${CONFIG.BASE_URL}/player-play`, { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice });
        }
    } else if (key === "2") {
        if (session.title) {
            await addToPlaylist(phone, "My Playlist", session.title);
            console.log(`[Player] 📋 [Call: ${req.body.CallSid}] Added to playlist: "${session.title}"`);
            const msg = isEn ? "Added to playlist." : "השיר נוסף לפלייליסט.";
            await playInterruptible(r, msg, `${CONFIG.BASE_URL}/player-play`, { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice });
        }
    }

    r.redirect(`${CONFIG.BASE_URL}/player-play`);
    res.type("text/xml").send(r.toString());
}
