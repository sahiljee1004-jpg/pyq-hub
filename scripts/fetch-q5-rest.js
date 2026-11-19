async function getFirestoreDoc() {
    const url = "https://firestore.googleapis.com/v1/projects/pyqs-hub-43bed/databases/(default)/documents/exams/NDA/years/2025/papers/nda%20math/questions/5";
    const res = await fetch(url);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}

getFirestoreDoc();
