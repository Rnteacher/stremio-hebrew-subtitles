require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(cors());

// Better error logging
function logError(context, error) {
  console.error(`[ERROR][${context}]: ${error.message}`);
  if (error.response) {
    console.error(`Status: ${error.response.status}`);
    console.error(`Data:`, error.response.data);
  }
  console.error(`Stack: ${error.stack}`);
}

// Enhanced environment validation at startup
function validateEnvironment() {
  const requiredVars = ['OPENAI_API_KEY', 'OPENSUB_API_KEY'];
  const missing = requiredVars.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please set these variables in your .env file or deployment environment');
    return false;
  }
  
  console.log('Environment validation successful');
  return true;
}

// Ensure the 'subs' directory exists with better error handling
const subsDir = path.join(__dirname, 'subs');
function ensureSubsDirectory() {
  if (!fs.existsSync(subsDir)) {
    try {
      fs.mkdirSync(subsDir, { recursive: true });
      console.log("Successfully created 'subs' directory:", subsDir);
      return true;
    } catch (err) {
      logError("Directory Creation", err);
      return false;
    }
  } else {
    console.log("'subs' directory already exists:", subsDir);
    
    // Test write permissions
    try {
      const testFile = path.join(subsDir, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log("Write permissions to 'subs' directory confirmed");
      return true;
    } catch (err) {
      logError("Write Permission Test", err);
      console.error("The application may not have write permissions to the 'subs' directory");
      return false;
    }
  }
}

// === Step 1: Fetch English subtitle file URL from OpenSubtitles (Improved) ===
async function getEnglishSubtitleFileUrl(imdbId) {
  console.log(`[OpenSubtitles] Fetching English subtitles for IMDb ID: ${imdbId}`);
  
  try {
    // Test API key with a simple validation request
    try {
      const testResponse = await axios.get('https://api.opensubtitles.com/api/v1/infos/user', {
        headers: {
          'Api-Key': process.env.OPENSUB_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      console.log('[OpenSubtitles] API key validation successful');
    } catch (validationError) {
      console.error('[OpenSubtitles] API key validation failed:');
      logError("OpenSubtitles API Key Validation", validationError);
      // Continue anyway to try the actual request
    }
    
    // Clean the IMDb ID (remove leading 'tt' if needed for API compatibility)
    const cleanImdbId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    console.log(`[OpenSubtitles] Using cleaned IMDb ID: ${cleanImdbId}`);
    
    const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params: {
        imdb_id: cleanImdbId.replace('tt', ''), // OpenSubtitles may require IMDb ID without 'tt' prefix
        languages: 'en',
        order_by: 'download_count', // Use download_count instead of downloads
      },
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'StremioHebrewAddon/1.0.2' // Consistent user agent
      },
      timeout: 10000
    });

    console.log(`[OpenSubtitles] API Response Status: ${response.status}`);
    console.log(`[OpenSubtitles] Total subtitles found: ${response.data?.data?.length || 0}`);

    // Check if data exists and is not empty
    if (!response.data || !response.data.data || response.data.data.length === 0) {
      console.log('[OpenSubtitles] No English subtitles found for this IMDb ID.');
      return null;
    }

    // Find the best subtitle file
    const bestSubtitle = response.data.data[0];
    if (!bestSubtitle || !bestSubtitle.attributes || !bestSubtitle.attributes.files || bestSubtitle.attributes.files.length === 0) {
      console.log('[OpenSubtitles] Found subtitle entry, but no files associated.');
      return null;
    }

    const fileId = bestSubtitle.attributes.files[0].file_id;
    console.log(`[OpenSubtitles] Found subtitle file ID: ${fileId}`);

    // Request download link
    console.log(`[OpenSubtitles] Requesting download link for file ID: ${fileId}`);
    const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', {
      file_id: fileId
    }, {
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'StremioHebrewAddon/1.0.2'
      },
      timeout: 10000
    });

    if (!downloadRes.data || !downloadRes.data.link) {
      console.error('[OpenSubtitles] Failed to get download link');
      console.error('Response data:', downloadRes.data);
      return null;
    }

    console.log(`[OpenSubtitles] Got download link: ${downloadRes.data.link}`);
    return downloadRes.data.link;

  } catch (error) {
    logError("OpenSubtitles API", error);
    return null;
  }
}

