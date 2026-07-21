/**
 * סוכן AI לקו תוכן בימות המשיח
 * =================================
 * גרסה שמשתמשת בהקלטה רגילה (חינמית) + תמלול עם Whisper של OpenAI,
 * במקום זיהוי הדיבור המובנה של ימות (שדורש יחידות בתשלום).
 *
 * תהליך לכל שאלה:
 * 1. call.read(..., 'record') - ימות מקליט את השאלה ומחזיר נתיב לקובץ
 * 2. מורידים את הקובץ מימות (DownloadFile API) ומתמללים עם Whisper
 * 3. שולחים את הטקסט למודל שפה עם חיפוש אינטרנט -> מקבלים תשובה קצרה
 * 4. call.id_list_message(...) - ימות מקריא את התשובה בעצמו (TTS מובנה, חינמי)
 * 5. חוזרים לשלב 1 (לולאה) עד שהמאזין מנתק
 */

import express from 'express';
import { YemotRouter } from 'yemot-router2';
import OpenAI from 'openai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { toFile } from 'openai/uploads';

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const YEMOT_TOKEN = process.env.YEMOT_TOKEN; // לדוגמה "0779709932:7292"
const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';

const router = YemotRouter({
    printLog: true, // חשוב! כך נראה בלוגים את הנתיב המדויק שחוזר מההקלטה
});

// -----------------------------------------------------------------------
// הורדת קובץ ההקלטה מימות ותמלול עם Whisper
// -----------------------------------------------------------------------
async function downloadAndTranscribe(recordingPath) {
    // נתיב שחוזר מ-call.read במצב 'record' - לרוב יחסי לשלוחה.
    // אם הוא לא כולל כבר את התחילית ivr2:, נוסיף אותה.
    const fullPath = recordingPath.startsWith('ivr2:') ? recordingPath : `ivr2:${recordingPath}`;

    const url = `${YEMOT_API_BASE}/DownloadFile?token=${encodeURIComponent(YEMOT_TOKEN)}&path=${encodeURIComponent(fullPath)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Yemot DownloadFile failed: ${resp.status}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());

    const tmpFile = path.join(os.tmpdir(), `rec-${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, buffer);

    const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: await toFile(fs.createReadStream(tmpFile), 'audio.wav'),
        language: 'he',
    });

    fs.unlinkSync(tmpFile);
    return transcription.text.trim();
}

// -----------------------------------------------------------------------
// חיפוש באינטרנט + ניסוח תשובה קצרה בעברית
// -----------------------------------------------------------------------
async function searchAndAnswer(question) {
    const response = await openai.responses.create({
        model: 'gpt-4.1',
        tools: [{ type: 'web_search' }],
        input:
            'ענה בעברית בלבד, בקצרה וברור (2-4 משפטים לכל היותר, ' +
            'מתאים להקראה בטלפון, בלי סימני פיסוק מיוחדים כמו מקף או גרש). ' +
            'אם צריך מידע עדכני, חפש באינטרנט. ' +
            `שאלה: ${question}`,
    });
    return response.output_text.trim();
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

        let question, answer;
        try {
            question = await downloadAndTranscribe(recordingPath);
            console.log('Transcribed:', question);
            answer = question ? await searchAndAnswer(question) : 'לא הצלחתי להבין את השאלה, נסו שוב';
        } catch (err) {
            console.error('Processing error:', err);
            answer = 'מצטער, קרתה שגיאה בעיבוד השאלה, נסו לשאול שוב';
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
