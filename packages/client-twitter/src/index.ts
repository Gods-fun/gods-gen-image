import {
    Client,
    elizaLogger,
    IAgentRuntime,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { validateTwitterConfig, TwitterConfig } from "./environment";
import { TwitterInteractionClient } from "./interactions";
import { TwitterPostClient } from "./post";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - interaction: handling mentions, replies
 */
class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    interaction: TwitterInteractionClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        this.client = new ClientBase(runtime, twitterConfig);
        this.client.twitterConfig = twitterConfig;

        // Only enable posting and interactions
        this.post = new TwitterPostClient(this.client, runtime);
        this.interaction = new TwitterInteractionClient(this.client, runtime);

        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${twitterConfig.TWITTER_USERNAME}`);
        elizaLogger.log(`- Processing mentions only from: 0x_sero`);
        elizaLogger.log(`- Dry Run Mode: ${twitterConfig.TWITTER_DRY_RUN ? "enabled" : "disabled"}`);
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);
        elizaLogger.log("Twitter client started");

        const manager = new TwitterManager(runtime, twitterConfig);
        await manager.client.init();
        await manager.post.start();
        await manager.interaction.start();

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