// === Step 2: Download subtitle text (Improved) ===
async function downloadSubtitleText(url) {
  console.log(`[Downloader] Downloading subtitle text from: ${url}`);
  
  // Validate URL format
  if (!url || !url.startsWith('http')) {
    console.error('[Downloader] Invalid URL format');
    return null;
  }
  
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'StremioHebrewAddon/1.0.2'
      },
      responseType: 'text'
    });
    
    console.log('[Downloader] Subtitle file downloaded successfully.');
    console.log(`[Downloader] Content length: ${res.data.length} bytes`);
    
    // Validate SRT format (basic check)
    if (!res.data || res.data.length < 20 || !res.data.includes('-->')) {
      console.error('[Downloader] Downloaded content does not appear to be a valid SRT file');
      console.log('First 100 characters:', res.data.substring(0, 100));
      return null;
    }
    
    return res.data;
  } catch (error) {
    logError("Subtitle Download", error);
    return null;
  }
}

// === Step 3: Translate using AI (Improved) ===
async function translateToHebrew(text) {
  console.log('[Translator] Starting translation to Hebrew...');
  
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.error('[Translator] Error: Input text is empty or invalid.');
    return null;
  }
  
  // Calculate number of lines for logging
  const lineCount = text.split('\n').length;
  console.log(`[Translator] Processing ${lineCount} lines of text`);
  
  // For large subtitles, we'll split the translation into chunks
  if (lineCount > 1000) {
    console.log('[Translator] Large subtitle detected, processing in chunks');
    return translateLargeSubtitle(text);
  }
  
  try {
    console.log('[Translator] Sending translation request to OpenAI API');
    const startTime = Date.now();
    
    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Translate the following English .srt subtitle text to Hebrew.
                    Preserve the .srt format exactly, including timestamps, line numbers, and line breaks.
                    Translate only the dialogue/text portions.
                    Make sure RTL formatting works properly.
                    Ensure the output is valid UTF-8 encoded Hebrew text.`
        },
        {
          role: 'user',
          content: text
        }
      ],
      timeout: 120000 // 2 minutes timeout
    });

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Translator] Translation completed in ${elapsedTime} seconds.`);

    if (!chat.choices || chat.choices.length === 0 || !chat.choices[0].message || !chat.choices[0].message.content) {
      console.error('[Translator] Error: Invalid response structure from OpenAI API.');
      console.error('Response:', chat);
      return null;
    }

    const translatedText = chat.choices[0].message.content;
    console.log(`[Translator] Translation successful. Output length: ${translatedText.length} bytes`);
    return translatedText;

  } catch (error) {
    logError("OpenAI Translation", error);
    return null;
  }
}

// Helper function to translate large subtitles in chunks
async function translateLargeSubtitle(text) {
  try {
    // Split by groups of subtitle entries (double newline is the separator between entries)
    const entries = text.split('\n\n').filter(entry => entry.trim());
    console.log(`[Translator] Split subtitle into ${entries.length} entries`);
    
    // Process in chunks of 100 entries
    const chunkSize = 100;
    let translatedChunks = [];
    
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const chunkText = chunk.join('\n\n');
      
      console.log(`[Translator] Processing chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(entries.length/chunkSize)}`);
      
      const chat = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `Translate the following English .srt subtitle text to Hebrew.
                      Preserve the .srt format exactly, including timestamps, line numbers, and line breaks.
                      Translate only the dialogue/text portions.
                      Make sure RTL formatting works properly.
                      Ensure the output is valid UTF-8 encoded Hebrew text.`
          },
          {
            role: 'user',
            content: chunkText
          }
        ],
        timeout: 60000
      });
      
      if (!chat.choices || !chat.choices[0].message || !chat.choices[0].message.content) {
        throw new Error('Invalid response from OpenAI API for chunk');
      }
      
      translatedChunks.push(chat.choices[0].message.content);
    }
    
    // Join all translated chunks
    const fullTranslation = translatedChunks.join('\n\n');
    console.log(`[Translator] Successfully translated all chunks. Total output length: ${fullTranslation.length} bytes`);
    return fullTranslation;
    
  } catch (error) {
    logError("Chunk Translation", error);
    return null;
  }
}

