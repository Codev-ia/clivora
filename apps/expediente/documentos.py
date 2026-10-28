"""Recetas (médica y oncológica) y órdenes médicas del expediente: pestañas
Recetas Médicas y Órdenes Médicas, y los botones de "Acciones Especiales" de
la Nota de Oncología Médica. Rutas que consume app.js."""
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.accounts.models import User
from apps.accounts.roles import ROLES
from apps.core.html import limpiar as limpiar_html
from apps.web.roles import has_role, is_admin

from .compat import _body, _int, _json, _nombre
from .models import LineaReceta, NotaOncologia, OrdenMedica, Receta
from .notas import _decimal, _entero, _no_encontrado, _nota_visible, _paciente, _prohibido, _texto_plano

# ── Permisos (mismo criterio que isEnfermeriaLimited / isRecepcionLimited
# de /api/me, que ocultan los botones en pantalla) ─────────────────────────


def _enfermeria_limitada(user):
    if is_admin(user) or has_role(user, 'group_jefa_enfermeria'):
        return False
    return has_role(user, 'group_enfermeria')


def _recepcion_limitada(user):
    if is_admin(user) or has_role(user, 'group_jefe_recepcion'):
        return False
    return has_role(user, 'group_recepcion')


def puede_editar_recetas(user):
    """Enfermería y Recepción ven las recetas pero no las crean ni editan."""
    return not (_enfermeria_limitada(user) or _recepcion_limitada(user))


def puede_editar_ordenes(user):
    """Recepción ve las órdenes médicas pero no las crea ni edita."""
    return not _recepcion_limitada(user)


def _iso(dt):
    return timezone.localtime(dt).replace(tzinfo=None).isoformat() if dt else ''


def _medico(value):
    pk = _int(value)
    return User.objects.filter(pk=pk, is_active=True).first() if pk else None


def _nota_origen(paciente, value):
    """Nota de Oncología Médica del mismo paciente desde la que se generó."""
    pk = _int(value)
    return NotaOncologia.objects.filter(pk=pk, paciente=paciente).first() if pk else None


def _auditoria(doc):
    return {
        'create_date': _iso(doc.created_at), 'createdBy': _nombre(doc.created_by),
        'write_date': _iso(doc.updated_at), 'updatedBy': _nombre(doc.updated_by),
        'clinic_consultations_id': doc.nota_oncologia_id or False,
    }


def documentos_de_nota(nota):
    """Recetas y órdenes generadas desde una Nota de Oncología Médica."""
    docs = [{'id': r.pk, 'kind': 'recipe',
             'label': 'Receta Oncológica' if r.tipo == Receta.ONCOLOGICA else 'Receta Médica',
             'create_date': _iso(r.created_at)}
            for r in Receta.objects.filter(nota_oncologia=nota).order_by('id')]
    docs += [{'id': o.pk, 'kind': 'lab_order', 'label': 'Orden Médica', 'create_date': _iso(o.created_at)}
             for o in OrdenMedica.objects.filter(nota_oncologia=nota).order_by('id')]
    return docs


def _doctores():
    nombres = [ROLES['group_medicos'], ROLES['group_medico_externo']]
    usuarios = User.objects.filter(is_active=True, groups__name__in=nombres).distinct()
    return sorted(({'id': u.pk, 'name': _nombre(u)} for u in usuarios), key=lambda d: d['name'])


# ── Órdenes médicas ───────────────────────────────────────────────────────

def serializar_orden(o):
    return {
        'id': o.pk, 'title': '',
        'hr_employee_id': o.medico_id or False, 'hr_employee_name': _nombre(o.medico),
        'observations': o.observaciones, **_auditoria(o), 'lines': [],
    }


@require_GET
@login_required
def catalogos_ordenes(request):
    # El formulario solo usa la lista de médicos.
    return _json({'laboratories': [], 'studies': [], 'employees': _doctores()})


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_http_methods(['GET', 'POST'])
def ordenes(request, patient_id):
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    if request.method == 'GET':
        qs = OrdenMedica.objects.filter(paciente=paciente).select_related('medico', 'created_by', 'updated_by')
        return _json([serializar_orden(o) for o in qs])
    if not puede_editar_ordenes(request.user):
        return _prohibido()
    payload = _body(request)
    orden = OrdenMedica.objects.create(
        paciente=paciente, created_by=request.user, updated_by=request.user,
        medico=_medico(payload.get('hr_employee_id')) or paciente.doctor_asignado,
        observaciones=limpiar_html(payload.get('observations')),
        nota_oncologia=_nota_origen(paciente, payload.get('clinic_consultations_id')))
    return _json(serializar_orden(orden))


@csrf_exempt
@login_required
@require_POST
def orden_editar(request, rec_id):
    if not puede_editar_ordenes(request.user):
        return _prohibido()
    orden = _nota_visible(request, OrdenMedica, rec_id)
    if not orden:
        return _no_encontrado()
    payload = _body(request)
    if 'hr_employee_id' in payload:
        orden.medico = _medico(payload.get('hr_employee_id'))
    if 'observations' in payload:
        orden.observaciones = limpiar_html(payload.get('observations'))
    orden.updated_by = request.user
    orden.save()
    return _json(serializar_orden(orden))


@csrf_exempt
@login_required
@require_POST
def orden_borrar(request, rec_id):
    if not puede_editar_ordenes(request.user):
        return _prohibido()
    orden = _nota_visible(request, OrdenMedica, rec_id)
    if orden:
        orden.delete()
    return _json({'ok': True})


