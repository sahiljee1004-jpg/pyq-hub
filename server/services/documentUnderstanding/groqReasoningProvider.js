import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const REASONING_CACHE_DIR = path.join(process.cwd(), "uploads", "vault", "reasoning_cache");

/**
 * Universal Document Understanding — Groq Reasoning Provider
 * 
 * Powered by GPT-OSS 120B (`openai/gpt-oss-120b`) via Groq.
 * Acts as the synthesis and reconciliation engine:
 * 1. Analyzes the question paper, answer key, and exam pattern together.
 * 2. Reconciles OCR and Vision evidence without hallucinating missing data.
 * 3. Extracts examination rules and section hierarchy.
 * 4. Resolves conflicts using strict document evidence.
 */
export class GroqReasoningProvider {

    static getApiKey() {
        return process.env.GROQ_API_KEY || process.env.AI_API_KEY || null;
    }

    static getModel() {
        return process.env.GROQ_MODEL || process.env.AI_MODEL || "openai/gpt-oss-120b";
    }

    static getBaseUrl() {
        const raw = process.env.AI_BASE_URL || "https://api.groq.com/openai/v1";
        return raw.replace(/\/+$/, "");
    }

    /**
     * Check if Groq Reasoning is configured and available
     */
    static isAvailable() {
        const key = this.getApiKey();
        return Boolean(key && !key.includes("PASTE_YOUR") && key.length > 10);
    }

    /**
     * Compute SHA-256 cache key
     */
    static computeCacheKey(prompt, systemPrompt, model) {
        const hash = crypto.createHash("sha256");
        hash.update(prompt);
        hash.update(systemPrompt || "");
        hash.update(model);
        return hash.digest("hex").substring(0, 24);
    }

    /**
     * Read cached response
     */
    static getCachedResponse(cacheKey) {
        const cacheFile = path.join(REASONING_CACHE_DIR, `${cacheKey}.json`);
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
     * Persist response to cache
     */
    static setCachedResponse(cacheKey, data) {
        try {
            if (!fs.existsSync(REASONING_CACHE_DIR)) {
                fs.mkdirSync(REASONING_CACHE_DIR, { recursive: true });
            }
            const cacheFile = path.join(REASONING_CACHE_DIR, `${cacheKey}.json`);
            fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf8");
        } catch (e) {
            console.warn(`[GroqReasoningProvider] Cache write failed for ${cacheKey}:`, e.message);
        }
    }

    /**
     * Core reasoning completion call to Groq API
     * Note: openai/gpt-oss-120b allocates reasoning tokens internally;
     * maxTokens must be sufficiently large (e.g. >= 1500) to prevent premature truncation.
     */
    static async complete({
        prompt,
        systemPrompt = "You are an expert examination document auditor and synthesizer. Respond only with valid JSON.",
        temperature = 0.1,
        maxTokens = 2500,
        useCache = true
    }) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error("[GroqReasoningProvider] GROQ_API_KEY is not configured.");
        }

        const model = this.getModel();
        const baseUrl = this.getBaseUrl();
        const endpoint = `${baseUrl}/chat/completions`;

