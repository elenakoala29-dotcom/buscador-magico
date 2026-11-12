exports.handler = async function (event) {
  const inicio = Date.now();
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Método no permitido. Usa POST." })
    };
  }

  const apiKey = (process.env.GEMINI_API_KEY || "")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "La clave del buscador no está configurada en el servidor (GEMINI_API_KEY)."
      })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const promptUsuario = (body.prompt || "").trim();

    if (!promptUsuario) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Escribe qué quieres buscar primero." })
      };
    }

    const promptCompleto = `Eres docente de 2º de Primaria (7-8 años). Responde en español claro, educativo y seguro para niños sobre: "${promptUsuario}".
Devuelve SOLO un JSON válido con esta estructura:
{
  "titulo": "Nombre claro del tema",
  "oraciones": ["Oración 1 muy breve.", "Oración 2..."],
  "continente": "África | América | Asia | Europa | Oceanía | Antártida | Todo el mundo",
  "pais": "País o países principales (o 'Todo el planeta')",
  "curiosidades": ["Curiosidad 1 corta.", "Curiosidad 2 corta.", "Curiosidad 3 corta."],
  "busqueda_imagen": "término corto para foto real"
}
Reglas: 6 a 8 oraciones cortas y fáciles de leer (qué es, cómo es y dónde vive o está). 3 curiosidades breves.`;

    const llamarGemini = async (thinkingConfig) => {
      const tiempoRestante = 9600 - (Date.now() - inicio);
      if (tiempoRestante < 1500) {
        return {
          ok: false,
          status: 504,
          data: { error: { message: "Tiempo límite alcanzado en Netlify." } }
        };
      }

      const generationConfig = {
        temperature: 0.4,
        maxOutputTokens: 600,
        responseMimeType: "application/json"
      };

      if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }

      const payload = {
        contents: [
          {
            role: "user",
            parts: [{ text: promptCompleto }]
          }
        ],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" }
        ],
        generationConfig
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), tiempoRestante);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await response.json();
        return { ok: response.ok, status: response.status, data };
      } catch (err) {
        clearTimeout(timeoutId);
        return {
          ok: false,
          status: 504,
          data: { error: { message: "La respuesta superó los 9,6 segundos permitidos por Netlify." } }
        };
      }
    };

    // 1. Modo ultrarrápido (sin tiempo extra de razonamiento)
    let res = await llamarGemini({ thinkingLevel: "MINIMAL" });

    // 2. Si ese nivel no aplica, prueba con nivel bajo
    if (!res.ok && res.status === 400) {
      res = await llamarGemini({ thinkingLevel: "LOW" });
    }

    // 3. Si sigue dando 400 por el parámetro, envía sin thinkingConfig
    if (!res.ok && res.status === 400) {
      res = await llamarGemini(null);
    }

    if (res.ok) {
      const candidato = res.data.candidates && res.data.candidates[0];
      if (!candidato || candidato.finishReason === "SAFETY") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            error: "Esa búsqueda no es adecuada para clase. ¡Prueba con otro animal, lugar o invento!"
          })
        };
      }

      let texto = candidato.content?.parts?.[0]?.text || "";
      texto = texto.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ resultado: texto })
      };
    }

    const mensajeError = res.data?.error?.message || `Error HTTP ${res.status}`;
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `Google rechazó la consulta (${res.status}): ${mensajeError}`
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: `Error interno en el servidor: ${err.message}`
      })
    };
  }
};
