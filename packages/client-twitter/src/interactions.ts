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
import { TwitterConfig } from "./environment";
import type { TwitterPostClient } from "./post";
import { TwitterProfile } from "./types";

// Define interfaces for state content
interface StateContent {
    action?: string;
    text?: string;
}

interface ExtendedState extends State {
    content?: StateContent;
}

interface ImageAttachment {
    url: string;
    mediaType?: string;
}

interface TwitterClientAccess {
    getTwitterConfig(): {
        TWITTER_USERNAME: string;
        TWITTER_POLL_INTERVAL?: number;
    };
    getTwitterClient(): any;
    getProfile(): any;
    handleImageGenerationRequest(tweet: Tweet, prompt: string): Promise<ImageAttachment | null>;
}

// Use type instead of interface to avoid protected property inheritance issues
type ExtendedClientBase = ClientBase & {
    processedTweets: Set<string>;
    post: TwitterPostClient & {
        reply(tweetId: string, content: string): Promise<void>;
        replyWithImage(tweetId: string, content: string, image: ImageAttachment): Promise<void>;
    };
};

interface ExtendedRuntime extends IAgentRuntime {
    actionManager: {
        handleAction: Function;
    };
}

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

// Template for determining when the agent should respond
export const twitterShouldRespondTemplate = () =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation.

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULES:
- ALWAYS RESPOND to image generation requests
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

// Helper function to identify image generation requests
const isImageGenerationRequest = (text: string): boolean => {
    const imageKeywords = [
        'generate image',
        'create image',
        'make image',
        'draw',
        'picture',
        'generate a',
        'create a',
        'make a',
        'show me',
        'can you make',
        'can you create',
        'can you generate'
    ];
    const lowerText = text.toLowerCase();
    return imageKeywords.some(keyword => lowerText.includes(keyword));
};

interface ActionResponse {
    text?: string;
    attachments?: Array<{
        url: string;
        contentType?: string;
        description?: string;
    }>;
}

// Remove duplicate interface definitions
export class TwitterInteractionClient {
    private client: ExtendedClientBase;
    private runtime: ExtendedRuntime;
    private processedTweets: Set<string> = new Set();
    private pollInterval: number;
    private isProcessingActions: boolean = false;
    private processingTimer: NodeJS.Timeout | null = null;

    constructor(client: ExtendedClientBase, runtime: ExtendedRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.pollInterval = client.getTwitterConfig().TWITTER_POLL_INTERVAL * 1000;
        elizaLogger.log("TwitterInteractionClient initialized", {
            pollInterval: this.pollInterval,
            username: client.getTwitterConfig().TWITTER_USERNAME
        });
    }

    async start(): Promise<void> {
        elizaLogger.log("Starting Twitter interaction polling with interval:", this.pollInterval);
        
        // Start processing in the background
        this.processingTimer = setInterval(() => {
            if (!this.isProcessingActions) {
                this.handleTwitterInteractions().catch(error => {
                    elizaLogger.error("Error in Twitter interaction processing:", error);
                });
            }
        }, this.pollInterval);

        elizaLogger.log("Twitter interaction polling started", {
            pollIntervalMs: this.pollInterval,
            startTime: new Date().toISOString()
        });
    }

    private async handleTwitterInteractions(): Promise<void> {
        if (this.isProcessingActions) {
            elizaLogger.debug("Already processing actions, skipping this cycle");
            return;
        }

        this.isProcessingActions = true;
        elizaLogger.log("Starting Twitter interactions check");

        try {
            const username = this.client.getTwitterConfig().TWITTER_USERNAME;
            const searchQuery = `@${username}`;
            elizaLogger.log("Search query:", searchQuery);

            const searchResults = await this.client.getTwitterClient().fetchSearchTweets(
                searchQuery,
                20,
                SearchMode.Latest
            );

            elizaLogger.log("Raw search results received", {
                totalTweets: searchResults.tweets.length,
                query: searchQuery,
                timestamp: new Date().toISOString()
            });

            // Log raw tweet data for debugging
            searchResults.tweets.forEach(tweet => {
                elizaLogger.debug("Raw tweet data:", {
                    id: tweet.id,
                    text: tweet.text,
                    username: tweet.username,
                    timestamp: tweet.timestamp,
                    inReplyToStatusId: tweet.inReplyToStatusId
                });
            });

            await this.processTweets(searchResults.tweets);
        } catch (error) {
            elizaLogger.error("Error processing Twitter interactions:", {
                error: error instanceof Error ? error.message : "Unknown error",
                stack: error instanceof Error ? error.stack : undefined
            });
        } finally {
            this.isProcessingActions = false;
        }
    }