        // Cache check
        const cacheKey = this.computeCacheKey(prompt, systemPrompt, model);
        if (useCache) {
            const cached = this.getCachedResponse(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true
                };
            }
        }

        const messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 40000); // 40s timeout

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
                    console.error(`[GroqReasoningProvider] HTTP ${response.status} (attempt ${attempt}/${maxRetries}):`, errText);

                    if (response.status === 429) {
                        const waitTime = Math.min(2000 * Math.pow(2, attempt), 10000);
                        console.warn(`[GroqReasoningProvider] Rate limit reached. Backing off for ${waitTime}ms...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        continue;
                    }
                    if (response.status >= 500 && attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                        continue;
                    }
                    throw new Error(`[GroqReasoningProvider] API returned HTTP ${response.status}: ${errText.substring(0, 200)}`);
                }

                const data = await response.json();
                const rawContent = data.choices?.[0]?.message?.content || "";
                const reasoning = data.choices?.[0]?.message?.reasoning || "";

                // Attempt to parse JSON
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
                    reasoning: reasoning.trim(),
                    model: data.model || model,
                    usage: {
                        promptTokens: data.usage?.prompt_tokens || 0,
                        completionTokens: data.usage?.completion_tokens || 0,
                        totalTokens: data.usage?.total_tokens || 0,
                        latencyMs
                    },
                    cached: false
                };

                if (useCache) {
                    this.setCachedResponse(cacheKey, result);
                }

                return result;

            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
        }

        throw lastError || new Error("[GroqReasoningProvider] Request failed after retries.");
    }

    /**
     * Reconcile evidence for a single question between OCR, Vision, and Answer Key
     */
    static async reconcileQuestionEvidence({
        questionNumber,
        ocrQuestion,
        visionQuestion,
        answerKeyEntry,
        examPatternRules,
        useCache = true
    }) {
        const prompt = `Reconcile the evidence for Question ${questionNumber} of this examination.

=== OCR EVIDENCE ===
Stem: ${ocrQuestion ? ocrQuestion.questionText : "None"}
Options (${ocrQuestion && ocrQuestion.options ? ocrQuestion.options.length : 0}):
${ocrQuestion && ocrQuestion.options ? ocrQuestion.options.map(o => `${o.label || o.id}: ${o.text}`).join("\n") : "None"}
Solution Text: ${ocrQuestion ? ocrQuestion.solutionText || "None" : "None"}

=== VISION EVIDENCE ===
Stem: ${visionQuestion ? visionQuestion.stem : "None"}
Options (${visionQuestion && visionQuestion.options ? visionQuestion.options.length : 0}):
${visionQuestion && visionQuestion.options ? visionQuestion.options.map(o => `${o.label || o.id}: ${o.text}`).join("\n") : "None"}
Has Diagram: ${visionQuestion ? Boolean(visionQuestion.hasDiagram) : false}

=== OFFICIAL ANSWER KEY ENTRY ===
Accepted Answers: ${answerKeyEntry ? JSON.stringify(answerKeyEntry.acceptedAnswers) : "Missing"}
Is Bonus/Dropped: ${answerKeyEntry ? Boolean(answerKeyEntry.isBonus || answerKeyEntry.isDropped) : false}

Instructions:
1. Reconcile the question stem: choose the text that best preserves mathematical notation and scientific formulas.
2. Reconcile the options: if OCR merged a 2x2 grid but Vision separated all 4 options, adopt the 4 distinct options from Vision.
3. Validate that options do not contain solution derivations.
4. Verify correspondence with the official answer key entry.
5. Provide a confidence score (0.0 to 1.0) and verification status ("VERIFIED" or "NEEDS_REVIEW").
   If 4 clean options and an unambiguous stem are confirmed, mark as "VERIFIED".

Return a valid JSON object:
{
  "questionNumber": ${questionNumber},
  "reconciledStem": "...",
  "options": [
    { "label": "(1)", "text": "..." },
    { "label": "(2)", "text": "..." },
    { "label": "(3)", "text": "..." },
    { "label": "(4)", "text": "..." }
  ],
  "questionType": "single_choice_mcq",
  "hasDiagram": false,
  "confidence": 0.95,
  "verificationStatus": "VERIFIED",
  "reconciliationNotes": "..."
}`;

        const res = await this.complete({
            prompt,
            systemPrompt: "You are an authoritative examination data reconciler. You never invent options or stems. Output valid JSON.",
            temperature: 0.1,
            maxTokens: 2000,
            useCache
        });

        if (res.parsedJson) {
            return {
                result: res.parsedJson,
                rawContent: res.content,
                usage: res.usage,
                cached: res.cached
            };
        }

        return {
            result: null,
            rawContent: res.content,
            usage: res.usage,
            cached: res.cached
        };
    }

    /**
     * Cross-verify all three documents at the macro level
     */
    static async crossVerifyThreeDocuments({
        qpSummary,
        akSummary,
        epSummary,
        useCache = true
    }) {
        const prompt = `Perform cross-document verification across the three uploaded examination documents:

1. QUESTION PAPER SUMMARY:
- Total Questions Extracted: ${qpSummary.totalQuestions}
- Sections Detected: ${JSON.stringify(qpSummary.sections)}
- Scanned Bitmap: ${qpSummary.isScanned}
- Detected Booklet Code Evidence: ${qpSummary.detectedBookletCode || "None"}

2. OFFICIAL ANSWER KEY SUMMARY:
- Total Answers: ${akSummary.totalAnswers}
- Booklet Code: ${akSummary.paperCode || "None"}
- Dropped / Bonus Questions: ${JSON.stringify(akSummary.droppedQuestions || [])}
- Multi-Option Questions: ${JSON.stringify(akSummary.multiOptionQuestions || [])}

3. OFFICIAL EXAMINATION PATTERN SUMMARY:
- Declared Total Questions: ${epSummary.totalQuestions}
- Duration Seconds: ${epSummary.durationSeconds}
- Maximum Marks: ${epSummary.maximumMarks}
- Marking Rules: Positive ${epSummary.markingRules?.positiveMarks?.value}, Negative ${epSummary.markingRules?.negativeMarks?.value}, Unattempted ${epSummary.markingRules?.unansweredMarks?.value}
- Declared Sections: ${JSON.stringify(epSummary.sections)}
- Declared Booklet Code: ${epSummary.paperCode || "None"}

Evaluate:
1. Question count consistency (QP vs AK vs EP).
2. Section boundary alignment.
3. Marking scheme consistency.
4. Booklet code correspondence.
5. Overall publication readiness.

Return a valid JSON object:
{
  "isConsistent": true,
  "questionCountMatched": true,
  "sectionDistributionMatched": true,
  "markingRulesMatched": true,
  "bookletCodeConfirmed": true,
  "bookletCode": "...",
  "discrepancies": [],
  "reconciliationRationale": "..."
}`;

        const res = await this.complete({
            prompt,
            systemPrompt: "You are an authoritative examination compliance auditor. Output valid JSON.",
            temperature: 0.1,
            maxTokens: 2000,
            useCache
        });

        return {
            result: res.parsedJson,
            rawContent: res.content,
            usage: res.usage,
            cached: res.cached
        };
    }
}

