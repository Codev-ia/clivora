"""Roles de Clivora (grupos de Django).

La llave es el identificador interno del rol (el que usa el código); el
nombre es el que se ve en pantalla.
"""

ROLES = {
    'group_medical_portal': 'Acceso a Clivora',
    'group_medicos': 'Médicos',
    'group_medico_externo': 'Médico Externo',
    'group_enfermeria': 'Enfermería',
    'group_jefa_enfermeria': 'Jefa de Enfermería',
    'group_recepcion': 'Recepción',
    'group_jefe_recepcion': 'Jefe de Admisiones/Recepción',
    'group_farmacia': 'Farmacia',
    'group_comercial': 'Comercial',
    'group_cita_coordinacion': 'Coordinación de Citas',
    'group_compartir_expediente': 'Compartir Expediente',
    'group_desglose_documentos': 'Desglose de Documentos',
    'group_historial_create_date_edit': 'Historial Médico: Editar Fecha de Creación',
    'administrador': 'Administrador',
}

DESCRIPTIONS = {
    'Acceso a Clivora': 'Puede entrar a Clivora. Sin este rol no se permite iniciar sesión.',
    'Médicos': 'Consulta expedientes; Agenda y Tratamientos en solo lectura.',
    'Médico Externo': 'Solo ve a sus pacientes asignados.',
    'Enfermería': 'Signos vitales, notas de enfermería, anotaciones y esquema de la cita.',
    'Jefa de Enfermería': 'Todo lo de Enfermería y Médicos, sin restricciones de solo lectura.',
    'Recepción': 'Pacientes y citas de Consulta; expediente en solo lectura.',
    'Jefe de Admisiones/Recepción': 'Recepción con edición de historia clínica, recetas y órdenes.',
    'Farmacia': 'Administra el inventario y marca el stock de la aplicación de medicamento.',
    'Comercial': 'Administra listas de precios; campos de Nuevo Paciente no obligatorios.',
    'Coordinación de Citas': 'Confirma o rechaza las citas nuevas.',
    'Compartir Expediente': 'Puede compartir el expediente de un paciente.',
    'Desglose de Documentos': 'Revisa y desglosa los documentos del expediente.',
    'Historial Médico: Editar Fecha de Creación': 'Puede corregir la fecha de un registro del historial.',
    'Administrador': 'Configuración completa: clínicas, lugares, usuarios, médicos, especialidades, productos y precios.',
}

_INV_VIEW = [
    'inventario.view_product', 'inventario.view_productcategory', 'inventario.view_unitofmeasure',
    'inventario.view_location', 'inventario.view_lot', 'inventario.view_stockquant',
    'inventario.view_stockmove', 'precios.view_pricelist', 'precios.view_pricelistitem',
    'precios.view_aseguradora',
]
_INV_MANAGE = _INV_VIEW + [
    'inventario.add_lot', 'inventario.change_lot',
    'inventario.add_stockmove', 'inventario.change_stockmove', 'inventario.delete_stockmove',
]
_PRICING_MANAGE = [
    'precios.add_pricelist', 'precios.change_pricelist',
    'precios.add_pricelistitem', 'precios.change_pricelistitem', 'precios.delete_pricelistitem',
    'precios.add_aseguradora', 'precios.change_aseguradora',
]
_CONFIG = _INV_MANAGE + _PRICING_MANAGE + [
    'inventario.add_product', 'inventario.change_product',
    'inventario.add_location', 'inventario.change_location',
    'core.view_clinica', 'core.add_clinica', 'core.change_clinica',
    'core.view_lugar', 'core.add_lugar', 'core.change_lugar', 'core.delete_lugar',
    'core.view_sala', 'core.add_sala', 'core.change_sala', 'core.delete_sala',
    'accounts.view_user', 'accounts.add_user', 'accounts.change_user',
    'accounts.view_perfilmedico', 'accounts.change_perfilmedico',
    'accounts.view_especialidad', 'accounts.add_especialidad', 'accounts.change_especialidad',
]

# Farmacia (inventario) y Configuración → Productos / Listas de precios solo
# para Farmacia, Comercial y Administrador. Las pantallas clínicas que
# necesitan el catálogo (medicamentos, listas de precios del paciente,
# productos de Tratamientos) usan rutas de /clivora/api/ que solo piden
# sesión, así que el rol base no necesita ver el inventario.
ROLE_PERMISSIONS = {
    'Acceso a Clivora': ['core.view_lugar', 'core.view_sala'],
    'Farmacia': _INV_MANAGE,
    'Comercial': _INV_VIEW + _PRICING_MANAGE,
    'Administrador': _CONFIG,
}
