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

// High-quota models (1,500 requests/day each)
const FAST_MODELS = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];

/**
 * Direct Audio -> Intent + Query using Gemini Multimodal Function Calling
 */
export async function analyzeAudioIntent(base64Audio) {
    if (CONFIG.GEMINI_KEYS.length === 0) {
        console.warn("[Gemini] ⚠️ No GEMINI_API_KEY configured!");
        return null;
    }

    console.log(`[Gemini] 🧠 Routing audio intent using Gemini...`);

    for (const key of CONFIG.GEMINI_KEYS) {
        const genAI = new GoogleGenerativeAI(key);

        for (const modelName of FAST_MODELS) {
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
                    console.log(`[Gemini] 🎯 Audio Intent via ${modelName}: "${call.args.intent}", Query: "${call.args.query}"`);
                    return call.args;
                }
            } catch (e) {
                if (e.message.includes("429")) {
                    console.warn(`[Gemini] ⚠️ Quota 429 on model ${modelName}. Trying next model...`);
                    continue; // Try next high-quota model
                }
                console.error(`[Gemini] ❌ Router error (${modelName}):`, e.message.slice(0, 80));
            }
        }
    }
    return null;
}

/**
 * Conversational Chat with Gemini (with Google Search Grounding & Persistent History)
 */
export async function chatWithGemini(phone, userInputText, customHistory = null) {
    const user = await getUser(phone);
    const isEn = user.settings?.language !== "he";
    const presetKey = user.settings?.system_prompt_preset || "default";
    const systemPrompt = SYSTEM_PRESETS[presetKey] || SYSTEM_PRESETS.default;
    const preferredModel = user.settings?.model || "gemini-1.5-flash";

    await saveChatHistory(phone, "user", userInputText);
    const history = customHistory || (await getUser(phone)).chat_history || [];

    const modelsToTry = [preferredModel, ...FAST_MODELS.filter(m => m !== preferredModel)];

    for (const key of CONFIG.GEMINI_KEYS) {
        const genAI = new GoogleGenerativeAI(key);

        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    tools: [{ googleSearch: {} }],
                    systemInstruction: systemPrompt
                });

                const prevTurns = history.slice(0, -1);
                const chat = model.startChat({ history: prevTurns });

                console.log(`[Gemini] 💬 Chatting with "${modelName}" for: "${userInputText}"`);
                const result = await chat.sendMessage(userInputText);
                const replyText = result.response.text().replace(/[*_#`]/g, "").trim();

                console.log(`[Gemini] ✅ Reply generated from ${modelName} (${replyText.length} chars)`);
                await saveChatHistory(phone, "model", replyText);
                return replyText;
            } catch (e) {
                if (e.message.includes("429")) {
                    console.warn(`[Gemini] ⚠️ 429 Quota on ${modelName}. Trying fallback model...`);
                    continue;
                }
                console.error(`[Gemini] ❌ Chat error (${modelName}):`, e.message.slice(0, 80));
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

    for (const key of CONFIG.GEMINI_KEYS) {
        const genAI = new GoogleGenerativeAI(key);
        for (const modelName of FAST_MODELS) {
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
