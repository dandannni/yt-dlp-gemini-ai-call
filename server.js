console.log("🚀 Starting Server: Final Production Build...");

import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ==============================================================================
// ⚙️ SETTINGS & CONFIGURATION
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    
    // 🟢 CRITICAL FIX: The exact URL you provided.
    // This tells Twilio exactly where to find the MP3 file on the internet.
    BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://yt-dlp-gemini-ai-call.onrender.com", 

    DOWNLOAD_DIR: "/tmp",
    
    VERIFIED_CALLERS: [
        "+972548498889", 
        "+972554402506", 
        "+972525585720", 
        "+972528263032", 
        "+972583230268"
    ],
    
    GEMINI_KEYS: [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY_4
    ].filter(key => key),

    MESSAGES: {
        WELCOME: "Hello! Speak to Gemini, or press Hash for music.",
        MUSIC_WELCOME: "Music Mode. Name a song.",
        SEARCHING: "Searching SoundCloud...",
        NO_HISTORY: "No history yet.",
    }
};

// ==============================================================================
// 🛠️ SERVICES (THE LOGIC)
// ==============================================================================

// 1. LOGGING SERVICE
const logBuffer = [];
const addToLog = (type, args) => {
    try {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const line = `[${time}] [${type}] ${msg.replace(/\r/g, '')}`;
        logBuffer.push(line);
        if (logBuffer.length > 200) logBuffer.shift();
        process.stdout.write(line + '\n');
    } catch (e) {}
};
console.log = (...args) => addToLog("INFO", args);
console.error = (...args) => addToLog("ERROR", args);

// 2. SESSION MANAGER
const sessions = new Map();
const downloadQueue = new Map();
const getSession = (callSid) => {
    if (!sessions.has(callSid)) sessions.set(callSid, { chatHistory: [], musicHistory: [], index: -1 });
    return sessions.get(callSid);
};

// 3. AI SERVICE (GEMINI 2.5)
async function askGemini(session, text) {
    if (CONFIG.GEMINI_KEYS.length === 0) return "No API Keys configured.";
    
    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                systemInstruction: "You are a helpful phone assistant. Keep answers short (1-2 sentences). If asked for music, say 'Press hash'.",
            });
            const chat = model.startChat({ history: session.chatHistory });
            const result = await chat.sendMessage(text);
            const response = result.response.text();
            
            session.chatHistory.push({ role: "user", parts: [{ text }] });
            session.chatHistory.push({ role: "model", parts: [{ text: response }] });
            return response;
        } catch (e) {
            console.error(`⚠️ AI Key Failed: ${e.message}`);
        }
    }
    return "I cannot connect to my brain right now.";
}

// 4. MUSIC SERVICE (DOWNLOADER)
async function searchAndDownload(callSid, query) {
    console.log(`🎵 [Download Request] ${query}`);
    downloadQueue.set(callSid, { status: 'pending', startTime: Date.now() });

    const id = uuidv4();
    const filename = `${id}.mp3`;
    const outputPath = path.join(CONFIG.DOWNLOAD_DIR, `${id}.%(ext)s`);

    // Anti-Preview Command (Filters < 60s, mono audio)
    const args = [
        `scsearch5:${query}`,
        '--match-filter', 'duration > 60',
        '-I', '1',
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
        '--no-playlist', '--force-ipv4', '-o', outputPath
    ];

    const child = spawn('yt-dlp', args);

    child.on('close', (code) => {
        if (code === 0) {
            // Construct th