# ── Recetas ───────────────────────────────────────────────────────────────

# Campos de la Receta Oncológica: (llave del JSON, campo, tipo).
CAMPOS_ONCOLOGICA = (
    ('cycle_number', 'ciclo', 'str'), ('application_day', 'dia_aplicacion', 'str'),
    ('blood_pressure', 'presion', 'str'), ('general_diagnosis', 'diagnostico_general', 'str'),
    ('premedication_description', 'premedicacion', 'html'),
    ('postmedication_description', 'postmedicacion', 'html'),
    ('weight', 'peso', 'float'), ('height', 'talla', 'float'), ('heart_rate', 'fc', 'int'),
    ('respiratory_rate', 'fr', 'int'), ('temperature', 'temperatura', 'float'),
    ('oxygen_saturation', 'saturacion', 'int'), ('body_surface_area', 'superficie_corporal', 'float'),
    ('body_mass_index', 'imc', 'float'),
)


def serializar_receta(r):
    data = {
        'id': r.pk, 'recipe_type': r.tipo,
        'doctor_id': r.medico_id or False, 'doctor_name': _nombre(r.medico),
        'notes': r.notas, **_auditoria(r),
        'lines': [{'id': ln.pk, 'product': ln.medicamento, 'indications': ln.indicaciones, 'notes': ln.notas}
                  for ln in r.lineas.all()],
        'next_treatment_date': r.proxima_aplicacion.isoformat() if r.proxima_aplicacion else '',
        # El desglose (venta) de la receta queda fuera de alcance por ahora.
        'saleOrderId': False, 'saleOrderName': '',
    }
    for key, field, _ in CAMPOS_ONCOLOGICA:
        data[key] = getattr(r, field)
    return data


def _aplicar_receta(receta, payload):
    if payload.get('recipe_type') in dict(Receta.TIPOS):
        receta.tipo = payload['recipe_type']
    if 'notes' in payload:
        receta.notas = limpiar_html(payload.get('notes'))
    if 'doctor_id' in payload:
        receta.medico = _medico(payload.get('doctor_id'))
    # Sin médico elegido (la Receta Oncológica no tiene selector): el
    # asignado al paciente. La oncológica lo actualiza también al editar.
    if not receta.medico or (receta.tipo == Receta.ONCOLOGICA and receta.paciente.doctor_asignado):
        receta.medico = receta.paciente.doctor_asignado or receta.medico
    for key, field, tipo in CAMPOS_ONCOLOGICA:
        if key not in payload:
            continue
        value = payload.get(key)
        if tipo == 'int':
            value = _entero(value)
        elif tipo == 'float':
            value = _decimal(value)
        elif tipo == 'html':
            value = limpiar_html(value)
        else:
            value = _texto_plano(value, receta._meta.get_field(field).max_length)
        setattr(receta, field, value)
    if 'next_treatment_date' in payload:
        valor = payload.get('next_treatment_date')
        receta.proxima_aplicacion = parse_date(valor) if isinstance(valor, str) and valor else None


def _guardar_lineas(receta, filas):
    """Deja exactamente los medicamentos recibidos (los que traen id se
    actualizan, los nuevos se crean y los que ya no vienen se borran)."""
    existentes = {ln.pk: ln for ln in receta.lineas.all()}
    conservar = set()
    for fila in filas if isinstance(filas, list) else []:
        if not isinstance(fila, dict) or not _texto_plano(fila.get('product')):
            continue
        linea = existentes.get(_int(fila.get('id'))) or LineaReceta(receta=receta)
        linea.medicamento = _texto_plano(fila.get('product'), 500)
        linea.indicaciones = _texto_plano(fila.get('indications'))
        linea.notas = _texto_plano(fila.get('notes'))
        linea.save()
        conservar.add(linea.pk)
    receta.lineas.exclude(pk__in=conservar).delete()


@csrf_exempt
@login_required
@require_http_methods(['GET', 'POST'])
def recetas(request, patient_id):
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    if request.method == 'GET':
        qs = (Receta.objects.filter(paciente=paciente).select_related('medico', 'created_by', 'updated_by')
              .prefetch_related('lineas'))
        return _json([serializar_receta(r) for r in qs])
    if not puede_editar_recetas(request.user):
        return _prohibido()
    payload = _body(request)
    receta = Receta(paciente=paciente, created_by=request.user, updated_by=request.user,
                    nota_oncologia=_nota_origen(paciente, payload.get('clinic_consultations_id')))
    _aplicar_receta(receta, payload)
    with transaction.atomic():
        receta.save()
        _guardar_lineas(receta, payload.get('lines'))
    return _json(serializar_receta(receta))


@csrf_exempt
@login_required
@require_POST
def receta_editar(request, rec_id):
    if not puede_editar_recetas(request.user):
        return _prohibido()
    receta = _nota_visible(request, Receta, rec_id)
    if not receta:
        return _no_encontrado()
    payload = _body(request)
    _aplicar_receta(receta, payload)
    receta.updated_by = request.user
    with transaction.atomic():
        receta.save()
        if 'lines' in payload:
            _guardar_lineas(receta, payload.get('lines'))
    return _json(serializar_receta(receta))


@csrf_exempt
@login_required
@require_POST
def receta_borrar(request, rec_id):
    if not puede_editar_recetas(request.user):
        return _prohibido()
    receta = _nota_visible(request, Receta, rec_id)
    if receta:
        receta.delete()
    return _json({'ok': True})
