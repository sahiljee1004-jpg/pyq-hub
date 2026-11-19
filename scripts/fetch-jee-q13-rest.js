async function getJEEQ13() {
    const url = "https://firestore.googleapis.com/v1/projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2025/papers/23%20Jan%202025%20Shift%202/questions/13";
    const res = await fetch(url);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}

getJEEQ13();
