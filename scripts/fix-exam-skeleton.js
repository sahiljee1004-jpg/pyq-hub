import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const file = path.join(root, 'www/js/exam.js');
let content = fs.readFileSync(file, 'utf8');
const isCRLF = content.includes('\r\n');
const norm = content.replace(/\r\n/g, '\n');

let updated = norm;

// Ensure import
if (!updated.includes('import { SkeletonManager }')) {
    updated = updated.replace(
        '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
        '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
    );
}

// Replace loading in loadYears
const oldLoading = `        yearGrid.innerHTML = \`
            <div class="loading">
                Loading years...
            </div>
        \`;`;

const newLoading = `        const skeletonYears = SkeletonManager.mount(
            yearGrid,
            () => SkeletonManager.templates.examYears(4),
            { delay: 200, ariaLabel: "Loading available examination years..." }
        );`;

updated = updated.replace(oldLoading, newLoading);

// Wrap display in dismiss
const oldDisplaySection = `        // ====================================================
        // DISPLAY YEARS
        // ====================================================

        yearGrid.innerHTML = "";


        years.forEach(
            (yearData) => {

                const card =
                    document.createElement(
                        "a"
                    );


                card.className =
                    "year-card";


                const yearName =
                    yearData.year ||
                    yearData.id;


                card.href =
                    \`papers.html?exam=\${encodeURIComponent(examId)}&year=\${encodeURIComponent(yearData.id)}\`;


                card.innerHTML = \`

                    <div class="year-number">

                        \${escapeHTML(
                            yearName
                        )}

                    </div>

                    <div class="year-text">

                        View Papers →

                    </div>

                \`;


                yearGrid.appendChild(
                    card
                );

            }
        );`;

const newDisplaySection = `        // ====================================================
        // DISPLAY YEARS
        // ====================================================

        skeletonYears.dismiss(() => {
            yearGrid.innerHTML = "";

            years.forEach(
                (yearData) => {

                    const card =
                        document.createElement(
                            "a"
                        );

                    card.className =
                        "year-card";

                    const yearName =
                        yearData.year ||
                        yearData.id;

                    card.href =
                        \`papers.html?exam=\${encodeURIComponent(examId)}&year=\${encodeURIComponent(yearData.id)}\`;

                    card.innerHTML = \`

                        <div class="year-number">

                            \${escapeHTML(
                                yearName
                            )}

                        </div>

                        <div class="year-text">

                            View Papers →

                        </div>

                    \`;

                    yearGrid.appendChild(
                        card
                    );

                }
            );
        });`;

updated = updated.replace(oldDisplaySection, newDisplaySection);

// Add cancel in error
updated = updated.replace(
    'console.error(\n            "Error loading years:",',
    'skeletonYears?.cancel();\n        console.error(\n            "Error loading years:",'
);

const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
fs.writeFileSync(file, finalContent, 'utf8');
console.log('Successfully updated www/js/exam.js with SkeletonManager');
