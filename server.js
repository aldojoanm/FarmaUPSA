const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const mongoose = require('mongoose');
const fs = require('fs');
const Medicamento = require('./models/Medicamento');

dotenv.config();

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('Conectado a MongoDB'))
.catch(err => console.error('Error conectando a MongoDB:', err));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Historial por sesión (en memoria)
const sesiones = {};

// ==============================================
// MIDDLEWARE PARA VALIDACIÓN DE DATOS
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

// Cargar datos iniciales desde JSON
app.get('/cargar-datos', async (req, res) => {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'medicamentos.json'), 'utf-8');
    const medicamentosData = JSON.parse(rawData);
    
    if (!Array.isArray(medicamentosData)) {
      throw new Error('El archivo JSON no contiene un array válido');
    }

    // Limpiar y normalizar datos
    const datosNormalizados = medicamentosData.map(med => ({
      ...med,
      controlado: med.controlado === true // Asegurar que es boolean
    }));

    await Medicamento.deleteMany({});
    const result = await Medicamento.insertMany(datosNormalizados);
    
    res.json({ 
      success: true,
      message: `Datos cargados exitosamente. ${result.length} medicamentos insertados.`,
      medicamentos: result.length
    });
  } catch (error) {
    console.error('Error en /cargar-datos:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al cargar datos',
      details: error.message
    });
  }
});

