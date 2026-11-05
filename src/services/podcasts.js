import RSSParser from "rss-parser";

const parser = new RSSParser();

export const PODCAST_CATALOG = [
    {
        id: 1,
        title: "עושים היסטוריה",
        titleEn: "Osim Historia",
        feedUrl: "https://www.spreaker.com/show/4227531/episodes/feed",
        searchTerm: "עושים+היסטוריה"
    },
    {
        id: 2,
        title: "בזמן שעבדתם",
        titleEn: "Bizman Sheavadtem",
        feedUrl: "https://www.omnycontent.com/d/playlist/2ee97a4e-8795-4260-9648-accf00a38c6a/a5d4b51f-5b9e-43db-84da-ace100c04108/0ab18f83-1327-4f4e-9d7a-ace100c0411f/podcast.rss",
        searchTerm: "בזמן+שעבדתם"
    },
    {
        id: 3,
        title: "אחד ביום",
        titleEn: "Ehad Bayom",
        feedUrl: "https://www.omnycontent.com/d/playlist/2ee97a4e-8795-4260-9648-accf00a38c6a/ac2da21e-2193-4683-bcb5-accf011076ad/409bad89-c4c2-46cb-b69b-accf01152781/podcast.rss",
        searchTerm: "אחד+ביום"
    },
    {
        id: 4,
        title: "עושים טכנולוגיה",
        titleEn: "Osim Technologia",
        feedUrl: "https://www.spreaker.com/show/4231127/episodes/feed",
        searchTerm: "עושים+טכנולוגיה"
    },
    {
        id: 5,
        title: "התשובה עם דורון פישלר",
        titleEn: "Hateshuva",
        feedUrl: "https://www.spreaker.com/show/4228834/episodes/feed",
        searchTerm: "התשובה"
    }
];

// In-memory cache for parsed feeds (refreshed every 20 minutes)
const feedCache = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000;

export async function getPodcastEpisodes(podcastId) {
    const podcast = PODCAST_CATALOG.find(p => p.id === parseInt(podcastId));
    if (!podcast) return [];

    const cached = feedCache.get(podcast.id);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        return cached.episodes;
    }

    try {
        let feedUrl = podcast.feedUrl;
        const feed = await parser.parseURL(feedUrl);

        const episodes = (feed.items || []).slice(0, 10).map((item, idx) => ({
            index: idx,
            title: (item.title || "Episode").replace(/[^\u0590-\u05FFa-zA-Z0-9\s.,-]/g, "").trim(),
            pubDate: item.pubDate,
            audioUrl: item.enclosure?.url || item.link
        })).filter(ep => ep.audioUrl);

        feedCache.set(podcast.id, {
            timestamp: Date.now(),
            episodes
        });

        return episodes;
    } catch (err) {
        console.error(`Failed to fetch podcast ${podcast.title}:`, err.message);
        return [];
    }
}
