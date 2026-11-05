import { GoogleGenerativeAI } from "@google/generative-ai";
import { CONFIG } from "../config.js";
import { saveChatHistory, getUser } from "../db.js";

export const SYSTEM_PRESETS = {
    default: `You are a highly intelligent phone assistant with access to Google Search. 
Conduct research to find accurate answers. Synthesize your findings into a natural, conversational response. 
Keep it concise (2-4 sentences) so it sounds natural on a phone call. Never output URLs, lists, or markdown symbols like asterisks. 
CRITICAL: Respond STRICTLY in the language the user asked in. If they speak Hebrew, you MUST reply in Hebrew.`,

    tutor: `You are a patient and clear Hebrew-English tutor on a phone call.
Explain concepts simply and clearly in 2-3 sentences. Never output markdown or URLs.
Respond in the language the user addressed you in.`,

    brief: `You are an ultra-concise executive briefing assistant.
Answer questions directly with facts only in 1-2 short sentences. No pleasantries, no markdown, no URLs.
Match the user's language strictly.`
};

const ROUTER_PROMPT = `You are a smart voice routing engine. Listen to the audio. 
1. If the user asks for a song, figure out the actual song name/artist (correcting slang or mispronunciations) and output intent 'music'.
2. If the user asks for a PODCAST, a FULL SET, or a long mix, output intent 'music_long'.
3. If they ask a question or want to talk, output intent 'chat'.
CRITICAL: Extract the query in the EXACT language they used. If they speak Hebrew, output Hebrew text. Do not translate.`;

const ROUTER_TOOL = {
    functionDeclarations: [{
        name: "route_request",
        description: "Routes user request.",
        parameters: {
            type: "OBJECT",
            properties: {
                intent: { type: "STRING", description: "'music', 'music_long', or 'chat'" },
                query: { type: "STRING", description: "Song name or chat question." }
            },
            required: ["intent", "query"]
        }
    }]
};

/**
 * Direct Audio -> Intent + Query using Gemini Multimodal Function Calling
 */
export async function analyzeAudioIntent(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) return null;

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                tools: [ROUTER_TOOL],
                systemInstruction: ROUTER_PROMPT
            });

            const result = await model.generateContent([
                { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
            ]);

            const call = result.response.functionCalls()?.[0];
            if (call && call.name === "route_request") {
                return call.args;
            }
        } catch (e) {
            console.error("Gemini Router error with key:", e.message);
        }
    }
    return null;
}

/**
 * Conversational Chat with Gemini (with Google Search Grounding & Persistent History)
 */
export async function chatWithGemini(phone, userInputText, customHistory = null) {
    const user = await getUser(phone);
    const presetKey = user.settings?.system_prompt_preset || "default";
    const systemPrompt = SYSTEM_PRESETS[presetKey] || SYSTEM_PRESETS.default;
    const modelName = user.settings?.model || "gemini-2.5-flash";

    await saveChatHistory(phone, "user", userInputText);
    const history = customHistory || (await getUser(phone)).chat_history || [];

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: modelName,
                tools: [{ googleSearch: {} }],
                systemInstruction: systemPrompt
            });

            // Feed history except the last prompt which is sent via sendMessage
            const prevTurns = history.slice(0, -1);
            const chat = model.startChat({ history: prevTurns });

            const result = await chat.sendMessage(userInputText);
            const replyText = result.response.text().replace(/[*_#`]/g, "").trim();

            await saveChatHistory(phone, "model", replyText);
            return replyText;
        } catch (e) {
            console.error("Gemini Chat error with key:", e.message);
        }
    }

    return "סליחה, נתקלתי בבעיה בחיבור. אנא נסה שוב בעוד רגע.";
}

/**
 * Generate a quick 15-second summary of the chat so far
 */
export async function summarizeChatSoFar(phone) {
    const user = await getUser(phone);
    const history = user.chat_history || [];
    if (history.length === 0) return "אין עדיין היסטוריית שיחה לסכם.";

    for (const key of CONFIG.GEMINI_KEYS) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `סכם במשפט או שניים קצרים וברורים בעברית את עיקרי השיחה שהתקיימה עד כה:
${JSON.stringify(history)}`;

            const result = await model.generateContent(prompt);
            return result.response.text().replace(/[*_#`]/g, "").trim();
        } catch (e) {
            console.error("Summary error:", e.message);
        }
    }
    return "לא הצלחתי לסכם כרגע.";
}
