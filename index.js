const { addonBuilder } = require('stremio-addon-sdk');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SUBS_DIR = path.join(__dirname, 'subs');

// ודא שהתיקייה קיימת
if (!fs.existsSync(SUBS_DIR)) {
    fs.mkdirSync(SUBS_DIR);
    console.log("Successfully created 'subs' directory.");
}

const app = express();
app.use('/subs', express.static(SUBS_DIR));

// בניית התוסף
const builder = new addonBuilder({
    id: 'community.hebrew-translator',
    version: '1.0.2',
    name: 'AI Hebrew Subtitles (GPT)',
    description: 'Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`Received subtitles request for ${type} with id ${id}`);

    // דוגמה: החזרת כתוביות מדומות בעברית
    const subtitleUrl = `https://stremio-hebrew-subtitles.onrender.com/subs/${id}.vtt`;

    // בעתיד, כאן תוכל לבדוק אם קיימת כבר גרסה מתורגמת או להפעיל את GPT לתרגום
    return {
        subtitles: [
            {
                id: 'hebrew-ai',
                lang: 'he',
                url: subtitleUrl
            }
        ]
    };
});

const port = process.env.PORT || 7000;
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(builder.getInterface()));
});

app.get('/', (req, res) => {
    res.send('Stremio Hebrew Subtitles Addon is running.');
});

app.listen(port, () => {
    console.log(`Stremio Addon Server listening on port ${port}`);
    console.log(`Manifest URL: https://stremio-hebrew-subtitles.onrender.com/manifest.json`);
    console.log(`Serving subtitles from: ${SUBS_DIR}`);
});
