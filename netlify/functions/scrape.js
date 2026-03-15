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
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
        },
        redirect: "follow",
      });
      if (pageResp.ok) {
        pageHTML = await pageResp.text();
      }
    } catch (e) {
      pageHTML = "";
    }

    // Step 2: Try regex extraction first
    if (pageHTML.length > 500) {
      const regexData = extractWithRegex(pageHTML, url);
      
      // If regex got good data (at least price OR area+rooms), return it
      if (regexData && (regexData.valorLista > 1000000 || (regexData.areaTotal > 0 && regexData.habitaciones > 0))) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: regexData }) };
      }
    }

    // Step 3: Send to Claude for parsing (without web_search)
    const htmlChunk = pageHTML.length > 500 ? pageHTML.substring(0, 20000) : "";
    const prompt = htmlChunk 
      ? "Analiza este HTML de un inmueble en venta y extrae todos los datos. Busca precios, áreas, habitaciones, baños, estrato, administración, etc. en el HTML, scripts, JSON-LD, metatags, o cualquier parte del código:\n\n" + htmlChunk
      : "No pude obtener el HTML de " + url + ". Intenta deducir datos de la URL.";

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
        system: "Extrae datos del inmueble. Responde SOLO con JSON puro sin backticks. Busca precios en formato colombiano (ej: 1.370.000.000 = mil trescientos setenta millones). Los precios en Colombia suelen estar entre 100.000.000 y 5.000.000.000 COP.",
        messages: [{ role: "user", content: prompt + '\n\nResponde SOLO este JSON: {"nombre":"","foto":"","direccion":"","ciudad":"","barrio":"","tipo":"Apartamento","areaTotal":0,"areaPrivada":0,"estrato":0,"piso":0,"antiguedad":0,"habitaciones":0,"banos":0,"parqueaderos":0,"deposito":"No","vista":"Exterior","estado":"Original","valorLista":0,"adminMensual":0,"predialAnual":0,"amenidades":"","descripcion":""}' }]
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
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "JSON parse error" }) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "No data extracted" }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function extractWithRegex(html, url) {
  const r = {};

  // ── Title ──
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) 
    || html.match(/<title[^>]*>([^<]+)/i);
  r.nombre = titleMatch ? titleMatch[1].replace(/\s*[-|].*$/, "").trim() : "";

  // ── OG Image (high-res) ──
  const imgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  r.foto = imgMatch ? imgMatch[1] : "";

  // ── OG Description ──
  const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  const desc = descMatch ? descMatch[1] : "";

  // ── JSON-LD structured data ──
  let jsonLD = null;
  const ldMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (ldMatches) {
    for (const ldBlock of ldMatches) {
      const content = ldBlock.match(/>([^<]+)</);
      if (content) {
        try {
          const parsed = JSON.parse(content[1]);
          if (parsed["@type"] === "Product" || parsed["@type"] === "RealEstateListing" || parsed["@type"] === "Apartment" || parsed.offers) {
            jsonLD = parsed;
            break;
          }
        } catch (e) {}
      }
    }
  }

  // ── Extract from JSON-LD if available ──
  if (jsonLD) {
    if (jsonLD.name) r.nombre = jsonLD.name;
    if (jsonLD.image) r.foto = typeof jsonLD.image === "string" ? jsonLD.image : (jsonLD.image[0] || r.foto);
    if (jsonLD.offers?.price) r.valorLista = parseInt(String(jsonLD.offers.price).replace(/[^0-9]/g, "")) || 0;
    if (jsonLD.description) r.descripcion = jsonLD.description.substring(0, 200);
  }

  // ── Price: search in multiple patterns (Colombian format: 1.370.000.000) ──
  if (!r.valorLista || r.valorLista < 10000000) {
    const pricePatterns = [
      // Wasi/FincaRaiz patterns in JS data
      /sale_price['":\s]+([\d.]+)/i,
      /precio[_\s]*(?:de\s*)?(?:venta)?['":\s]*\$?\s*([\d.]+(?:\.\d{3})*)/i,
      /price['":\s]+([\d.]+)/i,
      // Visible price with $ sign and dots
      /\$\s*([\d]+(?:\.[\d]{3})+)/,
      // data attributes
      /data-price['"=:\s]+([\d.]+)/i,
      /data-sale[_-]?price['"=:\s]+([\d.]+)/i,
      // JS variable assignments
      /(?:sale_price|salePrice|precio|price)\s*[:=]\s*['"]*(\d[\d.]*)['"]*[,;\s]/i,
      // Meta price
      /property="product:price:amount"\s+content="([^"]+)"/i,
    ];
    
    for (const pat of pricePatterns) {
      const m = html.match(pat);
      if (m) {
        let val = m[1].replace(/\./g, "");
        val = parseInt(val) || 0;
        // Colombian real estate prices are typically between 50M and 50B
        if (val >= 50000000 && val <= 50000000000) {
          r.valorLista = val;
          break;
        }
        // Maybe it's in millions without zeros (e.g., "1370" = 1.370.000.000)
        if (val >= 100 && val <= 50000) {
          r.valorLista = val * 1000000;
          break;
        }
      }
    }
  }

  // ── Area ──
  const areaPatterns = [
    /(?:area|área)[_\s]*(?:construida)?['":\s]*([\d.,]+)\s*(?:m|mt|M)/i,
    /(?:area|área)['":\s]*([\d.,]+)/i,
    /([\d.,]+)\s*(?:m²|m2|mt2|mts2|mts|metros?\s*cuadrados)/i,
    /data-area['"=:\s]+([\d.,]+)/i,
  ];
  r.areaTotal = 0;
  for (const pat of areaPatterns) {
    const m = html.match(pat);
    if (m) { r.areaTotal = parseInt(m[1].replace(/[^0-9]/g, "")) || 0; if (r.areaTotal > 0 && r.areaTotal < 10000) break; r.areaTotal = 0; }
  }

  // ── Rooms ──
  const roomPatterns = [
    /(?:habitacion|alcoba|bedroom|rooms)['":\s]*(\d+)/i,
    /(\d+)\s*(?:habitacion|alcoba|cuarto|bedroom)/i,
    /data-rooms['"=:\s]+(\d+)/i,
  ];
  r.habitaciones = 0;
  for (const pat of roomPatterns) {
    const m = html.match(pat);
    if (m) { r.habitaciones = parseInt(m[1]) || 0; if (r.habitaciones > 0 && r.habitaciones <= 20) break; r.habitaciones = 0; }
  }

  // ── Bathrooms ──
  const bathPatterns = [
    /(?:baño|bathroom|banos|bathrooms)['":\s]*(\d+)/i,
    /(\d+)\s*(?:baño|bano|bathroom)/i,
    /data-bath['"=:\s]+(\d+)/i,
  ];
  r.banos = 0;
  for (const pat of bathPatterns) {
    const m = html.match(pat);
    if (m) { r.banos = parseInt(m[1]) || 0; if (r.banos > 0 && r.banos <= 20) break; r.banos = 0; }
  }

  // ── Parking ──
  const parkPatterns = [
    /(?:parqueadero|garaje|parking|garage)['":\s]*(\d+)/i,
    /(\d+)\s*(?:parqueadero|garaje|parking)/i,
    /data-parking['"=:\s]+(\d+)/i,
  ];
  r.parqueaderos = 0;
  for (const pat of parkPatterns) {
    const m = html.match(pat);
    if (m) { r.parqueaderos = parseInt(m[1]) || 0; if (r.parqueaderos > 0 && r.parqueaderos <= 10) break; r.parqueaderos = 0; }
  }

  // ── Estrato ──
  const estratoPatterns = [
    /estrato['":\s]*(\d)/i,
    /stratum['":\s]*(\d)/i,
    /data-stratum['"=:\s]+(\d)/i,
  ];
  r.estrato = 0;
  for (const pat of estratoPatterns) {
    const m = html.match(pat);
    if (m) { r.estrato = parseInt(m[1]) || 0; if (r.estrato >= 1 && r.estrato <= 6) break; r.estrato = 0; }
  }

  // ── Admin fee ──
  const adminPatterns = [
    /admin[a-z]*['":\s]*\$?\s*([\d.,]+)/i,
    /cuota[_\s]*(?:de\s*)?admin[^0-9]*([\d.,]+)/i,
  ];
  r.adminMensual = 0;
  for (const pat of adminPatterns) {
    const m = html.match(pat);
    if (m) { 
      let val = parseInt(m[1].replace(/[^0-9]/g, "")) || 0;
      if (val >= 50000 && val <= 5000000) { r.adminMensual = val; break; }
    }
  }

  // ── Location from description or URL ──
  r.direccion = "";
  if (desc) r.direccion = desc.substring(0, 100);
  
  // City from URL
  if (url.includes("medell")) r.ciudad = "Medellín";
  else if (url.includes("bogot")) r.ciudad = "Bogotá";
  else if (url.includes("cali")) r.ciudad = "Cali";
  else if (url.includes("barranquilla")) r.ciudad = "Barranquilla";
  else if (url.includes("cartagena")) r.ciudad = "Cartagena";
  else r.ciudad = "";

  // Type from URL
  if (url.includes("apartamento")) r.tipo = "Apartamento";
  else if (url.includes("casa")) r.tipo = "Casa";
  else if (url.includes("oficina")) r.tipo = "Oficina";
  else if (url.includes("local")) r.tipo = "Local";
  else r.tipo = "Apartamento";

  // Check for amenities keywords
  const amenities = [];
  if (/piscina/i.test(html)) amenities.push("Piscina");
  if (/gimnasio|gym/i.test(html)) amenities.push("Gimnasio");
  if (/sauna/i.test(html)) amenities.push("Sauna");
  if (/turco/i.test(html)) amenities.push("Turco");
  if (/jacuzzi/i.test(html)) amenities.push("Jacuzzi");
  if (/bbq|asadero/i.test(html)) amenities.push("BBQ");
  if (/squash/i.test(html)) amenities.push("Squash");
  if (/salon\s*social|salón\s*social/i.test(html)) amenities.push("Salón Social");
  r.amenidades = amenities.join(", ");

  // Vista panorámica detection
  r.vista = /panoram|panor[aá]m/i.test(html) ? "Panorámica" : "Exterior";

  r.barrio = "";
  r.areaPrivada = 0;
  r.piso = 0;
  r.antiguedad = 0;
  r.deposito = /(?:cuarto\s*[uú]til|dep[oó]sito)/i.test(html) ? "Sí" : "No";
  r.estado = /remodelad/i.test(html) ? "Remodelado total" : (/nuevo|estrenar/i.test(html) ? "Nuevo" : "Original");
  r.predialAnual = 0;
  r.descripcion = desc.substring(0, 200);

  return r;
}
