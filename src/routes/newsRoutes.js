import express from "express";
import twilio from "twilio";
import { CONFIG } from "../config.js";
import { getYnetMivzakim } from "../services/news.js";
import { gatherPlayOrSay, playInterruptible } from "../services/tts.js";
import { getUser } from "../db.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const newsSessions = new Map();

function getNewsSession(callSid) {
    if (!newsSessions.has(callSid)) {
        newsSessions.set(callSid, { items: [], index: 0 });
    }
    return newsSessions.get(callSid);
}

/**
 * News Entry: /news/menu
 */
router.all("/menu", async (req, res) => {
    const r = new VoiceResponse();
    const session = getNewsSession(req.body.CallSid);
    const caller = req.body.From;
    const user = await getUser(caller);

    const items = await getYnetMivzakim();
    if (!items || items.length === 0) {
        await playInterruptible(r, "לא הצלחתי לטעון מבזקים כרגע.", `${CONFIG.BASE_URL}/twiml`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    session.items = items;
    session.index = 0;
    r.redirect(`${CONFIG.BASE_URL}/news/read`);
    res.type("text/xml").send(r.toString());
});

/**
 * Read current flash news item: /news/read
 */
router.all("/read", async (req, res) => {
    const r = new VoiceResponse();
    const session = getNewsSession(req.body.CallSid);
    const caller = req.body.From;
    const user = await getUser(caller);

    if (!session.items || session.items.length === 0) {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    const current = session.items[session.index];
    const timePrefix = current.time ? `שעה ${current.time}. ` : "";
    const prompt = `${timePrefix}${current.title}. לחץ 6 למבזק הבא, 4 לקודם, 8 לפרטים, כוכבית לתפריט.`;

    await gatherPlayOrSay(
        r,
        prompt,
        `${CONFIG.BASE_URL}/news/action`,
        1,
        10,
        { voice: user.settings?.hebrew_voice }
    );

    r.redirect(`${CONFIG.BASE_URL}/twiml`);
    res.type("text/xml").send(r.toString());
});

/**
 * Flash news action: /news/action
 */
router.all("/action", async (req, res) => {
    const r = new VoiceResponse();
    const session = getNewsSession(req.body.CallSid);
    const caller = req.body.From;
    const user = await getUser(caller);
    const key = req.body.Digits;

    if (key === "*") {
        r.redirect(`${CONFIG.BASE_URL}/twiml`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "6") {
        if (session.index < session.items.length - 1) session.index++;
        r.redirect(`${CONFIG.BASE_URL}/news/read`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "4") {
        if (session.index > 0) session.index--;
        r.redirect(`${CONFIG.BASE_URL}/news/read`);
        return res.type("text/xml").send(r.toString());
    }

    if (key === "8") {
        const current = session.items[session.index];
        const detailText = `מאת ${current.creator}. ${current.details}`;
        await playInterruptible(r, detailText, `${CONFIG.BASE_URL}/news/read`, { voice: user.settings?.hebrew_voice });
        r.redirect(`${CONFIG.BASE_URL}/news/read`);
        return res.type("text/xml").send(r.toString());
    }

    r.redirect(`${CONFIG.BASE_URL}/news/read`);
    res.type("text/xml").send(r.toString());
});

export default router;
