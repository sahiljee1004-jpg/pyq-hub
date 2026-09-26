import { db } from "./firebase.js";
import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
    sortMaterials,
    sortResourceExams,
    sortSubjects,
    sortTopics
} from "./sorting.js";

const resourceList = document.getElementById("resourceList");
const resourceStatus = document.getElementById("resourceStatus");
const resourceExams = new Map();
const listeners = new Map();

const footerYear = document.getElementById("year");
if (footerYear) {
    footerYear.textContent = new Date().getFullYear();
}

function subscribe(path, reference, onData) {
    if (listeners.has(path)) {
        return;
    }

    const unsubscribe = onSnapshot(
        reference,
        onData,
        (error) => {
            console.error(`Unable to load resources at ${path}:`, error);
            resourceStatus.textContent = "Some resources could not be loaded.";
        }
    );
    listeners.set(path, unsubscribe);
}

function stopAtOrBelow(path) {
    for (const [listenerPath, unsubscribe] of listeners) {
        if (listenerPath === path || listenerPath.startsWith(`${path}/`)) {
            unsubscribe();
            listeners.delete(listenerPath);
        }
    }
}

function watchExams() {
    subscribe("resources", collection(db, "resources"), (snapshot) => {
        const presentIds = new Set(snapshot.docs.map((document) => document.id));

        for (const examId of resourceExams.keys()) {
            if (!presentIds.has(examId)) {
                stopAtOrBelow(`resources/${examId}`);
                resourceExams.delete(examId);
            }
        }

        for (const document of snapshot.docs) {
            const previous = resourceExams.get(document.id);
            const exam = {
                ...document.data(),
                id: document.id,
                subjects: previous?.subjects ?? new Map()
            };
            resourceExams.set(document.id, exam);
            watchSubjects(exam);
        }

        renderResources();
    });
}

function watchSubjects(exam) {
    const path = `resources/${exam.id}/subjects`;
    subscribe(path, collection(db, "resources", exam.id, "subjects"), (snapshot) => {
        const presentIds = new Set(snapshot.docs.map((document) => document.id));

        for (const subjectId of exam.subjects.keys()) {
            if (!presentIds.has(subjectId)) {
                stopAtOrBelow(`${path}/${subjectId}`);
                exam.subjects.delete(subjectId);
            }
        }

        for (const document of snapshot.docs) {
            const previous = exam.subjects.get(document.id);
            const subject = {
                ...document.data(),
                id: document.id,
                topics: previous?.topics ?? new Map()
            };
            exam.subjects.set(document.id, subject);
            watchTopics(exam, subject);
        }

        renderResources();
    });
}

function watchTopics(exam, subject) {
    const path = `resources/${exam.id}/subjects/${subject.id}/topics`;
    subscribe(
        path,
        collection(db, "resources", exam.id, "subjects", subject.id, "topics"),
        (snapshot) => {
            const presentIds = new Set(snapshot.docs.map((document) => document.id));

            for (const topicId of subject.topics.keys()) {
                if (!presentIds.has(topicId)) {
                    stopAtOrBelow(`${path}/${topicId}`);
                    subject.topics.delete(topicId);
                }
            }

            for (const document of snapshot.docs) {
                const previous = subject.topics.get(document.id);
                const topic = {
                    ...document.data(),
                    id: document.id,
                    materials: previous?.materials ?? new Map()
                };
                subject.topics.set(document.id, topic);
                watchMaterials(exam, subject, topic);
            }

            renderResources();
        }
    );
}

function watchMaterials(exam, subject, topic) {
    const path = `resources/${exam.id}/subjects/${subject.id}/topics/${topic.id}/materials`;
    subscribe(
        path,
        collection(db, "resources", exam.id, "subjects", subject.id, "topics", topic.id, "materials"),
        (snapshot) => {
            topic.materials.clear();
            for (const document of snapshot.docs) {
                topic.materials.set(document.id, {
                    ...document.data(),
                    id: document.id
                });
            }
            renderResources();
        }
    );
}

function createDetails(className, label, open = false) {
    const details = document.createElement("details");
    details.className = className;
    details.open = open;

    const summary = document.createElement("summary");
    summary.textContent = label;
    details.appendChild(summary);
    return details;
}

function renderMaterial(material) {
    const row = document.createElement("article");
    row.className = "resource-material";

    const copy = document.createElement("div");
    copy.className = "resource-material-copy";

    const title = document.createElement("h3");
    title.textContent = material.title || "Untitled material";
    copy.appendChild(title);

    if (material.description) {
        const description = document.createElement("p");
        description.textContent = material.description;
        copy.appendChild(description);
    }
    row.appendChild(copy);

    const pdfUrl = getSafePdfUrl(material.pdfUrl);
    if (pdfUrl) {
        const link = document.createElement("a");
        link.href = pdfUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open PDF";
        row.appendChild(link);
    }

    return row;
}

function getSafePdfUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
        return "";
    }

    try {
        const url = new URL(value, window.location.href);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
        return "";
    }
}

function renderResources() {
    const exams = sortResourceExams([...resourceExams.values()]);
    resourceList.replaceChildren();

    if (!exams.length) {
        resourceStatus.textContent = "0 exams";
        const empty = document.createElement("p");
        empty.className = "resource-empty";
        empty.textContent = "No study resources are available yet.";
        resourceList.appendChild(empty);
        return;
    }

    let materialCount = 0;
    for (const exam of exams) {
        for (const subject of exam.subjects.values()) {
            for (const topic of subject.topics.values()) {
                materialCount += topic.materials.size;
            }
        }
    }
    resourceStatus.textContent = `${exams.length} exams · ${materialCount} materials`;

    for (const exam of exams) {
        const examDetails = createDetails("resource-exam", exam.name || exam.id, true);
        const subjectsContainer = document.createElement("div");
        subjectsContainer.className = "resource-subjects";

        for (const subject of sortSubjects([...exam.subjects.values()])) {
            const subjectDetails = createDetails(
                "resource-subject",
                subject.name || subject.id
            );
            const topicsContainer = document.createElement("div");
            topicsContainer.className = "resource-topics";

            for (const topic of sortTopics([...subject.topics.values()])) {
                const topicDetails = createDetails(
                    "resource-topic",
                    topic.name || topic.id
                );
                const materials = document.createElement("div");
                materials.className = "resource-materials";

                for (const material of sortMaterials([...topic.materials.values()])) {
                    materials.appendChild(renderMaterial(material));
                }

                if (!topic.materials.size) {
                    const empty = document.createElement("p");
                    empty.className = "resource-empty";
                    empty.textContent = "No materials in this topic.";
                    materials.appendChild(empty);
                }

                topicDetails.appendChild(materials);
                topicsContainer.appendChild(topicDetails);
            }

            if (!subject.topics.size) {
                const empty = document.createElement("p");
                empty.className = "resource-empty";
                empty.textContent = "No topics in this subject.";
                topicsContainer.appendChild(empty);
            }

            subjectDetails.appendChild(topicsContainer);
            subjectsContainer.appendChild(subjectDetails);
        }

        if (!exam.subjects.size) {
            const empty = document.createElement("p");
            empty.className = "resource-empty";
            empty.textContent = "No subjects for this exam.";
            subjectsContainer.appendChild(empty);
        }

        examDetails.appendChild(subjectsContainer);
        resourceList.appendChild(examDetails);
    }
}

watchExams();