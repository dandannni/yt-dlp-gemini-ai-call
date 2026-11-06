import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { CONFIG } from "../config.js";

export const musicQueue = new Map();

// In-memory stream URL cache (avoids re-resolving popular songs)
const streamUrlCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function normalizeMusicQuery(raw) {
    if (!raw) return "";
    let q = raw.trim();
    // Strip common English voice prefixes
    q = q.replace(/^(can you |please )?(play|stream|listen to|hear|find|search for)\s+(the song\s+|the track\s+|song\s+)?/i, "");
    // Strip common Hebrew voice prefixes
    q = q.replace(/^(אפשר לשמוע את|תשמיע לי את|תשמיע את|נגן את|שים לי את|שים את|אני רוצה לשמוע את|שיר של|שיר)\s+/i, "");
    // Strip trailing punctuation
    q = q.replace(/[.,!?;:]+$/, "");
    return q.trim() || raw.trim();
}

function getTrackHash(query) {
    const clean = normalizeMusicQuery(query);
    return crypto.createHash("md5").update(clean.toLowerCase()).digest("hex").slice(0, 12);
}

/**
 * Tier 1 & 2: Extract direct streaming URL from YouTube without downloading whole file
 */
function extractStreamUrl(searchQuery, clientArgs = ["--extractor-args", "youtube:player_client=default,web"]) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const searchArg = `ytsearch1:${searchQuery}`;

        const args = [
            "--no-playlist",
            "--no-check-certificates",
            "--force-ipv4",
            ...clientArgs,
            "-f", "bestaudio/ba/b/best",
            "-g",               // Direct stream URL
            "--print", "title", // Video title
            searchArg
        ];

        const child = spawn("yt-dlp", args);
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("close", (code) => {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            if (code === 0 && stdout.trim()) {
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
                const title = lines[0] || searchQuery;
                const directUrl = lines.find(l => l.startsWith("http://") || l.startsWith("https://"));

                if (directUrl) {
                    resolve({ title, url: directUrl, elapsed });
                    return;
                }
            }
            reject(new Error(`Stream extraction failed (Code ${code}): ${stderr.slice(0, 150)}`));
        });

        child.on("error", (err) => reject(err));
    });
}

/**
 * Tier 3: Direct audio download fallback directly to local disk (Guaranteed to work if stream URL extraction is blocked)
 */
function downloadAudioToDisk(searchQuery, trackHash) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const outputTemplate = path.resolve(CONFIG.DOWNLOAD_DIR, `track_${trackHash}.%(ext)s`);
        const finalMp3Path = path.resolve(CONFIG.DOWNLOAD_DIR, `track_${trackHash}.mp3`);

        const args = [
            "--no-playlist",
            "--no-check-certificates",
            "--force-ipv4",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "5",
            "--no-simulate",
            "--print", "title",
            "-o", outputTemplate,
            `ytsearch1:${searchQuery}`
        ];

        console.log(`[Music] 📥 Downloading full audio track to disk: "${searchQuery}"...`);

        const child = spawn("yt-dlp", args);
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("close", (code) => {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            if (code === 0 && fs.existsSync(finalMp3Path)) {
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
                const title = lines[0] || searchQuery;
                const localUrl = `${CONFIG.BASE_URL}/audio/track_${trackHash}.mp3`;
                console.log(`[Music] 💾 Direct track download ready in ${elapsed}s -> "${title}"`);
                resolve({ title, url: localUrl, elapsed, isLocal: true });
                return;
            }
            reject(new Error(`Disk download failed (Code ${code}): ${stderr.slice(0, 150)}`));
        });

        child.on("error", (err) => reject(err));
    });
}

/**
 * Tier 4: SoundCloud Fallback
 */
function extractSoundCloudStream(searchQuery) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const args = [
            "--no-playlist",
            "--no-check-certificates",
            "-f", "bestaudio/best",
            "-g",
            "--print", "title",
            `scsearch1:${searchQuery}`
        ];

        const child = spawn("yt-dlp", args);
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("close", (code) => {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            if (code === 0 && stdout.trim()) {
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
                const title = lines[0] || searchQuery;
                const directUrl = lines.find(l => l.startsWith("http://") || l.startsWith("https://"));
                if (directUrl) {
                    resolve({ title, url: directUrl, elapsed });
                    return;
                }
            }
            reject(new Error(`SoundCloud failed (Code ${code}): ${stderr.slice(0, 150)}`));
        });

        child.on("error", (err) => reject(err));
    });
}

