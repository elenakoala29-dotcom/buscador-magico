/**
 * Función Serverless de Netlify: netlify/functions/buscar.js
 * Recibe { prompt } por POST desde index.html, consulta el modelo gemini-1.5-flash
 * usando process.env.GEMINI_API_KEY con un filtro infantil estricto y devuelve { resultado }.
 */

exports.handler = async function (event, context) {
    // Cabeceras CORS estándar para permitir peticiones desde el frontend
    const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    // Responder a peticiones preflight OPTIONS
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ""
        };
    }

    // Validar que el método sea POST
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Método no permitido. Utiliza POST." })
        };
    }

    // Leer la clave de API oculta en las variables de entorno de Netlify
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("Falta la variable de entorno GEMINI_API_KEY en Netlify.");
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "La clave del buscador no está configurada en el servidor (GEMINI_API_KEY)."
            })
        };
    }

    try {
        // Parsear el cuerpo recibido desde index.html
        const body = event.body ? JSON.parse(event.body) : {};
        const promptUsuario = (body.prompt || "").trim();

        if (!promptUsuario) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Debes escribir una palabra o tema para buscar." })
            };
        }

        // Limitar longitud de entrada por seguridad
        const consultaSegura = promptUsuario.slice(0, 150);

        // Instrucciones del sistema con filtro educativo e infantil estricto (2º de Primaria: 7-8 años)
        const systemInstructionText = `
            Eres un docente experto y protector en 2º de Educación Primaria en España (niños y niñas de 7 a 8 años).
            Tu tarea es responder a la búsqueda del alumnado: "${consultaSegura}".

            REGLAS DE SEGURIDAD INFANTIL OBLIGATORIAS:
            1. Todo el contenido debe ser 100% seguro, educativo, amable y apto para niños de 7 años.
            2. Si la búsqueda pide contenido violento, adulto, aterrador, peligroso o inapropiado para niños de primaria, NO lo describas; en su lugar devuelve un mensaje educativo amable indicando que ese tema está protegido en el buscador escolar y sugiere buscar sobre animales, países, naturaleza o el espacio.
            3. Usa un lenguaje claro, cariñoso, positivo y fácil de leer.

            FORMATO DE RESPUESTA OBLIGATORIO (JSON ESTRICTO):
            Debes responder ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
            {
                "titulo": "Título amigable y claro (ej. El León africano)",
                "pais": "Nombre del país o región principal donde vive o se encuentra (ej: Kenia, Egipto, Francia, En todo el mundo)",
                "continente": "Debe ser EXACTAMENTE uno de estos valores: América del Norte | América del Sur | Europa | África | Asia | Oceanía | Antártida | Global / Espacio",
                "oraciones": [
                    "Oración 1 breve y sencilla.",
                    "Oración 2 breve y sencilla."
                ],
                "caracteristicas": [
                    "Dato rápido 1 (2-4 palabras)",
                    "Dato rápido 2",
                    "Dato rápido 3"
                ],
                "curiosidades": [
                    "Dato curioso y divertido 1",
                    "Dato curioso y divertido 2",
                    "Dato curioso y divertido 3",
                    "Dato curioso y divertido 4"
                ],
                "busquedaImagen": "Término conciso en inglés para buscar su fotografía real (ej: Lion, Pyramids of Giza, Eiffel Tower)",
                "websRecomendadas": [
                    {
                        "nombre": "Vikidia - Enciclopedia Escolar",
                        "descripcion": "Enciclopedia libre para niños de primaria",
                        "url": "https://es.vikidia.org"
                    },
                    {
                        "nombre": "National Geographic Kids",
                        "descripcion": "Artículos con fotos de la naturaleza y animales",
                        "url": "https://kids.nationalgeographic.com"
                    },
                    {
                        "nombre": "Wikimedia Commons",
                        "descripcion": "Imágenes y archivos educativos libres",
                        "url": "https://commons.wikimedia.org"
                    }
                ]
            }
            Importante: El array "oraciones" DEBE contener ESTRICTAMENTE entre 10 y 15 oraciones cortas y fáciles de entender.
        `;

        // URL oficial del modelo gemini-1.5-flash
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        // Payload con filtro de seguridad infantil estricto (BLOCK_LOW_AND_ABOVE en todas las categorías)
        const payload = {
            systemInstruction: {
                parts: [{ text: systemInstructionText }]
            },
            contents: [
                {
                    role: "user",
                    parts: [{ text: `Busca y explica para 2º de Primaria: ${consultaSegura}` }]
                }
            ],
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_LOW_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_LOW_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_LOW_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_LOW_AND_ABOVE"
                }
            ],
            generationConfig: {
                temperature: 0.5,
                responseMimeType: "application/json"
            }
        };

        const geminiResponse = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!geminiResponse.ok) {
            const errorDetail = await geminiResponse.text();
            console.error("Error de respuesta en Gemini API:", geminiResponse.status, errorDetail);
            return {
                statusCode: geminiResponse.status,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "No se pudo obtener respuesta del asistente educativo en este momento."
                })
            };
        }

        const rawData = await geminiResponse.json();
        const candidate = rawData.candidates?.[0];

        // Comprobar si el filtro infantil de Gemini bloqueó la consulta
        if (rawData.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
            const respuestaSeguraBloqueo = {
                titulo: "Búsqueda protegida 🛡️",
                pais: "Aula Segura",
                continente: "Global / Espacio",
                oraciones: [
                    "Este tema está protegido por nuestro filtro infantil de 2º de Primaria.",
                    "El buscador está preparado para mostrar solo temas educativos adecuados a tu edad.",
                    "Puedes buscar información sobre animales sorprendentes como el león o el canguro.",
                    "También puedes descubrir países, ríos como el Amazonas o monumentos como la Torre Eiffel.",
                    "Si tienes curiosidad sobre cualquier tema, pregúntale a tu maestra o maestro en clase.",
                    "¡Prueba ahora pulsando uno de los botones de ejemplos rápidos de arriba!"
                ],
                caracteristicas: ["Filtro Infantil Activo", "Entorno Escolar Seguro", "2º de Primaria"],
                curiosidades: [
                    "El filtro infantil ayuda a que navegues por Internet de forma segura en el colegio.",
                    "¡Hay miles de animales, planetas y lugares del mundo esperando a que los explores!"
                ],
                busquedaImagen: "school books globe",
                websRecomendadas: [
                    {
                        nombre: "Vikidia - Enciclopedia Escolar",
                        descripcion: "Enciclopedia libre para niños de primaria",
                        url: "https://es.vikidia.org"
                    },
                    {
                        nombre: "National Geographic Kids",
                        descripcion: "Artículos con fotos de la naturaleza y animales",
                        url: "https://kids.nationalgeographic.com"
                    },
                    {
                        nombre: "Wikimedia Commons",
                        descripcion: "Imágenes y archivos educativos libres",
                        url: "https://commons.wikimedia.org"
                    }
                ]
            };

            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({ resultado: respuestaSeguraBloqueo })
            };
        }

        const textContent = candidate?.content?.parts?.[0]?.text || "";
        const cleanJsonText = textContent.replace(/```json/gi, "").replace(/```/g, "").trim();
        const resultadoParseado = JSON.parse(cleanJsonText);

        // Devolver el objeto { resultado: ... } esperado por index.html
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ resultado: resultadoParseado })
        };

    } catch (error) {
        console.error("Error interno en netlify/functions/buscar.js:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Ocurrió un error al procesar la búsqueda en el servidor."
            })
        };
    }
};