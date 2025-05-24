let carrito = [];
let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = "session-" + Math.random().toString(36).slice(2);
  localStorage.setItem("sessionId", sessionId);
}

// Función para obtener medicamentos desde la API
async function obtenerMedicamentos() {
  try {
    const response = await fetch('/api/medicamentos?query=');
    if (!response.ok) throw new Error("Error al obtener medicamentos");
    return await response.json();
  } catch (error) {
    console.error("Error obteniendo medicamentos:", error);
    return [];
  }
}

window.onload = async function () {
  // Evento input para autocompletar búsqueda
  document.getElementById("input-busqueda").addEventListener("input", mostrarSugerencias);

  // Evento click para enviar pregunta en chat
  document.querySelector("#chatbox button").addEventListener("click", async (event) => {
    event.preventDefault();
    await manejarEnvioPregunta();
  });

  // Enviar pregunta con Enter en input-chat
  document.getElementById("input-chat").addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await manejarEnvioPregunta();
    }
  });
};

function mostrarSugerencias() {
  const input = document.getElementById("input-busqueda").value.trim().toLowerCase();
  const lista = document.getElementById("sugerencias");
  lista.innerHTML = "";

  // Mostrar sugerencias desde la 3ra letra
  if (input.length < 3) {
    lista.style.display = "none";
    return;
  }

  // Filtrar medicamentos (excepto controlados)
  const medicamentosNormales = medicamentos.filter(med => !med.controlado);
  
  const sugerencias = medicamentosNormales
    .filter(med => med.nombre.toLowerCase().includes(input))
    .slice(0, 5);

  if (sugerencias.length === 0) {
    lista.style.display = "none";
    return;
  }

  lista.style.display = "block";

  sugerencias.forEach(med => {
    const li = document.createElement("li");
    li.textContent = `${med.nombre} ${med.mg || ""} - Bs ${med.precio.toFixed(2)}`;
    li.classList.add("sugerencia-item");
    li.addEventListener("click", () => {
      document.getElementById("input-busqueda").value = med.nombre;
      lista.innerHTML = "";
      lista.style.display = "none";
      buscarMedicamento();
    });
    lista.appendChild(li);
  });
}

async function buscarMedicamento() {
  const input = document.getElementById("input-busqueda").value.trim();
  const resultadoDiv = document.getElementById("resultado-busqueda");
  resultadoDiv.innerHTML = "";
  const listaSugerencias = document.getElementById("sugerencias");
  listaSugerencias.innerHTML = "";
  listaSugerencias.style.display = "none";

  if (!input) {
    resultadoDiv.innerHTML = "<p>Escribe el nombre del medicamento para buscar.</p>";
    return;
  }

  try {
    const response = await fetch(`/api/medicamentos?query=${encodeURIComponent(input)}`);
    if (!response.ok) throw new Error("Error en la búsqueda");
    
    const resultados = await response.json();

    if (resultados.length === 0) {
      resultadoDiv.innerHTML = "<p>No se encontró el medicamento.</p>";
      return;
    }

    resultados.forEach(med => {
      const div = document.createElement("div");
      div.innerHTML = `
        <strong>${med.nombre}</strong> - Bs ${med.precio.toFixed(2)} - Stock: ${med.stock}
        <br>
        Cantidad: <input type="number" min="1" max="${med.stock}" value="1" data-id="${med._id}" data-nombre="${med.nombre}" style="width: 60px" />
        <button onclick="agregarAlCarrito('${med._id}', '${med.nombre}', ${med.precio}, ${med.stock})">Agregar</button>
        <hr>
      `;
      resultadoDiv.appendChild(div);
    });
  } catch (error) {
    resultadoDiv.innerHTML = `<p>Error: ${error.message}</p>`;
    console.error("Error buscando medicamento:", error);
  }
}

async function agregarAlCarrito(id, nombre, precio, stockMaximo) {
  const cantidadInput = document.querySelector(`input[data-id="${id}"]`);
  if (!cantidadInput) {
    alert("Cantidad no especificada.");
    return;
  }

  const cantidad = parseInt(cantidadInput.value);
  if (!cantidad || cantidad < 1) {
    alert("Cantidad inválida.");
    return;
  }

  // Verificar stock disponible
  try {
    const response = await fetch(`/api/medicamentos/${id}`);
    if (!response.ok) throw new Error("Error verificando stock");
    
    const medicamento = await response.json();
    
    if (cantidad > medicamento.stock) {
      alert(`No hay suficiente stock. Stock disponible: ${medicamento.stock}`);
      return;
    }

    const existente = carrito.find(item => item.id === id);
    if (existente) {
      if (existente.cantidad + cantidad > medicamento.stock) {
        alert(`No hay suficiente stock. Stock disponible: ${medicamento.stock}`);
        return;
      }
      existente.cantidad += cantidad;
    } else {
      carrito.push({ 
        id,
        nombre, 
        precio, 
        cantidad,
        stockMaximo: medicamento.stock
      });
    }

    actualizarCarrito();
  } catch (error) {
    console.error("Error agregando al carrito:", error);
    alert("Error al verificar el stock. Intenta nuevamente.");
  }
}

function actualizarCarrito() {
  const lista = document.getElementById("lista-carrito");
  const totalSpan = document.getElementById("total");
  lista.innerHTML = "";
  let total = 0;

  carrito.forEach(item => {
    const li = document.createElement("li");
    li.innerHTML = `
      ${item.nombre} x ${item.cantidad} = Bs ${(item.precio * item.cantidad).toFixed(2)}
      <button onclick="eliminarDelCarrito('${item.id}')" style="margin-left: 10px; background: #ff4444; padding: 2px 6px;">×</button>
    `;
    lista.appendChild(li);
    total += item.precio * item.cantidad;
  });

  totalSpan.textContent = `Total: Bs ${total.toFixed(2)}`;
}

