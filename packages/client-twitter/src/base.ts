import {
    Content,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    State,
    UUID,
    getEmbeddingZeroVector,
    elizaLogger,
    stringToUuid,
    generateImage
} from "@elizaos/core";
import {
    QueryTweetsResponse,
    Scraper,
    SearchMode,
    Tweet
} from "agent-twitter-client";
import { EventEmitter } from "events";
import { TwitterConfig } from "./environment";
import { TwitterPostClient } from "./post";
import { TwitterClientAccess, RequestQueue, TwitterProfile } from "./types";

interface ImageAttachment {
    data?: Buffer;
    url?: string;
    mediaType: string;
    description?: string;
}

interface ImageGenerationError {
    message: string;
    details?: {
        success?: boolean;
        hasData?: boolean;
        error?: any;
        rawResult?: any;
    };
}

interface TwitterApiTweet {
    __typename?: string;
    id?: string;
    rest_id?: string;
    name?: string;
    username?: string;
    text?: string;
    legacy?: {
        created_at: string;
        full_text: string;
        in_reply_to_status_id_str?: string;
        user_id_str: string;
        conversation_id_str: string;
        entities: {
            hashtags: any[];
            user_mentions: any[];
            urls: any[];
            media?: {
                type: string;
                id_str: string;
                media_url_https: string;
                alt_text?: string;
            }[];
        };
    };
    core?: {
        user_results?: {
            result?: {
                legacy?: {
                    name: string;
                    screen_name: string;
                    created_at: string;
                };
            };
        };
    };
    thread?: any[];
}

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

export class ClientBase extends EventEmitter implements TwitterClientAccess {
    static _twitterClients: { [accountIdentifier: string]: Scraper } = {};
    protected twitterClient: Scraper;
    protected twitterConfig: TwitterConfig;
    protected runtime: IAgentRuntime;
    protected profile: TwitterProfile | null = null;
    protected initializationTime: number;
    protected requestQueue: RequestQueue;
    protected processedTweets = new Set<string>();
    protected directions: string;
    protected lastCheckedTweetId: bigint | null = null;
    protected imageDescriptionService: IImageDescriptionService | null = null;
    protected temperature: number = 0.5;
    protected postClient!: TwitterPostClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        super();
        elizaLogger.log("Initializing ClientBase", {
            username: twitterConfig.TWITTER_USERNAME,
            searchEnabled: twitterConfig.TWITTER_SEARCH_ENABLE,
            pollInterval: twitterConfig.TWITTER_POLL_INTERVAL
        });

        this.twitterConfig = twitterConfig;
        this.runtime = runtime;
        this.initializationTime = Date.now();
        this.requestQueue = new RequestQueue();
        this.directions = "";

        const accountIdentifier = `${twitterConfig.TWITTER_USERNAME}:${twitterConfig.TWITTER_PASSWORD}`;
        elizaLogger.log("Checking for existing Twitter client instance");

        if (ClientBase._twitterClients[accountIdentifier]) {
            elizaLogger.log("Using existing Twitter client instance", {
                username: twitterConfig.TWITTER_USERNAME,
                instanceExists: true
            });
            this.twitterClient = ClientBase._twitterClients[accountIdentifier];
        } else {
            elizaLogger.log("Creating new Twitter client instance", {
                username: twitterConfig.TWITTER_USERNAME
            });
            this.twitterClient = new Scraper() as any;
            (this.twitterClient as any).credentials = {
                username: twitterConfig.TWITTER_USERNAME,
                password: twitterConfig.TWITTER_PASSWORD
            };
            ClientBase._twitterClients[accountIdentifier] = this.twitterClient;
            elizaLogger.log("Twitter client credentials stored", {
                username: twitterConfig.TWITTER_USERNAME
            });
        }

