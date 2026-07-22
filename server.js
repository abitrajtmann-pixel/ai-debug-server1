/**
 * סוכן AI לקו תוכן בימות המשיח
 * =================================
 * גרסה עם Gemini API + רוטציה בין כמה מפתחות (GEMINI_API_KEY, GEMINI_API_KEY1..4)
 * כדי לנצל את מלוא המכסה החינמית הזמינה בין החשבונות.
 *
 * תהליך לכל שאלה:
 * 1. call.read(..., 'record') - ימות מקליט את השאלה ומחזיר נתיב לקובץ (חינמי)
 * 2. מורידים את הקובץ מימות (DownloadFile API)
 * 3. שולחים את קובץ השמע ישירות ל-Gemini עם כלי חיפוש - מקבלים תשובה מוכנה
 *    אם מפתח מסוים חרג ממכסה (429), עוברים אוטומטית למפתח הבא ברשימה
 * 4. call.id_list_message(...) - ימות מקריא את התשובה בעצמו (TTS מובנה, חינמי)
 * 5. חוזרים לשלב 1 (לולאה) עד שהמאזין מנתק
 */

import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';

const app = express();

// -----------------------------------------------------------------------
// איסוף כל מפתחות ה-Gemini הזמינים ממשתני הסביבה
// -----------------------------------------------------------------------
const API_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY1,
    process.env.GEMINI_API_KEY2,
    process.env.GEMINI_API_KEY3,
    process.env.GEMINI_API_KEY4,
].filter(Boolean); // מסנן ערכים ריקים אם חסר מפתח כלשהו

if (API_KEYS.length === 0) {
    console.error('No GEMINI_API_KEY* environment variables found!');
}

// אינדקס "המפתח הבא לנסות" - נשמר בזיכרון בין שיחות, כדי לפזר עומס
let nextKeyIndex = 0;

const YEMOT_TOKEN = process.env.YEMOT_TOKEN; // לדוגמה "0779709932:7292"
const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';

const router = YemotRouter({
    printLog: true,
});

// -----------------------------------------------------------------------
// הורדת קובץ ההקלטה מימות
// -----------------------------------------------------------------------
async function downloadRecording(recordingPath) {
    const fullPath = recordingPath.startsWith('ivr2:') ? recordingPath : `ivr2:${recordingPath}`;
    const url = `${YEMOT_API_BASE}/DownloadFile?token=${encodeURIComponent(YEMOT_TOKEN)}&path=${encodeURIComponent(fullPath)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Yemot DownloadFile failed: ${resp.status}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const tmpFile = path.join(os.tmpdir(), `rec-${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, buffer);
    return tmpFile;
}

// -----------------------------------------------------------------------
// שליחת קובץ השמע ל-Gemini, עם רוטציה אוטומטית בין מפתחות במקרה של 429
// -----------------------------------------------------------------------
async function transcribeAndAnswer(audioFilePath) {
    const audioBytes = fs.readFileSync(audioFilePath);

    const promptParts = [
        { inlineData: { mimeType: 'audio/wav', data: audioBytes.toString('base64') } },
        {
            text:
                'הקובץ המצורף הוא הקלטה קולית של שאלה בעברית. תמלל אותה, ' +
                'ואז ענה על השאלה בעברית בלבד, בקצרה וברור ' +
                '(2-4 משפטים לכל היותר, מתאים להקראה בטלפון, ' +
                'בלי סימני פיסוק מיוחדים כמו מקף או גרש). ' +
                'אם צריך מידע עדכני, חפש באינטרנט. ' +
                'החזר רק את התשובה עצמה, בלי לחזור על התמלול או להסביר מה עשית.',
        },
    ];

    let lastError;

    // מנסים את כל המפתחות בתור, מתחילים מהמקום שהפסקנו בו בפעם הקודמת
    for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
        const keyIndex = (nextKeyIndex + attempt) % API_KEYS.length;
        const apiKey = API_KEYS[keyIndex];
        const genAI = new GoogleGenAI({ apiKey });

        try {
            const response = await genAI.models.generateContent({
                model: 'gemini-3.5-flash-lite',
                contents: [{ role: 'user', parts: promptParts }],
                config: { tools: [{ googleSearch: {} }] },
            });

            // הצלחה - נתחיל מהמפתח הבא בפעם הבאה, כדי לפזר עומס
            nextKeyIndex = (keyIndex + 1) % API_KEYS.length;
            return response.text.trim();
        } catch (err) {
            const is429 = err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
            console.error(`Key #${keyIndex} failed${is429 ? ' (quota exceeded)' : ''}:`, err.message);
            lastError = err;
            if (!is429) throw err; // שגיאה שאינה מכסה - אין טעם לנסות מפתחות נוספים
            // אחרת - ממשיכים ללולאה ומנסים את המפתח הבא
        }
    }

    throw lastError ?? new Error('No API keys configured');
}

// -----------------------------------------------------------------------
// הלוגיקה הראשית של השיחה
// -----------------------------------------------------------------------
router.get('/', async (call) => {
    for (let i = 0; i < 10; i++) {
        const recordingPath = await call.read(
            [{ type: 'text', data: i === 0 ? 'שלום, אחרי הצפצוף אמור את שאלתך' : 'תרצה לשאול עוד משהו' }],
            'record',
            { no_confirm_menu: true, max_length: 30 }
        );

        if (!recordingPath) {
            return call.id_list_message([{ type: 'text', data: 'תודה, להתראות' }]);
        }

        let answer;
        let tmpFile;
        try {
            tmpFile = await downloadRecording(recordingPath);
            answer = await transcribeAndAnswer(tmpFile);
            console.log('Answer:', answer);
        } catch (err) {
            console.error('Processing error:', err);
            answer = 'מצטער, קרתה שגיאה בעיבוד השאלה, נסו לשאול שוב';
        } finally {
            if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }

        await call.id_list_message([{ type: 'text', data: answer, removeInvalidChars: true }], {
            prependToNextAction: true,
        });
    }

    return call.hangup();
});

app.use(router.asExpressRouter ?? router);

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Server listening on port ${port}, ${API_KEYS.length} Gemini keys loaded`));
