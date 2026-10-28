"""Rutas de Historia Clínica que consume el frontend (app.js)."""
import json

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from apps.web.roles import has_role, is_admin
from apps.core.html import limpiar as limpiar_html
from apps.pacientes.compat import visible_pacientes

from . import cie
from .models import (AntecedenteFamiliar, ArchivoPaciente, Diagnostico, DiagnosticoCIE, HistoriaClinica, MedicamentoActual,
                     NotaEnfermeria, NotaOncologia, OrdenMedica, Pronostico, Receta, SeccionModificada,
                     SignosVitales)

NEGADO = 'Interrogado y Negado'
SIN_MEDICAMENTOS = 'Interrogado y no refiere tomar alguno'

# Llave del JSON de Clivora → campo de HistoriaClinica. Todos los textos vienen
# del editor enriquecido (HTML).
CAMPOS_TEXTO = {
    'antecedentes_importantes': 'antecedentes_importantes',
    'motivo_consulta': 'motivo_consulta',
    'non_pathological_observations': 'no_patologicos',
    'smoking_observations': 'tabaquismo_obs',
    'vaping_observations': 'vapeo_obs',
    'exposed_to_smoke_observations': 'humo_pasivo_obs',
    'alcoholism_observations': 'alcoholismo_obs',
    'drug_observations': 'drogas_obs',
    'allergies_observations': 'alergias_obs',
    'surgeries_observations': 'cirugias_obs',
    'transfusions_observations': 'transfusiones_obs',
    'reproductive_observations': 'reproductivos_obs',
    'other_personal_diseases': 'otras_enfermedades',
    'gynecological_other': 'gineco_obs',
    'respiratory': 'respiratorio',
    'endocrine': 'endocrino',
    'skin_and_appendages': 'piel_anexos',
    'cardiovascular': 'cardiovascular',
    'musculoskeletal': 'musculoesqueletico',
    'digestive': 'digestivo',
    'genitourinary': 'genitourinario',
    'aparatus_general_comments': 'aparatos_comentarios',
    'physical_exploration_head': 'exploracion_cabeza',
    'physical_exploration_neck': 'exploracion_cuello',
    'physical_exploration_thorax': 'exploracion_torax',
    'physical_exploration_abdomen': 'exploracion_abdomen',
    'physical_exploration_genitals': 'exploracion_genitales',
    'physical_exploration_extremities': 'exploracion_extremidades',
    'peea_description': 'peea',
    'hc_analysis': 'analisis',
    'treatment_plan_description': 'plan_tratamiento',
}
CAMPOS_SWITCH = {
    'smoking': 'tabaquismo',
    'vapes': 'vapeo',
    'exposed_to_smoke': 'humo_pasivo',
    'alcoholism': 'alcoholismo',
    'uses_drugs': 'drogas',
    'has_allergies_hc': 'alergias',
    'has_surgeries': 'cirugias',
    'has_transfusions': 'transfusiones',
    'is_reproductive': 'reproductivos',
    'has_gineco_history': 'gineco',
}


def _json(data, status=200):
    return JsonResponse(data, safe=False, status=status, json_dumps_params={'ensure_ascii': False})


def _body(request):
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        return {}


def _nombre(user):
    return (user.get_full_name() or user.username) if user else ''


def _iso(dt):
    return timezone.localtime(dt).replace(tzinfo=None).isoformat() if dt else ''


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def puede_editar(user):
    """Mismo criterio que el frontend (isEnfermeriaLimited/isRecepcionLimited
    en /api/me): Enfermería y Recepción ven la Historia Clínica pero no la
    editan; Jefa de Enfermería y Jefe de Recepción sí."""
    if is_admin(user):
        return True
    enfermeria = has_role(user, 'group_enfermeria') or has_role(user, 'group_jefa_enfermeria')
    if enfermeria and not has_role(user, 'group_jefa_enfermeria'):
        return False
    if has_role(user, 'group_recepcion') and not has_role(user, 'group_jefe_recepcion'):
        return False
    return True


def _paciente_o_error(request, patient_id):
    """(paciente, None) o (None, respuesta de error). GET para quien ve al
    paciente; POST además exige poder editar la Historia Clínica."""
    paciente = visible_pacientes(request.user).filter(pk=patient_id).first()
    if not paciente:
        return None, _json({'error': 'not_found'}, status=404)
    if request.method == 'POST' and not puede_editar(request.user):
        return None, _json({'error': 'forbidden'}, status=403)
    return paciente, None


# ── Historia Clínica (registro único por paciente) ────────────────────────

