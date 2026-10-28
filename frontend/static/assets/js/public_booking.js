// Página pública de auto-agendado (sin login). Independiente de app.js —
// solo necesita los 2 endpoints públicos (auth='public') expuestos en
// main.py: /clivora/api/public/citas/catalogs y /clivora/api/public/citas.

let pbCatalogs = { types: [], reasons: [], doctors: [] };

async function pbLoadCatalogs() {
  try {
    const response = await fetch('/clivora/api/public/citas/catalogs', { cache: 'no-store' });
    pbCatalogs = response.ok ? await response.json() : { types: [], reasons: [], doctors: [] };
  } catch (error) {
    console.error('Error al cargar catálogos:', error);
  }

  const doctorSelect = document.getElementById('pbDoctor');
  pbCatalogs.doctors.forEach(doctor => {
    const opt = document.createElement('option');
    opt.value = String(doctor.id);
    opt.textContent = doctor.name;
    doctorSelect.appendChild(opt);
  });

  pbUpdateMotivoOptions();
}

function pbUpdateMotivoOptions() {
  const tipoSelect = document.getElementById('pbTipo');
  const motivoSelect = document.getElementById('pbMotivo');
  const isConsulta = (tipoSelect.value || '').toLowerCase().startsWith('consulta');
  const reasonType = isConsulta ? 'C' : 'T';

  const activeVal = motivoSelect.value;
  const options = pbCatalogs.reasons.filter(r => r.type === reasonType);

  motivoSelect.innerHTML = '';
  options.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = r.name;
    motivoSelect.appendChild(opt);
  });

  if (activeVal && options.some(r => r.name === activeVal)) {
    motivoSelect.value = activeVal;
  } else if (options.length) {
    motivoSelect.value = options[0].name;
  }
}

function pbUpdateDateConstraints() {
  const fechaInput = document.getElementById('pbFecha');
  const horaInput = document.getElementById('pbHora');
  const todayStr = new Date().toISOString().split('T')[0];
  fechaInput.min = todayStr;

  const isToday = fechaInput.value === todayStr;
  if (isToday) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    horaInput.min = `${hh}:${mm}`;
  } else {
    horaInput.removeAttribute('min');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  pbLoadCatalogs();
  pbUpdateDateConstraints();

  const tipoSelect = document.getElementById('pbTipo');
  tipoSelect.addEventListener('change', pbUpdateMotivoOptions);

  const fechaInput = document.getElementById('pbFecha');
  const fechaError = document.getElementById('pbFechaError');
  fechaInput.addEventListener('change', () => {
    fechaError.style.display = 'none';
    if (!fechaInput.value) return;
    const selectedDate = new Date(fechaInput.value + 'T00:00:00');
    if (selectedDate.getDay() === 0) {
      fechaError.textContent = 'Sólo se permiten citas de Lunes a Sábado. Elige otro día.';
      fechaError.style.display = 'block';
      fechaInput.value = '';
      return;
    }
    pbUpdateDateConstraints();
  });

  const form = document.getElementById('publicBookingForm');
  const errorBox = document.getElementById('pbErrorBox');
  const submitBtn = document.getElementById('pbSubmitBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';

    const doctorSelect = document.getElementById('pbDoctor');
    const payload = {
      nombre: document.getElementById('pbNombre').value.trim(),
      telefono: document.getElementById('pbTelefono').value.trim(),
      expediente: document.getElementById('pbExpediente').value.trim(),
      rfc: document.getElementById('pbRfc').value.trim(),
      tipo: tipoSelect.value,
      motivo: document.getElementById('pbMotivo').value,
      doctorId: doctorSelect.value ? Number(doctorSelect.value) : false,
      fecha: fechaInput.value,
      hora: document.getElementById('pbHora').value,
      nota: document.getElementById('pbNota').value.trim(),
      website: document.getElementById('pbWebsite')?.value || '',
    };

    if (!payload.doctorId) {
      errorBox.textContent = 'Selecciona un doctor.';
      errorBox.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    try {
      const response = await fetch('/clivora/api/public/citas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 429) {
        throw new Error('too_many_requests');
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'error');
      }
      const result = await response.json();
      document.getElementById('pbFormWrapper').style.display = 'none';
      errorBox.style.display = 'none';
      const trackingLinkEl = document.getElementById('pbTrackingLink');
      if (trackingLinkEl && result.trackingToken) {
        const url = `${window.location.origin}/clivora/estado/${result.trackingToken}`;
        trackingLinkEl.innerHTML = `Guarda este link para consultar el estado de tu solicitud:<br><a href="${url}">${url}</a>`;
      }
      document.getElementById('pbSuccessOverlay').style.display = 'block';
    } catch (error) {
      console.error('Error al enviar la solicitud:', error);
      errorBox.textContent = error.message === 'too_many_requests'
        ? 'Enviaste demasiadas solicitudes en poco tiempo. Intenta de nuevo más tarde o llámanos directamente.'
        : 'No se pudo enviar tu solicitud. Verifica los datos e intenta de nuevo.';
      errorBox.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Solicitar cita';
    }
  });
});
