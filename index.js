require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // Import path module
const { OpenAI } = require('openai');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(cors());


// Ensure the 'subs' directory exists
const subsDir = path.join(__dirname, 'subs'); // Use absolute path
if (!fs.existsSync(subsDir)) {
  try {
    fs.mkdirSync(subsDir);
    console.log("Successfully created 'subs' directory.");
  } catch (err) {
    console.error("Error creating 'subs' directory:", err);
    // Depending on the error, you might want to exit or handle differently
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
    const res = await axios.get(url, {
        timeout: 15000, // Increase timeout for download
        headers: {
            'User-Agent': 'StremioHebrewAddon/1.0'
        }
    });
    console.log('Subtitle file downloaded successfully.');
    return res.data; // Assuming it's text (.srt)
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
      model: 'gpt-3.5-turbo', 
      messages: [
        {
          role: 'system',
          content: `Translate the following English .srt subtitle text to Hebrew.
                    Preserve the .srt format exactly, including timestamps, line numbers, and line breaks.
                    Translate only the dialogue/text portions.
                    Ensure the output is valid UTF-8 encoded Hebrew text.`
        },
        {
          role: 'user',
          content: text
        }
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
  const filePath = path.join(subsDir, `${imdbId}_he.srt`);
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

// === Step 5: Stremio Addon Definition ===
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.2',
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
  console.log('Subtitles handler invoked with args:', args);

  const imdbId = args.id;
  if (!imdbId || !imdbId.startsWith('tt')) {
    console.error('Invalid IMDb ID received:', args.id);
    return Promise.resolve({ subtitles: [] });
  }

  try {
    const fileUrl = await getEnglishSubtitleFileUrl(imdbId);
    if (!fileUrl) {
      console.log(`No suitable English subtitle download URL found for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const originalSrt = await downloadSubtitleText(fileUrl);
    if (!originalSrt) {
      console.log(`Failed to download English subtitles for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const translatedSrt = await translateToHebrew(originalSrt);
    if (!translatedSrt) {
      console.log(`Failed to translate subtitles for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const localPath = saveSubtitleToFile(translatedSrt, imdbId);
    if (!localPath) {
      console.log(`Failed to save translated subtitles locally for ${imdbId}.`);
      return Promise.resolve({ subtitles: [] });
    }

    const subtitleUrl = `/subs/${path.basename(localPath)}`;
    console.log(`Serving translated subtitle at relative URL: ${subtitleUrl}`);

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
    console.error(`Unexpected error in subtitles handler for ${imdbId}:`, error);
    return Promise.resolve({ subtitles: [] });
  }
});

// === Step 6: Setup Express Server ===
const addonInterface = builder.getInterface();

// Serve the manifest
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(addonInterface.manifest);
});

// Serve the static subtitle files from the 'subs' directory
app.use('/subs', express.static(subsDir));

app.get('/', (req, res) => {
    res.send('Stremio Hebrew AI Subtitle Addon is running!');
});

// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(`Stremio Addon Server listening on port ${port}`);
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  console.log(`Manifest URL: ${host}/manifest.json`);
  console.log(`Serving subtitles from: ${subsDir}`);
});
