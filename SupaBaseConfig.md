# Supabase Configuration Documentation

## Storage Bucket Configuration

### General Settings

- Bucket Name: generated-images
- File Size Limit: 50MiB
- Enabled: Yes

### Image Upload Specifications

- Allowed File Types: PNG, JPG, JPEG, GIF
- Maximum File Size: 5MB per image
- Storage Path Format: generated-images/{record_id}_{filename}

## Database Tables

### 1. Generated Images Table

```sql
CREATE TABLE generated_images (
id: UUID PRIMARY KEY,
created_at: TIMESTAMP WITH TIME ZONE,
storage_path: TEXT,
original_filepath: TEXT,
prompt: TEXT,
status: TEXT,
error_message: TEXT,
metadata: JSONB
);
```

#### Status Values:
- uploading: Initial state when upload starts
- completed: Successfully uploaded
- error: Upload failed

#### Metadata Fields:
- uploadStarted: Timestamp when upload began
- uploadCompleted: Timestamp when upload finished
- originalFilename: Original file name
- processingTime: Time taken to process in milliseconds
- attempts: Number of upload attempts

### 2. Cache Table

```sql
CREATE TABLE cache (
key TEXT NOT NULL,
agentId TEXT NOT NULL,
value JSONB DEFAULT '{}'::jsonb,
createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
expiresAt TIMESTAMP,
PRIMARY KEY (key, agentId)
);
```

## Image Validation Rules

- File Existence: Checks if file exists on disk
- Size Validation:
  - Minimum: > 0 bytes
  - Maximum: 5MB
- Format Validation:
  - Checks file extension
  - Validates magic numbers for PNG, JPEG, and GIF
  - Content Type: Enforces image/\* MIME types

## Upload Process

### Pre-upload:
- Validate image file
- Create database record with 'uploading' status

### Upload:
- Upload to Supabase Storage bucket
- Generate public URL
- Update database record with storage path

### Post-upload:
- Update record status to 'completed'
- Store metadata about processing time
- Return public URL for access

## Error Handling
- Failed uploads are logged with detailed error information
- Database records are updated with error status and messages
- Retry mechanism implemented for both storage and database operations
- Error details stored in metadata for debugging

## Access Control
- Images are stored with public access
- URLs are generated in format: https://{bucket}.{supabase-project}.supabase.co/storage/v1/object/public/generated-images/{filename}
- No authentication required to view images
- Write access controlled through Supabase authentication

## Monitoring
- Processing time tracked for all operations
- Upload success/failure rates logged
- File size and type statistics maintained
- Error rates and types monitored
