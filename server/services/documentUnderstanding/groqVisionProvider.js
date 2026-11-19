import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const VISION_CACHE_DIR = path.join(process.cwd(), "uploads", "vault", "vision_cache");

/**
 * Universal Document Understanding — Groq Vision Provider
 * 
 * Powered by Qwen Vision (`qwen/qwen3.8-27b`) via Groq's high-throughput LPU API.
 * Provides visual document perception for scanned examination pages, 
 * reading horizontal 2x2 option grids, complex LaTeX formulas, diagrams, 
 * matching columns, and multi-statement questions.
 */
export class GroqVisionProvider {

    static getApiKey() {
        return process.env.GROQ_API_KEY || process.env.AI_API_KEY || null;
    }

    static getModel() {
        return process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
    }

    static getBaseUrl() {
        const raw = process.env.AI_BASE_URL || "https://api.groq.com/openai/v1";
        return raw.replace(/\/+$/, "");
    }

    /**
     * Check if Groq Vision is configured and available
     */
    static isAvailable() {
        const key = this.getApiKey();
        return Boolean(key && !key.includes("PASTE_YOUR") && key.length > 10);
    }

    /**
     * Generate content-addressed cache key
     */
    static computeCacheKey(imageBuffer, prompt, model) {
        const hash = crypto.createHash("sha256");
        hash.update(imageBuffer);
        hash.update(prompt);
        hash.update(model);
        return hash.digest("hex").substring(0, 24);
    }

    /**
     * Read cached vision response if available
     */
    static getCachedResponse(cacheKey) {
        const cacheFile = path.join(VISION_CACHE_DIR, `${cacheKey}.json`);
        if (fs.existsSync(cacheFile)) {
            try {
                return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    /**
     * Persist vision response to cache
     */
    static setCachedResponse(cacheKey, data) {
        try {
            if (!fs.existsSync(VISION_CACHE_DIR)) {
                fs.mkdirSync(VISION_CACHE_DIR, { recursive: true });
            }
            const cacheFile = path.join(VISION_CACHE_DIR, `${cacheKey}.json`);
            fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf8");
        } catch (e) {
            console.warn(`[GroqVisionProvider] Cache write failed for ${cacheKey}:`, e.message);
        }
    }

    /**
     * Core multimodal completion call to Groq Vision API
     * 
     * @param {object} params
     * @param {Buffer|string} params.image Input image buffer or base64 string
     * @param {string} [params.mimeType="image/png"] MIME type
     * @param {string} params.prompt Text prompt instructing the model
     * @param {string} [params.systemPrompt] Optional system prompt
     * @param {number} [params.temperature=0.1] Temperature
     * @param {number} [params.maxTokens=2048] Max generation tokens
     * @param {boolean} [params.useCache=true] Whether to read/write disk cache
     * @returns {Promise<{ content: string, parsedJson: object|null, model: string, usage: object, cached: boolean }>}
     */
    static async completeWithImage({
        image,
        mimeType = "image/png",
        prompt,
        systemPrompt = "You are an expert examination document analyzer. Extract questions, mathematical formulas, and options with exact fidelity.",
        temperature = 0.1,
        maxTokens = 2048,
        useCache = true
    }) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error("[GroqVisionProvider] GROQ_API_KEY is not configured.");
        }

        const model = this.getModel();
        const baseUrl = this.getBaseUrl();
        const endpoint = `${baseUrl}/chat/completions`;

        // Normalize image to Buffer and base64
        let imageBuffer;
        let base64Image;
        if (Buffer.isBuffer(image)) {
            imageBuffer = image;
            base64Image = image.toString("base64");
        } else if (typeof image === "string") {
            if (image.startsWith("data:")) {
                const parts = image.split(",");
                base64Image = parts[1];
                imageBuffer = Buffer.from(base64Image, "base64");
            } else if (fs.existsSync(image)) {
                imageBuffer = fs.readFileSync(image);
                base64Image = imageBuffer.toString("base64");
            } else {
                base64Image = image;
                imageBuffer = Buffer.from(base64Image, "base64");
            }
        } else {
            throw new Error("[GroqVisionProvider] Invalid image input: expected Buffer, base64 string, or filepath.");
        }

        // Check cache
        const cacheKey = this.computeCacheKey(imageBuffer, prompt + systemPrompt, model);
        if (useCache) {
            const cached = this.getCachedResponse(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true
                };
            }
        }

        // Build multimodal payload
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({
            role: "user",
            content: [
                { type: "text", text: prompt },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:${mimeType};base64,${base64Image}`
                    }
                }
            ]
        });

        // Exponential backoff retry loop (handles HTTP 429 and transient 5xx)
        let lastError = null;
        const maxRetries = 6;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout

            try {
                const startTime = Date.now();
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature,
                        max_tokens: maxTokens
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                const latencyMs = Date.now() - startTime;

                if (!response.ok) {
                    const errText = await response.text();
                    console.error(`[GroqVisionProvider] HTTP ${response.status} (attempt ${attempt}/${maxRetries}):`, errText);

                    if (response.status === 429) {
                        const isTpd = /tokens per day|TPD/i.test(errText);
                        let waitTime = Math.min(3000 * Math.pow(2, attempt), 25000);
                        const match = errText.match(/try again in (?:(\d+)m)?([\d\.]+)s/i);
                        if (match) {
                            const mins = match[1] ? parseInt(match[1], 10) : 0;
                            const secs = parseFloat(match[2]);
                            waitTime = Math.ceil((mins * 60 + secs) * 1000) + 2000;
                        }
                        if (isTpd && (attempt >= 2 || waitTime > 30000)) {
                            throw new Error(`[GroqVisionProvider] Daily token quota exceeded (TPD): cooldown of ${Math.round(waitTime / 1000)}s requested`);
                        }
                        console.warn(`[GroqVisionProvider] Rate limit reached. Backing off for ${waitTime}ms...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        continue;
                    }
                    if (response.status >= 500 && attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                        continue;
                    }
                    throw new Error(`[GroqVisionProvider] API returned HTTP ${response.status}: ${errText.substring(0, 200)}`);
                }

                const data = await response.json();
                const rawContent = data.choices?.[0]?.message?.content || "";

                // Attempt to parse JSON if model returned structured output
                let parsedJson = null;
                const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
                const candidateStr = jsonMatch ? jsonMatch[1].trim() : rawContent.trim();
                if ((candidateStr.startsWith("{") && candidateStr.endsWith("}")) || 
                    (candidateStr.startsWith("[") && candidateStr.endsWith("]"))) {
                    try {
                        parsedJson = JSON.parse(candidateStr);
                    } catch (e) {
                        // Keep content as raw text
                    }
                }

                const result = {
                    content: rawContent.trim(),
                    parsedJson,
                    model: data.model || model,
                    usage: {
                        promptTokens: data.usage?.prompt_tokens || 0,
                        completionTokens: data.usage?.completion_tokens || 0,
                        totalTokens: data.usage?.total_tokens || 0,
                        latencyMs
                    },
                    cached: false
                };

                // Persist successful response
                if (useCache) {
                    this.setCachedResponse(cacheKey, result);
                }

                return result;

            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;
                if (err.name === "AbortError") {
                    console.warn(`[GroqVisionProvider] Timeout on attempt ${attempt}`);
                }
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
        }

        throw lastError || new Error("[GroqVisionProvider] Request failed after retries.");
    }

