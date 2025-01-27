import { elizaLogger } from "@elizaos/core";

export interface ImageGenerationOptions {
    prompt: string;
    width: number;
    height: number;
    provider?: string;
    model?: string;
}

export interface ImageGenerationResult {
    success: boolean;
    data?: string[];
    error?: any;
}

export async function generateImage(options: ImageGenerationOptions, runtime: any): Promise<ImageGenerationResult> {
    elizaLogger.log('Starting image generation with options:', options);

    const provider = runtime.imageModelProvider.toLowerCase();
    elizaLogger.log('Using image provider:', provider);

    if (provider === 'heurist') {
        try {
            const apiKey = runtime.getSetting('HEURIST_API_KEY');
            if (!apiKey) {
                throw new Error('Heurist API key not found');
            }

            const model = runtime.getSetting('IMAGE_HEURIST_MODEL') || 'SDXL';
            elizaLogger.log('Using Heurist model:', model);

            const response = await fetch('https://api.heurist.xyz/v1/image', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    prompt: options.prompt,
                    model: model,
                    width: options.width,
                    height: options.height
                })
            });

            if (!response.ok) {
                const error = await response.text();
                elizaLogger.error('Heurist API error:', error);
                return {
                    success: false,
                    error: error
                };
            }

            const result = await response.json();
            elizaLogger.log('Heurist API response:', result);

            if (result.images && result.images.length > 0) {
                return {
                    success: true,
                    data: result.images
                };
            } else {
                return {
                    success: false,
                    error: 'No images returned from Heurist API'
                };
            }
        } catch (error) {
            elizaLogger.error('Error calling Heurist API:', error);
            return {
                success: false,
                error: error
            };
        }
    }

    // Fallback to canvas-based generation for other providers
    elizaLogger.warn('Unsupported image provider:', provider);
    return {
        success: false,
        error: `Unsupported image provider: ${provider}`
    };
}