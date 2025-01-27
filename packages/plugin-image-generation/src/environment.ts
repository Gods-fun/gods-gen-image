import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import { elizaLogger } from "@elizaos/core";

export const imageGenEnvSchema = z
    .object({
        ANTHROPIC_API_KEY: z.string().optional(),
        NINETEEN_AI_API_KEY: z.string().optional(),
        TOGETHER_API_KEY: z.string().optional(),
        HEURIST_API_KEY: z.string().optional(),
        FAL_API_KEY: z.string().optional(),
        OPENAI_API_KEY: z.string().optional(),
        VENICE_API_KEY: z.string().optional(),
        LIVEPEER_GATEWAY_URL: z.string().optional(),
    })
    .refine(
        (data: any) => {
            return !!(
                data.ANTHROPIC_API_KEY ||
                data.NINETEEN_AI_API_KEY ||
                data.TOGETHER_API_KEY ||
                data.HEURIST_API_KEY ||
                data.FAL_API_KEY ||
                data.OPENAI_API_KEY ||
                data.VENICE_API_KEY ||
                data.LIVEPEER_GATEWAY_URL
            );
        },
        {
            message:
                "At least one of ANTHROPIC_API_KEY, NINETEEN_AI_API_KEY, TOGETHER_API_KEY, HEURIST_API_KEY, FAL_API_KEY, OPENAI_API_KEY, VENICE_API_KEY or LIVEPEER_GATEWAY_URL is required",
        }
    );

export type ImageGenConfig = z.infer<typeof imageGenEnvSchema>;

export async function validateImageGenConfig(runtime: IAgentRuntime) {
    elizaLogger.log("Starting image generation environment validation");
    elizaLogger.log("Current runtime settings:", {
        imageModelProvider: runtime.imageModelProvider,
        modelProvider: runtime.modelProvider,
        characterName: runtime.character?.name
    });

    const imageModelProvider = runtime.imageModelProvider.toLowerCase();
    let requiredKey;

    elizaLogger.log(`Determining required API key for provider: ${imageModelProvider}`);
    switch (imageModelProvider) {
        case 'heurist':
            requiredKey = 'HEURIST_API_KEY';
            break;
        case 'openai':
            requiredKey = 'OPENAI_API_KEY';
            break;
        case 'anthropic':
            requiredKey = 'ANTHROPIC_API_KEY';
            break;
        case 'nineteen.ai':
            requiredKey = 'NINETEEN_AI_API_KEY';
            break;
        case 'together':
            requiredKey = 'TOGETHER_API_KEY';
            break;
        case 'fal':
            requiredKey = 'FAL_API_KEY';
            break;
        case 'venice':
            requiredKey = 'VENICE_API_KEY';
            break;
        case 'livepeer':
            requiredKey = 'LIVEPEER_GATEWAY_URL';
            break;
        default:
            elizaLogger.warn(`Unknown image model provider: ${imageModelProvider}`);
            return false;
    }

    elizaLogger.log(`Required API key for ${imageModelProvider}: ${requiredKey}`);
    const value = runtime.getSetting(requiredKey);
    
    if (!value) {
        elizaLogger.warn(`Missing required API key for ${imageModelProvider}: ${requiredKey}`);
        return false;
    }

    elizaLogger.log(`Found required API key for ${imageModelProvider}`);
    elizaLogger.log("Environment validation completed successfully");
    return true;
}
