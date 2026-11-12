exports.handler = async function (event) {
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

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
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

    const instruccionesSistema = `Eres un maestro o maestra de 2º de Primaria (niños y niñas de 7 y 8 años).
Responde SIEMPRE en español claro, cercano, educativo y 100% seguro para la infancia.
Devuelve ÚNICAMENTE un objeto JSON válido (sin bloques markdown ni texto adicional) con esta estructura exacta:
{
  "titulo": "Nombre claro del tema buscado",
  "oraciones": [
    "Oración 1 sencilla y corta.",
    "Oración 2..."
  ],
  "continente": "África | América | Asia | Europa | Oceanía | Antártida | Todo el mundo",
  "pais": "País o países principales donde se encuentra (o 'Todo el planeta' si es algo universal)",
  "curiosidades": [
    "Curiosidad 1 sorprendente para niños.",
    "Curiosidad 2...",
    "Curiosidad 3..."
  ],
  "busqueda_imagen": "término corto y exacto para buscar una foto real"
}
Reglas obligatorias:
- El array "oraciones" debe tener entre 10 y 15 oraciones breves, fáciles de leer y comprender en 2º de Primaria.
- Incluye características principales, dónde vive o dónde está, y datos interesantes.`;

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
      generationConfig: {
        temperature: 0.5,
        responseMimeType: "application/json"
      }
    };

    const modelos = ["gemini-2.5-flash", "gemini-2.0-flash"];
    let ultimoError = "No se pudo conectar con Gemini.";
    let ultimoStatus = 502;

    for (const modelo of modelos) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        const candidato = data.candidates && data.candidates[0];
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

      ultimoStatus = response.status;
      ultimoError = data?.error?.message || `Error HTTP ${response.status}`;

      if (response.status === 400 || response.status === 403) {
        break;
      }
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `Google rechazó la consulta (${ultimoStatus}): ${ultimoError}`
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
