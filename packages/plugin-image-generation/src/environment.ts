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
    elizaLogger.log("Validating image generation configuration");

    const requiredKeys = [
        "ANTHROPIC_API_KEY",
        "HEURIST_API_KEY",
        "OPENAI_API_KEY",
    ];

    const missingKeys = [];
    for (const key of requiredKeys) {
        const value = runtime.getSetting(key);
        if (!value) {
            elizaLogger.warn(`Missing configuration key: ${key}`);
            missingKeys.push(key);
        } else {
            elizaLogger.debug(`Found configuration key: ${key}`);
        }
    }

    if (missingKeys.length > 0) {
        elizaLogger.warn("Some configuration keys are missing:", missingKeys);
    } else {
        elizaLogger.success("All required configuration keys are present");
    }

    return true;
}
