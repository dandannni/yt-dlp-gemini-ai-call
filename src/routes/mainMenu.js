import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { gatherPlayOrSay } from "../services/tts.js";
import { getUser } from "../db.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Main Webhook Entry Point: /twiml
 */
router.all("/twiml", async (req, res) => {
    const caller = req.body.From;
    const r = new VoiceResponse();

    // Caller whitelist verification
    if (CONFIG.VERIFIED_CALLERS.length > 0 && !CONFIG.VERIFIED_CALLERS.includes(caller)) {
        console.warn(`[Security] 🚫 Unauthorized call attempt from ${caller}`);
        r.reject();
        return res.type("text/xml").send(r.toString());
    }

    const user = await getUser(caller);
    const isEn = user.settings?.language !== "he"; // Default English

    console.log(`[Menu] 📞 [Call: ${req.body.CallSid}] Main menu presented to ${caller} (Language: ${user.settings?.language || "en"})`);

    const menuPrompt = isEn
        ? "Welcome to Voice OS. Press 1 for AI Assistant, 2 for Music, 3 for Podcasts, 4 for News, or 0 for Settings."
        : "שלום. 1 לשיחה עם בינה מלאכותית, 2 למוזיקה, 3 לפודקאסטים, 4 למבזקי חדשות, או 0 להגדרות.";

    await gatherPlayOrSay(
        r,
        menuPrompt,
        `${CONFIG.BASE_URL}/main-menu-router`,
        1,
        8,
        { voice: isEn ? user.settings?.english_voice : user.settings?.hebrew_voice }
    );

    // If caller didn't press a button, prompt once more or loop
    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Main Menu Router: /main-menu-router
 */
router.all("/main-menu-router", async (req, res) => {
    const r = new VoiceResponse();
    const digit = req.body.Digits;

    console.log(`[Menu] 🔘 [Call: ${req.body.CallSid}] Main menu digit selected: "${digit}"`);

    switch (digit) {
        case "1":
            r.redirect(`${CONFIG.BASE_URL}/chat/menu`);
            break;
        case "2":
            r.redirect(`${CONFIG.BASE_URL}/music/menu`);
            break;
        case "3":
            r.redirect(`${CONFIG.BASE_URL}/podcasts/menu`);
            break;
        case "4":
            r.redirect(`${CONFIG.BASE_URL}/news/menu`);
            break;
        case "0":
            r.redirect(`${CONFIG.BASE_URL}/chat/settings`);
            break;
        default:
            r.redirect(`${CONFIG.BASE_URL}/twiml`);
            break;
    }

    res.type("text/xml").send(r.toString());
});

export default router;
