import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils";

// Template for handling Twitter messages, focusing on the agent's voice and context
export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

// Template for determining when the agent should respond, with focus on transfer requests
export const twitterShouldRespondTemplate = () =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation.

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULES:
- ALWAYS RESPOND to transfer/bridge/swap requests
- ALWAYS RESPOND to messages directed at {{agentName}} (mentions)

Rules for responding:
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

// Helper function to identify transfer-related requests
const isTransferRequest = (text: string): boolean => {
    const transferKeywords = [
        'transfer',
        'send',
        'eth',
        'bridge',
        'swap'
    ];
    const lowerText = text.toLowerCase();
    return transferKeywords.some(keyword => lowerText.includes(keyword));
};

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    // Start the Twitter interaction polling loop
    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();
    }


        async handleTwitterInteractions() {
            elizaLogger.log("Starting Twitter interactions check");
            const twitterUsername = this.client.profile!.username;

            try {
                // Get configurable search parameters
                const searchParams = this.getSearchParameters();
                const tweets = await this.fetchAndFilterTweets(twitterUsername, searchParams);

                if (tweets.length === 0) {
                    elizaLogger.log("No valid tweets to process");
                    return;
                }

                await this.processTweets(tweets);

            } catch (error) {
                elizaLogger.error("Error in handleTwitterInteractions:", error);
            }
        }

        private getSearchParameters() {
            return {
                maxResults: 20,
                targetUsers: this.client.twitterConfig.TWITTER_TARGET_USERS || [],
                searchMode: SearchMode.Latest,
                // Add any other configurable parameters here
                maxThreadDepth: 1,
                minTimestamp: Date.now() - (2) * 60 * 60 * 1000
            };
        }

        private async fetchAndFilterTweets(twitterUsername: string, params: any): Promise<Tweet[]> {
            // First fetch mentions
            const searchQuery = this.buildSearchQuery(twitterUsername, params.targetUsers);
            elizaLogger.log("Search query:", searchQuery);

            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    searchQuery,
                    params.maxResults,
                    params.searchMode
                )
            ).tweets as Tweet[];

            // Log raw mentions for debugging
            elizaLogger.log("Raw mentions received:", mentionCandidates.map(tweet => ({
                id: tweet.id,
                author: tweet.username,
                text: tweet.text?.substring(0, 50) + "..."
            })));

            // Process target users if configured
            let additionalTweets: Tweet[] = [];
            if (params.targetUsers.length > 0) {
                additionalTweets = await this.processTargetUsers(params);
            }

            // Combine and filter all tweets
            const allTweets = [...mentionCandidates, ...additionalTweets];
            return this.filterAndSortTweets(allTweets, params);
        }

        private buildSearchQuery(twitterUsername: string, targetUsers: string[]): string {
            const queries = [`@${twitterUsername}`];

            if (targetUsers.length > 0) {
                const userQueries = targetUsers.map(user => `from:${user}`);
                queries.push(...userQueries);
            }

            return queries.join(" OR ");
        }

        private async processTargetUsers(params: any): Promise<Tweet[]> {
            elizaLogger.log("Processing target users:", params.targetUsers);
            const targetTweets: Tweet[] = [];

            for (const username of params.targetUsers) {
                try {
                    const userTweets = (
                        await this.client.twitterClient.fetchSearchTweets(
                            `from:${username}`,
                            3,
                            SearchMode.Latest
                        )
                    ).tweets;

                    const validTweets = this.filterUserTweets(userTweets, params);
                    if (validTweets.length > 0) {
                        // Randomly select one tweet from this user
                        const randomTweet = validTweets[Math.floor(Math.random() * validTweets.length)];
                        targetTweets.push(randomTweet);
                        elizaLogger.log(`Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`);
                    }
                } catch (error) {
                    elizaLogger.error(`Error fetching tweets for ${username}:`, error);
                }
            }

            return targetTweets;
        }

        private filterUserTweets(tweets: Tweet[], params: any): Tweet[] {
            return tweets.filter(tweet => {
                const isUnprocessed = !this.client.lastCheckedTweetId ||
                                    parseInt(tweet.id) > this.client.lastCheckedTweetId;
                const isRecent = Date.now() - tweet.timestamp * 1000 < params.minTimestamp;

                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                    isUnprocessed,
                    isRecent,
                    isReply: tweet.isReply,
                    isRetweet: tweet.isRetweet
                });

                return isUnprocessed && !tweet.isReply && !tweet.isRetweet && isRecent;
            });
        }

        private filterAndSortTweets(tweets: Tweet[], params: any): Tweet[] {
            return tweets
                .filter(tweet => {
                    const isValidTweet =
                        typeof tweet.id === 'string' &&
                        typeof tweet.userId === 'string' &&
                        tweet.text &&
                        tweet.timestamp &&
                        tweet.username &&
                        params.targetUsers.map(u => u.toLowerCase()).includes(tweet.username.toLowerCase());

                    if (!isValidTweet) {
                        elizaLogger.log("Filtered out tweet:", {
                            id: tweet.id,
                            author: tweet.username,
                            reason: !params.targetUsers.map(u => u.toLowerCase()).includes(tweet.username?.toLowerCase()) ?
                                "Not from target user" : "Invalid tweet structure"
                        });
                    }

                    return isValidTweet;
                })
                .sort((a, b) => a.id.localeCompare(b.id));
        }

        private async processTweets(tweets: Tweet[]) {
            for (const tweet of tweets) {
                const thread = await buildConversationThread(
                    tweet,
                    this.client,
                    1
                );

                const message: Memory = {
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    content: {
                        text: tweet.text || "",
                    },
                    agentId: this.runtime.agentId,
                    userId: stringToUuid(tweet.userId!),
                    roomId: stringToUuid(tweet.conversationId!),
                    createdAt: tweet.timestamp! * 1000,
                    embedding: []
                };

                await this.handleTweet({
                    tweet,
                    message,
                    thread,
                });

                // Update last checked tweet ID
                if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                    await this.client.cacheLatestCheckedTweetId();
                }
            }
        }

    // Method for handling individual tweets
    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Validate tweet data
        if (!tweet.text || !tweet.id || !tweet.userId || !tweet.timestamp) {
            elizaLogger.log("Invalid tweet data", tweet);
            return { text: "", action: "IGNORE" };
        }

        if (tweet.userId === this.client.profile!.id) {
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        // Check for transfer request
        const isTransfer = isTransferRequest(message.content.text);
        if (isTransfer) {
            elizaLogger.log("Transfer request detected in tweet:", tweet.id);
            message.content.action = "transfer";
        }

        // Log message content
        elizaLogger.log("Processing tweet with content:", {
            id: tweet.id,
            text: message.content.text,
            action: message.content.action
        });

        const formatTweet = (t: Tweet) => {
            if (!t.text || !t.id || !t.name || !t.username) {
                return "";
            }
            return `  ID: ${t.id}
  From: ${t.name} (@${t.username})
  Text: ${t.text}`;
        };

        const currentPost = formatTweet(tweet);
        const formattedConversation = thread
            .filter(t => t.text && t.username && t.timestamp)
            .map((t) => `@${t.username} (${new Date(t.timestamp! * 1000).toLocaleString()}):
    ${t.text}`)
            .join("\n\n");

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
        });

        // Save tweet if it doesn't exist
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId);
            const roomId = stringToUuid(tweet.conversationId!);

            const newMessage: Memory = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text || "",
                    url: tweet.permanentUrl || "",
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
                embedding: []
            };
            await this.client.saveRequestMessage(newMessage, state);
        }

        // Check if we should respond
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        // Generate and process response
        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        elizaLogger.debug("Interactions prompt:\n" + context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        response.inReplyTo = stringId;
        response.text = removeQuotes(response.text);

        if (response.text) {
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const memories = await sendTweet(
                        this.client,
                        response,
                        message.roomId,
                        this.client.twitterConfig.TWITTER_USERNAME,
                        tweet.id!
                    );
                    return memories;
                };

                const responseMessages = await callback(response);

                state = (await this.runtime.updateRecentMessageState(
                    state
                )) as State;

                for (const responseMessage of responseMessages) {
                    if (
                        responseMessage ===
                        responseMessages[responseMessages.length - 1]
                    ) {
                        responseMessage.content.action = response.action;
                    } else {
                        responseMessage.content.action = "CONTINUE";
                    }
                    await this.runtime.messageManager.createMemory(
                        responseMessage
                    );
                }

                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${
                    tweet.id
                } - ${
                    tweet.username || "unknown"
                }: ${
                    tweet.text || ""
                }\nAgent's Output:\n${response.text || ""}`;

                await this.runtime.cacheManager.set(
                    `twitter/tweet_generation_${tweet.id}.txt`,
                    responseInfo
                );
                await wait();
            } catch (error) {
                elizaLogger.error(`Error sending response tweet: ${error}`);
            }
        }

        // Handle transfer requests specifically
        if (isTransferRequest(message.content.text)) {
            elizaLogger.log("Transfer request detected:", {
                tweetId: tweet.id,
                text: message.content.text,
                from: tweet.username
            });

            try {
                message.content.action = "transfer";
                const state = await this.runtime.composeState(message, {
                    twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
                    currentPost: formatTweet(tweet),
                    formattedConversation: thread
                        .map((t) => `@${t.username}: ${t.text}`)
                        .join("\n\n"),
                });

                elizaLogger.log("Transfer state composed:", {
                    action: state.content?.action,
                    text: state.content?.text
                });

                const result = await this.runtime.processActions(
                    message,
                    [message],
                    state
                );

                elizaLogger.log("Transfer action result:", result);
            } catch (error) {
                elizaLogger.error("Transfer processing error:", {
                    error,
                    tweetId: tweet.id,
                    text: message.content.text
                });
            }
        }
    }
    async buildConversationThread(
        tweet: Tweet,
        maxReplies: number = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth: number = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            elizaLogger.debug("Current thread state:", {
                length: thread.length,
                currentDepth: depth,
                tweetId: currentTweet.id,
            });

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        elizaLogger.debug("Final thread built:", {
            totalTweets: thread.length,
            tweetIds: thread.map((t) => ({
                id: t.id,
                text: t.text?.slice(0, 50),
            })),
        });

        return thread;
    }
}
