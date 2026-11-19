async function testNDA() {
    try {
        const mockToken = `header.${Buffer.from(JSON.stringify({ user_id: "test_user_123" })).toString("base64")}.signature`;
        const response = await fetch("http://127.0.0.1:3000/api/chat", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${mockToken}`
            },
            body: JSON.stringify({ message: "Solve question 5 of NDA Mathematics paper 2025" })
        });
        
        const data = await response.json();
        console.log("STATUS:", response.status);
        console.log("INTENT:", data.intent);
        console.log("ANSWER:\n", data.answer || data.reply || data.error);
    } catch (err) {
        console.error(err);
    }
}

testNDA();
