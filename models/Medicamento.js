// En models/Medicamento.js
const mongoose = require('mongoose');

const medicamentoSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  precio: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  controlado: { 
    type: Boolean,
    default: false,
    index: true
  }
});

module.exports = mongoose.model('Medicamento', medicamentoSchema);