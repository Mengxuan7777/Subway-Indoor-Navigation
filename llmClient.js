export async function callLLM(baseUrl, provider, model, input, system) {
  const r = await fetch(baseUrl + "/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: provider, model: model, input: input, system: system })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data.output_text;
}
