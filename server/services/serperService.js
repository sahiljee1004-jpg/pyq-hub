import { SerperSearchService } from "./search/serperSearchService.js";
import { SearchService } from "./searchService.js";

/**
 * Adapter for SerperService — delegates to SerperSearchService / SearchService
 */
export class SerperService {
    static getApiKey() {
        return SerperSearchService.getApiKey();
    }

    static isConfigured() {
        return SerperSearchService.isConfigured();
    }

    static buildSearchQuery(userMessage, context = {}) {
        return SearchService.buildSearchQuery(userMessage, context);
    }

    static async searchWeb(query, options = {}) {
        return SerperSearchService.searchWeb(query, options);
    }

    static extractDomain(urlStr) {
        return SerperSearchService.extractDomain(urlStr);
    }

    static classifySourceType(domain) {
        return SerperSearchService.classifySourceType(domain);
    }

    static async scrapeWebpage(urlStr) {
        return SearchService.fetchWebPage(urlStr);
    }
}
