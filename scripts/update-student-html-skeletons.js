import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const studentHtmlFiles = [
    'www/index.html',
    'www/exam.html',
    'www/mock-test.html',
    'www/pyq-library.html',
    'www/papers.html',
    'www/study-resources.html',
    'www/ai-chat.html',
    'www/live-updates.html',
    'www/profile.html',
    'www/edit-profile.html',
    'www/login.html',
    'www/signup.html',
    'www/contact.html'
];

let updatedCount = 0;

for (const relPath of studentHtmlFiles) {
    const fullPath = path.resolve(__dirname, '..', relPath);
    if (!fs.existsSync(fullPath)) {
        console.error('File not found:', fullPath);
        continue;
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    const isCRLF = content.includes('\r\n');
    const eol = isCRLF ? '\r\n' : '\n';

    let changed = false;

    // Inject CSS if missing
    if (!content.includes('css/skeleton.css')) {
        const cssTag = `    <link rel="stylesheet" href="css/skeleton.css">${eol}`;
        content = content.replace('</head>', `${cssTag}</head>`);
        changed = true;
    }

    // Inject JS if missing
    if (!content.includes('js/skeleton-manager.js')) {
        const scriptTag = `    <script type="module" src="js/skeleton-manager.js"></script>${eol}`;
        content = content.replace('</body>', `${scriptTag}</body>`);
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Successfully injected skeleton assets into: ${relPath}`);
        updatedCount++;
    } else {
        console.log(`Already up to date: ${relPath}`);
    }
}

console.log(`Total files updated: ${updatedCount} / ${studentHtmlFiles.length}`);
