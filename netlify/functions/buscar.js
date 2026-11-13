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
        error: "La clave del buscador no está configurada en Netlify (GEMINI_API_KEY)."
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
          // Ignorar si la conexión ya cerró
        }
      }, 2000);

      try {
        const promptCompleto = `Eres docente de 2º de Primaria (niños y niñas de 7-8 años).
Responde en español claro, cercano, educativo y 100% seguro para la infancia sobre: "${promptUsuario}".
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "titulo": "Nombre claro del tema",
  "pais": "País o países principales donde se encuentra (o 'Todo el planeta')",
  "continente": "América del Norte | América del Sur | Europa | África | Asia | Oceanía | Antártida | Todo el mundo",
  "caracteristicas": ["Etiqueta corta 1", "Etiqueta corta 2", "Etiqueta corta 3"],
  "oraciones": [
    "Oración 1 muy sencilla y breve.",
    "Oración 2..."
  ],
  "curiosidades": [
    "Dato curioso 1 corto y sorprendente.",
    "Dato curioso 2...",
    "Dato curioso 3..."
  ],
  "busquedaImagen": "término corto y exacto para buscar una foto real en Wikipedia",
  "websRecomendadas": [
    {
      "nombre": "Vikidia - Enciclopedia Escolar",
      "descripcion": "Enciclopedia libre adaptada para niños de Primaria",
      "url": "https://es.vikidia.org"
    },
    {
      "nombre": "National Geographic Kids",
      "descripcion": "Artículos y fotos sobre animales, ciencia y naturaleza",
      "url": "https://kids.nationalgeographic.com"
    },
    {
      "nombre": "Wikimedia Commons",
      "descripcion": "Fotografías e ilustraciones educativas libres",
      "url": "https://commons.wikimedia.org"
    }
  ]
}
Reglas obligatorias:
- "oraciones": entre 10 y 12 oraciones cortas y fáciles de leer (qué es, cómo es, dónde vive o está y por qué es importante).
- "caracteristicas": 3 o 4 palabras clave cortas (ej: "Mamífero", "Carnívoro", "Sabana").
- "curiosidades": 3 o 4 datos curiosos breves para compartir en clase.`;

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

        // 1. Usa nivel de pensamiento "low" (compatible con gemini-3.8-flash)
        let res = await llamarGemini({ thinkingLevel: "low" });

        // 2. Si "low" no aplicara, reintenta con la configuración por defecto del modelo
        if (!res.ok && res.status === 400) {
          res = await llamarGemini(null);
        }

        // 3. Si hubo saturación puntual (503), reintenta una vez
        if (!res.ok && res.status === 503) {
          await new Promise((r) => setTimeout(r, 600));
          res = await llamarGemini({ thinkingLevel: "low" });
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
                  error: `Gemini devolvió la ficha vacía (motivo: ${candidato.finishReason || "desconocido"}).`
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
            objetoFicha = {
              titulo: promptUsuario,
              pais: "Todo el planeta",
              continente: "Todo el mundo",
              caracteristicas: ["2º de Primaria"],
              oraciones: [texto],
              curiosidades: ["¡Sigue explorando temas nuevos con tu clase!"],
              busquedaImagen: promptUsuario
            };
          }

          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                ...objetoFicha,
                resultado: objetoFicha
              })
            )
          );
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
