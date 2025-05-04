require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // Import path module
const { OpenAI } = require('openai');
const { addonBuilder } = require('stremio-addon-sdk'); // Still needed for manifest generation

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
  }
} else {
    console.log("'subs' directory already exists.");
}


// === Step 1: Fetch English subtitle file URL from OpenSubtitles ===
async function getEnglishSubtitleFileUrl(imdbId) {
  // Keep the implementation from the previous version
  console.log(`Fetching English subtitles for IMDb ID: ${imdbId}`);
  try {
    const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params: {
        imdb_id: imdbId, // This should be just the number part, e.g., '0111161'
        languages: 'en',
        order_by: 'downloads',
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
  // Keep the implementation from the previous version
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
  // Keep the implementation from the previous version
  console.log('Starting translation to Hebrew...');
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
      console.error('Translation error: Input text is empty or invalid.');
      return null;
  }
  try {
    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
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
function saveSubtitleToFile(content, imdbId) {
  // Keep the implementation from the previous version
  const filePath = path.join(subsDir, `${imdbId}_he.srt`); // imdbId here includes 'tt'
  console.log(`Saving translated subtitle to: ${filePath}`);
  try {
    if (typeof content !== 'string') {
        throw new Error('Content to save is not a string.');
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
    console.log(`Successfully saved file: ${filePath}`);
    return filePath;
  } catch (error) {
    console.error(`Error saving subtitle file ${filePath}:`, error);
    return null;
  }
}

// === Step 5: Stremio Addon Manifest Definition ===
// We still use addonBuilder to easily create the manifest structure
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.3', // Increment version
  name: 'AI Hebrew Subtitles (GPT)',
  description: 'Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};
const builder = new addonBuilder(manifest);
// We don't call builder.defineSubtitlesHandler anymore because we handle the route manually


// === NEW: Function to handle the subtitle logic ===
async function handleSubtitleRequest(imdbIdWithPrefix) {
    console.log(`Handling subtitle request for ID: ${imdbIdWithPrefix}`);
    if (!imdbIdWithPrefix || !imdbIdWithPrefix.startsWith('tt')) {
        console.error('Invalid IMDb ID received:', imdbIdWithPrefix);
        return { subtitles: [] }; // Return empty array for invalid ID
    }

    const imdbIdNumeric = imdbIdWithPrefix.replace('tt', ''); // For OpenSubtitles API

    try {
        // 1. Get English subtitle URL
        const fileUrl = await getEnglishSubtitleFileUrl(imdbIdNumeric); // Use numeric ID
        if (!fileUrl) {
            console.log(`No suitable English subtitle download URL found for ${imdbIdWithPrefix}.`);
            return { subtitles: [] };
        }

        // 2. Download the English subtitle text
        const originalSrt = await downloadSubtitleText(fileUrl);
        if (!originalSrt) {
            console.log(`Failed to download English subtitles for ${imdbIdWithPrefix}.`);
            return { subtitles: [] };
        }

        // 3. Translate the text
        const translatedSrt = await translateToHebrew(originalSrt);
        if (!translatedSrt) {
            console.log(`Failed to translate subtitles for ${imdbIdWithPrefix}.`);
            return { subtitles: [] };
        }

        // 4. Save the translated text to a file
        // Pass the ID *with* 'tt' prefix for the filename to match the request ID
        const localPath = saveSubtitleToFile(translatedSrt, imdbIdWithPrefix);
        if (!localPath) {
            console.log(`Failed to save translated subtitles locally for ${imdbIdWithPrefix}.`);
            return { subtitles: [] };
        }

        // 5. Construct the URL to serve the file
        const subtitleUrl = `/subs/${path.basename(localPath)}`; // Relative URL
        console.log(`Serving translated subtitle at relative URL: ${subtitleUrl}`);

        // 6. Return the subtitle information structure
        return {
            subtitles: [
                {
                    id: `ai-he-${imdbIdWithPrefix}`, // Unique ID for this subtitle stream
                    lang: 'heb', // 3-letter code
                    url: subtitleUrl // The URL Stremio will fetch
                }
            ]
        };

    } catch (error) {
        console.error(`Unexpected error in handleSubtitleRequest for ${imdbIdWithPrefix}:`, error);
        return { subtitles: [] }; // Return empty on error
    }
}


// === Step 6: Setup Express Server ===

// Serve the manifest (using the manifest from the builder)
app.get('/manifest.json', (req, res) => {
  // Get the manifest object generated by the builder
  const addonManifest = builder.getInterface().manifest;
  if (!addonManifest) {
      console.error('Error: Addon manifest is not available!');
      res.status(500).send('Internal Server Error: Addon manifest not configured.');
      return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(addonManifest);
});

// *** NEW: Manually define the subtitles route ***
// This pattern matches /subtitles/movie/tt123456.json or /subtitles/series/tt123456:1:2.json etc.
// The :extra? makes the season/episode part optional and non-capturing for our needs here.
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
    const { type, id, extra } = req.params;
    console.log(`Received subtitle request - Type: ${type}, ID: ${id}, Extra: ${extra}`);

    // The 'id' parameter from the route (e.g., 'tt123456') is what we need
    const result = await handleSubtitleRequest(id);

    res.setHeader('Content-Type', 'application/json');
    res.json(result); // Send the { subtitles: [...] } structure or { subtitles: [] } on error/not found
});


// Serve the static subtitle files from the 'subs' directory
app.use('/subs', express.static(subsDir));

// Optional: Root handler for testing if the server is up
app.get('/', (req, res) => {
    res.send('Stremio Hebrew AI Subtitle Addon is running (Manual Route)!');
});


// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(`Stremio Addon Server listening on port ${port}`);
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  console.log(`Manifest URL: ${host}/manifest.json`);
  console.log(`Serving subtitles from: ${subsDir}`);
});