def serializar_historia(paciente):
    """Bloque `historia_clinica` del detalle del paciente."""
    hc = HistoriaClinica.objects.filter(paciente=paciente).select_related(
        'created_by', 'updated_by').prefetch_related('secciones__updated_by').first()
    data = {'religion': paciente.religion}
    if not hc:
        return data
    for key, field in CAMPOS_TEXTO.items():
        data[key] = getattr(hc, field)
    for key, field in CAMPOS_SWITCH.items():
        data[key] = getattr(hc, field)
    fecha = hc.exploracion_fecha and timezone.localtime(hc.exploracion_fecha)
    data['physical_exploration_datetime'] = fecha.strftime('%Y-%m-%dT%H:%M') if fecha else ''
    data['forecast_option_id'] = hc.pronostico_id or False
    data.update({
        'id': hc.pk, 'createdBy': _nombre(hc.created_by), 'createdAt': _iso(hc.created_at),
        'updatedBy': _nombre(hc.updated_by), 'updatedAt': _iso(hc.updated_at),
    })
    # Una sección que nunca se ha guardado muestra la fecha de creación del
    # expediente, no la última modificación general (que la mueve cualquier
    # otra sección).
    marcas = {s.seccion: s for s in hc.secciones.all()}
    data['sectionsAudit'] = {
        str(n): ({'updatedBy': _nombre(marcas[n].updated_by), 'updatedAt': _iso(marcas[n].updated_at)}
                 if n in marcas else {'updatedBy': data['createdBy'], 'updatedAt': data['createdAt']})
        for n in HistoriaClinica.SECCIONES
    }
    return data


def _valores(payload):
    """Campos del modelo que vienen en el payload, ya convertidos."""
    valores = {}
    for key, field in CAMPOS_TEXTO.items():
        if key in payload:
            valores[field] = limpiar_html(payload.get(key))
    for key, field in CAMPOS_SWITCH.items():
        if key in payload:
            valores[field] = bool(payload.get(key))
    if 'physical_exploration_datetime' in payload:
        naive = parse_datetime(payload.get('physical_exploration_datetime') or '')
        valores['exploracion_fecha'] = timezone.make_aware(naive) if naive and timezone.is_naive(naive) else naive
    if 'forecast_option_id' in payload:
        pk = _int(payload.get('forecast_option_id'))
        valores['pronostico_id'] = pk if pk and Pronostico.objects.filter(pk=pk).exists() else None
    return valores


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_http_methods(['POST'])
def historia_clinica_save(request, patient_id):
    paciente, error = _paciente_o_error(request, patient_id)
    if error:
        return error
    hc, _ = HistoriaClinica.objects.select_for_update().get_or_create(
        paciente=paciente, defaults={'created_by': request.user, 'updated_by': request.user})
    valores = _valores(_body(request))
    # El frontend manda el formulario completo en cada guardado: solo se
    # escriben (y se marcan como modificadas) las secciones donde cambió algo.
    cambiados = {f for f, v in valores.items() if getattr(hc, f) != v}
    if cambiados:
        for field in cambiados:
            setattr(hc, field, valores[field])
        hc.updated_by = request.user
        hc.save()
        ahora = timezone.now()
        nombres = {f.removesuffix('_id') for f in cambiados}
        for seccion, campos in HistoriaClinica.SECCIONES.items():
            if nombres.intersection(campos):
                SeccionModificada.objects.update_or_create(
                    historia=hc, seccion=seccion, defaults={'updated_at': ahora, 'updated_by': request.user})
    return _json({'ok': True})


# ── Listas (familiares, medicamentos, diagnósticos) ───────────────────────

def _sincronizar(qs, filas, crear, actualizar):
    """Deja en la base exactamente los renglones recibidos: actualiza los que
    traen id, crea los nuevos y borra los que ya no vienen."""
    existentes = {o.pk: o for o in qs}
    conservar = set()
    for fila in filas:
        obj = existentes.get(_int(fila.get('id')))
        if obj:
            actualizar(obj, fila)
            obj.save()
        else:
            obj = crear(fila)
        conservar.add(obj.pk)
    qs.exclude(pk__in=conservar).delete()


def _filas(request):
    filas = _body(request).get('rows') or []
    return [f for f in filas if isinstance(f, dict)]


@csrf_exempt
@login_required
@require_http_methods(['GET', 'POST'])
def family_history(request, patient_id):
    paciente, error = _paciente_o_error(request, patient_id)
    if error:
        return error
    qs = AntecedenteFamiliar.objects.filter(paciente=paciente)
    if request.method == 'GET':
        return _json([{'id': a.pk, 'has_died': a.fallecido, 'other_diseases': a.descripcion} for a in qs])

    def actualizar(obj, fila):
        if 'has_died' in fila:
            obj.fallecido = bool(fila.get('has_died'))
        if 'other_diseases' in fila:
            obj.descripcion = limpiar_html(fila.get('other_diseases'))

    def crear(fila):
        obj = AntecedenteFamiliar(paciente=paciente)
        actualizar(obj, fila)
        obj.save()
        return obj

    filas = _filas(request) or [{'other_diseases': NEGADO}]  # sin familiares: queda explícito
    _sincronizar(qs, filas, crear, actualizar)
    return _json({'ok': True})


