require('dotenv').config();
const mongoose = require('mongoose');
const Medicamento = require('./Medicamento');

// Lista de medicamentos controlados (puedes ampliarla)
const MEDICAMENTOS_CONTROLADOS = [
  'clonazepam', 'diazepam', 'lorazepam', 'alprazolam',
  'zolpidem', 'topiramato', 'metadona', 'morfina',
  'codeína', 'oxcodona', 'hidrocodona', 'fentanilo',
  'metilfenidato', 'anfetamina', 'pregabalina'
];

async function actualizarControlados() {
  await mongoose.connect(process.env.MONGODB_URI);

  // 1. Asegurar que todos los documentos tengan el campo controlado
  await Medicamento.updateMany(
    { controlado: { $exists: false } },
    { $set: { controlado: false } }
  );

  // 2. Marcar los medicamentos controlados
  for (const nombre of MEDICAMENTOS_CONTROLADOS) {
    await Medicamento.updateMany(
      { 
        nombre: { $regex: nombre, $options: 'i' },
        controlado: { $ne: true }
      },
      { $set: { controlado: true } }
    );
  }

  // Verificación
  const count = await Medicamento.countDocuments({ controlado: true });
  console.log(`Medicamentos controlados actualizados: ${count}`);

  process.exit(0);
}

actualizarControlados().catch(console.error);