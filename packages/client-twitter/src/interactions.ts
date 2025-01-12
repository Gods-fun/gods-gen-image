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
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils";

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

// Add helper function to check for transfer requests
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
            // Debug log the search query
            const searchQuery = `@${twitterUsername} from:0x_sero`;
            elizaLogger.log("Search query:", searchQuery);

            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    searchQuery,
                    20,
                    SearchMode.Latest
                )
            ).tweets as Tweet[];

            // Add detailed logging for each tweet
            elizaLogger.log("Raw mentions received:", mentionCandidates.map(t => ({
                id: t.id,
                author: t.username,
                text: t.text?.substring(0, 50) + "..."
            })));

            // Make username check case-insensitive and prioritize transfer requests
            const tweetCandidates = mentionCandidates
                .filter(tweet => {
                    const isValidTweet = 
                        typeof tweet.id === 'string' && 
                        typeof tweet.userId === 'string' &&
                        tweet.text &&
                        tweet.timestamp &&
                        tweet.username?.toLowerCase() === '0x_sero'; // Case-insensitive comparison

                    if (!isValidTweet) {
                        elizaLogger.log("Filtered out tweet:", {
                            id: tweet.id,
                            author: tweet.username,
                            reason: tweet.username?.toLowerCase() !== '0x_sero' ? 
                                "Wrong author" : "Invalid tweet structure"
                        });
                    }
                    
                    return isValidTweet;
                })
                .sort((a, b) => a.id!.localeCompare(b.id!));

            // Add early return if no valid tweets to process
            if (tweetCandidates.length === 0) {
                elizaLogger.log("No valid tweets to process from 0x_sero");
                return;
            }

            // Process each tweet through the normal handleTweet flow
            for (const tweet of tweetCandidates) {
                const thread = await buildConversationThread(tweet, this.client, 1);
                
                const message: Memory = {
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    content: { 
                        text: tweet.text || "",
                        // Let handleTweet determine if it's a transfer
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
            }
        } catch (error) {
            elizaLogger.error("Error in handleTwitterInteractions:", error);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
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

        // Check for transfer request early
        const isTransfer = isTransferRequest(message.content.text);
        if (isTransfer) {
            elizaLogger.log("Transfer request detected in tweet:", tweet.id);
            message.content.action = "transfer";
        }

        // Log the message content before processing
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

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

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

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

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

        // Add specific logging for transfer requests
        if (isTransferRequest(message.content.text)) {
            elizaLogger.log("Transfer request detected:", {
                tweetId: tweet.id,
                text: message.content.text,
                from: tweet.username
            });
            
            try {
                // Ensure transfer action is properly set
                message.content.action = "transfer";
                
                // Log the state composition
                const state = await this.runtime.composeState(message, {
                    twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
                    currentPost: formatTweet(tweet),
                    formattedConversation: thread
                        .map((t) => `@${t.username}: ${t.text}`)
                        .join("\n\n"),
                });
                
                elizaLogger.log("Transfer state composed:", {
                    // @ts-ignore
                    action: state.content.action,
                    // @ts-ignore
                    text: state.content.text
                });

                // Process the transfer
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

    private async buildConversationThread(tweet: Tweet, maxReplies: number = 10): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        const processThread = async (currentTweet: Tweet, depth: number = 0) => {
            if (!currentTweet?.id || depth >= maxReplies) {
                return;
            }

            if (visited.has(currentTweet.id)) {
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            if (currentTweet.inReplyToStatusId) {
                try {
                    const parentTweet = await this.client.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        await processThread(parentTweet, depth + 1);
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            }
        };

        await processThread(tweet, 0);
        return thread;
    }
}