function eliminarDelCarrito(id) {
  carrito = carrito.filter(item => item.id !== id);
  actualizarCarrito();
}

async function enviarPedido() {
  if (carrito.length === 0) {
    alert("Tu carrito está vacío.");
    return;
  }

  try {
    // 1. Enviar pedido al backend
    const response = await fetch('/api/pedidos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json' // Asegura que esperamos JSON
      },
      body: JSON.stringify({
        items: carrito,
        sessionId
      })
    });

    // Verificar si la respuesta es JSON
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      throw new Error(`Respuesta inesperada: ${text.substring(0, 100)}...`);
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Error en el servidor');
    }

    // 2. Generar enlace WhatsApp
    const mensaje = generarMensajeWhatsApp(carrito, data.numeroPedido);
    const numeroFarmacia = '59169123983'; // Reemplaza con número real
    const enlaceWhatsApp = `https://wa.me/${numeroFarmacia}?text=${encodeURIComponent(mensaje)}`;

    // 3. Mostrar opción para enviar
    if (confirm('¿Enviar pedido por WhatsApp al farmacéutico?')) {
      window.open(enlaceWhatsApp, '_blank');
    }

    // 4. Limpiar carrito
    limpiarCarrito();

  } catch (error) {
    console.error('Error en enviarPedido:', error);
    alert(`Error: ${error.message}`);
  }
}

function generarMensajeWhatsApp(items, numeroPedido) {
  let total = 0;
  const detalles = items.map(item => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    return `- ${item.nombre} x${item.cantidad} = Bs ${subtotal.toFixed(2)}`;
  }).join('\n');

  return `🚀 *PEDIDO #${numeroPedido}*\n\n${detalles}\n\n💰 *Total:* Bs ${total.toFixed(2)}`;
}

function limpiarCarrito() {
  carrito = [];
  actualizarCarrito();
  document.getElementById("resultado-busqueda").innerHTML = "";
  document.getElementById("input-busqueda").value = "";
}
// Funciones del chat (sin cambios)
async function manejarEnvioPregunta() {
  const input = document.getElementById("input-chat");
  const pregunta = input.value.trim();
  if (!pregunta) {
    alert("Por favor escribe una pregunta.");
    return;
  }

  const respuesta = await enviarPregunta(pregunta);

  const chatDiv = document.getElementById("chat-mensajes");

  // Crear mensaje usuario
  const mensajeUsuario = document.createElement("div");
  mensajeUsuario.classList.add("mensaje", "usuario");
  mensajeUsuario.innerHTML = `<div class="icono"></div><div class="texto">${pregunta}</div>`;
  chatDiv.appendChild(mensajeUsuario);

  // Crear mensaje bot
  const mensajeBot = document.createElement("div");
  mensajeBot.classList.add("mensaje", "bot");
  mensajeBot.innerHTML = `<div class="icono"></div><div class="texto">${respuesta}</div>`;
  chatDiv.appendChild(mensajeBot);

  chatDiv.scrollTop = chatDiv.scrollHeight;
  input.value = "";
}

async function enviarPregunta(pregunta) {
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ texto: pregunta, sessionId })
    });

    if (!res.ok) throw new Error("Error en la respuesta del servidor");

    const data = await res.json();
    return data.respuesta || "No se obtuvo respuesta.";
  } catch (error) {
    return "Error al conectar con el servidor.";
  }
}

// Control del botón para mostrar/ocultar chatbot
document.getElementById("toggle-chatbot").addEventListener("click", () => {
  const contenedor = document.getElementById("chatbot-container");
  contenedor.classList.toggle("chatbot-visible");
});

let advertenciaMostrada = false; // Variable para controlar la alerta

document.getElementById("input-controlados").addEventListener("input", async function(e) {
  const input = e.target.value.trim();
  const resultadoDiv = document.getElementById("resultado-controlados");
  resultadoDiv.innerHTML = "";

  if (input.length < 3) return;

  try {
    // Muestra advertencia solo la primera vez
    if (!advertenciaMostrada) {
      alert("ATENCIÓN: Los medicamentos controlados requieren atención personal con la farmacéutica y receta médica. Esta función es solo para consulta informativa.");
      advertenciaMostrada = true;
    }

    // Asegúrate que el parámetro sea controlado=true
    const response = await fetch(`/api/medicamentos?query=${encodeURIComponent(input)}&controlado=true`);
    
    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }

    const controlados = await response.json();

    // Verificación adicional en el frontend
    const verdaderosControlados = controlados.filter(med => 
      med.controlado === true && 
      med.nombre.toLowerCase().includes(input.toLowerCase())
    );

    if (verdaderosControlados.length === 0) {
      resultadoDiv.innerHTML = "<p>No se encontraron medicamentos controlados con ese nombre.</p>";
      return;
    }

    // Mostrar resultados
    verdaderosControlados.forEach(med => {
      const div = document.createElement("div");
      div.className = "medicamento-controlado";
      div.innerHTML = `
        <strong>${med.nombre}</strong>
        <p>Precio: Bs ${med.precio.toFixed(2)}</p>
        <p class="advertencia">⚠️ Medicamento controlado - Requiere receta</p>
      `;
      resultadoDiv.appendChild(div);
    });

  } catch (error) {
    console.error("Error en búsqueda de controlados:", error);
    resultadoDiv.innerHTML = `
      <p class="error">Error en la consulta</p>
      <p>${error.message}</p>
    `;
  }
});