    private async processTweets(tweets: Tweet[]): Promise<void> {
        elizaLogger.log("Processing tweets", {
            count: tweets.length,
            timestamp: new Date().toISOString()
        });

        for (const tweet of tweets) {
            try {
                elizaLogger.log("Processing tweet", {
                    id: tweet.id,
                    username: tweet.username,
                    text: tweet.text,
                    timestamp: tweet.timestamp ? new Date(tweet.timestamp * 1000).toISOString() : undefined
                });

                // Analyze tweet text for image generation request
                const cleanedText = tweet.text?.toLowerCase().trim() || '';
                const containsGenerate = cleanedText.includes('generate');
                const containsImage = cleanedText.includes('image');
                
                elizaLogger.log("Tweet text analysis", {
                    tweetId: tweet.id,
                    originalText: tweet.text,
                    cleanedText,
                    containsGenerate,
                    containsImage,
                    mentionsBot: cleanedText.includes(`@${this.client.getTwitterConfig().TWITTER_USERNAME.toLowerCase()}`),
                    isReply: !!tweet.inReplyToStatusId
                });

                if (containsGenerate && containsImage) {
                    // Extract prompt by removing mentions and commands
                    const prompt = tweet.text
                        ?.replace(/@\w+/g, '')
                        .replace(/generate\s+image/i, '')
                        .trim();

                    elizaLogger.log("Image generation request detected", {
                        tweetId: tweet.id,
                        originalText: tweet.text,
                        extractedPrompt: prompt,
                        username: tweet.username
                    });

                    // Generate image
                    const attachment = await this.client.handleImageGenerationRequest(tweet, prompt || '');
                    
                    if (attachment && attachment.url) {
                        elizaLogger.log("Image generated successfully", {
                            tweetId: tweet.id,
                            hasUrl: true,
                            mediaType: attachment.mediaType
                        });

                        if (tweet.id) {
                            // Post reply with image using the post client
                            await this.client.post.replyWithImage(tweet.id, "Here's your generated image! 🎨", {
                                url: attachment.url,
                                mediaType: attachment.mediaType
                            });

                            elizaLogger.log("Reply posted successfully", {
                                tweetId: tweet.id,
                                type: 'image_reply'
                            });
                        } else {
                            elizaLogger.error("Cannot reply - tweet ID is missing");
                        }
                    } else {
                        elizaLogger.warn("Image generation failed", {
                            tweetId: tweet.id
                        });

                        if (tweet.id) {
                            // Post error reply
                            await this.client.post.reply(tweet.id, "Sorry, I couldn't generate the image at this time. Please try again later.");

                            elizaLogger.log("Error reply posted", {
                                tweetId: tweet.id,
                                type: 'error_reply'
                            });
                        } else {
                            elizaLogger.error("Cannot reply - tweet ID is missing");
                        }
                    }
                } else {
                    elizaLogger.log("Tweet is not an image generation request", {
                        tweetId: tweet.id,
                        text: tweet.text,
                        containsGenerate,
                        containsImage
                    });
                }
            } catch (error) {
                elizaLogger.error("Error handling tweet", {
                    error: error instanceof Error ? error.message : "Unknown error",
                    tweetId: tweet.id,
                    stack: error instanceof Error ? error.stack : undefined
                });
            }
        }
    }

    stop(): void {
        elizaLogger.log("Stopping Twitter interaction client");
        if (this.processingTimer) {
            clearInterval(this.processingTimer);
            this.processingTimer = null;
        }
        this.isProcessingActions = false;
        elizaLogger.log("Twitter interaction client stopped");
    }
}