// Buscar medicamentos
// Ruta para buscar medicamentos (modificada)
// Ruta mejorada para buscar medicamentos
app.get('/api/medicamentos', validarBusqueda, async (req, res) => {
  try {
    const { query, controlado } = req.query;
    
    // Construye el filtro de manera más robusta
    const filtro = {
      nombre: { $regex: query, $options: 'i' }
    };

    // Manejo explícito para controlados
    if (controlado === 'true') {
      filtro.controlado = true;
      
      // Agrega esta línea para diagnóstico
      console.log('Buscando controlados con filtro:', filtro);
    } else {
      // Para búsquedas normales, excluir controlados
      filtro.$or = [
        { controlado: false },
        { controlado: { $exists: false } }
      ];
    }

    const medicamentos = await Medicamento.find(filtro)
      .sort({ nombre: 1 })
      .limit(20);

    // Log para diagnóstico
    console.log('Medicamentos encontrados:', medicamentos.length);
    
    res.json(medicamentos);
    
  } catch (error) {
    console.error('Error en búsqueda:', {
      query: req.query.query,
      controlado: req.query.controlado,
      error: error.message
    });
    res.status(500).json({ 
      error: 'Error en la búsqueda',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Obtener medicamento por ID
app.get('/api/medicamentos/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'ID de medicamento inválido' });
    }
    
    const medicamento = await Medicamento.findById(req.params.id);
    if (!medicamento) {
      return res.status(404).json({ error: 'Medicamento no encontrado' });
    }
    res.json(medicamento);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// RUTAS PARA STOCK Y PEDIDOS
// ==============================================

// Verificar stock
app.post('/api/verificar-stock', async (req, res) => {
  try {
    const { items } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Formato de datos inválido' });
    }

    const resultados = await Promise.all(
      items.map(async item => {
        const medicamento = await Medicamento.findById(item.id);
        
        if (!medicamento) {
          return { 
            id: item.id,
            error: `Medicamento no encontrado`,
            valido: false
          };
        }
        
        if (medicamento.stock < item.cantidad) {
          return {
            id: item.id,
            nombre: medicamento.nombre,
            error: `Stock insuficiente (Disponible: ${medicamento.stock})`,
            valido: false
          };
        }
        
        return {
          id: item.id,
          nombre: medicamento.nombre,
          stockDisponible: medicamento.stock,
          valido: true
        };
      })
    );

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
      message: 'Stock disponible para todos los items',
      items: resultados
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear pedido
app.post('/api/pedidos', async (req, res) => {
  try {
    const { items, sessionId } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Formato de datos inválido' });
    }

    // Verificar stock primero
    const verificacionStock = await Promise.all(
      items.map(async item => {
        const medicamento = await Medicamento.findById(item.id);
        return {
          medicamento,
          cantidad: item.cantidad,
          valido: medicamento && medicamento.stock >= item.cantidad
        };
      })
    );

    const itemsInvalidos = verificacionStock.filter(item => !item.valido);
    
    if (itemsInvalidos.length > 0) {
      const errores = itemsInvalidos.map(item => ({
        id: item.medicamento?._id || 'desconocido',
        nombre: item.medicamento?.nombre || 'Medicamento no encontrado',
        error: item.medicamento 
          ? `Stock insuficiente (${item.medicamento.stock} disponibles)` 
          : 'Medicamento no existe'
      }));
      
      return res.status(400).json({
        success: false,
        errors: errores,
        message: 'No se puede procesar el pedido por problemas de stock'
      });
    }

    // Actualizar stock y preparar respuesta
    const resultados = await Promise.all(
      verificacionStock.map(async item => {
        const medicamentoActualizado = await Medicamento.findByIdAndUpdate(
          item.medicamento._id,
          { $inc: { stock: -item.cantidad } },
          { new: true }
        );
        
        return {
          id: medicamentoActualizado._id,
          nombre: medicamentoActualizado.nombre,
          cantidad: item.cantidad,
          precio: medicamentoActualizado.precio,
          stockAnterior: item.medicamento.stock,
          stockNuevo: medicamentoActualizado.stock
        };
      })
    );

    // Aquí podrías guardar el pedido en una colección de pedidos
    // const nuevoPedido = new Pedido({ items, sessionId, fecha: new Date() });
    // await nuevoPedido.save();

    res.json({ 
      success: true,
      numeroPedido: `PED-${Date.now()}`,
      items: resultados,
      message: 'Pedido procesado correctamente'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// RUTA DEL CHATBOT (SANABOT)
// ==============================================

app.post("/chat", async (req, res) => {
  const pregunta = req.body.texto || req.body.message || "";
  const sessionId = req.body.sessionId || "anon";

  if (!pregunta.trim()) {
    return res.status(400).json({ error: "No se envió ninguna pregunta." });
  }

  if (!sesiones[sessionId]) {
    sesiones[sessionId] = [
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

  const yaRespondioAntes = sesiones[sessionId].some(msg => msg.role === "assistant");

  if (!yaRespondioAntes) {
    sesiones[sessionId].push({ role: "user", content: pregunta });
  } else {
    sesiones[sessionId].push({
      role: "user",
      content: `Responde sin repetir el saludo "Hola, soy SANABOT" y mantén el tono conversacional. Usuario: ${pregunta}`,
    });
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mistral-saba-24b",
        messages: sesiones[sessionId],
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Error de API: ${errText}` });
    }

    const data = await response.json();
    let respuesta = data.choices?.[0]?.message?.content || "No pude obtener respuesta";

    if (yaRespondioAntes) {
      respuesta = respuesta.replace(/^hola[^.!\n]*[.!:\n-]+\s*/i, "").trimStart();
    }

    sesiones[sessionId].push({ role: "assistant", content: respuesta });
    res.json({ respuesta });
  } catch (error) {
    console.error("Error en /chat:", error);
    res.status(500).json({ error: error.toString() });
  }
});

// ==============================================
// MANEJO DE ERRORES
// ==============================================

app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ==============================================
// INICIAR SERVIDOR
// ==============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Endpoints disponibles:`);
  console.log(`- GET  /cargar-datos          (Carga datos iniciales)`);
  console.log(`- GET  /api/medicamentos      (Buscar medicamentos)`);
  console.log(`- GET  /api/medicamentos/:id  (Obtener medicamento por ID)`);
  console.log(`- POST /api/verificar-stock   (Verificar stock)`);
  console.log(`- POST /api/pedidos           (Crear pedido)`);
  console.log(`- POST /chat                  (Chatbot SANABOT)`);
});