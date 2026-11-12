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

    const instruccionesSistema = `Eres docente de 2º de Primaria (niños de 7-8 años). Responde en español claro, educativo y seguro para niños.
Devuelve SOLO un JSON válido con esta estructura exacta:
{
  "titulo": "Nombre del tema",
  "oraciones": ["Oración 1 corta.", "Oración 2..."],
  "continente": "África | América | Asia | Europa | Oceanía | Antártida | Todo el mundo",
  "pais": "País o países principales (o 'Todo el planeta')",
  "curiosidades": ["Curiosidad 1.", "Curiosidad 2.", "Curiosidad 3."],
  "busqueda_imagen": "término corto para foto real"
}
Reglas:
- "oraciones": 8 a 10 oraciones cortas y fáciles de leer (características, hábitat y datos clave).
- "curiosidades": 3 datos sorprendentes y breves.`;

    const consultarGemini = async (modelo, thinkingLevel) => {
      const tiempoRestante = 9200 - (Date.now() - inicio);
      if (tiempoRestante < 1800) {
        return {
          ok: false,
          status: 504,
          data: { error: { message: "Tiempo límite alcanzado en el servidor." } }
        };
      }

      const modeloLimpio = modelo.replace(/^models\//, "");
      const generationConfig = {
        temperature: 0.4,
        maxOutputTokens: 850,
        responseMimeType: "application/json"
      };

      if (thinkingLevel) {
        generationConfig.thinkingConfig = { thinkingLevel };
      }

      const payload = {
        systemInstruction: {
          parts: [{ text: instruccionesSistema }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: promptUsuario }]
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

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modeloLimpio}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
        const rawText = await response.text();
        let data = {};
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          data = { error: { message: `Respuesta inesperada de Google (HTTP ${response.status}).` } };
        }
        return { ok: response.ok, status: response.status, data };
      } catch (err) {
        clearTimeout(timeoutId);
        return {
          ok: false,
          status: 504,
          data: { error: { message: `Google tardó demasiado en responder (${modeloLimpio}).` } }
        };
      }
    };

    // 1. Llamada rápida a gemini-3.8-flash con razonamiento mínimo
    let res = await consultarGemini("gemini-3.8-flash", "minimal");

    // 2. Si "minimal" no aplica, prueba con "low"
    if (!res.ok && res.status === 400) {
      res = await consultarGemini("gemini-3.8-flash", "low");
    }

    // 3. Si hubo saturación puntual (503), espera medio segundo y reintenta el mismo modelo
    if (!res.ok && res.status === 503 && Date.now() - inicio < 5500) {
      await new Promise((r) => setTimeout(r, 500));
      res = await consultarGemini("gemini-3.8-flash", "minimal");
    }

    const errorPrincipal = {
      status: res.status,
      mensaje: res.data?.error?.message || `Error HTTP ${res.status}`
    };

    // 4. Si sigue fallando por modelo no encontrado o saturado, busca automáticamente un modelo Flash activo en tu cuenta
    if (!res.ok && (res.status === 404 || res.status === 503) && Date.now() - inicio < 6000) {
      try {
        const listaRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        );
        if (listaRes.ok) {
          const listaData = await listaRes.json();
          const alternativo = (listaData.models || []).find(
            (m) =>
              Array.isArray(m.supportedGenerationMethods) &&
              m.supportedGenerationMethods.includes("generateContent") &&
              /flash/i.test(m.name) &&
              !/gemini-3\.8-flash$|1\.5|2\.0|2\.5/.test(m.name)
          );
          if (alternativo) {
            const resAlt = await consultarGemini(alternativo.name, "minimal");
            if (resAlt.ok) {
              res = resAlt;
            }
          }
        }
      } catch (e) {
        // Mantiene el errorPrincipal si falla el listado
      }
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

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `Google rechazó la consulta (${errorPrincipal.status}): ${errorPrincipal.mensaje}`
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
