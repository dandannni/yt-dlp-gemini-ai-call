import { spawn } from "child_process";
import twilio from "twilio";
import { CONFIG, isHebrewText } from "../config.js";
import { gatherPlayOrSay, playInterruptible } from "./tts.js";
import { saveLikedSong, addToPlaylist, getPlaylists } from "../db.js";

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
 * Handle HTTP Streaming of Audio with exact FFmpeg offset and volume
 */
export function handleStreamAudio(req, res) {
    const fileUrl = req.query.url;
    const offset = Math.max(0, parseFloat(req.query.offset) || 0);
    const volume = parseFloat(req.query.volume) || 1.0;

    if (!fileUrl) {
        return res.status(400).send("Missing audio url");
    }

    res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Accept-Ranges": "bytes"
    });

    const ffmpegArgs = [];
    if (offset > 0) {
        ffmpegArgs.push("-ss", offset.toString());
    }

    ffmpegArgs.push("-i", fileUrl);

    if (volume !== 1.0) {
        ffmpegArgs.push("-filter:a", `volume=${volume}`);
        ffmpegArgs.push("-c:a", "libmp3lame", "-q:a", "4");
    } else {
        // Fast direct copy if volume is normal
        ffmpegArgs.push("-c", "copy");
    }

    ffmpegArgs.push("-f", "mp3", "pipe:1");

    const child = spawn("ffmpeg", ffmpegArgs);
    child.stdout.pipe(res);

    child.stderr.on("data", () => {}); // silence buffer warnings

    req.on("close", () => {
        try {
            child.kill("SIGKILL");
        } catch (e) {}
    });

    child.on("error", (e) => {
        console.error("FFmpeg stream error:", e.message);
    });
}

/**
 * Twilio TwiML Player View
 */
export async function handlePlayerPlay(req, res) {
    const r = new VoiceResponse();
    const session = getPlayerSession(req.body.CallSid);

    if (!session.fileUrl) {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (session.isPaused) {
        await gatherPlayOrSay(
            r,
            "Paused. Press 5 to resume, or Star for menu.",
            `${CONFIG.BASE_URL}/player-action`,
            1,
            30
        );
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    session.startTime = Date.now();
    const streamUrl = `${CONFIG.BASE_URL}/stream-audio?url=${encodeURIComponent(session.fileUrl)}&offset=${session.offset}&volume=${session.volume || 1.0}`;

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
    await gatherPlayOrSay(
        r,
        "Finished. Press 8 to save, or Star for menu.",
        `${CONFIG.BASE_URL}/player-post-finish`,
        1,
        5
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
    const key = req.body.Digits;

    // Update offset with elapsed playback time
    if (!session.isPaused && session.startTime) {
        const elapsed = (Date.now() - session.startTime) / 1000;
        session.offset = Math.max(0, session.offset + elapsed);
    }

    if (key === "*") {
        session.isPaused = false;
        r.redirect(session.returnUrl || `${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Toggle Pause / Play
        session.isPaused = !session.isPaused;
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "1") {
        // 20 sec backward
        session.offset = Math.max(0, session.offset - 20);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // 20 sec forward
        session.offset += 20;
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // 1 min back for music, 5 min back for podcast
        const jump = session.type === "podcast" ? 300 : 60;
        session.offset = Math.max(0, session.offset - jump);
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        // 1 min forward for music, 5 min forward for podcast
        const jump = session.type === "podcast" ? 300 : 60;
        session.offset += jump;
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Volume adjustment sub-menu
        await gatherPlayOrSay(
            r,
            "Volume. Press 4 for louder, 6 for softer, 5 to resume.",
            `${CONFIG.BASE_URL}/player-volume-action`,
            1,
            6
        );
        r.redirect(`${CONFIG.BASE_URL}/player-play`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "8") {
        // Save sub-menu
        await gatherPlayOrSay(
            r,
            "Save. Press 1 for favorites, 2 for playlists, Star to cancel.",
            `${CONFIG.BASE_URL}/player-save-menu`,
            1,
            6
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
        // Louder (+25%)
        session.volume = Math.min(2.5, (session.volume || 1.0) + 0.25);
    } else if (key === "6") {
        // Softer (-25%)
        session.volume = Math.max(0.25, (session.volume || 1.0) - 0.25);
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
    const key = req.body.Digits;

    if (key === "1") {
        if (session.title) {
            await saveLikedSong(phone, session.title);
            await playInterruptible(r, "Saved to favorites.", `${CONFIG.BASE_URL}/player-play`);
        }
    } else if (key === "2") {
        if (session.title) {
            await addToPlaylist(phone, "My Playlist", session.title);
            await playInterruptible(r, "Added to playlist.", `${CONFIG.BASE_URL}/player-play`);
        }
    }

    r.redirect(`${CONFIG.BASE_URL}/player-play`);
    res.type("text/xml").send(r.toString());
}
