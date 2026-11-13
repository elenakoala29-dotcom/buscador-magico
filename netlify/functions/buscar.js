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

  const detectarContinente = (texto) => {
    const t = texto.toLowerCase();
    if (t.includes("américa del norte") || t.includes("norteamérica") || t.includes("estados unidos") || t.includes("canadá") || t.includes("méxico")) return "América del Norte";
    if (t.includes("américa del sur") || t.includes("sudamérica") || t.includes("amazonas") || t.includes("brasil") || t.includes("argentina") || t.includes("perú")) return "América del Sur";
    if (t.includes("áfrica") || t.includes("africa") || t.includes("egipto") || t.includes("sabana") || t.includes("kenia")) return "África";
    if (t.includes("europa") || t.includes("españa") || t.includes("francia") || t.includes("parís") || t.includes("italia")) return "Europa";
    if (t.includes("asia") || t.includes("china") || t.includes("japón") || t.includes("india")) return "Asia";
    if (t.includes("oceanía") || t.includes("oceania") || t.includes("australia") || t.includes("canguro")) return "Oceanía";
    if (t.includes("antártida") || t.includes("antartida") || t.includes("polo sur")) return "Antártida";
    return "Todo el mundo";
  };

  const websPorDefecto = [
    {
      nombre: "Vikidia - Enciclopedia Escolar",
      descripcion: "Enciclopedia libre adaptada para niños de Primaria",
      url: "https://es.vikidia.org"
    },
    {
      nombre: "National Geographic Kids",
      descripcion: "Artículos y fotos sobre animales, ciencia y naturaleza",
      url: "https://kids.nationalgeographic.com"
    },
    {
      nombre: "Wikimedia Commons",
      descripcion: "Fotografías e ilustraciones educativas libres",
      url: "https://commons.wikimedia.org"
    }
  ];

  const parsearRespuestaGemini = (textoPlano) => {
    const lineas = textoPlano.split("\n").map((l) => l.trim()).filter(Boolean);
    let titulo = promptUsuario;
    let pais = "Todo el planeta";
    let continente = "";
    let caracteristicas = ["2º de Primaria", "Lectura Fácil"];
    const oraciones = [];
    const curiosidades = [];
    let busquedaImagen = promptUsuario;

    for (const linea of lineas) {
      if (/^TITULO:/i.test(linea)) {
        titulo = linea.replace(/^TITULO:/i, "").trim() || titulo;
      } else if (/^PAIS:/i.test(linea)) {
        pais = linea.replace(/^PAIS:/i, "").trim() || pais;
      } else if (/^CONTINENTE:/i.test(linea)) {
        continente = linea.replace(/^CONTINENTE:/i, "").trim();
      } else if (/^ETIQUETAS:/i.test(linea)) {
        const lista = linea
          .replace(/^ETIQUETAS:/i, "")
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        if (lista.length > 0) caracteristicas = lista.slice(0, 4);
      } else if (/^IMAGEN:/i.test(linea)) {
        busquedaImagen = linea.replace(/^IMAGEN:/i, "").trim() || busquedaImagen;
      } else if (/^-\s+/.test(linea)) {
        oraciones.push(linea.replace(/^-\s+/, "").trim());
      } else if (/^\*\s+/.test(linea)) {
        curiosidades.push(linea.replace(/^\*\s+/, "").trim());
      }
    }

    if (oraciones.length === 0) {
      const sueltas = textoPlano
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 15 && !/^(TITULO|PAIS|CONTINENTE|ETIQUETAS|IMAGEN):/i.test(s));
      oraciones.push(...sueltas.slice(0, 10));
    }

    if (curiosidades.length === 0) {
      curiosidades.push(
        "Es un tema muy interesante para investigar y comentar en clase.",
        "Puedes pulsar el botón rosa de arriba para escuchar toda la ficha en voz alta."
      );
    }

    return {
      titulo,
      pais,
      continente: continente || detectarContinente(`${titulo} ${pais} ${oraciones.join(" ")}`),
      caracteristicas,
      oraciones,
      curiosidades,
      busquedaImagen,
      websRecomendadas: websPorDefecto
    };
  };

  const buscarEnWikipedia = async (consulta) => {
    const wikiUrl = `https://es.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(consulta)}&gsrlimit=2&prop=extracts&exintro=1&explaintext=1&format=json`;
    const res = await fetch(wikiUrl, {
      headers: { "User-Agent": "BuscadorMagicoPrimaria/1.0 (educacion-primaria)" }
    });
    if (!res.ok) return null;

    const data = await res.json();
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    pages.sort((a, b) => (a.index || 0) - (b.index || 0));

    const articulo = pages.find((p) => p.extract && p.extract.trim().length > 60);
    if (!articulo) return null;

    const textoLimpio = articulo.extract
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const todasOraciones = textoLimpio
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 220);

    if (todasOraciones.length === 0) return null;

    const oraciones = todasOraciones.slice(0, 8);
    const curiosidades = todasOraciones.slice(8, 11);
    if (curiosidades.length === 0) {
      curiosidades.push(
        "Este resumen está adaptado de la enciclopedia libre para que sea fácil de leer en clase.",
        "Usa el botón rosa de ¡Escuchar! para oír la lectura paso a paso."
      );
    }

    const continente = detectarContinente(`${articulo.title} ${textoLimpio}`);

    return {
      titulo: articulo.title || consulta,
      pais: continente === "Todo el mundo" ? "Varios lugares del mundo" : `Regiones de ${continente}`,
      continente,
      caracteristicas: ["Enciclopedia Escolar", "2º de Primaria", "Lectura Fácil"],
      oraciones,
      curiosidades,
      busquedaImagen: articulo.title || consulta,
      websRecomendadas: websPorDefecto
    };
  };

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(" "));
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch (e) {}
      }, 2000);

      try {
        let fichaFinal = null;

        // 1. Intento rápido con Gemini en texto plano ligero (máximo 16 segundos)
        if (apiKey) {
          const promptLigero = `Docente de 2º de Primaria (7-8 años). Explica "${promptUsuario}" en español muy sencillo y seguro para niños.
Responde SOLO usando estas líneas exactas (sin saludos ni bloques de código):
TITULO: nombre claro
PAIS: país o países principales (o Todo el planeta)
CONTINENTE: América del Norte | América del Sur | Europa | África | Asia | Oceanía | Antártida | Todo el mundo
ETIQUETAS: palabra1, palabra2, palabra3
IMAGEN: término corto para buscar foto en Wikipedia
- oración corta 1
- oración corta 2
(escribe 8 oraciones muy fáciles sobre qué es, cómo es y dónde está)
* curiosidad breve 1
* curiosidad breve 2
* curiosidad breve 3`;

          const abortCtrl = new AbortController();
          const timeoutId = setTimeout(() => abortCtrl.abort(), 16000);

          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: promptLigero }] }],
                safetySettings: [
                  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
                  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
                  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
                  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" }
                ],
                generationConfig: {
                  temperature: 0.4,
                  maxOutputTokens: 750,
                  thinkingConfig: { thinkingLevel: "low" }
                }
              }),
              signal: abortCtrl.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) {
              const data = await response.json();
              const candidato = data.candidates && data.candidates[0];
              if (candidato && candidato.finishReason === "SAFETY") {
                clearInterval(keepAlive);
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

              const partes = candidato?.content?.parts || [];
              const texto = partes
                .filter((p) => !p.thought && typeof p.text === "string")
                .map((p) => p.text)
                .join("\n")
                .trim();

              if (texto) {
                fichaFinal = parsearRespuestaGemini(texto);
              }
            }
          } catch (e) {
            clearTimeout(timeoutId);
            // Si Gemini tarda más de 16s, continúa al respaldo automático de Wikipedia
          }
        }

        // 2. Respaldo automático en 0,3 segundos si Gemini tardó demasiado o agotó cuota
        if (!fichaFinal) {
          fichaFinal = await buscarEnWikipedia(promptUsuario);
        }

        clearInterval(keepAlive);

        if (fichaFinal) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                ...fichaFinal,
                resultado: fichaFinal
              })
            )
          );
          controller.close();
          return;
        }

        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              error: "No encontramos información sobre ese tema. Prueba a escribirlo de otra forma o usa los ejemplos rápidos."
            })
          )
        );
        controller.close();
      } catch (err) {
        clearInterval(keepAlive);
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              error: `Error en el servidor: ${err.message}`
            })
          )
        );
        controller.close();
      }
    }
  });

  return new Response(stream, { status: 200, headers });
};