// === Step 4: Save subtitle temporarily (Improved) ===
function saveSubtitleToFile(content, imdbId) {
  // Ensure imdbId is safe for filenames
  const safeImdbId = imdbId.replace(/[^a-zA-Z0-9]/g, '_');
  const filePath = path.join(subsDir, `${safeImdbId}_he.srt`);
  
  console.log(`[Storage] Saving translated subtitle to: ${filePath}`);
  
  try {
    if (typeof content !== 'string') {
      throw new Error('Content to save is not a string.');
    }
    
    // Add BOM (Byte Order Mark) for better UTF-8 compatibility
    const contentWithBOM = '\uFEFF' + content;
    
    fs.writeFileSync(filePath, contentWithBOM, { encoding: 'utf8' });
    console.log(`[Storage] Successfully saved file: ${filePath}`);
    
    // Verify the file was created and has content
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`[Storage] File size: ${stats.size} bytes`);
      if (stats.size < 10) {
        console.warn('[Storage] Warning: Saved file is suspiciously small');
      }
    } else {
      console.error('[Storage] Error: File was not created despite no errors');
      return null;
    }
    
    return filePath;
  } catch (error) {
    logError("Subtitle File Saving", error);
    return null;
  }
}

// === Step 5: Stremio Addon Definition (Improved) ===
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.3',
  name: 'AI Hebrew Subtitles (GPT)',
  description: 'Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

