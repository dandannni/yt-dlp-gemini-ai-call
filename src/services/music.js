import { spawn } from "child_process";
import crypto from "crypto";
import { CONFIG } from "../config.js";

export const musicQueue = new Map();

// In-memory cache for stream URLs (avoids re-resolving popular songs)
const streamUrlCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getTrackHash(query) {
    return crypto.createHash("md5").update((query || "").trim().toLowerCase()).digest("hex").slice(0, 12);
}

/**
 * Extract direct audio stream URL and title using yt-dlp (Starts in ~2-3 seconds!)
 */
function extractStreamUrl(query, engine, isFallback = false) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const searchPrefix = engine.startsWith("ytsearch") ? "ytsearch1:" : "scsearch1:";
        const searchArg = `${searchPrefix}${query}`;

        const args = [
            "--no-playlist",
            "--no-check-certificates",
            "-f", "ba/b",
            "-g",               // Output direct streaming URL
            "--print", "title", // Output video/track title
            searchArg
        ];

        // Mobile API client bypass for YouTube (completely bypasses web bot challenges on cloud servers!)
        if (engine.startsWith("ytsearch")) {
            args.splice(2, 0, "--extractor-args", "youtube:player_client=android,ios");
        }

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

            // If YouTube fails (or is blocked), automatically fallback to SoundCloud!
            if (!isFallback && engine.startsWith("ytsearch")) {
                console.log(`[Music] 🔄 YouTube query failed (${code}). Automatically trying SoundCloud...`);
                extractStreamUrl(query, "scsearch1:", true).then(resolve).catch(reject);
                return;
            }

            console.warn(`[Music] ⚠️ yt-dlp exit code ${code} for "${query}": ${stderr.slice(0, 100)}`);
            reject(new Error(`yt-dlp failed with code ${code}`));
        });

        child.on("error", (err) => {
            if (!isFallback && engine.startsWith("ytsearch")) {
                console.log(`[Music] 🔄 YouTube spawn error. Trying SoundCloud...`);
                extractStreamUrl(query, "scsearch1:", true).then(resolve).catch(reject);
                return;
            }
            reject(err);
        });
    });
}

/**
 * Search and prepare music for streaming
 */
export async function searchAndDownloadMusic(callSid, query, options = {}) {
    const engine = options.engine || "ytsearch1:"; // Default to YouTube search
    const trackHash = getTrackHash(query);

    musicQueue.set(callSid, {
        status: "pending",
        startTime: Date.now(),
        query
    });

    console.log(`[Music] 🔍 [Call: ${callSid}] Resolving song: "${query}" (Engine: ${engine})`);

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

    // 2. Direct Stream Extraction
    try {
        const { title, url, elapsed } = await extractStreamUrl(query, engine);
        console.log(`[Music] ⚡ [Call: ${callSid}] Stream extracted in ${elapsed}s -> "${title}"`);

        // Cache the stream URL
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
        console.error(`[Music] ❌ [Call: ${callSid}] Failed resolving stream for "${query}":`, err.message);
        musicQueue.set(callSid, { status: "error", query });
    }
}
