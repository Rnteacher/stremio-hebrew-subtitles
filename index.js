

// יצירת ספריית subs אם לא קיימת
const subsDir = path.join(__dirname, 'subs');
if (!fs.existsSync(subsDir)) {
    fs.mkdirSync(subsDir);
    console.log("Successfully created 'subs' directory.");
}

// הגדרת המניפסט של התוסף
const manifest = {
    id: "community.hebrew-translator",
    version: "1.0.2",
    name: "AI Hebrew Subtitles (GPT)",
    description: "Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).",
    resources: ["subtitles"],  // ✅ זה חשוב - רק subtitles
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// כאן נגדיר את פונקציית הכתוביות
builder.defineSubtitlesHandler(({ type, id }) => {
    // הדוגמה הזו מחזירה כתוביות מדומות, תוכל להחליף את זה ב-API אמיתי + תרגום
    return Promise.resolve({
        subtitles: [
            {
                id: "hebrew-ai-sub",
                lang: "he",
                label: "Hebrew (AI Translated)",
                url: `https://stremio-hebrew-subtitles.onrender.com/subs/${id}.srt`
            }
        ]
    });
});

// התחלת השרת
module.exports = builder.getInterface();
const { addonBuilder } = require('stremio-addon-sdk');
const fs = require('fs');
const path = require('path');
const http = require('http');

const subsDir = path.join(__dirname, 'subs');
if (!fs.existsSync(subsDir)) {
    fs.mkdirSync(subsDir);
    console.log("Successfully created 'subs' directory.");
}

const manifest = {
    id: "community.hebrew-translator",
    version: "1.0.2",
    name: "AI Hebrew Subtitles (GPT)",
    description: "Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(({ type, id }) => {
    return Promise.resolve({
        subtitles: [
            {
                id: "hebrew-ai-sub",
                lang: "he",
                label: "Hebrew (AI Translated)",
                url: `https://stremio-hebrew-subtitles.onrender.com/subs/${id}.srt`
            }
        ]
    });
});

const addonInterface = builder.getInterface();
const port = process.env.PORT || 7000;

http.createServer((req, res) => {
    if (req.url === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(addonInterface.manifest));
    } else {
        addonInterface.middleware(req, res);
    }
}).listen(port, () => {
    console.log(`Stremio Addon Server listening on port ${port}`);
    console.log("Manifest URL: https://stremio-hebrew-subtitles.onrender.com/manifest.json");
    console.log("Serving subtitles from:", subsDir);
});

console.log("Manifest URL: https://stremio-hebrew-subtitles.onrender.com/manifest.json");
console.log("Serving subtitles from:", subsDir);
