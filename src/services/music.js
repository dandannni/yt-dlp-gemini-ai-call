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

    // 1. Fast Cache Check: See if this track was recently downloaded
    try {
        const existingFiles = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
        const cachedFile = existingFiles.find(f => f.includes(trackHash) && f.endsWith(".mp3"));
        if (cachedFile) {
            const cachedUrl = `${CONFIG.BASE_URL}/audio/${cachedFile}`;
            musicQueue.set(callSid, {
                status: "done",
                url: cachedUrl,
                query
            });
            return;
        }
    } catch (e) {}

    // 2. Download via yt-dlp
    const id = `${trackHash}_${uuidv4().slice(0, 8)}`;
    const outputTemplate = path.resolve(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    let searchArg = `${engine}${query}`;
    let args = [
        searchArg,
        "-x",
        "--audio-format", "mp3",
        "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000",
        "--no-playlist",
        "--force-ipv4",
        "-o", outputTemplate
    ];

    if (!isLong) {
        args.splice(4, 0, "--match-filter", "duration < 600");
    }

    const child = spawn("yt-dlp", args);

    child.on("close", (code) => {
        try {
            const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
            const found = files.find(f => f.startsWith(id) && f.endsWith(".mp3"));

            if (found) {
                const finalUrl = `${CONFIG.BASE_URL}/audio/${found}`;
                musicQueue.set(callSid, {
                    status: "done",
                    url: finalUrl,
                    query
                });

                // Auto-cleanup after 45 minutes
                setTimeout(() => {
                    try {
                        const target = path.resolve(CONFIG.DOWNLOAD_DIR, found);
                        if (fs.existsSync(target)) fs.unlinkSync(target);
                    } catch (e) {}
                }, 45 * 60 * 1000);
            } else {
                console.error(`yt-dlp failed to find file for query "${query}". Code: ${code}`);
                musicQueue.set(callSid, { status: "error", query });
            }
        } catch (err) {
            console.error("yt-dlp close error:", err.message);
            musicQueue.set(callSid, { status: "error", query });
        }
    });

    child.on("error", (err) => {
        console.error("yt-dlp spawn error:", err.message);
        musicQueue.set(callSid, { status: "error", query });
    });
}
