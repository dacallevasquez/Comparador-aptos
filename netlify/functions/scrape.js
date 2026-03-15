exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const url = event.queryStringParameters?.url;
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: "Falta url" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }) };

  try {
    // Extract property ID from URL (works for Wasi URLs like /9412257 or /9818338)
    const idMatch = url.match(/\/(\d{5,10})(?:\?|$|\/)/);
    const propertyId = idMatch ? idMatch[1] : null;

    // ── STRATEGY 1: Try Wasi alternate URL that renders data server-side ──
    if (propertyId && url.includes("wasi.co")) {
      const altUrl = "https://inmuebles.wasi.co/inmueble/" + propertyId;
      const altUrls = [
        altUrl,
        "https://inmuebles.wasi.co/apartamento-vender/" + propertyId,
      ];
      
      for (const tryUrl of altUrls) {
        try {
          const resp = await fetch(tryUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" },
            redirect: "follow",
          });
          if (resp.ok) {
            const html = await resp.text();
            if (html.includes("sale_price") || html.includes("precio") || html.includes("bedrooms")) {
              const data = extractFromHTML(html, url);
              if (data && data.valorLista > 0) {
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
              }
            }
          }
        } catch (e) { /* try next */ }
      }
    }

    // ── STRATEGY 2: Fetch original URL and extract what we can ──
    let pageHTML = "";
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html,*/*" },
        redirect: "follow",
      });
      if (resp.ok) pageHTML = await resp.text();
    } catch (e) { /* continue */ }

    // Get basic data from original page (name, photo, amenities)
    const basicData = pageHTML.length > 500 ? extractFromHTML(pageHTML, url) : {};

    // ── STRATEGY 3: Send to Claude to parse HTML + fill gaps ──
    const htmlToSend = pageHTML.substring(0, 25000);
    
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
        system: `Eres un experto extractor de datos inmobiliarios colombianos. Analiza el HTML completo y extrae ABSOLUTAMENTE TODOS los datos del inmueble.

INSTRUCCIONES CRÍTICAS:
- Busca en TODAS partes: scripts, JSON embebido, data-attributes, metatags, texto visible, variables JavaScript, etc.
- Los precios colombianos usan puntos como separador de miles: 1.370.000.000 = mil trescientos setenta millones COP
- Si ves un precio como "1370000000" sin puntos, es 1.370 millones
- La administración suele estar entre 100.000 y 3.000.000 COP/mes
- El estrato va de 1 a 6
- Busca "sale_price", "precio", "price", "valor" para el precio
- Busca "area", "built_area", "private_area" para las áreas
- Busca "bedrooms", "habitaciones", "alcobas" para habitaciones
- Busca "bathrooms", "baños" para baños
- Busca "garages", "parqueadero", "garaje" para parqueaderos
- Busca "estrato", "stratum" para estrato
- Busca "maintenance_fee", "administracion", "admin" para administración
- Busca "floor", "nivel", "piso" para piso
- La foto debe ser la URL de og:image o la primera imagen grande del inmueble

Responde SOLO con JSON puro. Sin backticks, sin markdown, sin explicación.`,
        messages: [{ 
          role: "user", 
          content: "Extrae TODOS los datos de este inmueble. URL: " + url + (propertyId ? " (ID: " + propertyId + ")" : "") + "\n\nDatos básicos ya encontrados: " + JSON.stringify(basicData) + "\n\nHTML completo:\n" + htmlToSend + '\n\nDevuelve SOLO este JSON con TODOS los campos llenos: {"nombre":"","foto":"","direccion":"","ciudad":"","barrio":"","tipo":"Apartamento","areaTotal":0,"areaPrivada":0,"estrato":0,"piso":0,"antiguedad":0,"habitaciones":0,"banos":0,"parqueaderos":0,"deposito":"No","vista":"Exterior","estado":"Original","valorLista":0,"adminMensual":0,"predialAnual":0,"amenidades":"","descripcion":""}' 
        }]
      })
    });

    const apiData = await response.json();
    
    if (apiData.type === "error") {
      // If Claude fails, return basic data we have
      if (basicData && Object.keys(basicData).length > 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: basicData }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: JSON.stringify(apiData.error) }) };
    }

    let allText = "";
    if (apiData.content) {
      for (const block of apiData.content) {
        if (block.type === "text") allText += block.text;
      }
    }

    const clean = allText.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    
    if (match) {
      try {
        const claudeData = JSON.parse(match[0]);
        // Merge: Claude fills everything, basicData as fallback
        const merged = {};
        const keys = ["nombre","foto","direccion","ciudad","barrio","tipo","areaTotal","areaPrivada","estrato","piso","antiguedad","habitaciones","banos","parqueaderos","deposito","vista","estado","valorLista","adminMensual","predialAnual","amenidades","descripcion"];
        
        for (const k of keys) {
          const cv = claudeData[k];
          const bv = basicData[k];
          // Prefer Claude's value if it's meaningful
          if (cv !== undefined && cv !== null && cv !== "" && cv !== 0) {
            merged[k] = cv;
          } else if (bv !== undefined && bv !== null && bv !== "" && bv !== 0) {
            merged[k] = bv;
          } else {
            merged[k] = cv !== undefined ? cv : (bv !== undefined ? bv : (typeof cv === "number" ? 0 : ""));
          }
        }
        
        // Ensure numeric fields are numbers
        ["areaTotal","areaPrivada","estrato","piso","antiguedad","habitaciones","banos","parqueaderos","valorLista","adminMensual","predialAnual"].forEach(k => {
          merged[k] = Number(merged[k]) || 0;
        });
        
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: merged }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: basicData }) };
      }
    }

    // Fallback
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: basicData }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function extractFromHTML(html, url) {
  const r = {};

  // Title
  const t = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || html.match(/<title[^>]*>([^<]+)/i);
  r.nombre = t ? t[1].replace(/\s*[-|].*$/, "").trim() : "";

  // Photo
  const img = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  r.foto = img ? img[1] : "";

  // Description
  const desc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  r.descripcion = desc ? desc[1].substring(0, 200) : "";
  r.direccion = r.descripcion.substring(0, 100);

  // Type from URL
  r.tipo = /casa/i.test(url) ? "Casa" : /oficina/i.test(url) ? "Oficina" : /local/i.test(url) ? "Local" : "Apartamento";
  
  // City from URL
  r.ciudad = /medell/i.test(url) ? "Medellín" : /bogot/i.test(url) ? "Bogotá" : /cali[^a-z]/i.test(url) ? "Cali" : /barranquilla/i.test(url) ? "Barranquilla" : /cartagena/i.test(url) ? "Cartagena" : "";
  r.barrio = /poblado/i.test(url) ? "El Poblado" : /palmas/i.test(url) ? "Las Palmas" : /laureles/i.test(url) ? "Laureles" : /envigado/i.test(url) ? "Envigado" : "";

  // Try to find structured data in scripts
  const allScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let scriptText = allScripts.join(" ");

  // Price patterns
  r.valorLista = 0;
  const pricePatterns = [
    /sale_price['":\s]+["']?(\d[\d]*?)["']?[,\s}]/,
    /sale_price_label['":\s]+['"]\$?([\d.]+)['"]/,
    /precio[^"]*?(\d{9,12})/i,
    /\$\s*([\d]+(?:\.[\d]{3}){2,})/,
    /price['":\s]+["']?(\d{8,12})["']?/i,
  ];
  for (const p of pricePatterns) {
    const m = (html + scriptText).match(p);
    if (m) {
      let v = parseInt(m[1].replace(/\./g, "")) || 0;
      if (v >= 50000000 && v <= 50000000000) { r.valorLista = v; break; }
    }
  }

  // Area
  r.areaTotal = 0;
  const areaPatterns = [/area['":\s]+["']?(\d+)["']?/i, /([\d]+)\s*m[²2t]/i, /built_area['":\s]+["']?(\d+)/i];
  for (const p of areaPatterns) {
    const m = (html + scriptText).match(p);
    if (m) { const v = parseInt(m[1]); if (v > 10 && v < 10000) { r.areaTotal = v; break; } }
  }

  // Private area
  r.areaPrivada = 0;
  const pm = (html + scriptText).match(/private_area['":\s]+["']?(\d+)/i);
  if (pm) r.areaPrivada = parseInt(pm[1]) || 0;

  // Rooms
  r.habitaciones = 0;
  const rm = (html + scriptText).match(/bedrooms['":\s]+["']?(\d+)/i) || (html + scriptText).match(/habitacion[^"]*?(\d+)/i) || (html + scriptText).match(/(\d+)\s*(?:habitac|alcoba)/i);
  if (rm) r.habitaciones = parseInt(rm[1]) || 0;

  // Bathrooms
  r.banos = 0;
  const bm = (html + scriptText).match(/bathrooms['":\s]+["']?(\d+)/i) || (html + scriptText).match(/ba[ñn]os?['":\s]+["']?(\d+)/i) || (html + scriptText).match(/(\d+)\s*ba[ñn]o/i);
  if (bm) r.banos = parseInt(bm[1]) || 0;

  // Parking
  r.parqueaderos = 0;
  const gm = (html + scriptText).match(/garages['":\s]+["']?(\d+)/i) || (html + scriptText).match(/garaje['":\s]+["']?(\d+)/i) || (html + scriptText).match(/parqueadero[^"]*?(\d+)/i) || (html + scriptText).match(/(\d+)\s*(?:parqueadero|garaje)/i);
  if (gm) r.parqueaderos = parseInt(gm[1]) || 0;

  // Estrato
  r.estrato = 0;
  const em = (html + scriptText).match(/estrato['":\s]+["']?(\d)['":]?/i) || (html + scriptText).match(/stratum['":\s]+["']?(\d)/i);
  if (em) r.estrato = parseInt(em[1]) || 0;

  // Admin
  r.adminMensual = 0;
  const am = (html + scriptText).match(/maintenance_fee['":\s]+["']?(\d+)/i) || (html + scriptText).match(/admin[a-z]*['":\s]+\$?\s*["']?([\d.]+)/i);
  if (am) { let v = parseInt(am[1].replace(/\./g, "")); if (v >= 50000 && v <= 5000000) r.adminMensual = v; }

  // Floor
  r.piso = 0;
  const fm = (html + scriptText).match(/floor['":\s]+["']?(\d+)/i) || (html + scriptText).match(/nivel['":\s]+["']?(\d+)/i) || (html + scriptText).match(/piso['":\s]+["']?(\d+)/i);
  if (fm) r.piso = parseInt(fm[1]) || 0;

  // Amenities
  const amenities = [];
  if (/piscina/i.test(html)) amenities.push("Piscina");
  if (/gimnasio|gym/i.test(html)) amenities.push("Gimnasio");
  if (/sauna/i.test(html)) amenities.push("Sauna");
  if (/turco/i.test(html)) amenities.push("Turco");
  if (/jacuzzi/i.test(html)) amenities.push("Jacuzzi");
  if (/squash/i.test(html)) amenities.push("Squash");
  if (/sal[oó]n\s*(social|comunal)/i.test(html)) amenities.push("Salón Social");
  if (/bbq|asadero/i.test(html)) amenities.push("BBQ");
  if (/zona\s*infantil|juegos\s*infantil/i.test(html)) amenities.push("Zona Infantil");
  r.amenidades = amenities.join(", ");

  r.vista = /panoram/i.test(html) ? "Panorámica" : "Exterior";
  r.deposito = /(?:cuarto\s*[uú]til|dep[oó]sito)/i.test(html) ? "Sí" : "No";
  r.estado = /remodelad/i.test(html) ? "Remodelado total" : /nuevo|estrenar/i.test(html) ? "Nuevo" : /usado/i.test(html) ? "Original" : "Original";
  r.antiguedad = 0;
  const ym = (html + scriptText).match(/(?:building_date|año\s*(?:de\s*)?construcci[oó]n)['":\s]+["']?(\d{4})/i);
  if (ym) r.antiguedad = new Date().getFullYear() - parseInt(ym[1]);
  r.predialAnual = 0;

  return r;
}
