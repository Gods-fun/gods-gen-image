import { createCanvas, registerFont } from 'canvas';
import { elizaLogger } from "@elizaos/core";

export interface ImageGenerationOptions {
    width: number;
    height: number;
    backgroundColor: string;
    text?: string;
    font?: string;
    prompt?: string;
}

export async function generateImage(options: ImageGenerationOptions): Promise<Buffer> {
    elizaLogger.log('Starting image generation with options:', options);

    const canvas = createCanvas(options.width, options.height);
    const ctx = canvas.getContext('2d');

    // Set background
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, options.width, options.height);

    if (options.text) {
        // Configure text
        ctx.fillStyle = '#000000';
        ctx.font = `${options.font || 'Arial'} 32px`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw text
        ctx.fillText(
            options.text,
            options.width / 2,
            options.height / 2
        );
    }

    elizaLogger.log('Image generation completed');
    return canvas.toBuffer('image/png');
}