import fs from "fs";
import { MongoClient } from "mongodb";
import { CONFIG } from "./config.js";

const LOCAL_DB_FILE = "bot_database.json";
let mongoClient = null;
let dbInstance = null;
let usersCollection = null;
let isMongoConnected = false;

// Default template for a new user
export function getDefaultUserData(phone) {
    return {
        phone,
        music_history: [],
        chat_history: [],
        saved_chats: [],
        likes: [],
        playlists: {
            "Favorites": []
        },
        settings: {
            language: "en", // Default to English ('en' | 'he')
            model: "gemini-2.5-flash",
            hebrew_voice: "he-IL-HilaNeural",
            english_voice: "en-US-ChristopherNeural",
            search_engine: "ytsearch1:", // Default to YouTube search
            tts_speed: "+0%",
            system_prompt_preset: "default"
        },
        updated_at: new Date()
    };
}

// In-Memory cache with local JSON fallback
let localCache = { users: {} };

function loadLocalDB() {
    try {
        if (fs.existsSync(LOCAL_DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, "utf-8"));
            if (data && data.users) {
                localCache = data;
            }
        }
    } catch (e) {
        console.error("Local DB read error:", e.message);
    }
}

function saveLocalDB() {
    try {
        fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(localCache, null, 2));
    } catch (e) {
        console.error("Local DB write error:", e.message);
    }
}

// Initialize database
export async function initDB() {
    loadLocalDB();
    if (!CONFIG.MONGODB_URI) {
        console.log("ℹ️ No MONGODB_URI provided. Using local JSON store.");
        return;
    }

    try {
        console.log("🔌 Connecting to MongoDB Atlas...");
        mongoClient = new MongoClient(CONFIG.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });
        await mongoClient.connect();
        dbInstance = mongoClient.db("VoiceOS");
        usersCollection = dbInstance.collection("users");
        await usersCollection.createIndex({ phone: 1 }, { unique: true });
        isMongoConnected = true;
        console.log("✅ MongoDB Atlas connected successfully!");
    } catch (err) {
        console.warn("⚠️ MongoDB Atlas connection failed (" + err.message + "). Fallback to local JSON storage active.");
        isMongoConnected = false;
    }
}

// Get user profile
export async function getUser(phone) {
    if (!phone) return getDefaultUserData("anonymous");

    if (isMongoConnected && usersCollection) {
        try {
            let doc = await usersCollection.findOne({ phone });
            if (!doc) {
                doc = getDefaultUserData(phone);
                await usersCollection.insertOne(doc);
            }
            if (!doc.settings) doc.settings = {};
            if (!doc.settings.language) doc.settings.language = "en";
            if (!doc.settings.search_engine || doc.settings.search_engine.startsWith("scsearch")) {
                doc.settings.search_engine = "ytsearch1:";
            }
            localCache.users[phone] = doc;
            return doc;
        } catch (e) {
            console.error("Mongo getUser error:", e.message);
        }
    }

    // Fallback to local cache
    if (!localCache.users[phone]) {
        localCache.users[phone] = getDefaultUserData(phone);
        saveLocalDB();
    }
    const localUser = localCache.users[phone];
    if (!localUser.settings) localUser.settings = {};
    if (!localUser.settings.language) localUser.settings.language = "en";
    if (!localUser.settings.search_engine || localUser.settings.search_engine.startsWith("scsearch")) {
        localUser.settings.search_engine = "ytsearch1:";
    }
    return localUser;
}

// Update user helper
async function updateUser(phone, updateModifier) {
    const user = await getUser(phone);
    updateModifier(user);
    user.updated_at = new Date();
    localCache.users[phone] = user;
    saveLocalDB();

    if (isMongoConnected && usersCollection) {
        try {
            await usersCollection.updateOne(
                { phone },
                { $set: user },
                { upsert: true }
            );
        } catch (e) {
            console.error("Mongo updateUser error:", e.message);
        }
    }
    return user;
}

// Music history
export async function saveMusicHistory(phone, songQuery) {
    return updateUser(phone, (u) => {
        if (!u.music_history) u.music_history = [];
        u.music_history = u.music_history.filter(s => s !== songQuery);
        u.music_history.unshift(songQuery);
        if (u.music_history.length > 20) u.music_history.pop();
    });
}

// Liked songs
export async function saveLikedSong(phone, songQuery) {
    return updateUser(phone, (u) => {
        if (!u.likes) u.likes = [];
        if (!u.likes.includes(songQuery)) {
            u.likes.unshift(songQuery);
        }
    });
}

export async function removeLikedSong(phone, songQuery) {
    return updateUser(phone, (u) => {
        if (u.likes) {
            u.likes = u.likes.filter(s => s !== songQuery);
        }
    });
}

export async function getLikedSongs(phone) {
    const user = await getUser(phone);
    return user.likes || [];
}

// Playlists
export async function createPlaylist(phone, playlistName) {
    return updateUser(phone, (u) => {
        if (!u.playlists) u.playlists = {};
        if (!u.playlists[playlistName]) {
            u.playlists[playlistName] = [];
        }
    });
}

export async function addToPlaylist(phone, playlistName, songQuery) {
    return updateUser(phone, (u) => {
        if (!u.playlists) u.playlists = {};
        if (!u.playlists[playlistName]) u.playlists[playlistName] = [];
        if (!u.playlists[playlistName].includes(songQuery)) {
            u.playlists[playlistName].push(songQuery);
        }
    });
}

export async function getPlaylists(phone) {
    const user = await getUser(phone);
    return user.playlists || {};
}

// Chat history
export async function saveChatHistory(phone, role, text) {
    return updateUser(phone, (u) => {
        if (!u.chat_history) u.chat_history = [];
        u.chat_history.push({
            role: role === "user" ? "user" : "model",
            parts: [{ text }]
        });
        if (u.chat_history.length > 16) {
            u.chat_history = u.chat_history.slice(-16);
        }
    });
}

export async function clearChatHistory(phone) {
    return updateUser(phone, (u) => {
        u.chat_history = [];
    });
}

// Saved Chats / Bookmarked Sessions
export async function saveCurrentChatAsBookmark(phone, title) {
    return updateUser(phone, (u) => {
        if (!u.saved_chats) u.saved_chats = [];
        if (u.chat_history && u.chat_history.length > 0) {
            u.saved_chats.unshift({
                id: Date.now().toString(),
                title: title || (u.chat_history[0]?.parts[0]?.text || "Chat Session").substring(0, 35),
                saved_at: new Date().toISOString(),
                turns: [...u.chat_history]
            });
            if (u.saved_chats.length > 20) u.saved_chats.pop();
        }
    });
}

export async function deleteSavedChat(phone, index) {
    return updateUser(phone, (u) => {
        if (u.saved_chats && u.saved_chats[index]) {
            u.saved_chats.splice(index, 1);
        }
    });
}

// User Settings
export async function updateUserSettings(phone, partialSettings) {
    return updateUser(phone, (u) => {
        if (!u.settings) u.settings = {};
        u.settings = { ...u.settings, ...partialSettings };
    });
}
