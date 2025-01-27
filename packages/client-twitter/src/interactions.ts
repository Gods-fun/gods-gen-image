import { SearchMode, Tweet } from "agent-twitter-client";
import {
    messageCompletionFooter,
    shouldRespondFooter,
    IAgentRuntime,
    State,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "./base";
import type { TwitterPostClient } from "./post";

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
        this.pollInterval = 120;
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

                const cleanedText = tweet.text?.toLowerCase().trim() || '';
                const isMention = cleanedText.includes(`@${this.client.getTwitterConfig().TWITTER_USERNAME.toLowerCase()}`);
                
                if (isMention) {
                    // Handle mentions/replies with contextual Trump image
                    const contextualPrompt = `Generate a cinematic and realistic image of donald trump ${this.generateContextualPrompt(tweet.text || '')}`;
                    
                    elizaLogger.log("Generating contextual Trump image", {
                        tweetId: tweet.id,
                        prompt: contextualPrompt
                    });

                    const attachment = await this.client.handleImageGenerationRequest(tweet, contextualPrompt);
                    
                    if (attachment && attachment.url) {
                        if (tweet.id) {
                            await this.client.post.replyWithImage(tweet.id, this.generateReplyText(tweet.text || ''), {
                                url: attachment.url,
                                mediaType: attachment.mediaType
                            });
                        }
                    } else {
                        if (tweet.id) {
                            await this.client.post.reply(tweet.id, "I apologize, but I couldn't generate an image at this time. Let me respond anyway: " + this.generateReplyText(tweet.text || ''));
                        }
                    }
                } else {
                    // For new posts, use the default Trump prompt
                    const defaultPrompt = "Generate a cinematic and realistic image of donald trump looking over a crowd, doing something interesting.";
                    const attachment = await this.client.handleImageGenerationRequest(tweet, defaultPrompt);
                    
                    if (attachment && attachment.url) {
                        if (tweet.id) {
                            await this.client.post.replyWithImage(tweet.id, tweet.text || '', {
                                url: attachment.url,
                                mediaType: attachment.mediaType
                            });
                        }
                    }
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

    private generateContextualPrompt(text: string): string {
        // Remove mentions and common words to extract context
        const cleanText = text
            .replace(/@\w+/g, '')
            .replace(/generate|image|please|can you/gi, '')
            .trim();
        
        // If no specific context, return a default action
        if (!cleanText) {
            return "addressing a crowd with a powerful gesture";
        }
        
        return cleanText;
    }

    private generateReplyText(text: string): string {
        // Analyze the tweet content to determine the appropriate response type
        const isQuestion = text.includes('?');
        const isRequest = /please|can you|could you/i.test(text);
        const isCriticism = /(fake|wrong|bad|terrible|horrible|failing)/i.test(text);
        
        // Collection of authentic Trump-style responses
        const responses = [
            // General enthusiasm responses
            "Tremendous image, folks! Nobody's ever seen anything like it. AMAZING!",
            "This is what TRUE leadership looks like. The fake news media won't show you this!",
            "Many people are saying this is the most beautiful image they've ever seen. And they're right!",
            "We're doing things nobody thought possible. Just look at this masterpiece!",
            "The radical left doesn't want you to see this. But we're showing it anyway. Beautiful!",
            
            // Question/Request responses
            "Ask and you shall receive! Nobody delivers like we do. NOBODY!",
            "When you want something done right, you come to me. Look at this masterpiece!",
            "You asked for it, and I delivered BIG TIME! That's what real leaders do!",
            
            // Criticism handling
            "While the haters and losers spread FAKE NEWS, we keep winning! Look at this!",
            "They said it couldn't be done. WRONG! We did it, and it's BEAUTIFUL!",
            "The fake news media is in total meltdown. Meanwhile, we're creating MAGIC!"
        ];
        
        // Select appropriate response based on context
        let filteredResponses = responses;
        if (isQuestion || isRequest) {
            filteredResponses = responses.slice(5, 8);  // Use request-specific responses
        } else if (isCriticism) {
            filteredResponses = responses.slice(8);  // Use criticism-handling responses
        } else {
            filteredResponses = responses.slice(0, 5);  // Use general enthusiasm responses
        }
        
        // Return a random response from the filtered set
        return filteredResponses[Math.floor(Math.random() * filteredResponses.length)];
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