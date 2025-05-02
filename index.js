require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // Import path module
const { OpenAI } = require('openai');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure the 'subs' directory exists
const subsDir = path.join(__dirname, 'subs'); // Use absolute path
if (!fs.existsSync(subsDir)) {
  try {
    fs.mkdirSync(subsDir);
    console.log("Successfully created 'subs' directory.");
  } catch (err) {
    console.error("Error creating 'subs' directory:", err);
    // Depending on the error, you might want to exit or handle differently
    // For Render's ephemeral filesystem, this might fail if permissions are wrong
  }
} else {
    console.log("'subs' directory already exists.");
}


// === Step 1: Fetch English subtitle file URL from OpenSubtitles ===
async function getEnglishSubtitleFileUrl(imdbId) {
  console.log(`Fetching English subtitles for IMDb ID: ${imdbId}`);
  try {
    const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params: {
        imdb_id: imdbId,
        languages: 'en',
        order_by: 'downloads', // You might want 'ratings' or another criteria
        // Consider adding type: 'movie' or 'episode' if needed
      },
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json', // Good practice to include
        'Accept': 'application/json'       // Good practice to include
      },
      timeout: 10000 // Add timeout (10 seconds)
    });

    // Check if data exists and is not empty
    if (!response.data || !response.data.data || response.data.data.length === 0) {
      console.log('No English subtitles found for this IMDb ID.');
      return null;
    }

    // Find the best subtitle file (e.g., the first one)
    const bestSubtitle = response.data.data[0];
    if (!bestSubtitle || !bestSubtitle.attributes || !bestSubtitle.attributes.files || bestSubtitle.attributes.files.length === 0) {
      console.log('Found subtitle entry, but no files associated.');
      return null;
    }

    const fileId = bestSubtitle.attributes.files[0].file_id;
    console.log(`Found subtitle file ID: ${fileId}`);

    // Request download link
    const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', {
      file_id: fileId
    }, {
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000 // Add timeout
    });

    if (!downloadRes.data || !downloadRes.data.link) {
      console.error('Failed to get download link from OpenSubtitles.');
      return null;
    }

    console.log(`Got download link: ${downloadRes.data.link}`);
    return downloadRes.data.link;

  } catch (error) {
    console.error('Error fetching subtitles from OpenSubtitles:', error.response ? error.response.data : error.message);
    return null;
  }
}

// === Step 2: Download subtitle text ===
async function downloadSubtitleText(url) {
  console.log(`Downloading subtitle text from: ${url}`);
  try {
    // IMPORTANT: OpenSubtitles download links often expire quickly and might require specific headers (like User-Agent)
    // or might redirect. Axios handles redirects by default.
    const res = await axios.get(url, {
        timeout: 15000, // Increase timeout for download
        // Sometimes a User-Agent header helps
        headers: {
            'User-Agent': 'StremioHebrewAddon/1.0'
        }
    });
    console.log('Subtitle file downloaded successfully.');
    return res.data; // Assuming it's text (.srt)
  } catch (error) {
    console.error('Error downloading subtitle file:', error.message);
    if (error.response) {
        console.error('Download error status:', error.response.status);
        console.error('Download error headers:', error.response.headers);
    }
    return null; // Indicate failure
  }
}

// === Step 3: Translate using AI ===
async function translateToHebrew(text) {
  console.log('Starting translation to Hebrew...');
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
      console.error('Translation error: Input text is empty or invalid.');
      return null;
  }
  try {
    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // Consider newer/cheaper models if available/suitable
      messages: [
        {
          role: 'system',
          // More specific instructions might yield better results
          content: `Translate the following English .srt subtitle text to Hebrew.
                    Preserve the .srt format exactly, including timestamps, line numbers, and line breaks.
                    Translate only the dialogue/text portions.
                    Ensure the output is valid UTF-8 encoded Hebrew text.`
        },
        {
          role: 'user',
          content: text // Ensure text is not excessively long for the model's context window
        }
      ],
      // Optional: add temperature, max_tokens etc. if needed
      // temperature: 0.7,
      // max_tokens: 2048, // Adjust based on expected subtitle length
    });

    if (!chat.choices || chat.choices.length === 0 || !chat.choices[0].message || !chat.choices[0].message.content) {
        console.error('Translation error: Invalid response structure from OpenAI API.');
        return null;
    }

    const translatedText = chat.choices[0].message.content;
    console.log('Translation successful.');
    return translatedText;

  } catch (error) {
    console.error('Error calling OpenAI API:', error.response ? error.response.data : error.message);
    return null; // Indicate failure
  }
}

// === Step 4: Save subtitle temporarily ===
// Note: Render's free tier has an ephemeral filesystem. Files written might disappear on deploy or restart.
// For persistence, consider cloud storage (S3, Google Cloud Storage) or a database.
// For temporary use, the local filesystem might work for a single instance, but isn't scalable or reliable long-term.
function saveSubtitleToFile(content, imdbId) {
  // Use the absolute path defined earlier
  const filePath = path.join(subsDir, `${imdbId}_he.srt`);
  console.log(`Saving translated subtitle to: ${filePath}`);
  try {
    // Ensure content is a string before writing
    if (typeof content !== 'string') {
        throw new Error('Content to save is not a string.');
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8' }); // Specify UTF-8 encoding
    console.log(`Successfully saved file: ${filePath}`);
    return filePath; // Return the full path
  } catch (error) {
    console.error(`Error saving subtitle file ${filePath}:`, error);
    return null; // Indicate failure
  }
}

// === Step 5: Stremio Addon Definition ===
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.2', // Increment version for changes
  name: 'AI Hebrew Subtitles (GPT)',
  description: 'Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'], // Important: Tells Stremio this addon works for IMDb IDs
  catalogs: [] // No catalogs needed for a subtitle addon
};

