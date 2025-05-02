require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { OpenAI } = require('openai');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === שלב 1: משיכת כתוביות באנגלית מ־OpenSubtitles ===
async function getEnglishSubtitleFileUrl(imdbId) {
  const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
    params: {
      imdb_id: imdbId,
      languages: 'en',
      order_by: 'downloads',
    },
    headers: {
      'Api-Key': process.env.OPENSUB_API_KEY,
    }
  });

  const best = response.data.data?.[0];
  if (!best) return null;

  const fileId = best.attributes.files[0].file_id;

  const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', {
    file_id: fileId
  }, {
    headers: { 'Api-Key': process.env.OPENSUB_API_KEY }
  });

  return downloadRes.data.link;
}

// === שלב 2: הורדת קובץ כתוביות וטקסט ===
async function downloadSubtitleText(url) {
  const res = await axios.get(url);
  return res.data;
}

// === שלב 3: תרגום ===
async function translateToHebrew(text) {
  const chat = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'Translate the following .srt subtitles from English to Hebrew. Keep the format of subtitle file intact.'
      },
      {
        role: 'user',
        content: text
      }
    ]
  });

  return chat.choices[0].message.content;
}

// === שלב 4: שמירת כתובית זמנית ===
function saveSubtitleToFile(content, imdbId) {
  const path = `./subs/${imdbId}_he.srt`;
  fs.writeFileSync(path, content);
  return path;
}

// === שלב 5: תוסף Stremio ===
const manifest = {
  id: 'community.hebrew-translator',
  version: '1.0.0',
  name: 'AI Hebrew Subtitles',
  description: 'Translate English subtitles to Hebrew using GPT',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async ({ id }) => {
  const imdbId = id.replace('tt', '');

  const fileUrl = await getEnglishSubtitleFileUrl(imdbId);
  if (!fileUrl) return { subtitles: [] };

  const original = await downloadSubtitleText(fileUrl);
  const translated = await translateToHebrew(original);

  if (!fs.existsSync('./subs')) fs.mkdirSync('./subs');

  const localPath = saveSubtitleToFile(translated, imdbId);

  return {
    subtitles: [
      {
        id: 'hebrew-ai',
        lang: 'he',
        url: `https://stremio-hebrew-subtitles.onrender.com/subs/${imdbId}_he.srt`
      }
    ]
  };
});

// === שימוש נכון ב-getInterface ===
const addonInterface = builder.getInterface();

app.get('/subtitles-addon/manifest.json', (req, res) => {
  res.json(addonInterface.manifest);
});
app.use('/subtitles-addon', addonInterface);
app.use('/subs', express.static('subs'));

const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(`Addon is running on port ${port}`);
});
