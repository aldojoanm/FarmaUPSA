const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const mongoose = require('mongoose');
const fs = require('fs');
const Medicamento = require('./models/Medicamento');

dotenv.config();

// Configuración mejorada de conexión MongoDB
const connectWithRetry = () => {
  mongoose.connect(process.env.MONGODB_URI, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    retryWrites: true,
    w: 'majority'
  })
  .then(() => console.log('Conectado a MongoDB'))
  .catch(err => {
    console.error('Error conectando a MongoDB:', err);
    setTimeout(connectWithRetry, 5000);
  });
};

connectWithRetry();

// Eventos de conexión
mongoose.connection.on('disconnected', () => {
  console.log('Desconectado de MongoDB. Reconectando...');
  connectWithRetry();
});

mongoose.connection.on('error', (err) => {
  console.error('Error de MongoDB:', err);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Cache local para mejor rendimiento
let cacheMedicamentos = {
  timestamp: null,
  data: null,
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

// Middleware para verificar conexión a MongoDB
const verificarConexionDB = async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    try {
      await new Promise(resolve => {
        const checkConnection = () => {
          if (mongoose.connection.readyState === 1) resolve();
          else setTimeout(checkConnection, 100);
        };
        checkConnection();
      });
    } catch (err) {
      return res.status(503).json({ 
        error: 'Servicio no disponible. Reconectando con la base de datos...' 
      });
    }
  }
  next();
};

// ==============================================
// RUTAS PARA MEDICAMENTOS (MEJORADAS)
// ==============================================

// Cargar/actualizar datos desde JSON
app.get('/cargar-datos', async (req, res) => {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'medicamentos.json'), 'utf-8');
    const medicamentosData = JSON.parse(rawData);
    
    if (!Array.isArray(medicamentosData)) {
      throw new Error('El archivo JSON no contiene un array válido');
    }

    // Normalizar datos
    const datosNormalizados = medicamentosData.map(med => ({
      ...med,
      controlado: med.controlado === true,
      stock: Number(med.stock) || 0,
      precio: Number(med.precio) || 0
    }));

    // Actualizar base de datos
    await Medicamento.deleteMany({});
    const result = await Medicamento.insertMany(datosNormalizados);
    
    // Actualizar cache
    cacheMedicamentos = {
      timestamp: Date.now(),
      data: datosNormalizados,
      ttl: 60000
    };

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

// Buscar medicamentos (con cache y timeout)
app.get('/api/medicamentos', validarBusqueda, verificarConexionDB, async (req, res) => {
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

    // Búsqueda en MongoDB con timeout
    const filtro = {
      nombre: { $regex: query, $options: 'i' },
      ...(esControlado ? { controlado: true } : { 
        $or: [{ controlado: false }, { controlado: { $exists: false } }] 
      })
    };

    const medicamentos = await Medicamento.find(filtro)
      .maxTimeMS(30000)
      .sort({ nombre: 1 })
      .limit(20)
      .lean();

    // Actualizar cache
    cacheMedicamentos = {
      timestamp: Date.now(),
      data: medicamentos,
      ttl: 60000
    };

    res.json(medicamentos);
  } catch (error) {
    console.error('Error en búsqueda:', error);
    res.status(500).json({ 
      error: 'Error en la búsqueda',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==============================================
// RUTAS PARA STOCK (CON VALIDACIONES MEJORADAS)
// ==============================================

// Verificar stock con manejo de errores robusto
app.post('/api/verificar-stock', verificarConexionDB, async (req, res) => {
  try {
    const { items } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Formato de datos inválido' });
    }

    const resultados = await Promise.all(
      items.map(async item => {
        try {
          const medicamento = await Medicamento.findById(item.id)
            .maxTimeMS(30000)
            .lean();

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
            id: item.id,
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
app.post('/api/pedidos', verificarConexionDB, async (req, res) => {
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
    const operaciones = await Promise.all(
      itemsValidados.map(async item => {
        const medicamento = await Medicamento.findById(item.id)
          .maxTimeMS(30000);

        if (!medicamento) {
          return { error: `Medicamento no encontrado: ${item.id}` };
        }

        if (medicamento.stock < item.cantidad) {
          return { 
            error: `Stock insuficiente para ${medicamento.nombre}. Disponible: ${medicamento.stock}`,
            stockDisponible: medicamento.stock
          };
        }

        return {
          id: item.id,
          medicamento,
          cantidad: item.cantidad,
          valido: true,
          operacion: {
            updateOne: {
              filter: { _id: item.id, stock: { $gte: item.cantidad } },
              update: { $inc: { stock: -item.cantidad } }
            }
          }
        };
      })
    );

    // Manejar errores
    const errores = operaciones.filter(op => op && op.error);
    if (errores.length > 0) {
      return res.status(400).json({
        success: false,
        errors: errores,
        message: 'No se puede procesar el pedido'
      });
    }

    // Ejecutar actualizaciones en transacción
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const ops = operaciones
        .filter(op => op && op.valido)
        .map(op => op.operacion);

      const result = await Medicamento.bulkWrite(ops, { session });
      
      await session.commitTransaction();
      session.endSession();

      // Actualizar cache
      if (cacheMedicamentos.data) {
        operaciones.forEach(op => {
          if (op.valido) {
            const medCache = cacheMedicamentos.data.find(m => m._id.toString() === op.id);
            if (medCache) medCache.stock -= op.cantidad;
          }
        });
      }

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
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    console.error('Error en /api/pedidos:', error);
    res.status(500).json({ 
      error: 'Error al procesar el pedido',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==============================================
// RUTA DEL CHATBOT (SANABOT) - SIN CAMBIOS
// ==============================================

app.post("/chat", async (req, res) => {
  // ... (mantener el mismo código del chatbot)
});

// ==============================================
// ENDPOINTS ADICIONALES
// ==============================================

// Endpoint keepalive para prevenir cold starts
app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'active',
    dbState: mongoose.connection.readyState,
    uptime: process.uptime(),
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