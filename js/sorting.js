function getOrder(item) {
    if (item.order === null || item.order === undefined || String(item.order).trim() === "") {
        return null;
    }

    const order = Number(item.order);
    return Number.isFinite(order) ? order : null;
}

function compareText(valueA, valueB) {
    return String(valueA ?? "").localeCompare(
        String(valueB ?? ""),
        undefined,
        { numeric: true, sensitivity: "base" }
    );
}

function compareOrderThenLabel(itemA, itemB, labelKeys) {
    const orderA = getOrder(itemA);
    const orderB = getOrder(itemB);

    if (orderA !== null && orderB !== null && orderA !== orderB) {
        return orderA - orderB;
    }

    if (orderA !== null && orderB === null) {
        return -1;
    }

    if (orderA === null && orderB !== null) {
        return 1;
    }

    for (const key of labelKeys) {
        const comparison = compareText(itemA[key], itemB[key]);
        if (comparison !== 0) {
            return comparison;
        }
    }

    return compareText(itemA.id, itemB.id);
}

function getYear(item) {
    const value = item.year ?? item.id;
    if (value === null || value === undefined || String(value).trim() === "") {
        return null;
    }

    const year = Number(value);
    return Number.isFinite(year) ? year : null;
}

function getDateValue(value) {
    if (value && typeof value.toDate === "function") {
        value = value.toDate();
    }

    if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value !== "string" || !value.trim()) {
        return null;
    }

    const text = value.trim();
    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);

    if (match) {
        return makeDateValue(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (match) {
        const first = Number(match[1]);
        const second = Number(match[2]);
        const year = Number(match[3]);
        const month = first > 12 ? second : second > 12 ? first : second;
        const day = first > 12 ? first : second > 12 ? second : first;
        return makeDateValue(year, month, day);
    }

    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function makeDateValue(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date.getTime();
}

function getShiftNumber(shift) {
    const match = String(shift ?? "").match(/\d+/);
    return match ? Number(match[0]) : null;
}

function compareShift(shiftA, shiftB) {
    const numberA = getShiftNumber(shiftA);
    const numberB = getShiftNumber(shiftB);

    if (numberA !== null && numberB !== null && numberA !== numberB) {
        return numberA - numberB;
    }

    if (numberA !== null && numberB === null) {
        return -1;
    }

    if (numberA === null && numberB !== null) {
        return 1;
    }

    return compareText(shiftA, shiftB);
}

export function sortExams(exams) {
    return [...exams].sort((examA, examB) =>
        compareOrderThenLabel(examA, examB, ["name", "title", "examName", "id"])
    );
}

export function sortYearsDescending(years) {
    return [...years].sort((yearA, yearB) => {
        const valueA = getYear(yearA);
        const valueB = getYear(yearB);

        if (valueA !== null && valueB !== null && valueA !== valueB) {
            return valueB - valueA;
        }

        if (valueA !== null && valueB === null) {
            return -1;
        }

        if (valueA === null && valueB !== null) {
            return 1;
        }

        return compareText(yearA.year ?? yearA.id, yearB.year ?? yearB.id) ||
            compareText(yearA.id, yearB.id);
    });
}

export function sortPapers(papers) {
    return [...papers].sort((paperA, paperB) => {
        const orderA = getOrder(paperA);
        const orderB = getOrder(paperB);

        if (orderA !== null && orderB !== null && orderA !== orderB) {
            return orderA - orderB;
        }

        if (orderA !== null && orderB === null) {
            return -1;
        }

        if (orderA === null && orderB !== null) {
            return 1;
        }

        const dateA = getDateValue(paperA.date);
        const dateB = getDateValue(paperB.date);

        if (dateA !== null && dateB !== null && dateA !== dateB) {
            return dateA - dateB;
        }

        if (dateA !== null && dateB === null) {
            return -1;
        }

        if (dateA === null && dateB !== null) {
            return 1;
        }

        return compareShift(paperA.shift, paperB.shift) ||
            compareText(paperA.subject, paperB.subject) ||
            compareText(paperA.title ?? paperA.name, paperB.title ?? paperB.name) ||
            compareText(paperA.id, paperB.id);
    });
}

export function sortResourceExams(exams) {
    return [...exams].sort((examA, examB) =>
        compareOrderThenLabel(examA, examB, ["name", "id"])
    );
}

export function sortSubjects(subjects) {
    return [...subjects].sort((subjectA, subjectB) =>
        compareOrderThenLabel(subjectA, subjectB, ["name", "id"])
    );
}

export function sortTopics(topics) {
    return [...topics].sort((topicA, topicB) =>
        compareOrderThenLabel(topicA, topicB, ["name", "id"])
    );
}

export function sortMaterials(materials) {
    return [...materials].sort((materialA, materialB) =>
        compareOrderThenLabel(materialA, materialB, ["title", "category", "id"])
    );
}