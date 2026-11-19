import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const file = path.join(root, 'www/js/papers.js');
let content = fs.readFileSync(file, 'utf8');
const isCRLF = content.includes('\r\n');
const norm = content.replace(/\r\n/g, '\n');

let updated = norm;

// Add import
if (!updated.includes('import { SkeletonManager }')) {
    updated = updated.replace(
        '} from "./pdf-viewer-core.js";',
        '} from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
    );
}

// Update loadPaperCollection
const oldTarget = `async function loadPaperCollection() {
    try {
        const papersRef = collection(db, "exams", examId, "years", yearId, "papers");`;

const newTarget = `async function loadPaperCollection() {
    let skeletonPapers = null;
    if (paperList) {
        skeletonPapers = SkeletonManager.mount(
            paperList,
            () => SkeletonManager.templates.papersList(5),
            { delay: 200, ariaLabel: "Loading question papers..." }
        );
    }
    try {
        const papersRef = collection(db, "exams", examId, "years", yearId, "papers");`;

updated = updated.replace(oldTarget, newTarget);

const oldDisplay = `        if (!papers.length) {
            paperList.innerHTML = \`
                <div class="empty-message">
                    <div class="empty-icon">📄</div>
                    <h3>No papers available</h3>
                    <p>Question papers for this year haven't been added yet.</p>
                </div>
            \`;
            return;
        }

        paperList.innerHTML = "";
        papers.forEach((paper, index) => {
            paperList.appendChild(createPaperCard(paper, index));
        });`;

const newDisplay = `        skeletonPapers?.dismiss(() => {
            if (!papers.length) {
                paperList.innerHTML = \`
                    <div class="empty-message">
                        <div class="empty-icon">📄</div>
                        <h3>No papers available</h3>
                        <p>Question papers for this year haven't been added yet.</p>
                    </div>
                \`;
                return;
            }

            paperList.innerHTML = "";
            papers.forEach((paper, index) => {
                paperList.appendChild(createPaperCard(paper, index));
            });
        });`;

updated = updated.replace(oldDisplay, newDisplay);

updated = updated.replace(
    'console.error("Paper collection error:", error);',
    'skeletonPapers?.cancel();\n        console.error("Paper collection error:", error);'
);

const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
fs.writeFileSync(file, finalContent, 'utf8');
console.log('Successfully updated www/js/papers.js with SkeletonManager');
