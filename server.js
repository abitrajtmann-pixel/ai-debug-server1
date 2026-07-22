/**
 * סוכן AI לקו תוכן בימות המשיח
 * =================================
 * גרסה עם Gemini API (Google AI Studio) - חינמי לגמרי, ללא כרטיס אשראי.
 * Gemini מקבל את קובץ ההקלטה ישירות (הוא מולטימודלי), מתמלל, מחפש
 * באינטרנט (Google Search grounding), ועונה - הכול בקריאה אחת.
 *
 * תהליך לכל שאלה:
 * 1. call.read(..., 'record') - ימות מקליט את השאלה ומחזיר נתיב לקובץ (חינמי)
 * 2. מורידים את הקובץ מימות (DownloadFile API)
 * 3. שולחים את קובץ השמע ישירות ל-Gemini עם כלי חיפוש - מקבלים תשובה מוכנה
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
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const YEMOT_TOKEN = process.env.YEMOT_TOKEN; // לדוגמה "0779709932:7292"
const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';

const router = YemotRouter({
    printLog: true, // חשוב! כך נראה בלוגים את הנתיב המדויק שחוזר מההקלטה
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
// שליחת קובץ השמע ל-Gemini: תמלול + חיפוש + תשובה, בקריאה אחת
// -----------------------------------------------------------------------
async function transcribeAndAnswer(audioFilePath) {
    const audioBytes = fs.readFileSync(audioFilePath);

    const response = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            {
                role: 'user',
                parts: [
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
                ],
            },
        ],
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    return response.text.trim();
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
app.listen(port, () => console.log(`Server listening on port ${port}`));
