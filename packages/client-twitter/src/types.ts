import { Memory as CoreMemory } from "@elizaos/core";
import { Scraper } from "agent-twitter-client";
import { TwitterConfig } from "./environment";

// Extend the core Memory type with our Twitter-specific fields
export interface TwitterMemory extends CoreMemory {
    type: string;
}

export interface TwitterProfile {
    id: string;
    username: string;
    name: string;
    screenName: string;
    bio: string;
    nicknames: string[];
    followersCount?: number;
    followingCount?: number;
    tweetsCount?: number;
    isVerified?: boolean;
}

export interface Tweet {
    id: string;
    text: string;
    userId: string;
    username: string;
    name: string;
    timestamp: number;
    conversationId: string;
    permanentUrl: string;
    inReplyToStatusId?: string;
    isReply?: boolean;
    isRetweet?: boolean;
}

export interface ImageAttachment {
    url: string;
    mediaType?: string;
}

// Define the RequestQueue class
export class RequestQueue {
    private queue: Promise<any> = Promise.resolve();

    add<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue = this.queue
                .then(() => fn())
                .then(resolve)
                .catch(reject);
        });
    }
}

// Define the common interface for accessing protected properties
export interface TwitterClientAccess {
    getTwitterConfig(): TwitterConfig;
    getTwitterClient(): Scraper;
    getProfile(): TwitterProfile | null;
    getRequestQueue(): RequestQueue;
} 