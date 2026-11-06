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

// Supported Gemini Models for User Selection
export const AVAILABLE_MODELS = [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", nameHe: "ג'מיני 2.5 פלאש" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", nameHe: "ג'מיני 2.5 פרו" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", nameHe: "ג'מיני 2.0 פלאש" },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", nameHe: "ג'מיני 1.5 פלאש" },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", nameHe: "ג'מיני 1.5 פרו" }
];

/**
 * Direct Audio -> Intent + Query using Gemini Multimodal Function Calling
 * Rotates across all 3 configured Gemini API keys with multi-model fallback on 429
 */
export async function analyzeAudioIntent(base64Audio, preferredModel = "gemini-2.5-flash") {
    if (CONFIG.GEMINI_KEYS.length === 0) {
        console.warn("[Gemini] ⚠️ No GEMINI_API_KEY configured!");
        return null;
    }

    const modelsToTry = [
        preferredModel,
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-2.5-pro",
        "gemini-1.5-pro"
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    console.log(`[Gemini] 🧠 Routing audio intent (Preferred: ${preferredModel}, ${CONFIG.GEMINI_KEYS.length} keys available)...`);

    for (const modelName of modelsToTry) {
        for (let keyIdx = 0; keyIdx < CONFIG.GEMINI_KEYS.length; keyIdx++) {
            const key = CONFIG.GEMINI_KEYS[keyIdx];
            const genAI = new GoogleGenerativeAI(key);

            try {
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    tools: [ROUTER_TOOL],
                    systemInstruction: ROUTER_PROMPT
                });

                const result = await model.generateContent([
                    { inlineData: { mimeType: "audio/mp3", data: base64Audio } }
                ]);

                const call = result.response.functionCalls()?.[0];
                if (call && call.name === "route_request") {
                    console.log(`[Gemini] 🎯 Audio Intent via Key #${keyIdx + 1} (${modelName}): "${call.args.intent}", Query: "${call.args.query}"`);
                    return call.args;
                }
            } catch (e) {
                if (e.message.includes("429")) {
                    console.warn(`[Gemini] ⚠️ 429 Quota on Key #${keyIdx + 1} (${modelName}). Rotating to next key...`);
                    continue;
                }
                console.error(`[Gemini] ❌ Router error (Key #${keyIdx + 1}, ${modelName}):`, e.message.slice(0, 80));
            }
        }
    }
    return null;
}

/**
 * Conversational Chat with Gemini (with Google Search Grounding & Persistent History)
 * Rotates across all 3 configured Gemini API keys with multi-model fallback on 429
 */
export async function chatWithGemini(phone, userInputText, customHistory = null) {
    const user = await getUser(phone);
    const isEn = user.settings?.language !== "he";
    const presetKey = user.settings?.system_prompt_preset || "default";
    const systemPrompt = SYSTEM_PRESETS[presetKey] || SYSTEM_PRESETS.default;
    const preferredModel = user.settings?.model || "gemini-2.5-flash";

    await saveChatHistory(phone, "user", userInputText);
    const history = customHistory || (await getUser(phone)).chat_history || [];

    const modelsToTry = [
        preferredModel,
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    console.log(`[Gemini] 💬 Chatting with model "${preferredModel}" across ${CONFIG.GEMINI_KEYS.length} keys...`);

    for (const modelName of modelsToTry) {
        for (let keyIdx = 0; keyIdx < CONFIG.GEMINI_KEYS.length; keyIdx++) {
            const key = CONFIG.GEMINI_KEYS[keyIdx];
            const genAI = new GoogleGenerativeAI(key);

            try {
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    tools: [{ googleSearch: {} }],
                    systemInstruction: systemPrompt
                });

                const prevTurns = history.slice(0, -1);
                const chat = model.startChat({ history: prevTurns });

                const result = await chat.sendMessage(userInputText);
                const replyText = result.response.text().replace(/[*_#`]/g, "").trim();

                console.log(`[Gemini] ✅ Reply generated from Key #${keyIdx + 1} (${modelName}) (${replyText.length} chars)`);
                await saveChatHistory(phone, "model", replyText);
                return replyText;
            } catch (e) {
                if (e.message.includes("429")) {
                    console.warn(`[Gemini] ⚠️ 429 Quota on Key #${keyIdx + 1} (${modelName}). Rotating to next key...`);
                    continue;
                }
                console.error(`[Gemini] ❌ Chat error (Key #${keyIdx + 1}, ${modelName}):`, e.message.slice(0, 80));
            }
        }
    }

    return isEn 
        ? "I apologize, I encountered a temporary network issue. Please ask again in a moment."
        : "סליחה, נתקלתי בבעיה זמנית בחיבור. אנא נסה שוב בעוד רגע.";
}

/**
 * Generate a quick 15-second summary of the chat so far
 */
export async function summarizeChatSoFar(phone) {
    const user = await getUser(phone);
    const isEn = user.settings?.language !== "he";
    const history = user.chat_history || [];
    if (history.length === 0) {
        return isEn ? "There is no conversation history to summarize yet." : "אין עדיין היסטוריית שיחה לסכם.";
    }

    const preferredModel = user.settings?.model || "gemini-2.5-flash";
    const modelsToTry = [preferredModel, "gemini-2.0-flash", "gemini-1.5-flash"];

    for (const modelName of modelsToTry) {
        for (const key of CONFIG.GEMINI_KEYS) {
            const genAI = new GoogleGenerativeAI(key);
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const prompt = isEn
                    ? `Summarize the key points of this phone conversation in 1-2 clear, spoken sentences:\n${JSON.stringify(history)}`
                    : `סכם במשפט או שניים קצרים וברורים בעברית את עיקרי השיחה שהתקיימה עד כה:\n${JSON.stringify(history)}`;

                const result = await model.generateContent(prompt);
                return result.response.text().replace(/[*_#`]/g, "").trim();
            } catch (e) {
                continue;
            }
        }
    }
    return isEn ? "Could not generate summary." : "לא הצלחתי לסכם כרגע.";
}
