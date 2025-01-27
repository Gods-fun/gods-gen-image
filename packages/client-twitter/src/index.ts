import {
    Client,
    elizaLogger,
    IAgentRuntime,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { validateTwitterConfig, TwitterConfig } from "./environment";
import { TwitterInteractionClient } from "./interactions";
import { TwitterPostClient } from "./post";
import { TwitterClientAccess, RequestQueue, ImageAttachment } from "./types";

// Extended runtime type that includes actionManager
interface ExtendedRuntime extends IAgentRuntime {
    actionManager: {
        handleAction: Function;
    };
    getClient(): TwitterManager | null;
}

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - interaction: handling mentions, replies
 */
class TwitterManager {
    readonly client: ClientBase;
    readonly post: TwitterPostClient;
    readonly interaction: TwitterInteractionClient;
    readonly processedTweets: Set<string> = new Set();
    private requestQueue: RequestQueue;

    constructor(runtime: ExtendedRuntime, twitterConfig: TwitterConfig) {
        // Initialize base client
        this.client = new ClientBase(runtime, twitterConfig);
        this.requestQueue = new RequestQueue();

        // Initialize post client
        this.post = new TwitterPostClient(this.client, runtime);

        // Create an extended client that preserves the original methods and adds required properties
        const extendedClient = Object.create(this.client, {
            post: { 
                value: this.post,
                enumerable: true 
            },
            processedTweets: { 
                value: this.processedTweets,
                enumerable: true 
            }
        });

        // Initialize interaction client with the extended client and runtime
        this.interaction = new TwitterInteractionClient(
            extendedClient as ClientBase & { 
                post: TwitterPostClient & {
                    reply(tweetId: string, content: string): Promise<void>;
                    replyWithImage(tweetId: string, content: string, image: ImageAttachment): Promise<void>;
                };
                processedTweets: Set<string>;
                queueTweetAction: Function;
            },
            runtime
        );
    }

}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);
        elizaLogger.log("Starting Twitter client...");

        try {
            const manager = new TwitterManager(runtime as ExtendedRuntime, twitterConfig);
            await manager.client.init();
            await manager.post.start();
            await manager.interaction.start();

            elizaLogger.log("Twitter client started successfully");
            return manager;
        } catch (error) {
            elizaLogger.error("Failed to start Twitter client", {
                error: error instanceof Error ? error.message : "Unknown error"
            });
            throw error;
        }
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
