/**
 * סוכן AI לקו תוכן בימות המשיח
 * =================================
 * משתמש בספריית yemot-router2 (https://github.com/ShlomoCode/yemot-router2)
 * שמטפלת נכון בכל הפרוטוקול הגולמי של ימות.
 *
 * תהליך לכל שאלה:
 * 1. call.read(..., 'stt') - ימות מקליט ומתמלל בעצמו לעברית (זיהוי דיבור מובנה)
 * 2. שולחים את הטקסט למודל שפה עם חיפוש אינטרנט -> מקבלים תשובה קצרה
 * 3. call.id_list_message(...) - ימות מקריא את התשובה בעצמו (TTS מובנה)
 * 4. חוזרים לשלב 1 (לולאה) עד שהמאזין מנתק
 */

import express from 'express';
import { YemotRouter } from 'yemot-router2';
import OpenAI from 'openai';

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const router = YemotRouter({
    printLog: true, // לוגים מפורטים - שימושי מאוד בפיתוח, אפשר לכבות בהמשך
});

// -----------------------------------------------------------------------
// הפונקציה שמחפשת ועונה - כאן אפשר להחליף בכל ספק חיפוש/מודל שנרצה בהמשך
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
    // עד 10 שאלות ברצף בשיחה אחת (הגנה מפני לולאה אינסופית)
    for (let i = 0; i < 10; i++) {
        const question = await call.read(
            [{ type: 'text', data: i === 0 ? 'שלום, מה תרצה לשאול' : 'תרצה לשאול עוד משהו, או לנתק' }],
            'stt',
            { lang: 'he-IL' }
        );

        if (!question || question.trim() === '') {
            return call.id_list_message([{ type: 'text', data: 'תודה, להתראות' }]);
        }

        let answer;
        try {
            answer = await searchAndAnswer(question);
        } catch (err) {
            console.error('AI error:', err);
            answer = 'מצטער, קרתה שגיאה בעיבוד השאלה, נסו לשאול שוב';
        }

        // משמיעים את התשובה, ואז (prependToNextAction) ממשיכים ישר ללולאה הבאה
        await call.id_list_message([{ type: 'text', data: answer, removeInvalidChars: true }], {
            prependToNextAction: true,
        });
    }

    return call.hangup();
});

app.use(router.asExpressRouter ?? router);

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
