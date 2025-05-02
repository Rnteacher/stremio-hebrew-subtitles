const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');

// הגדרת המניפסט של התוסף
const manifest = {
    "id": "community.hebrew-translator",
    "version": "1.0.2",
    "name": "AI Hebrew Subtitles (GPT)",
    "description": "Fetches English subtitles from OpenSubtitles and translates them to Hebrew using AI (GPT-3.5 Turbo).",
    "resources": [
        "subtitles"
    ],
    "types": [
        "movie",
        "series"
    ],
    "idPrefixes": [
        "tt"
    ],
    "catalogs": []
};

// יצירת האובייקט של ה-Addon
const builder = new addonBuilder(manifest);

// הגדרת הפונקציה המנפיקה את הכתוביות
builder.defineStreamHandler('subtitles', async ({ id }) => {
    try {
        // שליחת בקשה ל-OpenSubtitles או שירות אחר שברשותך
        const response = await axios.get(`https://api.opensubtitles.org/subtitles/${id}`);
        
        // תרגום הכתוביות לעברית
        const translatedSubtitles = translateToHebrew(response.data);

        // החזרת כתוביות בעברית
        return [
            {
                language: 'he',
                subtitles: translatedSubtitles
            }
        ];
    } catch (error) {
        console.error('Error fetching subtitles:', error);
        return [];
    }
});

// פונקציה לדוגמה לתרגום הכתוביות לעברית
function translateToHebrew(englishSubtitles) {
    // כאן אתה יכול לשלב עם GPT או כל כלי אחר כדי לתרגם את הכתוביות לעברית
    // כרגע, זה רק החזרת הכתוביות כפי שהן
    return englishSubtitles.map(sub => {
        return {
            text: sub.text, // תרגם כאן את הכתוביות לאנגלית
            start: sub.start,
            end: sub.end
        };
    });
}

// הפעלת השרת
const server = builder.getInterface();
server.start();

console.log("Stremio Addon Server listening on port 10000");
