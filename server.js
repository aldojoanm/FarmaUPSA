const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require('fs');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Cargar datos desde JSON
let medicamentos = [];
function cargarDatos() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'medicamentos.json'), 'utf-8');
    medicamentos = JSON.parse(rawData).map(med => ({
      ...med,
      _id: med._id || Math.random().toString(36).substring(2, 15) // Generar ID si no existe
    }));
    console.log(`Datos cargados: ${medicamentos.length} medicamentos`);
  } catch (error) {
    console.error('Error cargando datos:', error);
    process.exit(1);
  }
}
cargarDatos();

// Cache local para mejor rendimiento
let cacheMedicamentos = {
  timestamp: Date.now(),
  data: [...medicamentos],
  ttl: 60000 // 1 minuto
};

// ==============================================
// MIDDLEWARES
// ==============================================

const validarBusqueda = (req, res, next) => {
  const { query } = req.query;
  if (!query || query.trim().length < 3) {
    return res.status(400).json({ 
      error: 'La búsqueda debe tener al menos 3 caracteres' 
    });
  }
  next();
};

// ==============================================
// RUTAS PARA MEDICAMENTOS
// ==============================================

// Cargar/actualizar datos desde JSON
app.get('/cargar-datos', (req, res) => {
  cargarDatos();
  cacheMedicamentos = {
    timestamp: Date.now(),
    data: [...medicamentos],
    ttl: 60000
  };
  
  res.json({ 
    success: true,
    message: `Datos recargados. ${medicamentos.length} medicamentos cargados.`,
    medicamentos: medicamentos.length
  });
});

