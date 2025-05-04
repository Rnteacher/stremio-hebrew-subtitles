require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
// Import addonBuilder from the SDK
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure the 'subs' directory exists
const subsDir = path.join(__dirname, 'subs');
if (!fs.existsSync(subsDir)) {
  try {
    fs.mkdirSync(subsDir);
    console.log("Successfully created 'subs' directory.");
  } catch (err) {
    console.error("Error creating 'subs' directory:", err);
  }
} else {
    console.log("'subs' directory already exists.");
}

// === Step 1: Fetch English subtitle file URL from OpenSubtitles ===
async function getEnglishSubtitleFileUrl(imdbId) {
  console.log(`Workspaceing English subtitles for IMDb ID: ${imdbId}`);
  try {
    const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params: {
        imdb_id: imdbId, // This should be just the number part, e.g., '0111161'
        languages: 'en',
        order_by: 'downloads',
        // You might want to add season and episode filters here for series
        // season_number: extra.season, // Example if you pass season/episode
        // episode_number: extra.episode
      },
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!response.data || !response.data.data || response.data.data.length === 0) {
      console.log('No English subtitles found for this IMDb ID.');
      return null;
    }
    const bestSubtitle = response.data.data[0];
    if (!bestSubtitle || !bestSubtitle.attributes || !bestSubtitle.attributes.files || bestSubtitle.attributes.files.length === 0) {
      console.log('Found subtitle entry, but no files associated.');
      return null;
    }
    const fileId = bestSubtitle.attributes.files[0].file_id;
    console.log(`Found subtitle file ID: ${fileId}`);

    const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', {
      file_id: fileId
    }, {
      headers: {
        'Api-Key': process.env.OPENSUB_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
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
    const res = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'StremioHebrewAddon/1.0' }
    });
    console.log('Subtitle file downloaded successfully.');
    return res.data;
  } catch (error) {
    console.error('Error downloading subtitle file:', error.message);
    return null;
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
      model: 'gpt-3.5-turbo', // Consider gpt-4-turbo for potentially better quality
      messages: [
        {
          role: 'system',
          content: `Translate the following English .srt subtitle text to Hebrew.
                    Preserve the .srt format exactly, including timestamps, line numbers, and line breaks.
                    Translate only the dialogue/text portions.
                    Ensure the output is valid UTF-8 encoded Hebrew text.`
        },
        { role: 'user', content: text }
      ],
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
    return null;
  }
}

