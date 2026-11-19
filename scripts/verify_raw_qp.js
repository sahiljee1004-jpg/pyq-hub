import fs from 'fs';
import { QuestionPaperParser } from '../server/services/ingestion/questionPaperParser.js';

async function inspectPages() {
    const buf = fs.readFileSync('uploads/vault/1afd99f61ca04f63_1794777789438_SSC_CGL_23Sep2025_Shift1_Question_Paper.pdf');
    const { pages } = await QuestionPaperParser.extractPagesFromPdf(buf);
    console.log('Extracted pages count:', pages.length);
    pages.forEach(p => {
        const lines = p.text.split('\n').map(l => l.trim()).filter(Boolean);
        console.log(`Page ${p.pageNumber}: ${lines.length} lines. First line: "${lines[0]}" | Last line: "${lines[lines.length - 1]}"`);
    });
}
inspectPages();