// Buscar medicamentos
app.get('/api/medicamentos', validarBusqueda, (req, res) => {
  try {
    const { query, controlado } = req.query;
    const esControlado = controlado === 'true';

    // Intentar usar cache si está actualizado
    if (cacheMedicamentos.data && 
        (Date.now() - cacheMedicamentos.timestamp) < cacheMedicamentos.ttl) {
      console.log('Sirviendo desde cache');
      const resultados = cacheMedicamentos.data.filter(med => {
        const coincideNombre = med.nombre.toLowerCase().includes(query.toLowerCase());
        return coincideNombre && (esControlado ? med.controlado : !med.controlado);
      });
      return res.json(resultados.slice(0, 20));
    }

    // Búsqueda en los datos
    const resultados = medicamentos.filter(med => {
      const coincideNombre = med.nombre.toLowerCase().includes(query.toLowerCase());
      return coincideNombre && (esControlado ? med.controlado : !med.controlado);
    });

    // Actualizar cache
    cacheMedicamentos = {
      timestamp: Date.now(),
      data: [...medicamentos],
      ttl: 60000
    };

    res.json(resultados.slice(0, 20));
  } catch (error) {
    console.error('Error en búsqueda:', error);
    res.status(500).json({ 
      error: 'Error en la búsqueda',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==============================================
// RUTAS PARA STOCK
// ==============================================

// Verificar stock con manejo de errores robusto
app.post('/api/verificar-stock', (req, res) => {
  try {
    const { items } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Formato de datos inválido' });
    }

    const resultados = items.map(item => {
      try {
        const medicamento = medicamentos.find(m => m._id === item.id || m.nombre === item.nombre);
        
        if (!medicamento) {
          return { 
            id: item.id,
            error: 'Medicamento no encontrado',
            valido: false
          };
        }

        const cantidad = Number(item.cantidad) || 0;
        const stockDisponible = Number(medicamento.stock) || 0;

        if (cantidad <= 0) {
          return {
            id: item.id,
            nombre: medicamento.nombre,
            error: 'Cantidad inválida',
            valido: false
          };
        }

        if (stockDisponible < cantidad) {
          return {
            id: item.id,
            nombre: medicamento.nombre,
            error: `Stock insuficiente. Disponible: ${stockDisponible}`,
            valido: false,
            stockDisponible
          };
        }

        return {
          id: item.id || medicamento._id,
          nombre: medicamento.nombre,
          precio: medicamento.precio,
          stockDisponible,
          valido: true
        };
      } catch (error) {
        console.error(`Error verificando item ${item.id}:`, error);
        return {
          id: item.id,
          error: 'Error al verificar stock',
          valido: false
        };
      }
    });

    const errores = resultados.filter(r => !r.valido);
    if (errores.length > 0) {
      return res.status(400).json({ 
        success: false,
        errors: errores,
        message: 'Problemas con el stock'
      });
    }

    res.json({ 
      success: true, 
      items: resultados
    });
  } catch (error) {
    console.error('Error en /api/verificar-stock:', error);
    res.status(500).json({ 
      error: 'Error al verificar stock',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Procesar pedido con validación mejorada
app.post('/api/pedidos', (req, res) => {
  try {
    const { items, sessionId } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Formato de datos inválido' });
    }

    // Validación inicial
    const itemsValidados = items.map(item => ({
      ...item,
      cantidad: Number(item.cantidad) || 0,
      valido: false
    })).filter(item => item.cantidad > 0);

    if (itemsValidados.length === 0) {
      return res.status(400).json({ 
        error: 'No hay items válidos para procesar' 
      });
    }

    // Verificar stock y preparar actualización
    const operaciones = itemsValidados.map(item => {
      const medicamento = medicamentos.find(m => m._id === item.id || m.nombre === item.nombre);
      
      if (!medicamento) {
        return { error: `Medicamento no encontrado: ${item.id || item.nombre}` };
      }

      if (medicamento.stock < item.cantidad) {
        return { 
          error: `Stock insuficiente para ${medicamento.nombre}. Disponible: ${medicamento.stock}`,
          stockDisponible: medicamento.stock
        };
      }

      return {
        id: item.id || medicamento._id,
        medicamento,
        cantidad: item.cantidad,
        valido: true
      };
    });

    // Manejar errores
    const errores = operaciones.filter(op => op && op.error);
    if (errores.length > 0) {
      return res.status(400).json({
        success: false,
        errors: errores,
        message: 'No se puede procesar el pedido'
      });
    }

    // Actualizar stock
    operaciones.forEach(op => {
      if (op.valido) {
        const medIndex = medicamentos.findIndex(m => m._id === op.id || m.nombre === op.medicamento.nombre);
        if (medIndex !== -1) {
          medicamentos[medIndex].stock -= op.cantidad;
        }
      }
    });

    // Actualizar cache
    cacheMedicamentos = {
      timestamp: Date.now(),
      data: [...medicamentos],
      ttl: 60000
    };

    // Opcional: Guardar cambios en el archivo JSON
    fs.writeFileSync(path.join(__dirname, 'medicamentos.json'), JSON.stringify(medicamentos, null, 2));

    res.json({ 
      success: true,
      numeroPedido: `PED-${Date.now()}`,
      items: operaciones.filter(op => op.valido).map(op => ({
        id: op.id,
        nombre: op.medicamento.nombre,
        cantidad: op.cantidad,
        precio: op.medicamento.precio,
        nuevoStock: op.medicamento.stock - op.cantidad
      })),
      message: 'Pedido procesado correctamente'
    });
  } catch (error) {
    console.error('Error en /api/pedidos:', error);
    res.status(500).json({ 
      error: 'Error al procesar el pedido',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==============================================
// RUTA DEL CHATBOT (SANABOT)
// ==============================================

// ... (código anterior se mantiene igual hasta la ruta del chatbot)

// ==============================================
// RUTA DEL CHATBOT (SANABOT) - CORREGIDA
// ==============================================

// Objeto para almacenar las sesiones del chatbot
const sesionesChatbot = {};

app.post("/chat", async (req, res) => {
  try {
    const pregunta = req.body.texto || req.body.message || "";
    const sessionId = req.body.sessionId || "anon";

    if (!pregunta.trim()) {
      return res.status(400).json({ error: "No se envió ninguna pregunta." });
    }

    // Inicializar sesión si no existe
    if (!sesionesChatbot[sessionId]) {
      sesionesChatbot[sessionId] = [
        {
          role: "system",
          content: `Eres SANABOT, un asistente farmacéutico experto, amable y claro. 
Responde preguntas sobre medicamentos, enfermedades comunes y formas de administración de manera concisa y comprensible.
Evita respuestas largas, necesito respuestas puntuales de maximo 5 lineas. Si la pregunta no tiene sentido, responde con amabilidad.
Si es sobre síntomas, puedes dar sugerencias generales, pero siempre recalca que se debe consultar con un profesional de salud. 
En el primer mensaje, saluda con: "Hola, soy SANABOT! Tu asistente virtual."`,
        },
      ];
    }

    const yaRespondioAntes = sesionesChatbot[sessionId].some(msg => msg.role === "assistant");

    if (!yaRespondioAntes) {
      sesionesChatbot[sessionId].push({ role: "user", content: pregunta });
    } else {
      sesionesChatbot[sessionId].push({
        role: "user",
        content: `Responde sin repetir el saludo "Hola, soy SANABOT" y mantén el tono conversacional. Usuario: ${pregunta}`,
      });
    }

    // Verificar que la API key esté configurada
    if (!process.env.GROQ_API_KEY) {
      console.error("Error: GROQ_API_KEY no está configurada");
      return res.status(500).json({ error: "Configuración del servidor incompleta" });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: sesionesChatbot[sessionId],
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Error en API de Groq:", errText);
      return res.status(response.status).json({ 
        error: "Error al conectar con el servicio de chatbot",
        details: process.env.NODE_ENV === 'development' ? errText : undefined
      });
    }

    const data = await response.json();
    let respuesta = data.choices?.[0]?.message?.content || "No pude obtener una respuesta";

    // Limpiar respuesta si ya se ha saludado antes
    if (yaRespondioAntes) {
      respuesta = respuesta.replace(/^hola[^.!\n]*[.!:\n-]+\s*/i, "").trimStart();
    }

    // Guardar la respuesta en el historial
    sesionesChatbot[sessionId].push({ role: "assistant", content: respuesta });

    res.json({ respuesta });
  } catch (error) {
    console.error("Error en /chat:", error);
    res.status(500).json({ 
      error: "Error interno del servidor",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ... (el resto del código se mantiene igual)

// ==============================================
// ENDPOINTS ADICIONALES
// ==============================================

// Endpoint keepalive modificado
app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'active',
    uptime: process.uptime(),
    medicamentosCargados: medicamentos.length,
    cacheTimestamp: cacheMedicamentos.timestamp
  });
});

// ==============================================
// INICIAR SERVIDOR
// ==============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log('Endpoints disponibles:');
  console.log('- GET  /keepalive           Verifica estado del servidor');
  console.log('- GET  /cargar-datos        Recarga datos desde JSON');
  console.log('- GET  /api/medicamentos    Buscar medicamentos');
  console.log('- POST /api/verificar-stock Validar stock');
  console.log('- POST /api/pedidos         Procesar pedido');
  console.log('- POST /chat                Chatbot SANABOT');
});