// === Step 4: Save subtitle temporarily ===
function saveSubtitleToFile(content, filenameId) {
  const filePath = path.join(subsDir, `${filenameId}_he.srt`); // Use the ID for the filename
  console.log(`Saving translated subtitle to: ${filePath}`);
  try {
    if (typeof content !== 'string') {
        throw new Error('Content to save is not a string.');
    }
    // Ensure directory exists before writing, although it should be created on startup
    if (!fs.existsSync(subsDir)) {
      fs.mkdirSync(subsDir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
    console.log(`Successfully saved file: ${filePath}`);
    return path.basename(filePath); // Return just the filename
  } catch (error) {
    console.error(`Error saving subtitle file ${filePath}:`, error);
    return null;
  }
}


// === Stremio Addon Setup ===

// Define the manifest
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.5', // Increment version
  name: 'AI Hebrew Subtitles (GPT)',
  description: 'Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).',
  resources: ['subtitles'], // Declare subtitles as a resource
  types: ['movie', 'series'], // Types of content the addon provides subtitles for
  idPrefixes: ['tt'], // Stremio uses IMDb IDs prefixed with 'tt'
  catalogs: [] // No catalogs provided by this addon
};

// Build the addon interface
const builder = new addonBuilder(manifest);

// === Define the Subtitles Handler ===
// This replaces the manual app.get('/subtitles/:type/:id.json', ...) route
builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    console.log(`Received subtitle request - Type: ${type}, ID: ${id}, Extra:`, extra);

    // The 'id' parameter will be the Stremio content ID (e.g., "tt123456" or "tt123456:1:2")
    // We need the numeric IMDb part for the OpenSubtitles API call.
    // Use a regex to extract the 'tt' followed by digits part.
    const imdbMatch = id.match(/^(tt\d+)/);
    const imdbIdWithPrefix = imdbMatch ? imdbMatch[1] : null; // e.g., "tt123456"

    if (!imdbIdWithPrefix) {
        console.error(`Could not extract valid IMDb ID from request ID: ${id}`);
        return { subtitles: [] }; // Return empty array for invalid ID format
    }

    const imdbIdNumeric = imdbIdWithPrefix.replace('tt', ''); // For OpenSubtitles API (e.g., "123456")

    try {
        // 1. Get English subtitle URL from OpenSubtitles using the numeric IMDb ID
        // You might want to enhance getEnglishSubtitleFileUrl to use extra.season and extra.episode for series.
        const fileUrl = await getEnglishSubtitleFileUrl(imdbIdNumeric);
        if (!fileUrl) {
            console.log(`No suitable English subtitle download URL found for ${id}.`);
            return { subtitles: [] };
        }

        // 2. Download the English subtitle text
        const originalSrt = await downloadSubtitleText(fileUrl);
        if (!originalSrt) {
            console.log(`Failed to download English subtitles for ${id}.`);
            return { subtitles: [] };
        }

        // 3. Translate the text
        const translatedSrt = await translateToHebrew(originalSrt);
        if (!translatedSrt) {
            console.log(`Failed to translate subtitles for ${id}.`);
            return { subtitles: [] };
        }

        // 4. Save the translated text to a file
        // Use the original Stremio ID (e.g., "tt123456" or "tt123456:1:2") for the filename to make it unique per episode
        const savedFilename = saveSubtitleToFile(translatedSrt, id.replace(/[:.]/g, '_')); // Replace special characters for filename safety
        if (!savedFilename) {
            console.log(`Failed to save translated subtitles locally for ${id}.`);
            return { subtitles: [] };
        }

        // 5. Construct the URL to serve the file
        // The Stremio client will request this URL
        const subtitleUrl = `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`}/subs/${savedFilename}`;
         console.log(`Serving translated subtitle at URL: ${subtitleUrl}`);


        // 6. Return the subtitle information structure expected by Stremio
        return {
            subtitles: [
                {
                    id: `ai-he-${id}`, // Unique ID for this subtitle stream based on content ID
                    lang: 'heb', // 3-letter ISO 639-2 B code for Hebrew
                    url: subtitleUrl, // The full URL Stremio will fetch
                    // You can add 'featured: 1' to make it appear at the top
                    // featured: 1
                }
            ]
        };

    } catch (error) {
        console.error(`Unexpected error in subtitles handler for ${id}:`, error);
        return { subtitles: [] }; // Return empty on error
    }
});


// === Setup Express Server ===

// Serve the manifest from the builder
app.get('/manifest.json', (req, res) => {
    // Use the getInterface() method to get the generated manifest object
    const addonInterface = builder.getInterface();
    if (!addonInterface || !addonInterface.manifest) {
        console.error('Error: Addon manifest is not available from builder!');
        res.status(500).send('Internal Server Error: Addon manifest not configured.');
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.json(addonInterface.manifest);
});

// Serve the static subtitle files from the 'subs' directory
app.use('/subs', express.static(subsDir));

// Optional: Root handler for testing if the server is up
app.get('/', (req, res) => {
    res.send('Stremio Hebrew AI Subtitle Addon is running!');
});


// Mount the Stremio Addon SDK handlers
// The SDK will create routes like /subtitles/:type/:id.json based on the builder
// Ensure this is done *after* defining handlers with the builder
const addonInterface = builder.getInterface();
if (!addonInterface) {
     console.error('Error: Could not get addon interface from builder!');
     // Decide how to handle this error - maybe exit or just log and continue (likely won't work)
} else {
    app.use('/', addonInterface); // Mount the addon interface
}


// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(`Stremio Addon Server listening on port ${port}`);
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  console.log(`Manifest URL: ${host}/manifest.json`);
  console.log(`Serving static files from: ${subsDir}`);
});