/**
 * Main Search & Prepare Music Flow
 */
export async function searchAndDownloadMusic(callSid, query, options = {}) {
    const cleanQuery = normalizeMusicQuery(query);
    const trackHash = getTrackHash(cleanQuery);

    musicQueue.set(callSid, {
        status: "pending",
        startTime: Date.now(),
        query: cleanQuery
    });

    console.log(`[Music] 🔍 [Call: ${callSid}] Resolving song: "${cleanQuery}" (Hash: ${trackHash})`);

    // 1. Check local file on disk
    const localMp3Path = path.resolve(CONFIG.DOWNLOAD_DIR, `track_${trackHash}.mp3`);
    if (fs.existsSync(localMp3Path) && fs.statSync(localMp3Path).size > 100000) {
        console.log(`[Music] ⚡ [Call: ${callSid}] Instant local disk HIT: "track_${trackHash}.mp3"`);
        musicQueue.set(callSid, {
            status: "done",
            url: `${CONFIG.BASE_URL}/audio/track_${trackHash}.mp3`,
            query: cleanQuery
        });
        return;
    }

    // 2. Check in-memory URL stream cache
    const cached = streamUrlCache.get(trackHash);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        console.log(`[Music] ⚡ [Call: ${callSid}] Instant cache HIT: "${cached.title}"`);
        musicQueue.set(callSid, {
            status: "done",
            url: cached.url,
            query: cached.title
        });
        return;
    }

    // 3. Multi-tier resolution
    let resolved = null;

    // Tier 1: Fast YouTube Direct Stream URL (VisionOS / Web client)
    try {
        console.log(`[Music] 🎯 [Call: ${callSid}] Tier 1: Fast direct stream extraction for "${cleanQuery}"...`);
        resolved = await extractStreamUrl(cleanQuery, ["--extractor-args", "youtube:player_client=default,web"]);
    } catch (e1) {
        console.warn(`[Music] ⚠️ Tier 1 failed: ${e1.message}`);
    }

    // Tier 2: YouTube Search with query variant & TV/Web client
    if (!resolved) {
        try {
            console.log(`[Music] 🎯 [Call: ${callSid}] Tier 2: Retrying with TV/Web client for "${cleanQuery} audio"...`);
            resolved = await extractStreamUrl(`${cleanQuery} audio`, ["--extractor-args", "youtube:player-client=tv,web"]);
        } catch (e2) {
            console.warn(`[Music] ⚠️ Tier 2 failed: ${e2.message}`);
        }
    }

    // Tier 3: Direct local audio download to disk (Bulletproof)
    if (!resolved) {
        try {
            console.log(`[Music] 🎯 [Call: ${callSid}] Tier 3: Direct download to local storage for "${cleanQuery}"...`);
            resolved = await downloadAudioToDisk(cleanQuery, trackHash);
        } catch (e3) {
            console.warn(`[Music] ⚠️ Tier 3 failed: ${e3.message}`);
        }
    }

    // Tier 4: SoundCloud Fallback
    if (!resolved) {
        try {
            console.log(`[Music] 🎯 [Call: ${callSid}] Tier 4: Falling back to SoundCloud for "${cleanQuery}"...`);
            resolved = await extractSoundCloudStream(cleanQuery);
        } catch (e4) {
            console.warn(`[Music] ⚠️ Tier 4 failed: ${e4.message}`);
        }
    }

    // Result handling
    if (resolved && resolved.url) {
        console.log(`[Music] 🚀 [Call: ${callSid}] Song ready in ${resolved.elapsed}s -> "${resolved.title}"`);

        // Cache stream URL if not local
        if (!resolved.isLocal) {
            streamUrlCache.set(trackHash, {
                title: resolved.title,
                url: resolved.url,
                timestamp: Date.now()
            });
        }

        musicQueue.set(callSid, {
            status: "done",
            url: resolved.url,
            query: resolved.title
        });
    } else {
        console.error(`[Music] ❌ [Call: ${callSid}] All extraction tiers failed for: "${cleanQuery}"`);
        musicQueue.set(callSid, { status: "error", query: cleanQuery });
    }
}
