import RSSParser from "rss-parser";

const parser = new RSSParser();
const YNET_MIVZAKIM_RSS = "https://www.ynet.co.il/Integration/StoryRss3082.xml";

let mivzakimCache = {
    timestamp: 0,
    items: []
};
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export async function getYnetMivzakim() {
    if (Date.now() - mivzakimCache.timestamp < CACHE_TTL_MS && mivzakimCache.items.length > 0) {
        return mivzakimCache.items;
    }

    try {
        const feed = await parser.parseURL(YNET_MIVZAKIM_RSS);
        const items = (feed.items || []).slice(0, 20).map((it, idx) => {
            const rawTitle = it.title || "מבזק חדשות";
            const cleanTitle = rawTitle.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1").replace(/[<>*]/g, "").trim();
            const rawSnippet = it.contentSnippet || it.content || it.summary || cleanTitle;
            const cleanSnippet = rawSnippet.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "").trim();
            
            // Format time e.g. 14:30
            let timeStr = "";
            if (it.pubDate) {
                try {
                    const d = new Date(it.pubDate);
                    timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                } catch (e) {}
            }

            return {
                id: idx,
                title: cleanTitle,
                details: cleanSnippet,
                time: timeStr,
                creator: it.creator || it.author || "כתב ynet",
                pubDate: it.pubDate
            };
        });

        mivzakimCache = {
            timestamp: Date.now(),
            items
        };
        return items;
    } catch (e) {
        console.error("Ynet RSS error:", e.message);
        return mivzakimCache.items || [];
    }
}
