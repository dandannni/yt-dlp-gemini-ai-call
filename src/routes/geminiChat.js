import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { gatherPlayOrSay, playInterruptible, generateTTS, VOICES } from "../services/tts.js";
import {
    analyzeAudioIntent,
    chatWithGemini,
    summarizeChatSoFar
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
    const isEn = user.settings?.language !== "he";

    console.log(`[Chat] 🤖 [Call: ${req.body.CallSid}] Opening Chat Menu (Lang: ${isEn ? "English" : "Hebrew"})`);

    const prompt = isEn
        ? "AI Assistant. Press 1 for a new chat, 2 to continue recent chat, 3 for saved chats, 4 for settings, Star for main menu."
        : "שיחה עם בינה מלאכותית: 1 לשיחה חדשה, 2 להמשך שיחה מהיסטוריה, 3 לשיחות שמורות, 4 להגדרות, כוכבית לתפריט הראשי.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/menu-action`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
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
    const isEn = user.settings?.language !== "he";
    const session = getChatSession(req.body.CallSid);
    const key = req.body.Digits;

    console.log(`[Chat] 🔘 [Call: ${req.body.CallSid}] Chat menu key: "${key}"`);

    if (key === "1") {
        // Start brand new chat
        console.log(`[Chat] 🆕 [Call: ${req.body.CallSid}] Starting brand new chat session`);
        await clearChatHistory(caller);
        session.activeTurns = [];
        session.currentTurnIndex = 0;

        const speakPrompt = isEn ? "Speak after the tone. Press pound when finished." : "דבר לאחר הצפצוף, ולחץ סולמית לסיום.";
        const g = r.gather({
            input: "speech dtmf",
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            finishOnKey: "#",
            speechTimeout: "auto",
            timeout: 8,
            language: isEn ? "en-US" : "he-IL"
        });

        const promptFile = await generateTTS(speakPrompt, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
            isDynamic: false
        });

        if (promptFile) {
            g.play(`${CONFIG.BASE_URL}/audio/${promptFile}`);
        } else {
            g.say({ language: isEn ? "en-US" : "he-IL" }, speakPrompt);
        }

        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: false,
            timeout: 15,
            finishOnKey: "#"
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Continue chat from history
        const history = user.chat_history || [];
        if (history.length === 0) {
            console.log(`[Chat] ℹ️ [Call: ${req.body.CallSid}] No previous history found`);
            const noHistMsg = isEn ? "No previous chats found in history." : "אין שיחות קודמות בהיסטוריה.";
            await playInterruptible(r, noHistMsg, `${CONFIG.BASE_URL}/chat/menu`, {
                voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
            });
            r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
            return res.type("text/xml").send(r.toString());
        }

        console.log(`[Chat] 📜 [Call: ${req.body.CallSid}] Resuming chat with ${history.length} previous turns`);
        session.activeTurns = [...history];
        session.currentTurnIndex = Math.max(0, history.length - 1);

        const resumePrompt = isEn ? "Resuming previous chat. Speak after the tone, and press pound when finished." : "ממשיך שיחה קודמת. דבר לאחר הצפצוף, ולחץ סולמית לסיום.";
        const g = r.gather({
            input: "speech dtmf",
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            finishOnKey: "#",
            speechTimeout: "auto",
            timeout: 8,
            language: isEn ? "en-US" : "he-IL"
        });

        const promptFile = await generateTTS(resumePrompt, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
            isDynamic: false
        });

        if (promptFile) {
            g.play(`${CONFIG.BASE_URL}/audio/${promptFile}`);
        } else {
            g.say({ language: isEn ? "en-US" : "he-IL" }, resumePrompt);
        }

        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: false,
            timeout: 15,
            finishOnKey: "#"
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Saved chats
        const saved = user.saved_chats || [];
        if (saved.length === 0) {
            console.log(`[Chat] ℹ️ [Call: ${req.body.CallSid}] No saved chats found`);
            const noSavedMsg = isEn ? "No saved chats found." : "אין שיחות שמורות.";
            await playInterruptible(r, noSavedMsg, `${CONFIG.BASE_URL}/chat/menu`, {
                voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
            });
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
    const isEn = user.settings?.language !== "he";
    const session = getChatSession(req.body.CallSid);
    const recordingUrl = req.body.RecordingUrl;
    let queryText = req.body.SpeechResult || null;
    let intentData = null;

    if (req.body.Digits === "*") {
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (!queryText && recordingUrl) {
        console.log(`[Chat] 🎙️ [Call: ${req.body.CallSid}] Speech recording received: ${recordingUrl}`);
        let base64Audio = null;
        try {
            const authHeader = "Basic " + Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
            const fetchRes = await fetch(recordingUrl + ".mp3", { headers: { Authorization: authHeader } });
            if (fetchRes.ok) {
                base64Audio = Buffer.from(await fetchRes.arrayBuffer()).toString("base64");
            }
        } catch (e) {
            console.error(`[Chat] ❌ Fetch recording error:`, e.message);
        }

        intentData = base64Audio ? await analyzeAudioIntent(base64Audio) : null;
        if (intentData && intentData.query) {
            queryText = intentData.query;
        }
    }

    if (!queryText) {
        console.warn(`[Chat] ⚠️ [Call: ${req.body.CallSid}] Could not transcribe user speech`);
        const noSpeechMsg = isEn ? "Could not understand speech. Please try again." : "לא הצלחתי לזהות דיבור. אנא נסה שוב.";
        await playInterruptible(r, noSpeechMsg, `${CONFIG.BASE_URL}/chat/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    console.log(`[Chat] 🧠 [Call: ${req.body.CallSid}] Query recognized: "${queryText}" (Source: ${req.body.SpeechResult ? "Twilio ASR" : "Audio Model"})`);

    const replyText = await chatWithGemini(caller, queryText);
    console.log(`[Chat] 💬 [Call: ${req.body.CallSid}] Gemini replied: "${replyText.slice(0, 100)}..."`);

    const ttsFile = await generateTTS(replyText, {
        voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
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
    const user = await getUser(req.body.From);
    const isEn = user.settings?.language !== "he";
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
    const ctrlPrompt = isEn
        ? "1 to continue, 3 to save, 4 for previous turn, 6 for next turn, 7 for summary, Star for menu."
        : "1 להמשך, 3 לשמירה, 4 לקודם, 6 להבא, 7 לסיכום, כוכבית לתפריט.";

    await gatherPlayOrSay(
        r,
        ctrlPrompt,
        `${CONFIG.BASE_URL}/chat/post-reply-action`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
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
    const isEn = user.settings?.language !== "he";
    const session = getChatSession(req.body.CallSid);
    const key = req.body.Digits;

    console.log(`[Chat] 🔘 [Call: ${req.body.CallSid}] Post-reply action key: "${key}"`);

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "1") {
        // Continue chat with Gather speech and # key
        const speakPrompt = isEn ? "Speak after the tone. Press pound when finished." : "דבר לאחר הצפצוף, ולחץ סולמית לסיום.";
        const g = r.gather({
            input: "speech dtmf",
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            finishOnKey: "#",
            speechTimeout: "auto",
            timeout: 8,
            language: isEn ? "en-US" : "he-IL"
        });

        const promptFile = await generateTTS(speakPrompt, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
            isDynamic: false
        });

        if (promptFile) {
            g.play(`${CONFIG.BASE_URL}/audio/${promptFile}`);
        } else {
            g.say({ language: isEn ? "en-US" : "he-IL" }, speakPrompt);
        }

        r.record({
            action: `${CONFIG.BASE_URL}/chat/process-speech`,
            method: "POST",
            maxLength: 300,
            playBeep: false,
            timeout: 15,
            finishOnKey: "#"
        });
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Save current chat session
        const title = session.activeTurns[0]?.parts[0]?.text?.slice(0, 30) || (isEn ? "Saved Chat" : "שיחה שמורה");
        await saveCurrentChatAsBookmark(caller, title);
        console.log(`[Chat] 💾 [Call: ${req.body.CallSid}] Chat bookmarked: "${title}"`);
        const savedMsg = isEn ? "Chat saved successfully." : "השיחה נשמרה בהצלחה.";
        await playInterruptible(r, savedMsg, `${CONFIG.BASE_URL}/chat/play-reply`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
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
            session.pendingTtsFile = await generateTTS(session.pendingReplyText, {
                voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
            });
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
            session.pendingTtsFile = await generateTTS(session.pendingReplyText, {
                voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
            });
        }
        r.redirect(`${CONFIG.BASE_URL}/chat/play-reply`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "7") {
        // Quick 15-second summary
        console.log(`[Chat] 📝 [Call: ${req.body.CallSid}] Generating quick chat summary`);
        const summary = await summarizeChatSoFar(caller);
        session.pendingReplyText = summary;
        session.pendingTtsFile = await generateTTS(summary, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
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
    const isEn = user.settings?.language !== "he";
    const session = getChatSession(req.body.CallSid);

    const saved = user.saved_chats || [];
    if (saved.length === 0) {
        const noSavedMsg = isEn ? "No saved chats." : "אין שיחות שמורות.";
        await playInterruptible(r, noSavedMsg, `${CONFIG.BASE_URL}/chat/menu`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
        return res.type("text/xml").send(r.toString());
    }

    const current = saved[session.browseIndex];
    const prompt = isEn
        ? `Saved chat: ${current.title}. Press 5 to continue this chat, 6 for next, 4 for previous, 9 to delete, Star to return.`
        : `שיחה שמורה: ${current.title}. לחץ 5 להמשך שיחה זו, 6 להבאה, 4 לקודמת, 9 למחיקה, כוכבית לחזרה.`;

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/saved-action`,
        1,
        10,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
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
    const isEn = user.settings?.language !== "he";
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
            console.log(`[Chat] 📂 [Call: ${req.body.CallSid}] Resuming saved chat: "${target.title}"`);
            await clearChatHistory(caller);
            for (const t of target.turns) {
                await saveChatHistory(caller, t.role, t.parts[0]?.text);
            }
            session.activeTurns = [...target.turns];
            const speakPrompt = isEn ? "Resuming saved conversation. Speak after the tone, and press pound when finished." : "ממשיך שיחה זו. דבר לאחר הצפצוף, ולחץ סולמית לסיום.";
            await playInterruptible(r, speakPrompt, `${CONFIG.BASE_URL}/chat/record-prompt`, {
                voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
            });
            r.record({
                action: `${CONFIG.BASE_URL}/chat/process-speech`,
                method: "POST",
                maxLength: 300,
                playBeep: true,
                timeout: 15,
                finishOnKey: "#"
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
        console.log(`[Chat] 🗑️ [Call: ${req.body.CallSid}] Deleted saved chat at index ${session.browseIndex}`);
        const delMsg = isEn ? "Chat deleted." : "השיחה נמחקה.";
        await playInterruptible(r, delMsg, `${CONFIG.BASE_URL}/chat/browse-saved`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
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
    const isEn = user.settings?.language !== "he";

    console.log(`[Settings] ⚙️ [Call: ${req.body.CallSid}] Opening Settings Menu`);

    const prompt = isEn
        ? "Settings: Press 1 for voice, 2 for AI model, 3 for persona style, 4 for speech speed, 5 to change language, Star to return."
        : "הגדרות: 1 לבחירת קול, 2 לבחירת מודל בינה מלאכותית, 3 לסגנון שיחה, 4 לקצב דיבור, 5 להחלפת שפה, כוכבית לחזרה.";

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/chat/settings-action`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
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
    const isEn = user.settings?.language !== "he";
    const key = req.body.Digits;

    console.log(`[Settings] 🔘 [Call: ${req.body.CallSid}] Settings key: "${key}"`);

    if (key === "1") {
        // Voice toggle
        if (isEn) {
            const currentVoice = user.settings?.english_voice || VOICES.ENGLISH.Christopher;
            const newVoice = currentVoice === VOICES.ENGLISH.Christopher ? VOICES.ENGLISH.Jenny : VOICES.ENGLISH.Christopher;
            await updateUserSettings(caller, { english_voice: newVoice });
            const name = newVoice === VOICES.ENGLISH.Christopher ? "Christopher" : "Jenny";
            console.log(`[Settings] Voice changed to ${name}`);
            await playInterruptible(r, `Voice set to ${name}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: newVoice });
        } else {
            const currentVoice = user.settings?.hebrew_voice || VOICES.HEBREW.Hila;
            const newVoice = currentVoice === VOICES.HEBREW.Hila ? VOICES.HEBREW.Avri : VOICES.HEBREW.Hila;
            await updateUserSettings(caller, { hebrew_voice: newVoice });
            const name = newVoice === VOICES.HEBREW.Hila ? "הילה" : "אברי";
            console.log(`[Settings] Voice changed to ${name}`);
            await playInterruptible(r, `הקול הוגדר לקול של ${name}.`, `${CONFIG.BASE_URL}/chat/settings`, { voice: newVoice });
        }
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "2") {
        // Model toggle (Gemini 1.5 Flash vs Gemini 2.0 Flash)
        const currentModel = user.settings?.model || "gemini-1.5-flash";
        const newModel = currentModel === "gemini-1.5-flash" ? "gemini-2.0-flash" : "gemini-1.5-flash";
        await updateUserSettings(caller, { model: newModel });
        console.log(`[Settings] AI Model changed to ${newModel}`);
        const msg = isEn ? `Model set to ${newModel}.` : `המודל הוגדר ל-${newModel}.`;
        await playInterruptible(r, msg, `${CONFIG.BASE_URL}/chat/settings`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "3") {
        // Prompt preset toggle (default -> tutor -> brief)
        const currentPreset = user.settings?.system_prompt_preset || "default";
        const nextPreset = currentPreset === "default" ? "tutor" : (currentPreset === "tutor" ? "brief" : "default");
        await updateUserSettings(caller, { system_prompt_preset: nextPreset });
        console.log(`[Settings] Persona preset changed to ${nextPreset}`);
        const msg = isEn ? `Persona style set to ${nextPreset}.` : `סגנון השיחה הוגדר ל-${nextPreset}.`;
        await playInterruptible(r, msg, `${CONFIG.BASE_URL}/chat/settings`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice
        });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        // TTS Speed toggle (+0% -> +20% -> +35%)
        const currentSpeed = user.settings?.tts_speed || "+0%";
        const nextSpeed = currentSpeed === "+0%" ? "+20%" : (currentSpeed === "+20%" ? "+35%" : "+0%");
        await updateUserSettings(caller, { tts_speed: nextSpeed });
        console.log(`[Settings] Speech rate changed to ${nextSpeed}`);
        const msg = isEn ? `Speech speed set to ${nextSpeed}.` : `קצב הדיבור הוגדר ל-${nextSpeed}.`;
        await playInterruptible(r, msg, `${CONFIG.BASE_URL}/chat/settings`, {
            voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice,
            rate: nextSpeed
        });
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "5") {
        // Language Toggle (English <-> Hebrew)
        const newLang = isEn ? "he" : "en";
        await updateUserSettings(caller, { language: newLang });
        console.log(`[Settings] 🌐 System language toggled to: ${newLang === "en" ? "English" : "Hebrew"}`);
        if (newLang === "en") {
            await playInterruptible(r, "Language set to English.", `${CONFIG.BASE_URL}/chat/settings`, {
                voice: VOICES.ENGLISH.Christopher
            });
        } else {
            await playInterruptible(r, "השפה הוגדרה בהצלחה לעברית.", `${CONFIG.BASE_URL}/chat/settings`, {
                voice: VOICES.HEBREW.Hila
            });
        }
        r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

export default router;
