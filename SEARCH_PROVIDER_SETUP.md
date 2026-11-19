# VidyarthiAstra — Web Search Architecture & Setup Guide (TinyFish + Serper Fallback + Groq)

This document provides setup instructions for the TinyFish Web Search with Serper Google Search Fallback architecture implemented in **VidyarthiAstra**.

---

## Architecture Overview

```text
                     ┌──────────────────────────────────┐
                     │     VidyarthiAstra Frontend      │
                     │  AI Assistant  |  Live Updates   │
                     └────────────────┬─────────────────┘
                                      │
                                      ▼
                     ┌──────────────────────────────────┐
                     │       Node.js / Express          │
                     │       Backend (Port 3000)        │
                     └────────────────┬─────────────────┘
                                      │
                     ┌────────────────┴─────────────────┐
                     │          SearchService           │
                     │  Provider Abstraction & Fallback │
                     └────────────────┬─────────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               │                                             │
      (Primary Discovery)                           (Fallback on Failure)
               ▼                                             ▼
      ┌─────────────────┐                           ┌─────────────────┐
      │ TinyFish Search │                           │  Serper Google  │
      │   Discovery     │──[Quota/Rate/5xx Fail]───►│   Search API    │
      └────────┬────────┘                           └────────┬────────┘
               │                                             │
               └──────────────────────┬──────────────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │     TinyFish Fetch       │
                        │ Clean Content Extraction │
                        │  (Direct Fetch Fallback) │
                        └─────────────┬────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │   Normalized Results     │
                        │   Title / URL / Snippet  │
                        │   Source Trust Rank      │
                        └─────────────┬────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │           Groq           │
                        │     AI Summarization     │
                        │     & Answer Tutor       │
                        └─────────────┬────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │  Server-Side Cache (20m) │
                        │   Last-Known-Good Stale  │
                        └──────────────────────────┘
```

* **TinyFish Search**: Primary web discovery provider (`GET https://api.search.tinyfish.ai`).
* **Serper Google Search**: Secondary fallback web discovery provider (`POST https://google.serper.dev/search`).
* **TinyFish Fetch**: Page-content extraction provider (`POST https://api.fetch.tinyfish.ai` with per-URL HTML fallback).
* **Groq**: Primary LLM for AI tutoring, answer generation, and structured exam update summarization.
* **Cache Engine**: 20-minute server cache with query-isolated graceful stale fallback.

---

## 1. Provider Setup

### TinyFish (Primary Provider)
1. Obtain your API key from the TinyFish Developer Dashboard.
2. Set `TINYFISH_API_KEY` in your Hostinger/server `.env`.
3. Endpoint: `https://api.search.tinyfish.ai`.

### Serper (Secondary Fallback Provider)
1. Register and generate an API key at [serper.dev](https://serper.dev).
2. Set `SERPER_API_KEY` in your Hostinger/server `.env`.
3. Endpoint: `https://google.serper.dev/search`.
4. Automatically activates when TinyFish experiences quota exhaustion, rate limits, timeouts, network issues, or retryable 5xx server errors.

---

## 2. Environment Variables Configuration (`.env`)

Add or update the following parameters in your server environment:

```env
# Primary AI Provider (Groq)
AI_PROVIDER=groq
AI_API_KEY=gsk_your_groq_api_key_here
AI_MODEL=openai/gpt-oss-120b
AI_BASE_URL=https://api.groq.com/openai/v1

# Search Provider Configuration
SEARCH_PROVIDER=tinyfish
SEARCH_FALLBACK_ENABLED=true
SEARCH_TIMEOUT_MS=10000
FETCH_TIMEOUT_MS=15000
SEARCH_MAX_RESULTS=10
SEARCH_RATE_LIMIT_PER_MINUTE=10

# TinyFish Credentials & Endpoints (Primary)
TINYFISH_API_KEY=your_tinyfish_api_key_here
TINYFISH_SEARCH_URL=https://api.search.tinyfish.ai
TINYFISH_FETCH_URL=https://api.fetch.tinyfish.ai

# Serper Credentials & Endpoints (Secondary Fallback)
SERPER_API_KEY=your_serper_api_key_here
SERPER_SEARCH_URL=https://google.serper.dev/search

# Live Updates Budget & Request Control Limits
LIVE_UPDATES_MAX_SEARCHES=20
LIVE_UPDATES_MAX_FETCH_URLS=8

# Application Limits
PORT=3000
AI_TEMPERATURE=0.5
AI_MAX_TOKENS=1200
MAX_MESSAGE_LENGTH=3000
MAX_CHAT_MESSAGES=20
DAILY_MESSAGE_LIMIT=30
LIVE_UPDATES_CACHE_TTL_MINUTES=20
LIVE_UPDATES_RATE_LIMIT_PER_MINUTE=5
```

---

## 3. Health Check & Diagnostic Endpoints

### 1. General System Health Check
`GET http://localhost:3000/health` or `/api/health`

Response:
```json
{
  "success": true,
  "service": "VidyarthiAstra AI Assistant backend",
  "architecture": "TinyFish Search/Fetch + Serper Google Search Fallback + Groq AI Tutor + Live Updates Engine",
  "primarySearchProvider": "tinyfish",
  "secondarySearchProvider": "serper",
  "fallbackEnabled": true,
  "tinyfishConfigured": true,
  "serperConfigured": true,
  "groqConfigured": true
}
```

### 2. Search Engine Health Check
`GET http://localhost:3000/api/search/health`

Response:
```json
{
  "success": true,
  "primaryProvider": "tinyfish",
  "secondaryProvider": "serper",
  "fallbackEnabled": true,
  "tinyfishConfigured": true,
  "serperConfigured": true
}
```

### 3. Search Engine Test Endpoint (Dev Only)
`GET http://localhost:3000/api/search/test?q=JEE+Main+2026+notification`
