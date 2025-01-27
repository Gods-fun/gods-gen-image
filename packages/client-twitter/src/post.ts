import { IAgentRuntime, elizaLogger, stringToUuid, Memory } from "@elizaos/core";
import { Scraper, Tweet as TwitterApiTweet } from "agent-twitter-client";
import { TwitterConfig } from "./environment";
import { ClientBase } from "./base";

interface ImageAttachment {
    data?: Buffer;
    url?: string;
    mediaType: string;
    description?: string;
}

interface TweetOptions {
    text: string;
    replyToId?: string;
    imageAttachments?: ImageAttachment[];
    isThread?: boolean;
    isNoteTweet?: boolean;
    quoteTweetId?: string;
}

// Public interface for accessing protected properties
interface TwitterClientAccess {
    getTwitterConfig(): TwitterConfig;
    getTwitterClient(): Scraper;
    getProfile(): any;
}

export class TwitterPostClient {
    private client: ClientBase & TwitterClientAccess;
    private runtime: IAgentRuntime;
    private twitterUsername: string;
    private isDryRun: boolean = false;
    private lastPostTime: number = 0;

    constructor(client: ClientBase & TwitterClientAccess, runtime: IAgentRuntime, isDryRun: boolean = false) {
        elizaLogger.log("Initializing TwitterPostClient...");
        elizaLogger.log("Client configuration:", {
            twitterConfig: client.getTwitterConfig(),
            isDryRun: isDryRun
        });

        this.client = client;
        this.runtime = runtime;
        this.isDryRun = isDryRun;
        
        // Get username from config
        this.twitterUsername = this.client.getTwitterConfig().TWITTER_USERNAME;
        elizaLogger.log("Twitter username set from config:", this.twitterUsername);

        if (!this.twitterUsername) {
            elizaLogger.error("Twitter username is missing from configuration");
            throw new Error("Twitter username is required");
        }

        elizaLogger.log("TwitterPostClient initialization completed", {
            isDryRun: this.isDryRun,
            username: this.twitterUsername
        });
    }

