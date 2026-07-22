/**
 * סוכן AI לקו תוכן בימות המשיח
 * =================================
 * גרסה עם Groq (תמלול + מודל שפה, חינמי, מכסה נדיבה) + Tavily (חיפוש אינטרנט, חינמי).
 *
 * תהליך לכל שאלה:
 * 1. call.read(..., 'record') - ימות מקליט את השאלה ומחזיר נתיב לקובץ (חינמי)
 * 2. מורידים את הקובץ מימות (DownloadFile API)
 * 3. מתמללים עם Groq Whisper
 * 4. מחפשים באינטרנט עם Tavily
 * 5. שולחים את השאלה + תוצאות החיפוש למודל שפה של Groq -> תשובה קצרה בעברית
 * 6. call.id_list_message(...) - ימות מקריא את התשובה בעצמו (TTS מובנה, חינמי)
 * 7. חוזרים לשלב 1 (לולאה) עד שהמאזין מנתק
 */

import express from 'express';
import { YemotRouter } from 'yemot-router2';
import fs from 'fs';
import os from 'os';
import path from 'path';

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
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
// תמלול עם Groq Whisper
// -----------------------------------------------------------------------
async function transcribeWithGroq(audioFilePath) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(audioFilePath)]), 'audio.wav');
    form.append('model', 'whisper-large-v3');
    form.append('language', 'he');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
    });

    if (!resp.ok) {
        throw new Error(`Groq transcription failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.text.trim();
}

// -----------------------------------------------------------------------
// חיפוש באינטרנט עם Tavily
// -----------------------------------------------------------------------
async function searchTavily(query) {
    const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query,
            search_depth: 'basic',
            max_results: 4,
            include_answer: true,
        }),
    });

    if (!resp.ok) {
        throw new Error(`Tavily search failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();

    // תקציר קצר של תוצאות החיפוש, כדי להזין למודל השפה
    const snippets = (data.results || [])
        .slice(0, 4)
        .map((r) => `- ${r.title}: ${r.content}`.slice(0, 300))
        .join('\n');

    return { quickAnswer: data.answer || '', snippets };
}

// -----------------------------------------------------------------------
// ניסוח תשובה קצרה בעברית עם מודל השפה של Groq, על בסיס תוצאות החיפוש
// -----------------------------------------------------------------------
async function answerWithGroq(question, searchContext) {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content:
                        'אתה עונה בעברית בלבד, בקצרה וברור (2-4 משפטים לכל היותר), ' +
                        'בצורה שמתאימה להקראה בטלפון (בלי סימני פיסוק מיוחדים כמו מקף או גרש). ' +
                        'התבסס על תוצאות החיפוש שסופקו אם הן רלוונטיות.',
                },
                {
                    role: 'user',
                    content: `שאלה: ${question}\n\nתוצאות חיפוש:\n${searchContext.quickAnswer}\n${searchContext.snippets}`,
                },
            ],
        }),
    });

    if (!resp.ok) {
        throw new Error(`Groq chat failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.choices[0].message.content.trim();
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
            const question = await transcribeWithGroq(tmpFile);
            console.log('Transcribed:', question);

            const searchContext = await searchTavily(question);
            answer = await answerWithGroq(question, searchContext);
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
