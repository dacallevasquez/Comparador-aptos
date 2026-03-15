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
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Falta url" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }) };
  }

  try {
    // Step 1: Fetch the page HTML directly
    let pageHTML = "";
    try {
      const pageResp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
      });
      if (pageResp.ok) {
        pageHTML = await pageResp.text();
      }
    } catch (e) {
      pageHTML = "";
    }

    // Step 2: If we got HTML, try to extract with regex first (no API needed)
    if (pageHTML.length > 500) {
      const regexData = extractWithRegex(pageHTML, url);
      if (regexData && (regexData.valorLista > 0 || regexData.habitaciones > 0)) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: regexData }) };
      }
    }

    // Step 3: Send page content to Claude (without web_search) for parsing
    const contentToSend = pageHTML.length > 500
      ? "Aquí está el HTML de una página de inmueble. Extrae los datos:\n\n" + pageHTML.substring(0, 15000)
      : "No pude obtener el HTML de la página " + url + ". Basándote en la URL, intenta deducir qué datos puedas (código del inmueble, ciudad, tipo). Llena lo que puedas.";

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
        system: "Extrae datos del inmueble del HTML proporcionado. Responde SOLO con JSON puro sin backticks.",
        messages: [{
          role: "user",
          content: contentToSend + '\n\nDevuelve SOLO este JSON: {"nombre":"","foto":"","direccion":"","ciudad":"","barrio":"","tipo":"Apartamento","areaTotal":0,"areaPrivada":0,"estrato":0,"piso":0,"antiguedad":0,"habitaciones":0,"banos":0,"parqueaderos":0,"deposito":"No","vista":"Exterior","estado":"Original","valorLista":0,"adminMensual":0,"predialAnual":0,"amenidades":"","descripcion":""}'
        }]
      })
    });

    const data = await response.json();

    if (data.type === "error") {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: JSON.stringify(data.error) }) };
    }

    let allText = "";
    if (data.content) {
      for (const block of data.content) {
        if (block.type === "text") allText += block.text;
      }
    }

    const clean = allText.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: parsed }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "JSON parse error", raw: clean.substring(0, 300) }) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "No data extracted", raw: allText.substring(0, 300) }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function extractWithRegex(html, url) {
  const r = {};

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)/i) || html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  r.nombre = titleMatch ? titleMatch[1].trim() : "";

  // OG Image
  const imgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  r.foto = imgMatch ? imgMatch[1] : "";

  // Price - look for common patterns
  const pricePatterns = [
    /(?:precio|price|valor)[^0-9]*\$?\s*([\d.,]+)\s*(?:millones|mill|MM)/i,
    /\$\s*([\d.,]+)\s*(?:millones|mill|MM)/i,
    /(?:precio|price|valor)[^0-9]*\$?\s*([\d.,]+)/i,
    /"sale_price"\s*:\s*["\s]*([\d.,]+)/i,
    /"price"\s*:\s*["\s]*([\d.,]+)/i,
  ];
  r.valorLista = 0;
  for (const pat of pricePatterns) {
    const m = html.match(pat);
    if (m) {
      let val = m[1].replace(/\./g, "").replace(/,/g, "");
      val = parseInt(val) || 0;
      if (val > 0 && val < 100) val = val * 1000000; // "350" -> 350,000,000
      if (val > 100 && val < 10000) val = val * 1000000;
      r.valorLista = val;
      break;
    }
  }

  // Area
  const areaMatch = html.match(/(?:area|área|mt2|m2|metros)[^0-9]*([\d.,]+)\s*(?:m|mt)/i) || html.match(/"area"\s*:\s*["\s]*([\d.,]+)/i);
  r.areaTotal = areaMatch ? parseInt(areaMatch[1].replace(/[^0-9]/g, "")) || 0 : 0;

  // Rooms
  const roomMatch = html.match(/(\d+)\s*(?:habitacion|alcoba|cuarto|bedroom|hab)/i) || html.match(/"rooms"\s*:\s*["\s]*(\d+)/i);
  r.habitaciones = roomMatch ? parseInt(roomMatch[1]) || 0 : 0;

  // Bathrooms
  const bathMatch = html.match(/(\d+)\s*(?:baño|bathroom|bano)/i) || html.match(/"bathrooms"\s*:\s*["\s]*(\d+)/i);
  r.banos = bathMatch ? parseInt(bathMatch[1]) || 0 : 0;

  // Parking
  const parkMatch = html.match(/(\d+)\s*(?:parqueadero|garaje|parking|estacionamiento)/i) || html.match(/"parking"\s*:\s*["\s]*(\d+)/i);
  r.parqueaderos = parkMatch ? parseInt(parkMatch[1]) || 0 : 0;

  // Estrato
  const estratoMatch = html.match(/estrato\s*:?\s*(\d)/i) || html.match(/"strpiatum"\s*:\s*["\s]*(\d)/i);
  r.estrato = estratoMatch ? parseInt(estratoMatch[1]) || 0 : 0;

  // Admin
  const adminMatch = html.match(/admin[^0-9]*([\d.,]+)/i) || html.match(/"administration"\s*:\s*["\s]*([\d.,]+)/i);
  r.adminMensual = adminMatch ? parseInt(adminMatch[1].replace(/[^0-9]/g, "")) || 0 : 0;

  // Location from OG or meta
  const locMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  r.direccion = locMatch ? locMatch[1].substring(0, 100) : "";

  // Type from URL
  if (url.includes("apartamento")) r.tipo = "Apartamento";
  else if (url.includes("casa")) r.tipo = "Casa";
  else if (url.includes("oficina")) r.tipo = "Oficina";
  else r.tipo = "Apartamento";

  // City from URL
  if (url.includes("medell")) r.ciudad = "Medellín";
  else if (url.includes("bogot")) r.ciudad = "Bogotá";
  else if (url.includes("cali")) r.ciudad = "Cali";
  else r.ciudad = "";

  r.barrio = "";
  r.areaPrivada = 0;
  r.piso = 0;
  r.antiguedad = 0;
  r.deposito = "No";
  r.vista = "Exterior";
  r.estado = "Original";
  r.predialAnual = 0;
  r.amenidades = "";
  r.descripcion = "";

  return r;
}
