import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { CONFIG } from "../config.js";

export const musicQueue = new Map();

function getTrackHash(query) {
    return crypto.createHash("md5").update(query.trim().toLowerCase()).digest("hex").slice(0, 10);
}

/**
 * Execute yt-dlp child process with real-time logs and automatic fallback
 */
function executeDownload(callSid, query, engine, isLong, isFallback = false) {
    const trackHash = getTrackHash(query);
    const id = `${trackHash}_${uuidv4().slice(0, 8)}`;
    const outputTemplate = path.resolve(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    console.log(`[Music] 🎵 [Call: ${callSid}] Starting download with engine "${engine}" for query: "${query}" (Fallback: ${isFallback})`);

    let searchArg = `${engine}${query}`;
    let args = [
        searchArg,
        "-x",
        "--audio-format", "mp3",
        "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000",
        "--no-playlist",
        "--force-ipv4",
        "--no-check-certificates",
        "--extractor-args", "youtube:player_client=android,web",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "-o", outputTemplate
    ];

    if (!isLong) {
        args.splice(4, 0, "--match-filter", "duration < 600");
    }

    const child = spawn("yt-dlp", args);

    // Stream download progress to Render logs
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        const lines = text.split(/[\r\n]+/).filter(Boolean);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("[download]") || trimmed.startsWith("[ExtractAudio]") || trimmed.startsWith("[ffmpeg]")) {
                console.log(`[Music] 📥 [Call: ${callSid}] ${trimmed}`);
            }
        }
    });

    child.stderr.on("data", (chunk) => {
        const errLine = chunk.toString().trim();
        if (errLine && !errLine.includes("WARNING")) {
            console.warn(`[Music] ⚠️ [Call: ${callSid}] [yt-dlp stderr] ${errLine}`);
        }
    });

    child.on("close", (code) => {
        try {
            const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
            const found = files.find(f => f.startsWith(id) && f.endsWith(".mp3"));

            if (found) {
                const finalUrl = `${CONFIG.BASE_URL}/audio/${found}`;
                console.log(`[Music] ✅ [Call: ${callSid}] Download SUCCESS: ${found} -> URL: ${finalUrl}`);
                musicQueue.set(callSid, {
                    status: "done",
                    url: finalUrl,
                    query
                });

                // Auto-cleanup file after 45 minutes
                setTimeout(() => {
                    try {
                        const target = path.resolve(CONFIG.DOWNLOAD_DIR, found);
                        if (fs.existsSync(target)) {
                            fs.unlinkSync(target);
                            console.log(`[Music] 🧹 Auto-cleaned cached track: ${found}`);
                        }
                    } catch (e) {}
                }, 45 * 60 * 1000);
            } else {
                console.warn(`[Music] ⚠️ [Call: ${callSid}] yt-dlp finished with code ${code} but no MP3 was found for "${query}".`);

                // If YouTube search failed (common on Render data center IPs), automatically fallback to SoundCloud!
                if (!isFallback && engine.startsWith("ytsearch")) {
                    console.log(`[Music] 🔄 [Call: ${callSid}] YouTube failed. Auto-fallback to SoundCloud search for "${query}"...`);
                    return executeDownload(callSid, query, "scsearch1:", isLong, true);
                }

                musicQueue.set(callSid, { status: "error", query });
            }
        } catch (err) {
            console.error(`[Music] ❌ [Call: ${callSid}] Error in close handler:`, err.message);
            musicQueue.set(callSid, { status: "error", query });
        }
    });

    child.on("error", (err) => {
        console.error(`[Music] ❌ [Call: ${callSid}] Failed to spawn yt-dlp:`, err.message);
        if (!isFallback && engine.startsWith("ytsearch")) {
            console.log(`[Music] 🔄 [Call: ${callSid}] Spawn error. Auto-fallback to SoundCloud search...`);
            return executeDownload(callSid, query, "scsearch1:", isLong, true);
        }
        musicQueue.set(callSid, { status: "error", query });
    });
}

/**
 * Search and download audio using yt-dlp with caching
 */
export async function searchAndDownloadMusic(callSid, query, options = {}) {
    const isLong = options.isLong || false;
    const engine = options.engine || "scsearch1:";
    const trackHash = getTrackHash(query);

    musicQueue.set(callSid, {
        status: "pending",
        startTime: Date.now(),
        query
    });

    // 1. Fast Cache Check: Check if track was recently downloaded
    try {
        const existingFiles = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const cachedFile = existingFiles.find(f => f.includes(trackHash) && f.endsWith(".mp3"));
        if (cachedFile) {
            const cachedUrl = `${CONFIG.BASE_URL}/audio/${cachedFile}`;
            console.log(`[Music] ⚡ [Call: ${callSid}] Instant Cache HIT for "${query}": ${cachedFile}`);
            musicQueue.set(callSid, {
                status: "done",
                url: cachedUrl,
                query
            });
            return;
        }
    } catch (e) {}

    // 2. Execute download
    executeDownload(callSid, query, engine, isLong, false);
}
