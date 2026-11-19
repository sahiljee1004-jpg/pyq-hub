# VidyarthiVerse AI Chatbot Setup Guide

This guide explains how to configure and run the backend AI service for the **VidyarthiVerse AI Assistant**.

---

## --------------------------------------------------
## AI CHATBOT API CONFIGURATION
## --------------------------------------------------

**Provider:**
Groq

**API key creation page:**
https://console.groq.com/keys

**Backend environment variable:**
```env
AI_PROVIDER=groq
AI_API_KEY=PASTE_YOUR_REAL_API_KEY_HERE
AI_MODEL=openai/gpt-oss-120b
AI_BASE_URL=https://api.groq.com/openai/v1
```

**Model:**
`openai/gpt-oss-120b` 

**Base URL:**
`https://api.groq.com/openai/v1`

---

## Alternative Provider Configurations

### 1. OpenRouter Configuration
If you prefer to use **OpenRouter**:
```env
AI_PROVIDER=openrouter
AI_API_KEY=PASTE_YOUR_OPENROUTER_API_KEY_HERE
AI_MODEL=meta-llama/llama-3.1-8b-instruct:free
AI_BASE_URL=https://openrouter.ai/api/v1
```

### 2. Hugging Face Inference API Configuration
If you prefer to use **Hugging Face**:
```env
AI_PROVIDER=huggingface
AI_API_KEY=PASTE_YOUR_HF_TOKEN_HERE
AI_MODEL=meta-llama/Llama-3.2-3B-Instruct
AI_BASE_URL=https://router.huggingface.co/v1
```

---

## How to Set Up & Run the Server

1. Open the project root directory:
   ```bash
   cd c:\Users\RUPENDRA\Downloads\PYQS-website-clean-source
   ```

2. Open the `.env` file and replace `PASTE_YOUR_GROQ_API_KEY_HERE` with your actual API key from [https://console.groq.com/keys](https://console.groq.com/keys).

3. Start the backend server:
   ```bash
   npm run start:server
   ```
   The backend server will run on `http://localhost:3000`.

4. Build and Sync the Android Capacitor Application:
   ```bash
   npx cap sync android
   ```

---

## Security & Privacy Instructions

- **Never** paste your actual secret API key in frontend JS files (`ai-chat.js`, `papers.js`, etc.), HTML files, or Android assets.
- The API key is stored **only** in the server-side `.env` file.
- `.env` is listed in `.gitignore` and will never be committed to Git or packaged into the Android APK.
- Requests are authenticated via Firebase Authentication tokens to prevent unauthorized or anonymous abuse.