        elizaLogger.log("ClientBase initialization completed", {
            username: twitterConfig.TWITTER_USERNAME,
            hasClient: !!this.twitterClient,
            initTime: new Date(this.initializationTime).toISOString()
        });
    }

    protected async initializeProfile(): Promise<void> {
        elizaLogger.log("Initializing Twitter profile");
        try {
            // Set basic profile info from config
            const name = this.twitterConfig.TWITTER_USERNAME;
            this.profile = {
                id: "",  // We don't have this yet
                username: name,
                name: name,
                screenName: name,
                bio: "",  // We don't have this yet
                nicknames: [name],
                followersCount: 0,  // We don't have this yet
                followingCount: 0,  // We don't have this yet
                tweetsCount: 0,     // We don't have this yet
                isVerified: false   // We don't have this yet
            };
            elizaLogger.log("Profile initialization completed with basic info");
        } catch (error) {
            elizaLogger.error("Failed to initialize profile", {
                error: error instanceof Error ? error.message : "Unknown error"
            });
            throw error;
        }
    }

    async init(): Promise<void> {
        try {
            elizaLogger.log("Starting Twitter client initialization");

            elizaLogger.log("Creating new Twitter client instance");
            this.twitterClient = new Scraper();

            elizaLogger.log("Attempting Twitter login", {
                username: this.twitterConfig.TWITTER_USERNAME,
                has2FA: !!this.twitterConfig.TWITTER_2FA_SECRET
            });

            await this.twitterClient.login(
                this.twitterConfig.TWITTER_USERNAME,
                this.twitterConfig.TWITTER_PASSWORD,
                this.twitterConfig.TWITTER_EMAIL,
                this.twitterConfig.TWITTER_2FA_SECRET
            );

            elizaLogger.log("Twitter login successful", {
                username: this.twitterConfig.TWITTER_USERNAME
            });

            elizaLogger.log("Fetching Twitter profile");
            const profile = await this.twitterClient.getProfile(this.twitterConfig.TWITTER_USERNAME);
            
            if (!profile) {
                elizaLogger.error("Failed to fetch Twitter profile", {
                    username: this.twitterConfig.TWITTER_USERNAME
                });
                throw new Error("Failed to fetch Twitter profile");
            }

            elizaLogger.log("Profile fetched successfully", {
                username: profile.username,
                followersCount: profile.followersCount,
                followingCount: profile.followingCount,
                tweetsCount: profile.tweetsCount
            });

            const name = profile.name || profile.username || this.twitterConfig.TWITTER_USERNAME;
            this.profile = {
                id: profile.userId || '',
                username: profile.username || '',
                name: name,
                screenName: name,
                bio: profile.biography || '',
                nicknames: [name],
                followersCount: profile.followersCount,
                followingCount: profile.followingCount,
                tweetsCount: profile.tweetsCount,
                isVerified: profile.isVerified
            };

            elizaLogger.log("Profile initialized", {
                profile: {
                    username: this.profile.username,
                    followersCount: this.profile.followersCount,
                    tweetsCount: this.profile.tweetsCount
                }
            });

            this.emit('ready');
            elizaLogger.log("Twitter client fully initialized and ready");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            elizaLogger.error("Twitter client initialization failed", { 
                error: errorMessage,
                username: this.twitterConfig.TWITTER_USERNAME
            });
            throw error;
        }
    }

    async cacheTweet(tweet: Tweet): Promise<void> {
        if (!tweet) {
            elizaLogger.warn("Attempted to cache undefined tweet");
            return;
        }

        elizaLogger.log("Caching tweet", {
            tweetId: tweet.id,
            author: tweet.username
        });

        try {
            await this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
            elizaLogger.log("Tweet cached successfully", {
                tweetId: tweet.id
            });
        } catch (error) {
            elizaLogger.error("Failed to cache tweet", {
                tweetId: tweet.id,
                error: error instanceof Error ? error.message : "Unknown error"
            });
        }
    }

    async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
        elizaLogger.log("Fetching tweet from cache", {
            tweetId: tweetId
        });

        const cached = await this.runtime.cacheManager.get<Tweet>(
            `twitter/tweets/${tweetId}`
        );

        if (cached) {
            elizaLogger.log("Tweet found in cache", {
                tweetId: tweetId,
                author: cached.username
            });
        } else {
            elizaLogger.log("Tweet not found in cache", {
                tweetId: tweetId
            });
        }

        return cached;
    }

    async getTweet(tweetId: string): Promise<Tweet> {
        elizaLogger.log("Fetching tweet", {
            tweetId: tweetId
        });

        const cachedTweet = await this.getCachedTweet(tweetId);

        if (cachedTweet) {
            elizaLogger.log("Using cached tweet", {
                tweetId: tweetId
            });
            return cachedTweet;
        }

        elizaLogger.log("Fetching tweet from Twitter API", {
            tweetId: tweetId
        });

        try {
            const tweet = await this.requestQueue.add(() =>
                this.twitterClient.getTweet(tweetId)
            );

            if (!tweet) {
                elizaLogger.error("Tweet not found", {
                    tweetId: tweetId
                });
                throw new Error(`Failed to fetch tweet: ${tweetId}`);
            }

            elizaLogger.log("Tweet fetched successfully", {
                tweetId: tweetId,
                author: tweet.username
            });

            await this.cacheTweet(tweet);
            return tweet;
        } catch (error) {
            elizaLogger.error("Failed to fetch tweet", {
                tweetId: tweetId,
                error: error instanceof Error ? error.message : "Unknown error"
            });
            throw error;
        }
    }

    onReady(callback: (self: ClientBase) => any): void {
        this.once('ready', () => callback(this));
    }

    async fetchOwnPosts(count: number): Promise<Tweet[]> {
        elizaLogger.debug("fetching own posts");
        if (!this.profile?.id) {
            throw new Error("Profile not initialized");
        }
        const homeTimeline = await this.twitterClient.getUserTweets(
            this.profile.id,
            count
        );
        return homeTimeline.tweets;
    }

    /**
     * Fetch timeline for twitter account, optionally only from followed accounts
     */
    async fetchHomeTimeline(count: number, following?: boolean): Promise<Tweet[]> {
        elizaLogger.debug("fetching home timeline");
        const homeTimeline = following
            ? await this.twitterClient.fetchFollowingTimeline(count, [])
            : await this.twitterClient.fetchHomeTimeline(count, []);

        elizaLogger.debug(homeTimeline, { depth: Infinity });
        const processedTimeline = homeTimeline
            .filter((t) => t.__typename !== "TweetWithVisibilityResults") // what's this about?
            .map((tweet) => {
                //console.log("tweet is", tweet);
                const obj = {
                    id: tweet.id,
                    name:
                        tweet.name ?? tweet?.user_results?.result?.legacy.name,
                    username:
                        tweet.username ??
                        tweet.core?.user_results?.result?.legacy.screen_name,
                    text: tweet.text ?? tweet.legacy?.full_text,
                    inReplyToStatusId:
                        tweet.inReplyToStatusId ??
                        tweet.legacy?.in_reply_to_status_id_str ??
                        null,
                    timestamp:
                        new Date(tweet.legacy?.created_at).getTime() / 1000,
                    createdAt:
                        tweet.createdAt ??
                        tweet.legacy?.created_at ??
                        tweet.core?.user_results?.result?.legacy.created_at,
                    userId: tweet.userId ?? tweet.legacy?.user_id_str,
                    conversationId:
                        tweet.conversationId ??
                        tweet.legacy?.conversation_id_str,
                    permanentUrl: `https://x.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
                    hashtags: tweet.hashtags ?? tweet.legacy?.entities.hashtags,
                    mentions:
                        tweet.mentions ?? tweet.legacy?.entities.user_mentions,
                    photos: tweet.legacy?.entities?.media?.filter(
                            (media: any) => media.type === "photo"
                        ).map((media: any) => ({
                            id: media.id_str,
                            url: media.media_url_https,  // Store media_url_https as url
                            alt_text: media.alt_text
                        })) || [],
                    thread: tweet.thread || [],
                    urls: tweet.urls ?? tweet.legacy?.entities.urls,
                    videos:
                        tweet.videos ??
                        tweet.legacy?.entities.media?.filter(
                            (media: any) => media.type === "video"
                        ) ??
                        [],
                };
                //console.log("obj is", obj);
                return obj;
            });
        elizaLogger.debug("process homeTimeline", processedTimeline);
        return processedTimeline;
    }

    async fetchTimelineForActions(count: number): Promise<Tweet[]> {
        elizaLogger.debug("fetching timeline for actions");

        const agentUsername = this.twitterConfig.TWITTER_USERNAME
        const homeTimeline = await this.twitterClient.fetchHomeTimeline(
            count,
            []
        );

        return homeTimeline.map((tweet) => ({
            id: tweet.rest_id,
            name: tweet.core?.user_results?.result?.legacy?.name,
            username: tweet.core?.user_results?.result?.legacy?.screen_name,
            text: tweet.legacy?.full_text,
            inReplyToStatusId: tweet.legacy?.in_reply_to_status_id_str,
            timestamp: new Date(tweet.legacy?.created_at).getTime() / 1000,
            userId: tweet.legacy?.user_id_str,
            conversationId: tweet.legacy?.conversation_id_str,
            permanentUrl: `https://twitter.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
            hashtags: tweet.legacy?.entities?.hashtags || [],
            mentions: tweet.legacy?.entities?.user_mentions || [],
            photos: tweet.legacy?.entities?.media?.filter(
                (media: any) => media.type === "photo"
            ).map((media: any) => ({
                id: media.id_str,
                url: media.media_url_https,  // Store media_url_https as url
                alt_text: media.alt_text
                 })) || [],
            thread: tweet.thread || [],
            urls: tweet.legacy?.entities?.urls || [],
            videos:
                tweet.legacy?.entities?.media?.filter(
                    (media: any) => media.type === "video"
                ) || [],
        })).filter(tweet => tweet.username !== agentUsername); // do not perform action on self-tweets
    }

    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        searchMode: SearchMode,
        cursor?: string
    ): Promise<QueryTweetsResponse> {
        try {
            elizaLogger.log("Fetching search tweets", {
                query,
                maxTweets,
                searchMode,
                initTime: new Date(this.initializationTime).toISOString()
            });

            // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
            // if we dont get a response in 15 seconds, something is wrong
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve({ tweets: [] }), 15000)
            );

            try {
                const result = await this.requestQueue.add(
                    async () =>
                        await Promise.race([
                            this.twitterClient.fetchSearchTweets(
                                query,
                                maxTweets,
                                searchMode,
                                cursor
                            ),
                            timeoutPromise,
                        ])
                );

                // Filter out tweets from before initialization and already processed tweets
                const tweets = ((result ?? { tweets: [] }) as QueryTweetsResponse).tweets.filter(tweet => {
                    // Skip if no timestamp or ID
                    if (!tweet.timestamp || !tweet.id) {
                        elizaLogger.log("Skipping tweet without timestamp or ID", { tweetId: tweet.id });
                        return false;
                    }

                    // Skip if already processed
                    if (this.processedTweets.has(tweet.id)) {
                        elizaLogger.log("Skipping already processed tweet", { tweetId: tweet.id });
                        return false;
                    }

                    // Convert timestamp to milliseconds if needed
                    const tweetTimestamp = tweet.timestamp * 1000;
                    const isRecent = tweetTimestamp >= this.initializationTime;
                    
                    if (!isRecent) {
                        elizaLogger.log("Filtering out old tweet", {
                            tweetId: tweet.id,
                            tweetTime: new Date(tweetTimestamp).toISOString(),
                            initTime: new Date(this.initializationTime).toISOString(),
                            age: Math.round((Date.now() - tweetTimestamp) / 1000 / 60) + ' minutes'
                        });
                        return false;
                    }

                    // Mark as processed immediately
                    this.processedTweets.add(tweet.id);
                    return true;
                });

                elizaLogger.log("Filtered search results", {
                    totalTweets: ((result ?? { tweets: [] }) as QueryTweetsResponse).tweets.length,
                    recentTweets: tweets.length,
                    processedTweetsCount: this.processedTweets.size
                });

                return { tweets };
            } catch (error) {
                elizaLogger.error("Error fetching search tweets:", error);
                return { tweets: [] };
            }
        } catch (error) {
            elizaLogger.error("Error fetching search tweets:", error);
            return { tweets: [] };
        }
    }

    private async populateTimeline() {
        elizaLogger.debug("populating timeline...");

        const cachedTimeline = await this.getCachedTimeline();

        // Check if the cache file exists
        if (cachedTimeline) {
            // Read the cached search results from the file

            // Get the existing memories from the database
            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    roomIds: cachedTimeline.map((tweet) =>
                        stringToUuid(
                            tweet.conversationId + "-" + this.runtime.agentId
                        )
                    ),
                });

            //TODO: load tweets not in cache?

            // Create a Set to store the IDs of existing memories
            const existingMemoryIds = new Set<UUID>(
                existingMemories
                    .filter((memory): memory is Memory & { id: UUID } => memory.id !== undefined)
                    .map(memory => memory.id)
            );

            // Check if any of the cached tweets exist in the existing memories
            const someCachedTweetsExist = cachedTimeline.some((tweet) =>
                existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
            );

            if (someCachedTweetsExist) {
                // Filter out the cached tweets that already exist in the database
                const tweetsToSave = cachedTimeline.filter(
                    (tweet) =>
                        !existingMemoryIds.has(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        )
                );

                console.log({
                    processingTweets: tweetsToSave
                        .map((tweet) => tweet.id)
                        .join(","),
                });

                // Save the missing tweets as memories
                for (const tweet of tweetsToSave) {
                    elizaLogger.log("Saving Tweet", tweet.id);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const userId =
                        tweet.userId === this?.profile!.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    if (tweet.userId === this.profile!.id) {
                        await this.runtime.ensureConnection(
                            this.runtime.agentId,
                            roomId,
                            this.profile!.username,
                            this.profile!.screenName,
                            "twitter"
                        );
                    } else {
                        await this.runtime.ensureConnection(
                            userId,
                            roomId,
                            tweet.username,
                            tweet.name,
                            "twitter"
                        );
                    }

                    const content = {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(
                                  tweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    } as Content;

                    elizaLogger.log("Creating memory for tweet", tweet.id);

                    // check if it already exists
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );

                    if (memory) {
                        elizaLogger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        break;
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp! * 1000,
                    });

                    await this.cacheTweet(tweet);
                }

                elizaLogger.log(
                    `Populated ${tweetsToSave.length} missing tweets from the cache.`
                );
                return;
            }
        }

        const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
        const username = this.twitterConfig.TWITTER_USERNAME;

        // Get the most recent 20 mentions and interactions
        const mentionsAndInteractions = await this.fetchSearchTweets(
            `@${username}`,
            20,
            SearchMode.Latest
        );

        // Combine the timeline tweets and mentions/interactions
        const allTweets = [...timeline, ...mentionsAndInteractions.tweets];

        // Create a Set to store unique tweet IDs
        const tweetIdsToCheck = new Set<string>();
        const roomIds = new Set<UUID>();

        // Add tweet IDs to the Set
        for (const tweet of allTweets) {
            tweetIdsToCheck.add(tweet.id!);
            roomIds.add(
                stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
            );
        }

        // Check the existing memories in the database
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: Array.from(roomIds),
            });

        // Create a Set to store the existing memory IDs
        const existingMemoryIds = new Set<UUID>(
            existingMemories
                .filter((memory): memory is Memory & { id: UUID } => memory.id !== undefined)
                .map(memory => memory.id)
        );

        // Filter out the tweets that already exist in the database
        const tweetsToSave = allTweets.filter(
            (tweet) =>
                !existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
        );

        elizaLogger.debug({
            processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
        });

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.profile!.username,
            this.runtime.character.name,
            "twitter"
        );

        // Save the new tweets as memories
        for (const tweet of tweetsToSave) {
            elizaLogger.log("Saving Tweet", tweet.id);

            const roomId = stringToUuid(
                tweet.conversationId + "-" + this.runtime.agentId
            );
            const userId =
                tweet.userId === this.profile!.id
                    ? this.runtime.agentId
                    : stringToUuid(tweet.userId!);

            if (tweet.userId === this.profile!.id) {
                await this.runtime.ensureConnection(
                    this.runtime.agentId,
                    roomId,
                    this.profile!.username,
                    this.profile!.screenName,
                    "twitter"
                );
            } else {
                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    tweet.username,
                    tweet.name,
                    "twitter"
                );
            }

            const content = {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                userId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: tweet.timestamp! * 1000,
            });

            await this.cacheTweet(tweet);
        }

        // Cache
        await this.cacheTimeline(timeline);
        await this.cacheMentions(mentionsAndInteractions.tweets);
    }

    async setCookiesFromArray(cookiesArray: any[]) {
        const cookieStrings = cookiesArray.map(
            (cookie) =>
                `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                    cookie.secure ? "Secure" : ""
                }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                    cookie.sameSite || "Lax"
                }`
        );
        await this.twitterClient.setCookies(cookieStrings);
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                elizaLogger.debug("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: getEmbeddingZeroVector(),
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }

    async loadLatestCheckedTweetId(): Promise<void> {
        const latestCheckedTweetId =
            await this.runtime.cacheManager.get<string>(
                `twitter/${this.profile!.username}/latest_checked_tweet_id`
            );

        if (latestCheckedTweetId) {
            this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
        }
    }

    async cacheLatestCheckedTweetId() {
        if (this.lastCheckedTweetId) {
            await this.runtime.cacheManager.set(
                `twitter/${this.profile!.username}/latest_checked_tweet_id`,
                this.lastCheckedTweetId.toString()
            );
        }
    }

    async getCachedTimeline(): Promise<Tweet[] | undefined> {
        return await this.runtime.cacheManager.get<Tweet[]>(
            `twitter/${this.profile!.username}/timeline`
        );
    }

    async cacheTimeline(timeline: Tweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile!.username}/timeline`,
            timeline,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async cacheMentions(mentions: Tweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile!.username}/mentions`,
            mentions,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async getCachedCookies(username: string) {
        return await this.runtime.cacheManager.get<any[]>(
            `twitter/${username}/cookies`
        );
    }

    async cacheCookies(username: string, cookies: any[]) {
        await this.runtime.cacheManager.set(
            `twitter/${username}/cookies`,
            cookies
        );
    }

    async getCachedProfile(username: string) {
        return await this.runtime.cacheManager.get<TwitterProfile>(
            `twitter/${username}/profile`
        );
    }

    async cacheProfile(profile: TwitterProfile) {
        await this.runtime.cacheManager.set(
            `twitter/${profile.username}/profile`,
            profile
        );
    }

    async fetchProfile(username: string): Promise<TwitterProfile | undefined> {
        const cached = await this.getCachedProfile(username);

        if (cached) return cached;

        try {
            const profile = await this.requestQueue.add(async () => {
                const profile = await this.twitterClient.getProfile(username);
                const name = profile.name || username;
                return {
                    id: profile.userId || '',
                    username,
                    name: name,
                    screenName: name,
                    bio: profile.biography || 
                        (typeof this.runtime.character.bio === "string" 
                            ? this.runtime.character.bio 
                            : this.runtime.character.bio.length > 0 
                                ? this.runtime.character.bio[0] 
                                : ""),
                    nicknames: this.runtime.character.twitterProfile?.nicknames || [],
                    followersCount: profile.followersCount || 0,
                    followingCount: profile.followingCount || 0,
                    tweetsCount: profile.tweetsCount || 0,
                    isVerified: profile.isVerified || false
                } satisfies TwitterProfile;
            });

            await this.cacheProfile(profile);
            return profile;
        } catch (error) {
            console.error("Error fetching Twitter profile:", error);
        }
    }

    private generateTweetUUID(tweetId: string): UUID {
        if (!tweetId) {
            throw new Error("Cannot generate UUID: Tweet ID is required");
        }
        const uuid = stringToUuid(`${tweetId}-${this.runtime.agentId}`);
        if (!uuid) {
            throw new Error("Failed to generate UUID");
        }
        return uuid;
    }

    private async createTweetMemory(tweet: Tweet, roomId: UUID): Promise<void> {
        if (!tweet.id) {
            throw new Error("Cannot create memory: Tweet ID is required");
        }

        const memory: Memory = {
            userId: this.runtime.agentId,
            content: {
                text: tweet.text || '',
                url: tweet.permanentUrl || '',
                source: "twitter"
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp ? new Date(tweet.timestamp * 1000).getTime() : Date.now(),
            agentId: this.runtime.agentId,
            id: this.generateTweetUUID(tweet.id)
        };

        await this.runtime.messageManager.createMemory(memory);
    }

    private async storeTweetInCache(tweet: Tweet): Promise<void> {
        if (!this.profile?.username || !tweet.id) {
            elizaLogger.warn("Cannot cache tweet details: Missing required data");
            return;
        }

        await this.runtime.cacheManager.set(
            `twitter/${this.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: tweet.timestamp || Date.now() / 1000,
                text: tweet.text || ''
            }
        );
    }

    async cacheTweetDetails(tweet: Tweet): Promise<void> {
        if (!tweet.id) {
            elizaLogger.warn("Tweet has no ID, skipping cache");
            return;
        }

        const roomId = this.generateTweetUUID(`tweet-${tweet.id}`);
        
        try {
            await Promise.all([
                this.storeTweetInCache(tweet),
                this.createTweetMemory(tweet, roomId)
            ]);

            elizaLogger.debug("Tweet details cached successfully", { tweetId: tweet.id });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            elizaLogger.error("Error caching tweet details", { error: errorMessage });
            throw error;
        }
    }

    async handleImageGenerationRequest(tweet: Tweet, imagePrompt: string): Promise<ImageAttachment | null> {
        elizaLogger.log("Handling image generation request", {
            tweetId: tweet.id,
            prompt: imagePrompt
        });

        try {
            // Generate the image using the imported function
            elizaLogger.log("Calling generateImage with prompt:", imagePrompt);
            
            if (!imagePrompt || imagePrompt.trim().length === 0) {
                throw new Error("Empty image prompt");
            }

            const imageResult = await generateImage({
                prompt: imagePrompt,
                width: 1024,
                height: 1024
            }, this.runtime);

            elizaLogger.log("Image generation result:", {
                success: imageResult.success,
                hasData: !!imageResult.data,
                dataLength: imageResult.data?.length || 0,
                error: imageResult.error,
                rawResult: JSON.stringify(imageResult)
            });

            if (!imageResult.success || !imageResult.data || imageResult.data.length === 0) {
                const errorDetails: ImageGenerationError = {
                    message: "Failed to generate image",
                    details: {
                        success: imageResult.success,
                        hasData: !!imageResult.data,
                        error: imageResult.error,
                        rawResult: imageResult
                    }
                };
                throw errorDetails;
            }

            const imageUrl = imageResult.data[0];
            if (!imageUrl) {
                throw new Error("Generated image URL is empty");
            }

            elizaLogger.log("Image generated successfully", { imageUrl });

            // Create image attachment
            const attachment: ImageAttachment = {
                url: imageUrl,
                mediaType: 'image/png',
                description: imagePrompt
            };

            return attachment;
        } catch (error) {
            elizaLogger.error("Error generating image", {
                error: error instanceof Error ? error.message : 
                      (error as ImageGenerationError)?.message || "Unknown error",
                details: (error as ImageGenerationError)?.details,
                stack: error instanceof Error ? error.stack : undefined,
                prompt: imagePrompt,
                tweetId: tweet.id
            });
            return null;
        }
    }

    async handleTweetInteraction(tweet: Tweet): Promise<void> {
        if (!tweet.id || !tweet.text) {
            elizaLogger.warn("Tweet missing ID or text, skipping");
            return;
        }

        // Check if tweet is from before initialization
        const tweetTimestamp = tweet.timestamp ? tweet.timestamp * 1000 : Date.now();
        if (tweetTimestamp < this.initializationTime) {
            elizaLogger.log("Tweet is from before agent initialization, skipping", {
                tweetId: tweet.id,
                tweetTime: new Date(tweetTimestamp).toISOString(),
                initTime: new Date(this.initializationTime).toISOString()
            });
            // Add to processed tweets to prevent reprocessing
            this.processedTweets.add(tweet.id);
            return;
        }

        // Check if we've already processed this tweet
        if (this.processedTweets.has(tweet.id)) {
            elizaLogger.log("Tweet already processed, skipping", {
                tweetId: tweet.id
            });
            return;
        }

        elizaLogger.log("Processing new tweet interaction", {
            tweetId: tweet.id,
            text: tweet.text,
            username: tweet.username,
            tweetTime: new Date(tweetTimestamp).toISOString()
        });

        try {
            // Only process tweets that are either:
            // 1. Direct mentions (@username generate image...)
            // 2. Replies to the bot's tweets
            const isDirectMention = tweet.text.toLowerCase().includes(`@${this.twitterConfig.TWITTER_USERNAME.toLowerCase()}`);
            const isReplyToBot = tweet.inReplyToStatusId && await this.isOwnTweet(tweet.inReplyToStatusId);

            if (!isDirectMention && !isReplyToBot) {
                elizaLogger.log("Tweet is not a direct mention or reply to bot, skipping", {
                    tweetId: tweet.id
                });
                this.processedTweets.add(tweet.id);
                return;
            }

            // Extract image prompt from tweet text, removing all @mentions
            const imagePrompt = tweet.text.replace(/@\w+/g, '').trim();
            
            // Mark tweet as processed immediately to prevent reprocessing
            this.processedTweets.add(tweet.id);
            
            elizaLogger.log("Checking for image generation request", {
                originalText: tweet.text,
                cleanedPrompt: imagePrompt,
                isDirectRequest: imagePrompt.toLowerCase().includes('generate') && imagePrompt.toLowerCase().includes('image')
            });
            
            // Only process if it's explicitly requesting image generation
            if (imagePrompt.toLowerCase().includes('generate') && imagePrompt.toLowerCase().includes('image')) {
                elizaLogger.log("Valid image generation request detected", {
                    prompt: imagePrompt
                });
                
                // Generate the image
                const attachment = await this.handleImageGenerationRequest(tweet, imagePrompt);
                
                if (attachment) {
                    elizaLogger.log("Image generated successfully, queueing reply");
                    
                    
                }
            } else {
                elizaLogger.log("Not an explicit image generation request, skipping", {
                    prompt: imagePrompt
                });
            }
        } catch (error) {
            elizaLogger.error("Error handling tweet interaction", {
                error: error instanceof Error ? error.message : "Unknown error",
                stack: error instanceof Error ? error.stack : undefined,
                tweetId: tweet.id
            });
            // Mark as processed even if there's an error to prevent infinite retries
            this.processedTweets.add(tweet.id);
        }
    }

    private async isOwnTweet(tweetId: string): Promise<boolean> {
        try {
            const tweet = await this.getTweet(tweetId);
            return tweet.username?.toLowerCase() === this.twitterConfig.TWITTER_USERNAME.toLowerCase();
        } catch (error) {
            elizaLogger.error("Error checking if tweet is own", {
                error: error instanceof Error ? error.message : "Unknown error",
                tweetId
            });
            return false;
        }
    }

    // Implement the TwitterClientAccess interface
    getTwitterConfig(): TwitterConfig {
        return this.twitterConfig;
    }

    getTwitterClient(): Scraper {
        return this.twitterClient;
    }

    getProfile(): TwitterProfile | null {
        return this.profile;
    }

    getRequestQueue(): RequestQueue {
        return this.requestQueue;
    }

    protected async createUserProfile(userData: any): Promise<TwitterProfile> {
        const name = userData.name || userData.username || 'Unknown User';
        return {
            id: userData.userId || '',
            username: userData.username || '',
            name: name,
            screenName: name,
            bio: userData.biography || '',
            nicknames: [name],
            followersCount: userData.followersCount,
            followingCount: userData.followingCount,
            tweetsCount: userData.tweetsCount,
            isVerified: userData.isVerified || false
        };
    }

    protected async createTweetProfile(tweet: any): Promise<TwitterProfile> {
        const name = tweet.name || tweet.username || 'Unknown User';
        return {
            id: tweet.userId || '',
            username: tweet.username || '',
            name: name,
            screenName: name,
            bio: tweet.bio || '',
            nicknames: [name],
            followersCount: tweet.followersCount,
            followingCount: tweet.followingCount,
            tweetsCount: tweet.tweetsCount,
            isVerified: tweet.isVerified || false
        };
    }
}
