import { Memory as CoreMemory } from "@elizaos/core";

// Extend the core Memory type with our Twitter-specific fields
export interface TwitterMemory extends CoreMemory {
    type: string;
}

export interface TwitterProfile {
    id: string;
    username: string;
    name: string;
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

// Add RequestQueue class
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