    /**
     * Specialized prompt: Analyze a full examination page to extract structured questions
     */
    static async analyzePageQuestions({
        image,
        pageNumber,
        ocrText = "",
        subject = "General",
        useCache = true
    }) {
        const prompt = `Analyze page ${pageNumber} of this examination question paper.
Accompanying OCR text for reference:
"""
${ocrText ? ocrText.slice(0, 1500) : "No OCR text available"}
"""

Perform a comprehensive visual inspection of the page:
1. Identify all question numbers visible on this page.
2. For each question, extract:
   - "questionNumber": integer
   - "stem": complete question text with mathematical formulas formatted in LaTeX (e.g. $E = mc^2$, $\\frac{1}{2}$).
   - "hasDiagram": boolean (true if question refers to or contains a figure/graph/circuit).
   - "options": array of 4 option objects with keys "label" (e.g. "(1)", "(2)", "(3)", "(4)" or "(A)", "(B)", "(C)", "(D)") and "text".
     IMPORTANT: If options are arranged in a horizontal 2x2 grid or inline, separate all 4 options accurately.
   - "questionType": "single_choice_mcq" | "multiple_choice_msq" | "numerical_nat" | "match_the_following" | "assertion_reason"
3. DO NOT include solution derivations or explanations (e.g. "Ans.", "Sol.", "Explanation") in the question stem or options.

Return a valid JSON array of question objects:
[
  {
    "questionNumber": 1,
    "stem": "...",
    "hasDiagram": false,
    "questionType": "single_choice_mcq",
    "options": [
      { "label": "(1)", "text": "..." },
      { "label": "(2)", "text": "..." },
      { "label": "(3)", "text": "..." },
      { "label": "(4)", "text": "..." }
    ]
  }
]`;

        const res = await this.completeWithImage({
            image,
            prompt,
            systemPrompt: "You are an expert examination document analyzer. Always respond with a valid JSON array of reconstructed questions.",
            temperature: 0.1,
            maxTokens: 2500,
            useCache
        });

        if (Array.isArray(res.parsedJson)) {
            return {
                questions: res.parsedJson,
                rawContent: res.content,
                model: res.model,
                usage: res.usage,
                cached: res.cached
            };
        }

        // Fallback: extract JSON array from content if nested
        if (res.parsedJson && Array.isArray(res.parsedJson.questions)) {
            return {
                questions: res.parsedJson.questions,
                rawContent: res.content,
                model: res.model,
                usage: res.usage,
                cached: res.cached
            };
        }

        return {
            questions: [],
            rawContent: res.content,
            model: res.model,
            usage: res.usage,
            cached: res.cached
        };
    }

    /**
     * Specialized prompt: Analyze a high-resolution crop around an ambiguous formula, diagram, or 2x2 option grid
     */
    static async analyzeTargetedCrop({
        image,
        questionNumber,
        promptGoal = "Recover the 4 individual options from this option grid",
        useCache = true
    }) {
        const prompt = `Inspect this cropped section for Question ${questionNumber}.
Goal: ${promptGoal}.
If this contains options, extract all options clearly as (1), (2), (3), (4) or (A), (B), (C), (D).
Preserve LaTeX formatting for mathematical expressions.

Return a JSON object:
{
  "questionNumber": ${questionNumber},
  "options": [
    { "label": "(1)", "text": "..." },
    { "label": "(2)", "text": "..." },
    { "label": "(3)", "text": "..." },
    { "label": "(4)", "text": "..." }
  ],
  "clarification": "..."
}`;

        const res = await this.completeWithImage({
            image,
            prompt,
            systemPrompt: "You are an expert document inspector specializing in scientific notations and layout reconstruction. Output valid JSON.",
            temperature: 0.1,
            maxTokens: 1000,
            useCache
        });

        return {
            result: res.parsedJson,
            rawContent: res.content,
            model: res.model,
            usage: res.usage,
            cached: res.cached
        };
    }
}

