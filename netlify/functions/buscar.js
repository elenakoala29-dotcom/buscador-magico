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
        const promptCompleto = `Docente de 2º de Primaria (7-8 años). Tema: "${promptUsuario}".
Responde en español muy claro, educativo y seguro para niños, SOLO con este JSON válido:
{
  "titulo": "Nombre claro del tema",
  "pais": "País o países principales (o 'Todo el planeta')",
  "continente": "América del Norte | América del Sur | Europa | África | Asia | Oceanía | Antártida | Todo el mundo",
  "caracteristicas": ["Etiqueta 1", "Etiqueta 2", "Etiqueta 3"],
  "oraciones": ["Oración 1 corta.", "Oración 2 corta."],
  "curiosidades": ["Curiosidad 1 breve.", "Curiosidad 2 breve.", "Curiosidad 3 breve."],
  "busquedaImagen": "término exacto para foto en Wikipedia"
}
Reglas: 8 a 10 oraciones cortas (máximo 12 palabras cada una) sobre qué es, cómo es y dónde vive o está. 3 curiosidades muy breves.`;

        const llamarGeminiStream = async (thinkingConfig) => {
          const generationConfig = {
            temperature: 0.4,
            maxOutputTokens: 1500,
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

          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
          const abortCtrl = new AbortController();
          const timeoutId = setTimeout(() => abortCtrl.abort(), 28000);

          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: abortCtrl.signal
            });

            if (!response.ok) {
              clearTimeout(timeoutId);
              const errText = await response.text();
              let errData = {};
              try {
                errData = JSON.parse(errText);
              } catch (e) {
                errData = { error: { message: `Error HTTP ${response.status}` } };
              }
              return { ok: false, status: response.status, data: errData };
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let textoCompleto = "";
            let finishReason = "";

            const procesarLinea = (linea) => {
              const trimmed = linea.trim();
              if (!trimmed.startsWith("data:")) return;
              const jsonStr = trimmed.slice(5).trim();
              if (!jsonStr || jsonStr === "[DONE]") return;
              try {
                const chunk = JSON.parse(jsonStr);
                const cand = chunk.candidates && chunk.candidates[0];
                if (cand) {
                  if (cand.finishReason) finishReason = cand.finishReason;
                  const parts = cand.content?.parts || [];
                  for (const p of parts) {
                    if (!p.thought && typeof p.text === "string") {
                      textoCompleto += p.text;
                    }
                  }
                }
              } catch (e) {
                // Ignorar fragmentos parciales
              }
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lineas = buffer.split("\n");
              buffer = lineas.pop() || "";
              for (const linea of lineas) {
                procesarLinea(linea);
              }
            }

            if (buffer.trim()) {
              procesarLinea(buffer);
            }

            clearTimeout(timeoutId);
            return { ok: true, status: 200, texto: textoCompleto, finishReason };
          } catch (err) {
            clearTimeout(timeoutId);
            return {
              ok: false,
              status: 504,
              data: { error: { message: "Google tardó más de 28 segundos en responder." } }
            };
          }
        };

        let res = await llamarGeminiStream({ thinkingLevel: "low" });

        if (!res.ok && res.status === 400) {
          res = await llamarGeminiStream(null);
        }

        clearInterval(keepAlive);

        if (res.ok) {
          if (res.finishReason === "SAFETY") {
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

          const texto = (res.texto || "")
            .replace(/^```json\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

          if (!texto) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  error: `Gemini devolvió la ficha vacía (motivo: ${res.finishReason || "desconocido"}).`
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