console.log('--- SDK BUILDER LOGGING START ---');
console.log('Attempting to create addonBuilder...');
const builder = new addonBuilder(manifest);
console.log('addonBuilder created.');

console.log('Attempting to define Subtitles Handler...');
builder.defineSubtitlesHandler(async (args) => {
  console.log('Subtitles handler invoked with args:', args);

  // Extract IMDb ID correctly (it's in args.id, e.g., "tt123456")
  const imdbId = args.id;
  if (!imdbId || !imdbId.startsWith('tt')) {
    console.error('Invalid IMDb ID received:', args.id);
    return Promise.resolve({ subtitles: [] });
  }

  // --- Main Logic ---
  try {
    // 1. Get English subtitle URL
    const fileUrl = await getEnglishSubtitleFileUrl(imdbId);
    if (!fileUrl) {
      console.log(`No suitable English subtitle download URL found for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] }); // Resolve with empty array if no subs found
    }

    // 2. Download the English subtitle text
    const originalSrt = await downloadSubtitleText(fileUrl);
    if (!originalSrt) {
      console.log(`Failed to download English subtitles for ${imdbId} from ${fileUrl}.`);
      return Promise.resolve({ subtitles: [] });
    }

    // 3. Translate the text
    const translatedSrt = await translateToHebrew(originalSrt);
    if (!translatedSrt) {
      console.log(`Failed to translate subtitles for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    // 4. Save the translated text to a file
    // Note: This uses the local filesystem, see warning above.
    const localPath = saveSubtitleToFile(translatedSrt, imdbId);
    if (!localPath) {
      console.log(`Failed to save translated subtitles locally for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    // 5. Construct the URL to serve the file
    // Ensure your Render service URL is correctly configured if needed.
    // If running locally, this would be localhost. On Render, it's your service URL.
    // Using a relative path might be simpler if served by the same app.
    const subtitleUrl = `/subs/${path.basename(localPath)}`; // Relative URL
    console.log(`Serving translated subtitle at relative URL: ${subtitleUrl}`);

    // 6. Return the subtitle information to Stremio
    return Promise.resolve({
      subtitles: [
        {
          id: `ai-he-${imdbId}`, // Unique ID for this subtitle stream
          lang: 'heb', // Use 3-letter ISO 639-2 code for Hebrew ('heb')
          url: subtitleUrl // The URL Stremio will use to fetch the .srt file
        }
      ]
    });

  } catch (error) {
    console.error(`Unexpected error in subtitles handler for ${imdbId}:`, error);
    // Don't throw, resolve with empty array to avoid crashing Stremio requests
    return Promise.resolve({ subtitles: [] });
  }
});
console.log('Subtitles Handler defined.');

console.log('Attempting to get addon interface...');
const addonInterface = builder.getInterface();
console.log('Addon interface obtained.');
console.log('--- SDK BUILDER LOGGING END ---');


// *** DIAGNOSTIC LOGGING START (Existing) ***
console.log('--- DIAGNOSTICS ---');
console.log('Addon Interface Object:', JSON.stringify(addonInterface, null, 2)); // Stringify for better logging
console.log('Type of addonInterface.manifest:', typeof addonInterface.manifest);
console.log('Type of addonInterface.middleware:', typeof addonInterface.middleware);
console.log('--- END DIAGNOSTICS ---');
// *** DIAGNOSTIC LOGGING END ***


// Serve the manifest
// Make sure this route is defined *before* the addon middleware if they might conflict
// (Though typically /manifest.json won't conflict with /subtitles/...)
app.get('/manifest.json', (req, res) => {
  if (!addonInterface || !addonInterface.manifest) {
      console.error('Error: addonInterface or addonInterface.manifest is not available!');
      res.status(500).send('Internal Server Error: Addon manifest not configured.');
      return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(addonInterface.manifest);
});

// Check if middleware exists and is a function before using it
if (addonInterface && typeof addonInterface.middleware === 'function') {
  console.log('Addon middleware is a function. Applying app.use()...');
  // Serve the addon logic (subtitles endpoint)
  app.use(addonInterface.middleware);
} else {
  console.error('CRITICAL ERROR: addonInterface.middleware is not a function or addonInterface is invalid.');
  console.error('Addon middleware will not be configured. Subtitle requests will likely fail.');
  // Optional: You might want to prevent the server from starting or return errors
  // For now, we just log the error, the server will start but subtitle requests won't work.
}


// Serve the static subtitle files from the 'subs' directory
// Ensure this path matches where files are saved and the URL constructed above
app.use('/subs', express.static(subsDir)); // Serve files from the absolute path

// Optional: Root handler for testing if the server is up
app.get('/', (req, res) => {
    res.send('Stremio Hebrew AI Subtitle Addon is running!');
});


// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(`Stremio Addon Server listening on port ${port}`);
  // Construct the manifest URL based on Render's environment variable if available, otherwise localhost
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  console.log(`Manifest URL: ${host}/manifest.json`);
  console.log(`Serving subtitles from: ${subsDir}`);
});
