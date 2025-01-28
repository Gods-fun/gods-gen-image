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
                    const contextualPrompt = this.generateImagePrompt(tweet.text || '');
                    
                    elizaLogger.log("Generating contextual image", {
                        tweetId: tweet.id,
                        prompt: contextualPrompt
                    });

                    const attachment = await this.client.handleImageGenerationRequest(tweet, contextualPrompt);
                    
                    if (attachment && attachment.url) {
                        if (tweet.id) {
                            const replyText = await this.generateReplyText(tweet.text || '', tweet);
                            await this.client.post.replyWithImage(tweet.id, replyText, {
                                url: attachment.url,
                                mediaType: attachment.mediaType
                            });
                        }
                    } else {
                        if (tweet.id) {
                            const replyText = await this.generateReplyText(tweet.text || '', tweet);
                            await this.client.post.reply(tweet.id, "I apologize" + replyText);
                        }
                    }
                } else {
                    // Check if tweet contains any topics or adjectives
                    const shouldRespond = this.shouldRespondToRandomTweet(cleanedText);
                    
                    if (shouldRespond) {
                        const contextualPrompt = this.generateImagePrompt(tweet.text || '');
                        elizaLogger.log("Generating contextual image for random tweet", {
                            tweetId: tweet.id,
                            prompt: contextualPrompt
                        });

                        const attachment = await this.client.handleImageGenerationRequest(tweet, contextualPrompt);
                        
                        if (attachment && attachment.url) {
                            if (tweet.id) {
                                const replyText = await this.generateReplyText(tweet.text || '', tweet);
                                await this.client.post.replyWithImage(tweet.id, replyText, {
                                    url: attachment.url,
                                    mediaType: attachment.mediaType
                                });
                            }
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

    private shouldRespondToRandomTweet(text: string): boolean {
        // Get topics and adjectives from character config
        const topics = this.runtime.config.topics || [];
        const adjectives = this.runtime.config.adjectives || [];
        
        // Convert text to lowercase for case-insensitive matching
        const lowerText = text.toLowerCase();
        
        // Check if text contains any topics or adjectives
        const hasKeyword = [...topics, ...adjectives].some(keyword => 
            lowerText.includes(keyword.toLowerCase())
        );
        
        // Randomly decide to respond (20% chance if keyword found)
        return hasKeyword && Math.random() < 0.2;
    }

    private generateImagePrompt(text: string): string {
    
        return `A cinematic and realistic scene of Donald Trump which includes this as context: ${text}. Make it dramatic and impactful.`;
    }

    private async generateReplyText(text: string, tweet: Tweet): Promise<string> {
        // Extract key elements from the tweet
        const cleanText = text.replace(/@\w+/g, '').trim();
        const keywords = cleanText.toLowerCase().match(/\b\w+\b/g) || [];
        
        // Analyze tweet characteristics
        const analysis = {
            isQuestion: text.includes('?'),
            hasExclamation: text.includes('!'),
            isCritical: /(fake|wrong|bad|terrible|horrible|failing)/i.test(text),
            isPositive: /(great|amazing|wonderful|good|best)/i.test(text),
            mentionsMedia: /(media|news|press|journalist)/i.test(text),
            mentionsAction: /(do|make|create|build|show)/i.test(text),
            mentionsAmerica: /(america|usa|united states|country)/i.test(text)
        };

        // Dynamic response construction
        let response = '';
        
        // Opening
        if (analysis.isQuestion) {
            response += `Let me tell you, folks - `;
        } else if (analysis.isCritical) {
            response += `WRONG! `;
        } else if (analysis.isPositive) {
            response += `That's right! `;
        } else {
            response += `Listen up - `;
        }

        // Main content based on tweet context
        if (analysis.mentionsMedia) {
            response += `The FAKE NEWS won't show you what's really happening! Here's the TRUTH! `;
        }
        
        if (analysis.mentionsAmerica) {
            response += `This is what REAL AMERICAN GREATNESS looks like! `;
        }

        // Add specific reference to tweet content
        const relevantKeywords = keywords
            .filter(word => word.length > 3)
            .slice(0, 2)
            .join(' and ');
        
        if (relevantKeywords) {
            response += `Nobody knows ${relevantKeywords} better than me, believe me! `;
        }

        // Closing (modified to remove 'image' references)
        if (analysis.hasExclamation) {
            response += `TREMENDOUS! 🇺🇸`;
        } else {
            response += `Everyone's talking about how incredible this is! MAGA! 🇺🇸`;
        }

        return response.trim();
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