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

    const crearPayload = (usarThinkingZero) => {
      const generationConfig = {
        temperature: 0.5,
        maxOutputTokens: 1200,
        responseMimeType: "application/json"
      };
      if (usarThinkingZero) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      return {
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
    };

    const consultarModelo = async (versionApi, nombreModelo, usarThinkingZero) => {
      const modeloLimpio = nombreModelo.replace(/^models\//, "");
      const url = `https://generativelanguage.googleapis.com/${versionApi}/models/${modeloLimpio}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8500);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(crearPayload(usarThinkingZero)),
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
          data: { error: { message: `Tiempo agotado con ${modeloLimpio}.` } }
        };
      }
    };

    const candidatosPrueba = [
      { version: "v1beta", modelo: "gemini-3.8-flash", thinkingZero: true },
      { version: "v1", modelo: "gemini-3.8-flash", thinkingZero: false }
    ];

    let primerError = null;

    for (const intento of candidatosPrueba) {
      let res = await consultarModelo(intento.version, intento.modelo, intento.thinkingZero);

      if (!res.ok && res.status === 400 && intento.thinkingZero) {
        res = await consultarModelo(intento.version, intento.modelo, false);
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

      if (!primerError) {
        primerError = {
          status: res.status,
          mensaje: res.data?.error?.message || `Error HTTP ${res.status}`,
          modelo: intento.modelo
        };
      }
    }

    if (primerError && primerError.status === 404) {
      const listaRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (listaRes.ok) {
        const listaData = await listaRes.json();
        const modelosDisponibles = (listaData.models || [])
          .filter(
            (m) =>
              Array.isArray(m.supportedGenerationMethods) &&
              m.supportedGenerationMethods.includes("generateContent") &&
              /flash/i.test(m.name) &&
              !/2\.0|2\.5|1\.5/.test(m.name)
          )
          .map((m) => m.name);

        for (const nombreAuto of modelosDisponibles.slice(0, 2)) {
          const resAuto = await consultarModelo("v1beta", nombreAuto, false);
          if (resAuto.ok) {
            const candidato = resAuto.data.candidates && resAuto.data.candidates[0];
            let texto = candidato?.content?.parts?.[0]?.text || "";
            texto = texto.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ resultado: texto })
            };
          }
        }
      }
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `Google rechazó la consulta (${primerError.status} en ${primerError.modelo}): ${primerError.mensaje}`
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