@csrf_exempt
@login_required
@require_http_methods(['GET', 'POST'])
def medications(request, patient_id):
    paciente, error = _paciente_o_error(request, patient_id)
    if error:
        return error
    qs = MedicamentoActual.objects.filter(paciente=paciente)
    if request.method == 'GET':
        return _json([{'id': m.pk, 'product': m.descripcion} for m in qs])

    def actualizar(obj, fila):
        obj.descripcion = limpiar_html(fila.get('product'))

    def crear(fila):
        return MedicamentoActual.objects.create(paciente=paciente, descripcion=limpiar_html(fila.get('product')))

    filas = [f for f in _filas(request) if limpiar_html(f.get('product'))] or [{'product': SIN_MEDICAMENTOS}]
    _sincronizar(qs, filas, crear, actualizar)
    return _json({'ok': True})


@csrf_exempt
@login_required
@require_http_methods(['GET', 'POST'])
def diagnosis_lines(request, patient_id):
    paciente, error = _paciente_o_error(request, patient_id)
    if error:
        return error
    qs = Diagnostico.objects.filter(paciente=paciente)
    if request.method == 'GET':
        return _json([{'id': d.pk, 'diagnosis': d.diagnostico, 'cie11_diagnosis_id': d.cie_id or False,
                       'comment': d.comentario} for d in qs])

    filas = [f for f in _filas(request) if str(f.get('diagnosis') or '').strip()]
    validos = set(DiagnosticoCIE.objects.filter(
        pk__in=[_int(f.get('cie11_diagnosis_id')) for f in filas]).values_list('pk', flat=True))
    for i, fila in enumerate(filas):
        fila['_sequence'] = i * 10

    def actualizar(obj, fila):
        cie_id = _int(fila.get('cie11_diagnosis_id'))
        obj.diagnostico = str(fila.get('diagnosis')).strip()[:520]
        obj.cie_id = cie_id if cie_id in validos else None
        obj.comentario = str(fila.get('comment') or '').strip()[:500]
        obj.sequence = fila['_sequence']

    def crear(fila):
        obj = Diagnostico(paciente=paciente)
        actualizar(obj, fila)
        obj.save()
        return obj

    _sincronizar(qs, filas, crear, actualizar)
    return _json({'ok': True})


# ── Catálogos ─────────────────────────────────────────────────────────────

@require_GET
@login_required
def hc_catalogs(request):
    return _json({
        'forecast_options': [{'id': p.pk, 'name': p.name} for p in Pronostico.objects.filter(active=True)],
    })


@require_GET
@login_required
def cie11_search(request):
    query = (request.GET.get('q') or '').strip()
    qs = DiagnosticoCIE.objects.filter(active=True)
    if query:
        ids = cie.buscar(query)
        por_id = qs.in_bulk(ids)
        resultados = [por_id[i] for i in ids if i in por_id]
    else:
        resultados = list(qs.filter(catalogo='cie11')[:20])
    return _json([{'id': d.pk, 'code': d.codigo, 'name': d.nombre, 'catalog': d.catalogo} for d in resultados])


# ── Corregir "Creado el" (rol "Editar fecha de creación del historial") ──

# Tipo de registro que manda el frontend → modelo. Cada fase del expediente
# agrega los suyos (notas, recetas, órdenes…).
FECHA_CREACION_MODELOS = {
    'historia_clinica': HistoriaClinica,
    'signos_vitales': SignosVitales,
    'nota_enfermeria': NotaEnfermeria,
    'consulta': NotaOncologia,
    'receta': Receta,
    'orden_estudios': OrdenMedica,
    'archivo': ArchivoPaciente,
}


@csrf_exempt
@login_required
@require_http_methods(['POST'])
def historial_create_date(request, model, record_id):
    if not has_role(request.user, 'group_historial_create_date_edit'):
        return _json({'error': 'forbidden'}, status=403)
    Model = FECHA_CREACION_MODELOS.get(model)
    if not Model:
        return _json({'error': 'invalid_model'}, status=400)
    obj = Model.objects.filter(pk=record_id, paciente__in=visible_pacientes(request.user)).first()
    if not obj:
        return _json({'error': 'not_found'}, status=404)
    naive = parse_datetime(_body(request).get('create_date') or '')
    if not naive:
        return _json({'error': 'invalid_date'}, status=400)
    fecha = timezone.make_aware(naive) if timezone.is_naive(naive) else naive
    # update() en vez de save(): created_at es auto_now_add y updated_at no
    # debe moverse por una corrección de fecha.
    Model.objects.filter(pk=obj.pk).update(created_at=fecha)
    return _json({'create_date': _iso(fecha)})
