// ---------------------------------------------------------
// 🎵 HELPER: DOWNLOAD SONG (Smart TV Mode - No Cookies)
// ---------------------------------------------------------
async function downloadSong(query) {
    console.log(`🎵 Searching: "${query}"...`);
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.mp3`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${uniqueId}.%(ext)s`);

    // 🛠️ USE TV CLIENT (Bypasses "Sign in" check effectively)
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format mp3 --no-playlist --force-ipv4 --extractor-args "youtube:player_client=tv" -o "${outputTemplate}"`;

    console.log(`🚀 Running: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 40000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("🚨 Download Error:", stderr);
                return reject(error);
            }

            // Auto-delete
            setTimeout(() => {
                if (fs.existsSync(path.join(DOWNLOAD_DIR, filename))) fs.unlinkSync(path.join(DOWNLOAD_DIR, filename));
            }, 600000); 

            console.log("✅ Download complete");
            resolve({
                title: query,
                url: `${BASE_URL}/music/${filename}`
            });
        });
    });
}
