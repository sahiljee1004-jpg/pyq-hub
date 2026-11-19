import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const file = path.join(root, 'www/js/study-resources.js');
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

// Update fetchStudyResources
const oldTarget = `async function fetchStudyResources() {
    try {
        const examSnapshot = await getDocs(collection(db, "studyResources"));`;

const newTarget = `async function fetchStudyResources() {
    let skeleton = null;
    if (studyContentArea) {
        skeleton = SkeletonManager.mount(
            studyContentArea,
            () => SkeletonManager.templates.studyResources(6),
            { delay: 200, ariaLabel: "Loading study resources..." }
        );
    }
    try {
        const examSnapshot = await getDocs(collection(db, "studyResources"));`;

updated = updated.replace(oldTarget, newTarget);

const oldDismissTarget = `        exams.forEach((exam) => exam.subjects.forEach((subject) => subject.chapters.forEach((chapter) => allResources.push(...chapter.pdfs))));

        renderState();
    } catch (error) {`;

const newDismissTarget = `        exams.forEach((exam) => exam.subjects.forEach((subject) => subject.chapters.forEach((chapter) => allResources.push(...chapter.pdfs))));

        skeleton?.dismiss(() => {
            renderState();
        });
    } catch (error) {
        skeleton?.cancel();`;

updated = updated.replace(oldDismissTarget, newDismissTarget);

const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
fs.writeFileSync(file, finalContent, 'utf8');
console.log('Successfully updated www/js/study-resources.js with SkeletonManager');
