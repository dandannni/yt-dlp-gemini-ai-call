import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { gatherPlayOrSay, playInterruptible, generateTTS, VOICES } from "../services/tts.js";
import {
    analyzeAudioIntent,
    chatWithGemini,
    summarizeChatSoFar,
    SYSTEM_PRESETS
} from "../services/gemini.js";
import {
    getUser,
    saveChatHistory,
    clearChatHistory,
    saveCurrentChatAsBookmark,
    deleteSavedChat,
    updateUserSettings
} from "../db.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const chatSessions = new Map();

function getChatSession(callSid) {
    if (!chatSessions.has(callSid)) {
        chatSessions.set(callSid, {
            activeTurns: [],
            currentTurnIndex: 0,
            pendingReplyText: "",
            pendingTtsFile: null,
            browseIndex: 0
        });
    }
    return chatSessions.get(callSid);
}

/**
 * Chat Main Menu: /chat/menu
 */
router.all("/menu", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);

    const prompt = "שיחה עם בינה מלאכותית: 1 לשיחה חדשה, 2 להמשך שיחה מהיסטוריה, 3 לשיחות שמורות, 4 להגדרות, כוכבית לתפריט הראשי.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/menu-action`,
        1,
        8,
        { voice: user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Chat Menu Action
 */
router.all("/menu-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const session = getChatSession(req.body.CallSid);
    const key = req.body.Digits;

    if (key === "1") {
        // Start brand new chat
        await clearChatHistory(caller);
        session.activeTurns = [];
        session.currentTurnIndex = 0;

        await playInterruptible(r, "דבר לאחר הצפצוף.", `${CONFIG.BASE_URL}/chat/record-prompt`, { voice: user.settings?.hebrew_voice });
        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: true,
            timeout: 5
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Continue chat from history
        const history = user.chat_history || [];
        if (history.length === 0) {
            await playInterruptible(r, "אין שיחות קודמות בהיסטוריה.", `${CONFIG.BASE_URL}/chat/menu`, { voice: user.settings?.hebrew_voice });
            r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
            return res.type("text/xml").send(r.toString());
        }

        session.activeTurns = [...history];
        session.currentTurnIndex = Math.max(0, history.length - 1);
        await playInterruptible(r, "ממשיך שיחה קודמת. דבר לאחר הצפצוף.", `${CONFIG.BASE_URL}/chat/record-prompt`, { voice: user.settings?.hebrew_voice });
        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: true,
            timeout: 5
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Saved chats
        const saved = user.saved_chats || [];
        if (saved.length === 0) {
            await playInterruptible(r, "אין שיחות שמורות.", `${CONFIG.BASE_URL}/chat/menu`, { voice: user.settings?.hebrew_voice });
            r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
            return res.type("text/xml").send(r.toString());
        }
        session.browseIndex = 0;
        r.redirect(`${CONFIG.BASE_URL}/chat/browse-saved`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // Settings
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Process User Speech -> Gemini
 */
router.all("/process-speech", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const session = getChatSession(req.body.CallSid);
    const recordingUrl = req.body.RecordingUrl;

    if (!recordingUrl) {
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    let base64Audio = null;
    try {
        const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
        const fetchRes = await fetch(recordingUrl + ".mp3", { headers: { Authorization: authHeader } });
        if (fetchRes.ok) {
            base64Audio = Buffer.from(await fetchRes.arrayBuffer()).toString("base64");
        }
    } catch (e) {}

    const intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
    const queryText = intentData?.query || "שלום";

    const replyText = await chatWithGemini(caller, queryText);
    const ttsFile = await generateTTS(replyText, {
        voice: user.settings?.hebrew_voice,
        rate: user.settings?.tts_speed || "+0%"
    });

    session.pendingReplyText = replyText;
    session.pendingTtsFile = ttsFile;

    const freshUser = await getUser(caller);
    session.activeTurns = freshUser.chat_history || [];
    session.currentTurnIndex = Math.max(0, session.activeTurns.length - 1);

    r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
    res.type("text/xml").send(r.toString());
});

/**
 * Play Model Reply + Gather Next Action
 */
router.all("/play-reply", async (req, res) => {
    const r = new VoiceResponse();
    const session = getChatSession(req.body.CallSid);

    const g = r.gather({
        input: "dtmf",
        numDigits: 1,
        action: `${CONFIG.BASE_URL}/chat/post-reply-action`,
        method: "POST",
        timeout: 2
    });

    if (session.pendingTtsFile) {
        g.play(`${CONFIG.BASE_URL}/audio/${session.pendingTtsFile}`);
    } else {
        g.say(session.pendingReplyText);
    }

    // Controls prompt
    await gatherPlayOrSay(
        r,
        "1 להמשך, 3 לשמירה, 4 לקודם, 6 להבא, 7 לסיכום, כוכבית לתפריט.",
        `${CONFIG.BASE_URL}/chat/post-reply-action`,
        1,
        8
    );

    r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
    res.type("text/xml").send(r.toString());
});

/**
 * Controls After Reply (1=Continue, 3=Save, 4=Repeat Prev, 6=Repeat Next, 7=Summary, *=Menu)
 */
router.all("/post-reply-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const session = getChatSession(req.body.CallSid);
    const key = req.body.Digits;

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "1") {
        // Continue chat
        await playInterruptible(r, "דבר לאחר הצפצוף.", `${CONFIG.BASE_URL}/chat/record-prompt`, { voice: user.settings?.hebrew_voice });
        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: true,
            timeout: 5
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Save current chat session
        await saveCurrentChatAsBookmark(caller, "שיחה שמורה");
        await playInterruptible(r, "השיחה נשמרה בהצלחה.", `${CONFIG.BASE_URL}/chat/play-reply`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // Replay previous model response
        const modelTurns = (session.activeTurns || []).filter(t => t.role === "model");
        if (session.currentTurnIndex > 0) session.currentTurnIndex--;
        const turn = modelTurns[session.currentTurnIndex] || modelTurns[modelTurns.length - 1];
        if (turn) {
            session.pendingReplyText = turn.parts[0]?.text || "";
            session.pendingTtsFile = await generateTTS(session.pendingReplyText, { voice: user.settings?.hebrew_voice });
        }
        r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        // Replay next model response
        const modelTurns = (session.activeTurns || []).filter(t => t.role === "model");
        if (session.currentTurnIndex < modelTurns.length - 1) session.currentTurnIndex++;
        const turn = modelTurns[session.currentTurnIndex];
        if (turn) {
            session.pendingReplyText = turn.parts[0]?.text || "";
            session.pendingTtsFile = await generateTTS(session.pendingReplyText, { voice: user.settings?.hebrew_voice });
        }
        r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "7") {
        // Quick 15-second summary
        const summary = await summarizeChatSoFar(caller);
        session.pendingReplyText = summary;
        session.pendingTtsFile = await generateTTS(summary, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
    res.type("text/xml").send(r.toString());
});

/**
 * Browse Saved Chats
 */
router.all("/browse-saved", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const session = getChatSession(req.body.CallSid);

    const saved = user.saved_chats || [];
    if (saved.length === 0) {
        await playInterruptible(r, "אין שיחות שמורות.", `${CONFIG.BASE_URL}/chat/menu`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    const current = saved[session.browseIndex];
    const prompt = `שיחה שמורה: ${current.title}. לחץ 5 להמשך שיחה זו, 6 להבאה, 4 לקודמת, 9 למחיקה, כוכבית לחזרה.`;

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/saved-action`,
        1,
        10,
        { voice: user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
    res.type("text/xml").send(r.toString());
});

/**
 * Saved Chat Action
 */
router.all("/saved-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const session = getChatSession(req.body.CallSid);
    const key = req.body.Digits;

    const saved = user.saved_chats || [];

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Resume saved chat
        const target = saved[session.browseIndex];
        if (target && target.turns) {
            await clearChatHistory(caller);
            for (const t of target.turns) {
                await saveChatHistory(caller, t.role, t.parts[0]?.text);
            }
            session.activeTurns = [...target.turns];
            await playInterruptible(r, "ממשיך שיחה זו. דבר לאחר הצפצוף.", `${CONFIG.BASE_URL}/chat/record-prompt`, { voice: user.settings?.hebrew_voice });
            r.record({
                action: `${CONFIG.BASE_URL}/chat/process-speech`,
                method: "POST",
                maxLength: 300,
                playBeep: true,
                timeout: 5
            });
            return res.type("text/xml").send(r.toString());
        }
    }

    if (key === "6") {
        if (session.browseIndex < saved.length - 1) session.browseIndex++;
        r.redirect(`${CONFIG.BASE_URL}/chat/browse-saved`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        if (session.browseIndex > 0) session.browseIndex--;
        r.redirect(`${CONFIG.BASE_URL}/chat/browse-saved`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "9") {
        // Delete saved chat
        await deleteSavedChat(caller, session.browseIndex);
        session.browseIndex = 0;
        await playInterruptible(r, "השיחה נמחקה.", `${CONFIG.BASE_URL}/chat/browse-saved`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/browse-saved`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/chat/browse-saved`);
    res.type("text/xml").send(r.toString());
});

/**
 * Settings Menu: /chat/settings
 */
router.all("/settings", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);

    const prompt = "הגדרות: 1 לבחירת קול, 2 לבחירת מודל בינה מלאכותית, 3 להוראות מערכת, 4 לקצב דיבור, כוכבית לחזרה.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/settings-action`,
        1,
        8,
        { voice: user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Settings Action Router
 */
router.all("/settings-action", async (req, res) => {
    const r = new VoiceResponse();
    const caller = req.body.From;
    const user = await getUser(caller);
    const key = req.body.Digits;

    if (key === "1") {
        // Voice toggle (Hila vs Avri)
        const currentVoice = user.settings?.hebrew_voice || VOICES.HEBREW.Hila;
        const newVoice = currentVoice === VOICES.HEBREW.Hila ? VOICES.HEBREW.Avri : VOICES.HEBREW.Hila;
        await updateUserSettings(caller, { hebrew_voice: newVoice });
        const name = newVoice === VOICES.HEBREW.Hila ? "הילה" : "אברי";
        await playInterruptible(r, `הקול הוגדר לקול של ${name}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: newVoice });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Model toggle (Gemini 2.5 Flash vs Gemini 2.5 Pro)
        const currentModel = user.settings?.model || "gemini-2.5-flash";
        const newModel = currentModel === "gemini-2.5-flash" ? "gemini-2.5-pro" : "gemini-2.5-flash";
        await updateUserSettings(caller, { model: newModel });
        await playInterruptible(r, `המודל הוגדר ל-${newModel}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Prompt preset toggle (default -> tutor -> brief)
        const currentPreset = user.settings?.system_prompt_preset || "default";
        const nextPreset = currentPreset === "default" ? "tutor" : (currentPreset === "tutor" ? "brief" : "default");
        await updateUserSettings(caller, { system_prompt_preset: nextPreset });
        const names = { default: "עוזר חכם כללי", tutor: "מורה ומסביר מושגים", brief: "תמציתי וממוקד" };
        await playInterruptible(r, `הוגדר סגנון ${names[nextPreset]}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // TTS Speed toggle (+0% -> +20% -> +35%)
        const currentSpeed = user.settings?.tts_speed || "+0%";
        const nextSpeed = currentSpeed === "+0%" ? "+20%" : (currentSpeed === "+20%" ? "+35%" : "+0%");
        await updateUserSettings(caller, { tts_speed: nextSpeed });
        await playInterruptible(r, `קצב הדיבור הוגדר ל-${nextSpeed}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: user.settings?.hebrew_voice, rate: nextSpeed });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

export default router;
