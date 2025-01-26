import { createClient } from '@supabase/supabase-js';
import { elizaLogger } from "@elizaos/core";

export class SupabaseStorageService {
    private supabase;
    private bucketName = 'generated-images';

    constructor(supabaseUrl: string, supabaseKey: string) {
        elizaLogger.log("Initializing SupabaseStorageService");
        this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    async uploadImage(imageBuffer: Buffer, filename: string): Promise<string> {
        elizaLogger.log('Starting image upload process', { filename });
        elizaLogger.debug('Image buffer size:', imageBuffer.length);
        
        try {
            elizaLogger.log(`Uploading to bucket: ${this.bucketName}/images/${filename}`);
            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .upload(`images/${filename}`, imageBuffer, {
                    contentType: 'image/png',
                    upsert: true
                });

            if (error) {
                elizaLogger.error('Upload failed:', error);
                throw error;
            }

            elizaLogger.log('Upload successful, generating public URL');
            const { data: urlData } = this.supabase.storage
                .from(this.bucketName)
                .getPublicUrl(`images/${filename}`);

            elizaLogger.success('Image uploaded successfully:', urlData.publicUrl);
            return urlData.publicUrl;
        } catch (error) {
            elizaLogger.error('Error uploading image to Supabase:', error);
            throw error;
        }
    }

    async getImage(filename: string): Promise<Buffer> {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .download(`images/${filename}`);

            if (error) {
                throw error;
            }

            return Buffer.from(await data.arrayBuffer());
        } catch (error) {
            elizaLogger.error('Error downloading image from Supabase:', error);
            throw error;
        }
    }
}