// Define the subtitle handler
builder.defineSubtitlesHandler(async (args) => {
  console.log('[Stremio] Subtitles handler invoked with args:', JSON.stringify(args, null, 2));

  let imdbId = args.id;
  
  // Extract IMDb ID if it contains additional information (for series episodes)
  if (imdbId && imdbId.includes(':')) {
    const parts = imdbId.split(':');
    imdbId = parts[0]; // Get the base IMDb ID
    console.log(`[Stremio] Extracted base IMDb ID: ${imdbId} from: ${args.id}`);
  }
  
  if (!imdbId || (!imdbId.startsWith('tt') && !imdbId.match(/^\d+$/))) {
    console.error('[Stremio] Invalid IMDb ID received:', args.id);
    return Promise.resolve({ subtitles: [] });
  }

  // Normalize IMDb ID format
  if (!imdbId.startsWith('tt')) {
    imdbId = `tt${imdbId}`;
  }
  
  console.log(`[Stremio] Processing request for IMDb ID: ${imdbId}`);
  
  // Check if we already have this subtitle
  const potentialFilename = path.join(subsDir, `${imdbId}_he.srt`);
  if (fs.existsSync(potentialFilename)) {
    console.log(`[Stremio] Found existing Hebrew subtitle for ${imdbId}`);
    const subtitleUrl = `/subs/${path.basename(potentialFilename)}`;
    
    return Promise.resolve({
      subtitles: [
        {
          id: `ai-he-${imdbId}`,
          lang: 'heb',
          url: subtitleUrl
        }
      ]
    });
  }

  try {
    console.log(`[Stremio] Starting translation process for ${imdbId}`);
    
    const fileUrl = await getEnglishSubtitleFileUrl(imdbId);
    if (!fileUrl) {
      console.log(`[Stremio] No suitable English subtitle download URL found for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const originalSrt = await downloadSubtitleText(fileUrl);
    if (!originalSrt) {
      console.log(`[Stremio] Failed to download English subtitles for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const translatedSrt = await translateToHebrew(originalSrt);
    if (!translatedSrt) {
      console.log(`[Stremio] Failed to translate subtitles for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const localPath = saveSubtitleToFile(translatedSrt, imdbId);
    if (!localPath) {
      console.log(`[Stremio] Failed to save translated subtitles locally for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const subtitleUrl = `/subs/${path.basename(localPath)}`;
    console.log(`[Stremio] Serving translated subtitle at relative URL: ${subtitleUrl}`);

    return Promise.resolve({
      subtitles: [
        {
          id: `ai-he-${imdbId}`,
          lang: 'heb',
          url: subtitleUrl
        }
      ]
    });

  } catch (error) {
    logError(`Stremio Handler for ${imdbId}`, error);
    return Promise.resolve({ subtitles: [] });
  }
});

// === Step 6: Setup Express Server (Improved) ===
const addonInterface = builder.getInterface();

// Better logging middleware
app.use((req, res, next) => {
  console.log(`[Server] ${req.method} ${req.path}`);
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[Server] Completed ${req.method} ${req.path} - ${res.statusCode} in ${duration}ms`);
  });
  next();
});

// Serve the manifest
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(addonInterface.manifest);
});

// Define subtitles endpoint with custom handler
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  console.log(`[Server] Handling subtitle request: ${req.path}`);
  const { type, id } = req.params;
  
  try {
    const result = await addonInterface.subtitles({ type, id });
    res.setHeader('Content-Type', 'application/json');
    res.send(result);
  } catch (error) {
    logError("Subtitle Endpoint", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve the static subtitle files from the 'subs' directory
app.use('/subs', express.static(subsDir));

// Health check endpoint
app.get('/health', (req, res) => {
  const status = {
    service: 'stremio-hebrew-subtitles',
    status: 'ok',
    timestamp: new Date().toISOString(),
    envVarsSet: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      OPENSUB_API_KEY: !!process.env.OPENSUB_API_KEY
    },
    subsDirectory: {
      exists: fs.existsSync(subsDir),
      path: subsDir
    }
  };
  res.json(status);
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Stremio Hebrew AI Subtitle Addon</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>Stremio Hebrew AI Subtitle Addon</h1>
      <p>This addon fetches English subtitles and translates them to Hebrew using AI.</p>
      <p>To install in Stremio, add this URL to your addons:</p>
      <code>${process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`}/manifest.json</code>
      <p>Status: <strong>Running</strong></p>
      <p><a href="/health">Check Health Status</a></p>
    </body>
    </html>
  `);
});

// Fall-back route for any other requests coming from Stremio
app.get('*', (req, res, next) => {
  console.log(`[Server] Unhandled GET request: ${req.path}`);
  if (req.path.endsWith('.json')) {
    // This might be a Stremio request we didn't anticipate
    console.log('[Server] Returning empty JSON response for .json request');
    return res.json({ });
  }
  next();
});

// === Step 7: Start the server ===
function startServer() {
  // Validate environment before starting
  if (!validateEnvironment()) {
    console.error('Failed environment validation. Server will not start.');
    process.exit(1);
  }
  
  // Ensure subs directory
  if (!ensureSubsDirectory()) {
    console.error('Failed to set up subs directory. Server will not start.');
    process.exit(1);
  }
  
  const port = process.env.PORT || 7000;
  app.listen(port, () => {
    console.log('=====================================');
    console.log(`Stremio Addon Server listening on port ${port}`);
    const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    console.log(`Manifest URL: ${host}/manifest.json`);
    console.log(`Stremio Install URL: stremio://app.strem.io/addo/${encodeURIComponent(`${host}/manifest.json`)}`);
    console.log(`Serving subtitles from: ${subsDir}`);
    console.log('=====================================');
  });
}

// Start the server
startServer();