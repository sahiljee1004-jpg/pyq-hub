import dotenv from "dotenv";
import { MASTER_SYSTEM_PROMPT, SEARCH_MODE_PROMPT, TUTOR_MODE_PROMPT, PAPER_QUESTION_PROMPT } from "../prompts/systemPrompt.js";

dotenv.config();

export class GroqService {
    static getApiKey() {
        return process.env.AI_API_KEY || process.env.GROQ_API_KEY || null;
    }

    static getModel() {
        return process.env.AI_MODEL || "openai/gpt-oss-120b";
    }

    static getBaseUrl() {
        const raw = process.env.AI_BASE_URL || "https://api.groq.com/openai/v1";
        return raw.replace(/\/+$/, "");
    }

    /**
     * Generate response from Groq LLM with mode-specific context
     */
    static async generateResponse({
        mode,
        intent,
        userMessage,
        conversationHistory = [],
        searchEvidence = null,
        paperContext = null
    }) {
        const apiKey = this.getApiKey();
        if (!apiKey || apiKey.includes("PASTE_YOUR")) {
            throw new Error("AI API Key is not configured. Please set AI_API_KEY or GROQ_API_KEY in .env");
        }

        const model = this.getModel();
        const baseUrl = this.getBaseUrl();
        const endpoint = `${baseUrl}/chat/completions`;

        // Select Temperature based on mode
        let temperature = 0.35;
        if (mode === "paper_question") {
            temperature = 0.2; // Low temperature for factual question solving
        } else if (mode === "search") {
            temperature = 0.15;
        } else if (mode === "mixed") {
            temperature = 0.2;
        } else if (mode === "tutor") {
            temperature = 0.35;
        }

        // Build System Prompt
        let systemPrompt = MASTER_SYSTEM_PROMPT + "\n\n";
        
        if (mode === "paper_question") {
            systemPrompt += PAPER_QUESTION_PROMPT;
        } else if (mode === "search") {
            systemPrompt += SEARCH_MODE_PROMPT;
        } else if (mode === "tutor") {
            systemPrompt += TUTOR_MODE_PROMPT;
        } else if (mode === "mixed") {
            systemPrompt += SEARCH_MODE_PROMPT + "\n\n" + TUTOR_MODE_PROMPT;
        }

        // Inject Paper Question Context if present
        if (paperContext && paperContext.question) {
            const p = paperContext.paper || {};
            const q = paperContext.question || {};
            systemPrompt += `\n\n============================================================\n`;
            systemPrompt += `SUPPLIED PAPER QUESTION CONTEXT:\n`;
            systemPrompt += `============================================================\n`;
            systemPrompt += `Exam: ${p.examId || "Exam"}\n`;
            systemPrompt += `Year: ${p.yearId || "Year"}\n`;
            systemPrompt += `Paper / Shift: ${p.title || p.paperId || "Official Paper"}\n`;
            systemPrompt += `Question Number: ${q.questionNumber}\n`;
            if (q.subject) systemPrompt += `Subject: ${q.subject}\n`;
            systemPrompt += `\nQuestion:\n${q.questionText}\n`;
            if (Array.isArray(q.options) && q.options.length > 0) {
                systemPrompt += `\nOptions:\n${q.options.join("\n")}\n`;
            }
            if (q.hasDiagram) {
                systemPrompt += `\nIMPORTANT: This question references a diagram or figure from the original paper. Do NOT fabricate or guess diagram details not present in text. Inform the student to view the figure in the paper PDF.\n`;
            }
            systemPrompt += `============================================================\n`;
            systemPrompt += `CRITICAL DIRECTIVE: Solve strictly based on the supplied question and fundamental principles. Do NOT introduce unstated assumptions, fabricate conditions, or force your derivation to match options.\n`;
        }

        // Inject Web Search Context if present
        if (searchEvidence && Array.isArray(searchEvidence) && searchEvidence.length > 0) {
            systemPrompt += `\n\n============================================================\n`;
            systemPrompt += `RETRIEVED WEB SEARCH EVIDENCE (GROUND YOUR FACTS EXCLUSIVELY HERE):\n`;
            systemPrompt += `============================================================\n`;
            searchEvidence.forEach((item, idx) => {
                systemPrompt += `[Source ${idx + 1}]: ${item.title}\n`;
                systemPrompt += `URL: ${item.url} (Domain: ${item.domain}, Type: ${item.sourceType})\n`;
                systemPrompt += `Snippet: ${item.snippet}\n\n`;
            });
            systemPrompt += `CRITICAL: If the user asks for exact cutoffs, dates, or numerical statistics not present in the above sources, explicitly state that it could not be verified.\n`;
        }

        // Format Conversation History
        const maxLen = parseInt(process.env.MAX_MESSAGE_LENGTH || "1000", 10);
        const safeHistory = Array.isArray(conversationHistory)
            ? conversationHistory.slice(-10).map((msg) => ({
                  role: msg.role === "user" ? "user" : "assistant",
                  content: String(msg.content || "").substring(0, maxLen)
              }))
            : [];

        const messages = [
            { role: "system", content: systemPrompt },
            ...safeHistory,
            { role: "user", content: userMessage }
        ];

        console.log(`[GroqService] Calling model "${model}" with mode="${mode}" | temp=${temperature} | messages=${messages.length}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    temperature: temperature,
                    max_tokens: parseInt(process.env.AI_MAX_TOKENS || "1200", 10)
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[GroqService] Groq HTTP ${response.status}:`, errText);

                if (response.status === 429) {
                    throw new Error("AI service rate limit reached. Please wait a moment and try again.");
                }
                throw new Error(`AI provider returned HTTP ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : null;

            if (!content) {
                throw new Error("Received empty response from AI provider");
            }

            return content.trim();

        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === "AbortError") {
                throw new Error("Request timed out waiting for AI response.");
            }
            throw err;
        }
    }
}
