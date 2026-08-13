const k = process.env.OPENROUTER_API_KEY;
if (!k) { console.log("NO KEY"); process.exit(0); }
const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "deepseek/deepseek-v3.2", max_tokens: 20, messages: [{ role: "user", content: "reply with the word OK" }] }),
});
const d = await r.json();
console.log("http", r.status, "| reply:", (d.choices && d.choices[0] && d.choices[0].message.content) || JSON.stringify(d.error || d).slice(0, 200));
