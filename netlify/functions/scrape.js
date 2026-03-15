const Anthropic = require("@anthropic-ai/sdk");

exports.handler = async (event) => {
  // CORS headers
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada en Netlify" }) };
  }

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `Eres un extractor de datos inmobiliarios. El usuario te dará una URL de un inmueble en venta (puede ser de Wasi, FincaRaiz, Metrocuadrado, Ciencuadras, Properati u otro portal colombiano o latinoamericano).

Tu trabajo:
1. Usa web_search para buscar esa URL y encontrar los datos del inmueble.
2. Extrae TODOS los datos que puedas encontrar.
3. Responde ÚNICAMENTE con un JSON válido. Sin backticks, sin markdown, sin explicación. SOLO el JSON.

Si no encuentras un dato, usa "" para texto y 0 para números. Nunca pongas "No disponible".`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Extrae los datos de este inmueble en venta: ${url}

Responde SOLO con este JSON:
{"nombre":"","foto":"","direccion":"","ciudad":"","barrio":"","tipo":"Apartamento","areaTotal":0,"areaPrivada":0,"estrato":0,"piso":0,"antiguedad":0,"habitaciones":0,"banos":0,"parqueaderos":0,"deposito":"No","vista":"Exterior","estado":"Original","valorLista":0,"adminMensual":0,"predialAnual":0,"amenidades":"","descripcion":""}`
      }]
    });

    // Extract text from response
    let allText = "";
    for (const block of message.content) {
      if (block.type === "text") {
        allText += block.text;
      }
    }

    // Parse JSON from response
    const clean = allText.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, data: parsed }),
        };
      } catch (parseErr) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: false, error: "JSON inválido en respuesta", raw: clean.substring(0, 500) }),
        };
      }
    } else {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: "No se encontraron datos", raw: clean.substring(0, 500) }),
      };
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Error interno" }),
    };
  }
};