    private async fetchImageBuffer(url: string): Promise<Buffer> {
        elizaLogger.log("Fetching image from URL:", url);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                elizaLogger.error("Failed to fetch image", {
                    url,
                    status: response.status,
                    statusText: response.statusText
                });
                throw new Error(`Failed to fetch image: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            elizaLogger.log("Successfully fetched image", {
                url,
                size: arrayBuffer.byteLength
            });
            return Buffer.from(arrayBuffer);
        } catch (error) {
            elizaLogger.error("Error fetching image from URL", {
                url,
                error: error instanceof Error ? error.message : "Unknown error"
            });
            throw error;
        }
    }

    private async prepareImageAttachments(attachments: ImageAttachment[]): Promise<{data: Buffer; mediaType: string}[]> {
        elizaLogger.log("Preparing image attachments", {
            count: attachments.length
        });
        
        const preparedAttachments = await Promise.all(
            attachments.map(async (attachment, index) => {
                elizaLogger.log(`Processing attachment ${index + 1}/${attachments.length}`, {
                    hasData: !!attachment.data,
                    hasUrl: !!attachment.url,
                    mediaType: attachment.mediaType
                });

                let imageData: Buffer;
                if (attachment.data) {
                    elizaLogger.log("Using provided image data");
                    imageData = attachment.data;
                } else if (attachment.url) {
                    elizaLogger.log("Fetching image from URL");
                    imageData = await this.fetchImageBuffer(attachment.url);
                } else {
                    elizaLogger.error("Invalid attachment - missing both data and url");
                    throw new Error("Image attachment must have either data or url");
                }
                return {
                    data: imageData,
                    mediaType: attachment.mediaType
                };
            })
        );
        
        elizaLogger.log("Image attachments prepared successfully", {
            count: preparedAttachments.length
        });
        return preparedAttachments;
    }

    async postTweet(options: TweetOptions): Promise<void> {
        if (!options.text) {
            throw new Error("Tweet text is required");
        }

        // Rate limiting: Ensure at least 2 seconds between posts
        const now = Date.now();
        const timeSinceLastPost = now - this.lastPostTime;
        if (timeSinceLastPost < 2000) {
            await new Promise(resolve => setTimeout(resolve, 2000 - timeSinceLastPost));
        }

        try {
            elizaLogger.debug("Posting tweet", {
                text: options.text,
                replyToId: options.replyToId,
                quoteTweetId: options.quoteTweetId,
                isThread: options.isThread,
                isNoteTweet: options.isNoteTweet,
                hasImages: options.imageAttachments?.length ?? 0
            });

            if (this.isDryRun) {
                elizaLogger.info("Dry run mode - would have posted:", options);
                return;
            }

            let preparedAttachments: {data: Buffer; mediaType: string}[] | undefined;
            if (options.imageAttachments?.length) {
                elizaLogger.log("Preparing attachments for tweet");
                preparedAttachments = await this.prepareImageAttachments(options.imageAttachments);
                elizaLogger.log("Attachments prepared successfully", {
                    count: preparedAttachments.length
                });
            }

            elizaLogger.log("Sending tweet to Twitter API", {
                hasAttachments: !!preparedAttachments?.length,
                replyToId: options.replyToId,
                quoteTweetId: options.quoteTweetId
            });

            let response;
            if (options.quoteTweetId) {
                response = await this.client.getTwitterClient().sendQuoteTweet(
                    options.text,
                    options.quoteTweetId,
                    { mediaData: preparedAttachments ?? [] }
                );
            } else if (options.isNoteTweet) {
                response = await this.client.getTwitterClient().sendNoteTweet(
                    options.text,
                    options.replyToId,
                    preparedAttachments
                );
            } else {
                response = await this.client.getTwitterClient().sendTweet(
                    options.text,
                    options.replyToId,
                    preparedAttachments
                );
            }

            const result = await response.json();
            if (!result.data?.id) {
                throw new Error("Failed to post tweet: Invalid response");
            }

            elizaLogger.log("Tweet posted successfully to Twitter API", {
                tweetId: result.data.id
            });

            const tweet: TwitterApiTweet = {
                id: result.data.id,
                text: result.data.text,
                username: this.twitterUsername,
                userId: this.client.getProfile()?.id || '',
                timestamp: Date.now() / 1000,
                conversationId: result.data.id,
                permanentUrl: `https://twitter.com/${this.twitterUsername}/status/${result.data.id}`,
                inReplyToStatusId: options.replyToId,
                name: this.client.getProfile()?.screenName || this.twitterUsername,
                hashtags: [],
                mentions: [],
                photos: options.imageAttachments?.map(img => ({
                    id: '',
                    url: img.url || '',
                    alt_text: img.description || ''
                })) || [],
                thread: [],
                urls: [],
                videos: []
            };

            await this.cacheTweetDetails(tweet);
            this.lastPostTime = Date.now();

            elizaLogger.log("Tweet details cached", {
                tweetId: tweet.id,
                url: tweet.permanentUrl
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            elizaLogger.error("Failed to post tweet", { error: errorMessage });
            throw error;
        }
    }

    async reply(tweetId: string, content: string): Promise<void> {
        await this.postTweet({
            text: content,
            replyToId: tweetId
        });
    }

    async replyWithImage(tweetId: string, content: string, image: ImageAttachment): Promise<void> {
        await this.postTweet({
            text: content,
            replyToId: tweetId,
            imageAttachments: [image]
        });
    }

    private async cacheTweetDetails(tweet: TwitterApiTweet): Promise<void> {
        const profile = this.client.getProfile();
        if (!profile?.username) {
            elizaLogger.warn("Cannot cache tweet details: Client profile not initialized");
            return;
        }

        const roomId = stringToUuid(`tweet-${tweet.id}`);
        
        try {
            await this.runtime.cacheManager.set(
                `twitter/${profile.username}/lastPost`,
                {
                    id: tweet.id,
                    timestamp: tweet.timestamp,
                    text: tweet.text
                }
            );

            const memory: Memory = {
                id: stringToUuid(`${tweet.id}-${this.runtime.agentId}`),
                userId: this.runtime.agentId,
                content: {
                    text: tweet.text || '',
                    url: tweet.permanentUrl,
                    source: "twitter"
                },
                roomId,
                embedding: [],
                createdAt: tweet.timestamp ? new Date(tweet.timestamp * 1000).getTime() : Date.now(),
                agentId: this.runtime.agentId
            };

            await this.runtime.messageManager.createMemory(memory);

            elizaLogger.debug("Tweet details cached successfully", { tweetId: tweet.id });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            elizaLogger.error("Error caching tweet details", { error: errorMessage });
        }
    }

    async start(): Promise<void> {
        elizaLogger.log("Starting Twitter post client");
        if (!this.twitterUsername) {
            this.twitterUsername = this.client.getProfile()?.username ?? '';
            elizaLogger.log("Updated Twitter username", { username: this.twitterUsername });
        }
        elizaLogger.log("Twitter post client started successfully");
    }
}