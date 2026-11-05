import { spawn } from "child_process";
import crypto from "crypto";

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
    return q.trim() || raw.trim();
}

function getTrackHash(query) {
    const clean = normalizeMusicQuery(query);
    return crypto.createHash("md5").update(clean.toLowerCase()).digest("hex").slice(0, 12);
}

/**
 * Extract direct YouTube audio stream URL and title using yt-dlp Android client
 */
function extractYouTubeStream(query, attempt = 1) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const cleanQuery = normalizeMusicQuery(query);
        const searchQuery = attempt === 2 ? `${cleanQuery} audio` : cleanQuery;
        const searchArg = `ytsearch1:${searchQuery}`;

        const args = [
            "--no-playlist",
            "--no-check-certificates",
            "--force-ipv4",
            "--extractor-args", "youtube:player_client=android",
            "-f", "bestaudio/ba/b/best",
            "-g",               // Output direct streaming URL
            "--print", "title", // Output video title
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
                const title = lines[0] || query;
                const directUrl = lines[1] || lines[0];

                if (directUrl && directUrl.startsWith("http")) {
                    resolve({ title, url: directUrl, elapsed });
                    return;
                }
            }

            // Retry with alternate query suffix if first attempt failed
            if (attempt === 1) {
                console.log(`[Music] 🔄 Retrying YouTube search for "${query} audio"...`);
                return extractYouTubeStream(query, 2).then(resolve).catch(reject);
            }

            console.warn(`[Music] ⚠️ yt-dlp failed (Code: ${code}) for "${query}": ${stderr.slice(0, 150)}`);
            reject(new Error(`yt-dlp exited with code ${code}`));
        });

        child.on("error", (err) => {
            if (attempt === 1) {
                return extractYouTubeStream(query, 2).then(resolve).catch(reject);
            }
            reject(err);
        });
    });
}

/**
 * Search and prepare music for streaming
 */
export async function searchAndDownloadMusic(callSid, query, options = {}) {
    const trackHash = getTrackHash(query);

    musicQueue.set(callSid, {
        status: "pending",
        startTime: Date.now(),
        query
    });

    console.log(`[Music] 🔍 [Call: ${callSid}] Resolving YouTube track for: "${query}"`);

    // 1. Fast Cache Check
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

    // 2. Extract Direct YouTube Stream
    try {
        const { title, url, elapsed } = await extractYouTubeStream(query);
        console.log(`[Music] ⚡ [Call: ${callSid}] YouTube stream ready in ${elapsed}s -> "${title}"`);

        // Cache the result
        streamUrlCache.set(trackHash, {
            title,
            url,
            timestamp: Date.now()
        });

        musicQueue.set(callSid, {
            status: "done",
            url,
            query: title
        });
    } catch (err) {
        console.error(`[Music] ❌ [Call: ${callSid}] Failed resolving track for "${query}":`, err.message);
        musicQueue.set(callSid, { status: "error", query });
    }
}
