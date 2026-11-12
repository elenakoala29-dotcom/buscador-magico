export default async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Método no permitido. Usa POST." }),
      { status: 405, headers }
    );
  }

  const apiKey = (process.env.GEMINI_API_KEY || "")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "La clave del buscador no está configurada en el servidor (GEMINI_API_KEY)."
      }),
      { status: 500, headers }
    );
  }

  let promptUsuario = "";
  try {
    const body = await req.json();
    promptUsuario = (body.prompt || "").trim();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "No se pudo leer la búsqueda enviada." }),
      { status: 400, headers }
    );
  }

  if (!promptUsuario) {
    return new Response(
      JSON.stringify({ error: "Escribe qué quieres buscar primero." }),
      { status: 400, headers }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Mantiene abierta la conexión desde el segundo 0 para evitar cortes de Netlify
      controller.enqueue(encoder.encode(" "));

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch (e) {
          // Ignorar si la conexión ya finalizó
        }
      }, 2500);

      try {
        const promptCompleto = `Eres docente de 2º de Primaria (niños de 7-8 años). Responde en español claro, educativo y seguro para niños sobre: "${promptUsuario}".
Devuelve SOLO un JSON válido con esta estructura exacta:
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
          const generationConfig = {
            temperature: 0.4,
            maxOutputTokens: 2500,
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
          const abortCtrl = new AbortController();
          const timeoutId = setTimeout(() => abortCtrl.abort(), 24000);

          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: abortCtrl.signal
            });
            clearTimeout(timeoutId);
            const data = await response.json();
            return { ok: response.ok, status: response.status, data };
          } catch (err) {
            clearTimeout(timeoutId);
            return {
              ok: false,
              status: 504,
              data: { error: { message: "Google tardó más de 24 segundos en responder." } }
            };
          }
        };

        let res = await llamarGemini({ thinkingLevel: "minimal" });

        if (!res.ok && res.status === 400) {
          res = await llamarGemini({ thinkingLevel: "low" });
        }

        if (!res.ok && res.status === 400) {
          res = await llamarGemini(null);
        }

        clearInterval(keepAlive);

        if (res.ok) {
          const candidato = res.data.candidates && res.data.candidates[0];
          if (!candidato || candidato.finishReason === "SAFETY") {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  error: "Esa búsqueda no es adecuada para clase. ¡Prueba con otro animal, lugar o invento!"
                })
              )
            );
            controller.close();
            return;
          }

          const partes = candidato.content?.parts || [];
          let texto = partes
            .filter((p) => !p.thought && typeof p.text === "string")
            .map((p) => p.text)
            .join("")
            .replace(/^```json\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

          if (!texto) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  error: `Gemini devolvió una respuesta vacía (motivo: ${candidato.finishReason || "desconocido"}).`
                })
              )
            );
            controller.close();
            return;
          }

          let objetoFicha = {};
          try {
            objetoFicha = JSON.parse(texto);
          } catch (e) {
            objetoFicha = { titulo: promptUsuario, oraciones: [texto] };
          }

          // Incluye la ficha directa y todos los nombres habituales para que index.html la lea sin fallos
          const respuestaCompleta = {
            ...objetoFicha,
            resultado: texto,
            respuesta: texto,
            texto: texto,
            result: texto,
            contenido: texto
          };

          controller.enqueue(encoder.encode(JSON.stringify(respuestaCompleta)));
          controller.close();
          return;
        }

        const mensajeError = res.data?.error?.message || `Error HTTP ${res.status}`;
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              error: `Google rechazó la consulta (${res.status}): ${mensajeError}`
            })
          )
        );
        controller.close();
      } catch (err) {
        clearInterval(keepAlive);
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              error: `Error interno en el servidor: ${err.message}`
            })
          )
        );
        controller.close();
      }
    }
  });

  return new Response(stream, { status: 200, headers });
};
