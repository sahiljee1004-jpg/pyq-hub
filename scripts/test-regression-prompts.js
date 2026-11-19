

async function runTest(testName, userMessage) {
    console.log(`\n============================================================`);
    console.log(`RUNNING: ${testName}`);
    console.log(`QUERY: "${userMessage}"`);
    console.log(`============================================================`);
    
    try {
        const mockToken = `header.${Buffer.from(JSON.stringify({ user_id: "test_user_123" })).toString("base64")}.signature`;
        const response = await fetch("http://127.0.0.1:3000/api/chat", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${mockToken}`
            },
            body: JSON.stringify({ message: userMessage })
        });
        
        const data = await response.json();
        console.log(`STATUS: ${response.status}`);
        console.log(`INTENT: ${data.intent}`);
        console.log(`PAPER META:`, data.paperMeta || "N/A");
        console.log(`QUESTION META:`, data.questionMeta || "N/A");
        console.log(`\nRESPONSE MESSAGE:\n${data.answer || data.reply || data.error || data.message}`);
        return data;
    } catch (err) {
        console.error(`ERROR running ${testName}:`, err.message);
    }
}

async function main() {
    // TEST 1: NDA Mathematics 2025 Q5
    await runTest("TEST 1: NDA Mathematics 2025 Q5", "Solve question 5 of NDA Mathematics paper 2025");
    
    // TEST 2: JEE Main 2025 Shift 2 Q13
    await runTest("TEST 2: JEE Main 2025 Shift 2 Q13", "Solve Q13 from JEE Main 2025 Shift 2");
    
    // TEST 3: Normal Well-Formed MCQ (JEE Q14 or NDA Q1)
    await runTest("TEST 3: JEE Main 2025 Shift 2 Q14", "Solve Q14 from JEE Main 2025 Shift 2");

    // TEST 4: Diagram Question
    await runTestWithContext("TEST 4: Diagram Question", "Solve this question", {
        paper: { examId: "NDA", yearId: "2025", title: "NDA MATHEMATICS" },
        question: {
            questionNumber: 99,
            questionText: "Refer to the given figure below showing a circuit with resistors R1 and R2. Find the equivalent resistance.",
            hasDiagram: true,
            options: ["(A) 5 Ohm", "(B) 10 Ohm", "(C) 15 Ohm", "(D) 20 Ohm"]
        }
    });

    // TEST 5: General Study Question
    await runTest("TEST 5: General Study Question", "Explain how to prepare for NDA Mathematics linear algebra topics");
}

async function runTestWithContext(testName, userMessage, paperContext) {
    console.log(`\n============================================================`);
    console.log(`RUNNING: ${testName}`);
    console.log(`QUERY: "${userMessage}"`);
    console.log(`============================================================`);
    
    try {
        const mockToken = `header.${Buffer.from(JSON.stringify({ user_id: "test_user_123" })).toString("base64")}.signature`;
        const response = await fetch("http://127.0.0.1:3000/api/chat", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${mockToken}`
            },
            body: JSON.stringify({ message: userMessage, activeQuestionContext: paperContext })
        });
        
        const data = await response.json();
        console.log(`STATUS: ${response.status}`);
        console.log(`INTENT: ${data.intent}`);
        console.log(`PAPER META:`, data.paperMeta || "N/A");
        console.log(`QUESTION META:`, data.questionMeta || "N/A");
        console.log(`\nRESPONSE MESSAGE:\n${data.answer || data.reply || data.error || data.message}`);
        return data;
    } catch (err) {
        console.error(`ERROR running ${testName}:`, err.message);
    }
}

main();
