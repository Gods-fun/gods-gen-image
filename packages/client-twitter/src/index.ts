import { SearchMode, Tweet } from "agent-twitter-client";
import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    Client,
} from "@elizaos/core";
import { TwitterInteractionClient } from "./interactions";
import { TwitterClient } from "./client";
import { ClientBase } from "./base";
import { buildConversationThread } from "./utils";
import { TwitterConfig } from "./config";
import { TwitterProfile } from "./types";

export class TwitterClientImpl extends ClientBase {
    twitterClient: TwitterClient;
    interactionClient: TwitterInteractionClient;
    twitterConfig: TwitterConfig;
    search: string;

    constructor(runtime: IAgentRuntime, config: TwitterConfig) {
        super(runtime);
        this.twitterConfig = config;
        this.twitterClient = new TwitterClient(config);
        this.interactionClient = new TwitterInteractionClient(this, runtime);
        this.search = "";
    }

    async init() {
        // Implement initialization logic here
    }
}

export * from "./types";
export * from "./config";

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const manager = new TwitterClientImpl(runtime, config);
        await manager.init();
        return manager;
    },
    async stop() {
        // Implement stop logic if needed
    }
};
