# Twitter Image Posts Agent

A powerful AI agent capable of generating and posting images to Twitter, with customizable character personalities and multiple model provider support. Has the bare minimum features to generate and post images to Twitter based on user's request.

## Prerequisites

- Node.js (v23.3.0 or higher)
- pnpm package manager (v9.0.0 or higher)
- Twitter account credentials
- API keys for chosen model providers

## Quick Start

1. Clone the repository
2. Copy the environment template:
```bash
cp .env.example .env
``` 
3. Install dependencies and start the agent:
```bash
pnpm i
pnpm build 
pnpm start
```

## Configuration

### Character Configuration

The agent's personality and behavior can be customized through character files:

1. **Default Character**: 
   - Open `src/character.ts` to modify the default character
   - Uncomment and edit the desired sections

2. **Custom Characters**:
   - Create a JSON file following the template in `characters/trump.character.json`
   - Load custom characters using:
     ```bash
     pnpm start --characters="path/to/your/character.json"
     ```
   - Multiple character files can be loaded simultaneously

### Environment Variables (.env)

Key configurations required in your .env file:

#### 1. Twitter Configuration
```env
TWITTER_USERNAME=           # Account username
TWITTER_PASSWORD=           # Account password
TWITTER_EMAIL=              # Account email
TWITTER_DRY_RUN=false      # Set to true for testing without posting
TWITTER_POLL_INTERVAL=150   # Check interval for interactions (seconds)
POST_INTERVAL_MIN=3         # Minimum interval between posts (minutes)
POST_INTERVAL_MAX=10        # Maximum interval between posts (minutes)
```

#### 2. Model Providers (Choose at least one)

##### OpenAI
```env
OPENAI_API_KEY=            # OpenAI API key
```

##### Heurist
```env
HEURIST_API_KEY=           # Heurist API key
HEURIST_IMAGE_MODEL=       # Default: FLUX.1-dev
```

### Add login credentials and keys to .env

#### 3. Optional Configurations

##### SupaBase Integration
```env
SUPABASE_URL=                # Supabase URL
SUPABASE_ANON_KEY=           # Supabase anon key
```

## Install dependencies and start your agent

## Character Customization

Your character file (`character.json`) can include:

```json
{
  "name": "character_name",
  "clients": ["twitter"],
  "modelProvider": "openai",
  "imageModelProvider": "heurist",
  "settings": {
    "secrets": {
      "twitterUsername": "YourTwitterHandle"
    }
  },
  "plugins": [
    "@elizaos/plugin-image-generation"
  ],
  "bio": [
    "Character biography points"
  ],
  "lore": [
    "Character background information"
  ],
  "knowledge": [
    "Character knowledge base"
  ],
  "messageExamples": [
    // Example interactions (important to provide positive and negative examples of when the character should respond in a certain way)
  ],
  "style": {
    "chat": [
      "Styling rules for chat responses"
    ],
    "post": [
      "Styling rules for posts"
    ]
  }
}
```

## Available Plugins

- Image Generation (@elizaos/plugin-image-generation)

## Advanced Features

### Post Intervals
- Configure minimum and maximum intervals between posts
- Enable immediate posting with POST_IMMEDIATELY=true

### Action Processing
- Control interaction frequency with ACTION_INTERVAL
- Set maximum actions per cycle with MAX_ACTIONS_PROCESSING

### Timeline Interaction
- Configure timeline type with ACTION_TIMELINE_TYPE
- Enable/disable search functionality with TWITTER_SEARCH_ENABLE

## Troubleshooting

1. **Login Issues**:
   - Verify Twitter credentials
   - Check TWITTER_RETRY_LIMIT setting
   - Enable VERBOSE=true for detailed logs

2. **Rate Limiting**:
   - Adjust POST_INTERVAL_MIN and POST_INTERVAL_MAX
   - Monitor ACTION_INTERVAL settings

3. **API Errors**:
   - Verify API keys
   - Check model provider status
   - Review error logs

## Support

For additional support or feature requests, please open an issue in the repository.
