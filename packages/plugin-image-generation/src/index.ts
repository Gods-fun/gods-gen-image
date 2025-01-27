import { elizaLogger, generateText } from "@elizaos/core";
import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type Plugin,
    type State,
    ModelClass,
} from "@elizaos/core";
import { generateImage } from "@elizaos/core";
import { SupabaseStorageService } from "./storage";
import { validateImageGenConfig } from "./environment";

const imageGeneration: Action = {
    name: "GENERATE_IMAGE",
    similes: [
        "IMAGE_GENERATION",
        "IMAGE_GEN",
        "CREATE_IMAGE",
        "MAKE_PICTURE",
        "GENERATE_IMAGE",
        "GENERATE_A",
        "DRAW",
        "DRAW_A",
        "MAKE_A",
    ],
    description: "Generate an image to go along with the message.",
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Starting image generation validation");
        await validateImageGenConfig(runtime);
        elizaLogger.log("Image generation config validation completed");

        const anthropicApiKeyOk = !!runtime.getSetting("ANTHROPIC_API_KEY");
        const nineteenAiApiKeyOk = !!runtime.getSetting("NINETEEN_AI_API_KEY");
        const togetherApiKeyOk = !!runtime.getSetting("TOGETHER_API_KEY");
        const heuristApiKeyOk = !!runtime.getSetting("HEURIST_API_KEY");
        const falApiKeyOk = !!runtime.getSetting("FAL_API_KEY");
        const openAiApiKeyOk = !!runtime.getSetting("OPENAI_API_KEY");
        const veniceApiKeyOk = !!runtime.getSetting("VENICE_API_KEY");
        const livepeerGatewayUrlOk = !!runtime.getSetting("LIVEPEER_GATEWAY_URL");

        elizaLogger.log("API Keys status:", {
            anthropic: anthropicApiKeyOk,
            nineteenAi: nineteenAiApiKeyOk,
            together: togetherApiKeyOk,
            heurist: heuristApiKeyOk,
            fal: falApiKeyOk,
            openai: openAiApiKeyOk,
            venice: veniceApiKeyOk,
            livepeer: livepeerGatewayUrlOk
        });

        return (
            anthropicApiKeyOk ||
            togetherApiKeyOk ||
            heuristApiKeyOk ||
            falApiKeyOk ||
            openAiApiKeyOk ||
            veniceApiKeyOk ||
            nineteenAiApiKeyOk ||
            livepeerGatewayUrlOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: {
            width?: number;
            height?: number;
            count?: number;
            cfgScale?: number;
            negativePrompt?: string;
            numIterations?: number;
            guidanceScale?: number;
            seed?: number;
            modelId?: string;
            jobId?: string;
            stylePreset?: string;
            hideWatermark?: boolean;
            safeMode?: boolean;
        },
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Starting image generation handler");
        elizaLogger.log("Current image model provider:", runtime.imageModelProvider);
        elizaLogger.log("Current model provider:", runtime.modelProvider);

        // Initialize SupabaseStorageService
        const supabaseUrl = runtime.getSetting("SUPABASE_URL");
        const supabaseKey = runtime.getSetting("SUPABASE_ANON_KEY");
        
        elizaLogger.log("Checking Supabase configuration");
        if (!supabaseUrl || !supabaseKey) {
            elizaLogger.error("Supabase configuration missing. Please set SUPABASE_URL and SUPABASE_ANON_KEY");
            throw new Error("Supabase configuration missing");
        }
        elizaLogger.log("Supabase configuration validated");

        const storageService = new SupabaseStorageService(supabaseUrl, supabaseKey);
        elizaLogger.log("Supabase storage service initialized");

        elizaLogger.log("Composing state for message:", message);
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;
        elizaLogger.log("State composed, User ID:", userId);

        const CONTENT = message.content.text;
        elizaLogger.log("Processing content:", CONTENT);

        const IMAGE_SYSTEM_PROMPT = `You are an expert in writing prompts for AI art generation. You excel at creating detailed and creative visual descriptions. Incorporating specific elements naturally. Always aim for clear, descriptive language that generates a creative picture. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`;
        const STYLE = "realistic, high quality, cinematic";

        const IMAGE_PROMPT_INPUT = `You are tasked with generating an image prompt based on a content and a specified style.
            Your goal is to create a detailed and vivid image prompt that captures the essence of the content while incorporating an appropriate subject based on your analysis of the content.\n\nYou will be given the following inputs:\n<content>\n${CONTENT}\n</content>\n\n<style>\n${STYLE}\n</style>\n\nA good image prompt consists of the following elements:\n\n

1. Main subject
2. Detailed description
3. Style
4. Lighting
5. Composition
6. Quality modifiers

To generate the image prompt, follow these steps:\n\n1. Analyze the content text carefully, identifying key themes, emotions, and visual elements mentioned or implied.
\n\n

2. Determine the most appropriate main subject by:
   - Identifying concrete objects or persons mentioned in the content
   - Analyzing the central theme or message
   - Considering metaphorical representations of abstract concepts
   - Selecting a subject that best captures the content's essence

3. Determine an appropriate environment or setting based on the content's context and your chosen subject.

4. Decide on suitable lighting that enhances the mood or atmosphere of the scene.

5. Choose a color palette that reflects the content's tone and complements the subject.

6. Identify the overall mood or emotion conveyed by the content.

7. Plan a composition that effectively showcases the subject and captures the content's essence.

8. Incorporate the specified style into your description, considering how it affects the overall look and feel of the image.

9. Use concrete nouns and avoid abstract concepts when describing the main subject and elements of the scene.

Construct your image prompt using the following structure:\n\n
1. Main subject: Describe the primary focus of the image based on your analysis
2. Environment: Detail the setting or background
3. Lighting: Specify the type and quality of light in the scene
4. Colors: Mention the key colors and their relationships
5. Mood: Convey the overall emotional tone
6. Composition: Describe how elements are arranged in the frame
7. Style: Incorporate the given style into the description

Ensure that your prompt is detailed, vivid, and incorporates all the elements mentioned above while staying true to the content and the specified style. LIMIT the image prompt 50 words or less. \n\nWrite a prompt. Only include the prompt and nothing else.`;

        elizaLogger.log("Starting prompt generation");
        const imagePrompt = await generateText({
            runtime,
            context: IMAGE_PROMPT_INPUT,
            modelClass: ModelClass.MEDIUM,
            customSystemPrompt: IMAGE_SYSTEM_PROMPT,
        });
        elizaLogger.log("Generated image prompt:", imagePrompt);

        const imageSettings = runtime.character?.settings?.imageSettings || {};
        elizaLogger.log("Using image settings:", imageSettings);

        elizaLogger.log("Starting image generation with provider:", runtime.imageModelProvider);
        const images = await generateImage(
            {
                prompt: imagePrompt,
                width: options.width || imageSettings.width || 1024,
                height: options.height || imageSettings.height || 1024,
                ...(options.count != null || imageSettings.count != null
                    ? { count: options.count || imageSettings.count || 1 }
                    : {}),
                ...(options.negativePrompt != null ||
                imageSettings.negativePrompt != null
                    ? {
                          negativePrompt:
                              options.negativePrompt ||
                              imageSettings.negativePrompt,
                      }
                    : {}),
                ...(options.numIterations != null ||
                imageSettings.numIterations != null
                    ? {
                          numIterations:
                              options.numIterations ||
                              imageSettings.numIterations,
                      }
                    : {}),
                ...(options.guidanceScale != null ||
                imageSettings.guidanceScale != null
                    ? {
                          guidanceScale:
                              options.guidanceScale ||
                              imageSettings.guidanceScale,
                      }
                    : {}),
                ...(options.seed != null || imageSettings.seed != null
                    ? { seed: options.seed || imageSettings.seed }
                    : {}),
                ...(options.modelId != null || imageSettings.modelId != null
                    ? { modelId: options.modelId || imageSettings.modelId }
                    : {}),
                ...(options.jobId != null || imageSettings.jobId != null
                    ? { jobId: options.jobId || imageSettings.jobId }
                    : {}),
                ...(options.stylePreset != null ||
                imageSettings.stylePreset != null
                    ? { stylePreset: options.stylePreset ||
                            imageSettings.stylePreset }
                    : {}),
                ...(options.hideWatermark != null ||
                imageSettings.hideWatermark != null
                    ? { hideWatermark: options.hideWatermark ||
                            imageSettings.hideWatermark }
                    : {}),
            },
            runtime
        );
        elizaLogger.log("Image generation completed, success:", images.success);

        if (images.success && images.data && images.data.length > 0) {
            elizaLogger.log("Processing generated images, count:", images.data.length);
            
            for (let i = 0; i < images.data.length; i++) {
                const image = images.data[i];
                const filename = `generated_${Date.now()}_${i}.png`;
                elizaLogger.log(`Processing image ${i + 1}/${images.data.length}`);

                let imageBuffer: Buffer;
                let imageUrl: string;

                try {
                    elizaLogger.log("Converting image data to buffer");
                    if (image.startsWith("http")) {
                        elizaLogger.log("Processing Heurist URL:", image);
                        const response = await fetch(image);
                        if (!response.ok) {
                            throw new Error(`Failed to fetch image: ${response.statusText}`);
                        }
                        imageBuffer = Buffer.from(await response.arrayBuffer());
                        elizaLogger.log("Successfully fetched and buffered Heurist image");
                    } else {
                        elizaLogger.log("Processing base64 image data");
                        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
                        imageBuffer = Buffer.from(base64Data, "base64");
                        elizaLogger.log("Successfully converted base64 to buffer");
                    }

                    elizaLogger.log("Uploading image to Supabase");
                    imageUrl = await storageService.uploadImage(imageBuffer, filename);
                    elizaLogger.log("Image uploaded successfully:", imageUrl);

                    callback(
                        {
                            text: "...",
                            attachments: [
                                {
                                    id: crypto.randomUUID(),
                                    url: imageUrl,
                                    title: "Generated image",
                                    source: "imageGeneration",
                                    description: "...",
                                    text: "...",
                                    contentType: "image/png",
                                },
                            ],
                        },
                        [
                            {
                                attachment: imageUrl,
                                name: filename,
                            },
                        ]
                    );
                    elizaLogger.log("Callback executed successfully for image:", filename);
                } catch (error) {
                    elizaLogger.error("Error processing and uploading image:", error);
                    throw error;
                }
            }
        } else {
            elizaLogger.error("Image generation failed or returned no data");
            throw new Error("Image generation failed");
        }
    },
    examples: [
        // TODO: We want to generate images in more abstract ways, not just when asked to generate an image

        [
            {
                user: "{{user1}}",
                content: { text: "Generate an image of a cat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Generate an image of a dog" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a dog",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Create an image of a cat with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Make an image of a dog with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a dog with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Paint an image of a cat with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
    ],
} as Action;

export const imageGenerationPlugin: Plugin = {
    name: "imageGeneration",
    description: "Generate images",
    actions: [imageGeneration],
    evaluators: [],
    providers: [],
};

export default imageGenerationPlugin;