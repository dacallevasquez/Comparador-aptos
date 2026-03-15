exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Falta el parámetro url" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }) };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: "Eres un extractor de datos inmobiliarios. Busca la URL con web_search y extrae los datos. Responde SOLO con JSON puro sin backticks ni markdown.",
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: "Extrae datos de este inmueble: " + url + '\n\nDevuelve SOLO JSON: {"nombre":"","foto":"","direccion":"","ciudad":"","barrio":"","tipo":"Apartamento","areaTotal":0,"areaPrivada":0,"estrato":0,"piso":0,"antiguedad":0,"habitaciones":0,"banos":0,"parqueaderos":0,"deposito":"No","vista":"Exterior","estado":"Original","valorLista":0,"adminMensual":0,"predialAnual":0,"amenidades":"","descripcion":""}'
        }]
      })
    });

    const data = await response.json();

    // If API returned an error
    if (data.type === "error") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: response.status + " " + JSON.stringify(data) }),
      };
    }

    // Extract text from response content blocks
    let allText = "";
    if (data.content) {
      for (const block of data.content) {
        if (block.type === "text") allText += block.text;
      }
    }

    // Parse JSON
    const clean = allText.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: parsed }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "JSON parse error", raw: clean.substring(0, 500) }) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "No JSON found", raw: clean.substring(0, 500) }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
