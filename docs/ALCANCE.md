# Alcance y avance

Clivora es la plataforma clínica de Codevia: una aplicación propia (Django +
PostgreSQL) con su propia base de datos, lista para un VPS.

## Decisiones

- **Fuera de alcance por ahora:** ventas, cotizaciones, facturación (CFDI) y POS.
- **Productos, inventario y listas de precios** se administran aquí.
- **Solo lo que se usa**: cada módulo replica el funcionamiento que la
  operación necesita, nada más. Las reglas de precio son precio fijo + lista
  base; no hay sucursales: las reemplazan las clínicas.
- **Multiclínica**: clínicas permitidas + clínica activa por usuario; cada
  clínica tiene sus *lugares* de atención con sus salas.
- **Historia Clínica:** solo los ~45 campos que captura la pantalla. Las
  drogas, alergias, cirugías y transfusiones se capturan como observaciones.
  Los textos del editor se sanean antes de guardarse.
- **Identidad visual:** fondo gris frío, tarjetas blancas redondeadas, azul
  marino para la acción principal y azul plateado como acento
  (`frontend/static/assets/css/clivora-theme.css`).

## Avance

| Módulo | Estado |
|---|---|
| Base: configuración por `.env`, Docker, Nginx, respaldos | Hecho |
| Usuarios y roles | Hecho |
| Productos, categorías, unidades, ubicaciones, lotes con caducidad | Hecho |
| Inventario: movimientos, existencias, ajustes por conteo | Hecho |
| Listas de precios y aseguradoras | Hecho |
| Inicio de sesión (`/clivora/login`), cierre de sesión, `/api/me` con los permisos por rol | Hecho |
| Configuración: clínicas, lugares y salas, usuarios y roles, sistema | Hecho |
| Multiclínica: clínicas permitidas, clínica activa, selector en el encabezado | Hecho |
| Restablecer contraseña por correo (`/clivora/reset_password`): enlace de un solo uso que vence en 2 h, no revela qué cuentas existen, máximo 5 solicitudes por IP cada 15 min y las reglas de contraseña de Django | Hecho |
| Servidor de correo en Configuración → Sistema (solo superusuario): SMTP, seguridad, remitente, contraseña cifrada y correo de prueba; sin activarlo se usan las variables EMAIL_* del `.env` | Hecho |
| Verificación en dos pasos (Mi Perfil → Seguridad): app de autenticación (TOTP) con QR, 10 códigos de recuperación, "confiar en este equipo" 30 días, 5 intentos por inicio de sesión; el administrador la puede quitar desde Usuarios; `/admin/` entra por el login de Clivora | Hecho |
| Permisos por rol revisados: Farmacia y Configuración → Productos/Listas de precios solo para Farmacia, Comercial y Administrador (antes el rol base dejaba verlos a todos). Recepción: Inicio, Pacientes y Agenda (solo Consulta), expediente en solo lectura | Hecho |
| Pacientes: alta, lista, duplicados, ficha, información general, domicilio personal y fiscal, facturación | Hecho |
| Agenda: citas (Día/Semana/Mes), estados y transiciones, sala sin doble reserva, check-in/out, archivos, anotaciones, esquema, aplicación de medicamento | Hecho |
| Tratamientos (lista y Kanban) | Hecho (sin la orden de productos: depende de ventas) |
| Auto-agendado público (`/clivora/agendar?clinica=<id>`) y página de seguimiento | Hecho |
| Correos de cita confirmada/rechazada (en desarrollo salen en la consola) | Hecho |
| Expediente — fase 1: Historia Clínica, familiares, medicamentos actuales, auditoría por sección | Hecho |
| Expediente — fase 1: diagnósticos con catálogo CIE-10 (OPS, 14,352) y CIE-11 completo de la OMS (MMS 2026-01, 17,255; se actualiza con `manage.py actualizar_cie11 <versión>`) y buscador tolerante a faltas de ortografía | Hecho |
| Identidad visual de Clivora (colores, tipografía, componentes) | Hecho |
| Expediente — fase 2: signos vitales (con superficie corporal e IMC), Evaluación Inicial de Enfermería (patrones funcionales) y Registro Clínico de Enfermería (escalas, NEWS, Downton, Glasgow, laboratorio, sistemas, EVA, medicamentos aplicados, egreso) | Hecho |
| Expediente — nota de oncología médica (fecha de ingreso, ciclo, alergias, análisis SOAP, diagnósticos CIE, indicaciones y receta, que se precargan en la siguiente nota) | Hecho |
| Expediente — recetas (médica y oncológica) y órdenes médicas, también desde las Acciones Especiales de la nota de oncología | Hecho |
| Expediente — archivos del paciente (pestaña Archivos y "Archivos de HC"): subida clasificada y rápida, vista previa, descarga, compartir por WhatsApp/Facebook y borrado que conserva el documento | Hecho |
| Foto del paciente (botón de cámara de la ficha; se reduce a 512 px y solo la ve quien puede ver al paciente) | Hecho |
| Compartir expediente con un médico (pestaña Compartir, rol "Compartir Expediente"): al médico externo le da acceso al expediente mientras exista el registro | Hecho |
| Reportes PDF con WeasyPrint (encabezado de la clínica activa, folio, paginado y firma): Historia Clínica, signos vitales, Evaluación Inicial y Registro Clínico de Enfermería, nota de oncología, orden médica, receta médica y oncológica | Hecho |
| Médicos (reemplaza "Información del Médico"): lista de médicos (rol Médicos o Médico Externo) y enfermería (Enfermería o Jefa de Enfermería) con filtro por tipo; ficha con cédula profesional, universidad, teléfono y firma (imagen), y en los médicos además especialidad, cédula de especialidad y enfermera asignada. El administrador edita a todos; los demás solo su ficha. Los PDF llevan la firma, especialidad y cédulas de quien firma (médico o enfermería) | Hecho |
| Configuración → Especialidades: catálogo (alta, cambio de nombre, desactivar); filtra al médico en "Cita con" de la agenda y del alta de paciente | Hecho |

## Pendientes

Rutas que el frontend ya llama y el servidor todavía no tiene (responden 404
en JSON y esa parte se ve vacía):

| Módulo | Rutas |
|---|---|
| Ventas y cotizaciones (fuera de alcance por ahora), incluido el desglose de una receta | `sale_orders`, `sale_order`, `tratamientos/<id>/order`, `recipe_headers/<id>/create_quote`, `files/<id>/create_quote`, `facturacion/summary` |

Otros pendientes:

| Pendiente | Nota |
|---|---|
| Notas de evolución, esquemas de quimioterapia, cuestionario de ingreso y aseguradoras del paciente | No se replicaron: en el sistema anterior no había ningún registro, no se podían crear notas de evolución y las pestañas Esquemas, Cuestionario y Aseguradoras estaban ocultas. Se agregan si se van a usar. |
| Mi Perfil: nombre, puesto y departamento | El botón "Guardar Cambios" solo los cambia en pantalla (ya era así); la contraseña y la verificación en dos pasos sí se guardan desde Seguridad. |
| Revisar el modo oscuro con la paleta nueva | |
| Repositorio git y despliegue en el VPS | |
