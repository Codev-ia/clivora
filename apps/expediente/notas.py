"""Pestaña Notas del expediente: signos vitales y notas de enfermería
(Evaluación Inicial y Registro Clínico). Rutas que consume app.js.

Cada nota se lista con un "source" (vitals, nursing…) y un id con prefijo
("v-12", "n-7"); las demás clases de nota se agregan aquí en sus fases.
"""
from html import escape

from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.core.html import limpiar as limpiar_html
from apps.pacientes.compat import visible_pacientes
from apps.web.roles import has_role, is_admin

from .compat import _body, _int, _json, _nombre
from .models import (DiagnosticoCIE, DiagnosticoNotaOncologia, MedicamentoAplicado, NotaEnfermeria, NotaOncologia,
                     RecetaNotaOncologia, RespuestaValoracion, SignosVitales,
                     SignoVitalEnfermeria)

# ── Permisos ──────────────────────────────────────────────────────────────

def es_rol_recepcion(user):
    """Recepción o Jefe de Recepción (sin ser administrador, médico ni
    enfermería): ve signos vitales y notas de enfermería, pero no las crea,
    edita ni borra."""
    if is_admin(user):
        return False
    recepcion = has_role(user, 'group_recepcion') or has_role(user, 'group_jefe_recepcion')
    clinico = any(has_role(user, r) for r in ('group_medicos', 'group_enfermeria', 'group_jefa_enfermeria'))
    return recepcion and not clinico


def notas_solo_lectura(user):
    """Recepción (sin ser Jefe de Recepción): no crea, edita ni borra notas
    clínicas (oncología). El Jefe de Recepción sí."""
    return es_rol_recepcion(user) and not has_role(user, 'group_jefe_recepcion')


def _paciente(request, patient_id):
    return visible_pacientes(request.user).filter(pk=patient_id).first()


def _nota_visible(request, Model, pk):
    return Model.objects.filter(pk=pk, paciente__in=visible_pacientes(request.user)).first()


def _prohibido():
    return _json({'error': 'forbidden'}, status=403)


def _no_encontrado():
    return _json({'error': 'not_found'}, status=404)


# ── Conversión de valores del formulario ──────────────────────────────────

def _entero(value):
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _decimal(value):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def _texto(value, limite=None):
    texto = '' if value in (None, False) else str(value).strip()
    return texto[:limite] if limite else texto


# El frontend pone estos textos dentro de value="…" sin escapar: se quitan los
# caracteres que permitirían salirse del atributo e inyectar HTML.
_INSEGUROS = str.maketrans('', '', '<>"')


def _texto_plano(value, limite=None):
    return _texto(value, limite).translate(_INSEGUROS)


def _aplicar(obj, payload, campos, solo_presentes):
    """campos: (llave del JSON, campo del modelo, tipo). Con solo_presentes,
    los que no vienen en el payload no se tocan (edición parcial)."""
    for key, field, tipo in campos:
        if solo_presentes and key not in payload:
            continue
        value = payload.get(key)
        if tipo == 'int':
            value = _entero(value)
        elif tipo == 'float':
            value = _decimal(value)
        elif tipo == 'bool':
            value = bool(value)
        elif tipo == 'html':
            value = limpiar_html(value)
        elif tipo == 'choice':
            valid = {c for c, _ in obj._meta.get_field(field).choices}
            value = _texto(value)
            if value not in valid:
                value = obj._meta.get_field(field).default
        else:
            value = _texto_plano(value, obj._meta.get_field(field).max_length)
        setattr(obj, field, value)


def fecha_texto(dt):
    """'25/10/2026, 09:05 a.m.' en hora local (Creado el / Última modificación)."""
    if not dt:
        return ''
    dt = timezone.localtime(dt)
    hora = dt.hour % 12 or 12
    return f"{dt:%d/%m/%Y}, {hora:02d}:{dt:%M} {'a.m.' if dt.hour < 12 else 'p.m.'}"


def _auditoria(nota):
    return {
        'fecha': fecha_texto(nota.created_at), 'createdBy': _nombre(nota.created_by),
        'updatedAt': fecha_texto(nota.updated_at), 'updatedBy': _nombre(nota.updated_by),
    }


def _o_vacio(value):
    return value if value else ''


# ── Signos vitales ────────────────────────────────────────────────────────

CAMPOS_SIGNOS = (
    ('sistolica', 'sistolica', 'int'), ('diastolica', 'diastolica', 'int'), ('fc', 'fc', 'int'),
    ('fr', 'fr', 'int'), ('temperatura', 'temperatura', 'float'), ('saturacion', 'saturacion', 'int'),
    ('peso', 'peso', 'float'), ('altura', 'talla', 'float'), ('comentarios', 'comentarios', 'html'),
)


def serializar_signos(s):
    return {
        'id': f'v-{s.pk}', 'source': 'vitals', 'tipo': 'Signos vitales', 'titulo': 'Signos vitales', 'medico': '',
        **_auditoria(s),
        'sistolica': _o_vacio(s.sistolica), 'diastolica': _o_vacio(s.diastolica), 'fc': _o_vacio(s.fc),
        'fr': _o_vacio(s.fr), 'temperatura': _o_vacio(s.temperatura), 'saturacion': _o_vacio(s.saturacion),
        'peso': _o_vacio(s.peso), 'altura': _o_vacio(s.talla),
        'bsa': f'{s.superficie_corporal:.2f} m²' if s.superficie_corporal else '',
        'imc': f'{s.imc:.2f} kg/m²' if s.imc else '',
        'comentarios': s.comentarios,
    }


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_POST
def signos_crear(request, patient_id):
    if es_rol_recepcion(request.user):
        return _prohibido()
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    signos = SignosVitales(paciente=paciente, created_by=request.user, updated_by=request.user)
    _aplicar(signos, _body(request), CAMPOS_SIGNOS, solo_presentes=False)
    signos.save()
    return _json(serializar_signos(signos))


@csrf_exempt
@login_required
@require_POST
def signos_editar(request, rec_id):
    if es_rol_recepcion(request.user):
        return _prohibido()
    signos = _nota_visible(request, SignosVitales, rec_id)
    if not signos:
        return _no_encontrado()
    _aplicar(signos, _body(request), CAMPOS_SIGNOS, solo_presentes=False)
    signos.updated_by = request.user
    signos.save()
    return _json(serializar_signos(signos))


# ── Notas de enfermería ───────────────────────────────────────────────────

# Evaluación Inicial: valoración por patrones funcionales de salud (Marjory
# Gordon). Catálogo fijo; para ampliarlo se edita esta lista.
PREGUNTAS_VALORACION = (
    ('Percepción – Manejo de la Salud', '¿Conoce su enfermedad?'),
    ('Percepción – Manejo de la Salud', '¿Uso de terapias complementarias?'),
    ('Nutricional – Metabólico', '¿Pérdida de peso involuntaria (últimos 3 meses)?'),
    ('Nutricional – Metabólico', '¿Reducción de apetito o disfagia?'),
    ('Eliminación', '¿Alteraciones urinarias (frecuencia, disuria, incontinencia)?'),
    ('Eliminación', '¿Alteraciones intestinales (estreñimiento, diarrea)?'),
    ('Actividad – Ejercicio', '¿Limitación para realizar actividades cotidianas?'),
    ('Actividad – Ejercicio', '¿Requiere ayuda para la movilización?'),
    ('Sueño – Descanso', '¿Dificultad para conciliar o mantener el sueño?'),
    ('Sueño – Descanso', '¿Usa medicamentos para dormir?'),
    ('Cognitivo – Perceptual', '¿Alteraciones de memoria, atención u orientación?'),
    ('Cognitivo – Perceptual', '¿Dolor no controlado con el manejo actual?'),
    ('Autopercepción – Autoconcepto', '¿Cambios en la autoimagen a raíz de la enfermedad?'),
    ('Autopercepción – Autoconcepto', '¿Ansiedad o angustia relacionada con el diagnóstico?'),
    ('Rol – Relaciones', '¿Cuenta con red de apoyo familiar o social?'),
    ('Rol – Relaciones', '¿La enfermedad ha afectado su rol familiar o laboral?'),
    ('Sexualidad – Reproducción', '¿Cambios en la función sexual o reproductiva?'),
    ('Adaptación – Tolerancia al Estrés', '¿Estrategias de afrontamiento ante el diagnóstico?'),
    ('Adaptación – Tolerancia al Estrés',
     '¿Consumo de alcohol, tabaco u otras sustancias como manejo del estrés?'),
    ('Valores – Creencias', '¿Creencias religiosas o espirituales relevantes para su atención?'),
)

# Datos de ingreso (los dos tipos de nota).
CAMPOS_INGRESO = (
    ('comentarios', 'reporte', 'html'),
    ('admissionWeightKg', 'peso_kg', 'float'),
    ('admissionHeightCm', 'talla_cm', 'float'),
    ('admissionTreatmentCycle', 'ciclo', 'str'),
    ('admissionAllergiesNote', 'alergias', 'str'),
    ('admissionFloorSuite', 'piso_suite', 'str'),
    ('admissionIsolation', 'aislamiento', 'choice'),
    ('admissionCareModality', 'modalidad_atencion', 'str'),
)
# Registro Clínico.
CAMPOS_ESCALAS = (
    ('painScale', 'dolor', 'int'), ('downtonScore', 'downton', 'int'),
    ('ecogNumber', 'ecog', 'int'), ('karnofskyNumber', 'karnofsky', 'int'),
    ('glasgowMotor', 'glasgow_motor', 'int'), ('glasgowVerbal', 'glasgow_verbal', 'int'),
    ('glasgowOcular', 'glasgow_ocular', 'int'), ('glasgowResult', 'glasgow_total', 'int'),
)
CAMPOS_DOWNTON = (
    ('previous_falls_downton', 'caidas_previas', 'bool'), ('sedatives_downton', 'sedantes', 'bool'),
    ('diuretics_downton', 'diureticos', 'bool'), ('antihipertensives_downton', 'antihipertensivos', 'bool'),
    ('antiparkinsonians_downton', 'antiparkinsonianos', 'bool'),
    ('antidepressants_downton', 'antidepresivos', 'bool'), ('desoriented_downton', 'desorientado', 'bool'),
    ('visual_downton', 'deficit_visual', 'bool'), ('auditive_downton', 'deficit_auditivo', 'bool'),
    ('limbs_downton', 'deficit_extremidades', 'bool'), ('safe_with_help_downton', 'marcha_segura_con_ayuda', 'bool'),
    ('unsafe_with_help_downton', 'marcha_insegura', 'bool'), ('impossible_downton', 'marcha_imposible', 'bool'),
)
CAMPOS_REGISTRO = (
    ('nauseaScale', 'nausea', 'choice'), ('mucositisScale', 'mucositis', 'choice'),
    ('functionalFatigueScale', 'fatiga', 'choice'), ('neutropeniaScale', 'neutropenia', 'choice'),
    ('labHemoglobin', 'hemoglobina', 'float'), ('labLeukocytes', 'leucocitos', 'int'),
    ('labPlatelets', 'plaquetas', 'int'), ('labNeutrophils', 'neutrofilos', 'int'),
    ('systemsConsciousness', 'conciencia', 'choice'), ('systemsMood', 'animo', 'choice'),
    ('systemsUrinary', 'urinario', 'choice'), ('systemsGastrointestinal', 'gastrointestinal', 'choice'),
    ('systemsCardiorespiratory', 'cardiorrespiratorio', 'choice'), ('systemsSkin', 'piel', 'choice'),
    ('systemsObservations', 'sistemas_observaciones', 'html'),
    ('evaPainLevel', 'eva_nivel', 'int'), ('evaCharacteristics', 'eva_caracteristicas', 'choice'),
    ('evaLocation', 'eva_localizacion', 'str'), ('evaIntervention', 'eva_intervencion', 'str'),
    ('dischargeMedicationsNote', 'medicamentos_egreso', 'str'),
    ('nurseResponsible1', 'enfermera_1', 'str'), ('nurseResponsible2', 'enfermera_2', 'str'),
    ('dischargeTime', 'hora_egreso', 'str'), ('vitalSignsCaptureTime', 'hora_signos', 'str'),
)
CAMPOS_PREVENCION = (
    ('fallPreventionSideRails', 'barandales', 'bool'), ('fallPreventionBrake', 'freno', 'bool'),
    ('fallPreventionBlueBracelet', 'brazalete_azul', 'bool'), ('fallPreventionBell', 'timbre', 'bool'),
)
CAMPOS_SIGNO_NEWS = (
    ('time', 'hora', 'str'), ('pas', 'pas', 'int'), ('pad', 'pad', 'int'), ('fc', 'fc', 'int'),
    ('fr', 'fr', 'int'), ('temp', 'temperatura', 'float'), ('sat', 'saturacion', 'int'),
    ('consciousness', 'conciencia', 'choice'), ('newsScore', 'news', 'int'),
)
CAMPOS_SIGNO_MANUAL = (
    ('hora', 'hora', 'str'), ('pas', 'pas', 'int'), ('pad', 'pad', 'int'), ('fc', 'fc', 'int'),
    ('fr', 'fr', 'int'), ('temp', 'temperatura', 'float'), ('sat', 'saturacion', 'int'),
    ('peso', 'peso', 'float'), ('talla', 'talla', 'float'),
)
CAMPOS_MEDICAMENTO = (
    ('medicationName', 'medicamento', 'str'), ('doseText', 'dosis', 'str'), ('route', 'via', 'str'),
    ('time', 'hora', 'str'), ('doubleCheckVerification1', 'doble_verificacion_1', 'str'),
    ('doubleCheckVerification2', 'doble_verificacion_2', 'str'),
)


def _filas(payload, key):
    filas = payload.get(key) or []
    return [f for f in filas if isinstance(f, dict)]


def _sincronizar(qs, filas, crear, campos):
    """Deja exactamente los renglones recibidos: actualiza los que traen id,
    crea los nuevos y borra los que ya no vienen."""
    existentes = {o.pk: o for o in qs}
    conservar = set()
    for fila in filas:
        obj = existentes.get(_int(fila.get('id'))) or crear()
        _aplicar(obj, fila, campos, solo_presentes=False)
        obj.save()
        conservar.add(obj.pk)
    qs.exclude(pk__in=conservar).delete()


def _guardar_respuestas(nota, filas):
    nota.respuestas.all().delete()
    validas = {c for c, _ in RespuestaValoracion.RESPUESTAS}
    RespuestaValoracion.objects.bulk_create([
        RespuestaValoracion(nota=nota, patron=_texto_plano(f.get('pattern'), 120),
                            pregunta=_texto_plano(f.get('question'), 250),
                            respuesta=f.get('answer') if f.get('answer') in validas else 'no',
                            detalle=_texto_plano(f.get('detail'), 500))
        for f in filas if _texto(f.get('pattern')) and _texto(f.get('question'))
    ])


def _guardar_news(nota, datos):
    if not isinstance(datos, dict) or not datos:
        return
    signo = nota.signos.filter(tipo=SignoVitalEnfermeria.NEWS).first() or SignoVitalEnfermeria(
        nota=nota, tipo=SignoVitalEnfermeria.NEWS)
    _aplicar(signo, datos, CAMPOS_SIGNO_NEWS, solo_presentes=False)
    signo.save()


def _guardar_tablas(nota, payload, solo_presentes):
    if nota.tipo == NotaEnfermeria.VALORACION_INICIAL:
        if not solo_presentes or 'assessmentAnswers' in payload:
            _guardar_respuestas(nota, _filas(payload, 'assessmentAnswers'))
        return
    if not solo_presentes or 'newsVitals' in payload:
        _guardar_news(nota, payload.get('newsVitals'))
    if not solo_presentes or 'manualVitalSigns' in payload:
        _sincronizar(nota.signos.filter(tipo=SignoVitalEnfermeria.MANUAL), _filas(payload, 'manualVitalSigns'),
                     lambda: SignoVitalEnfermeria(nota=nota, tipo=SignoVitalEnfermeria.MANUAL), CAMPOS_SIGNO_MANUAL)
    if not solo_presentes or 'appliedMedications' in payload:
        filas = [f for f in _filas(payload, 'appliedMedications') if _texto(f.get('medicationName'))]
        _sincronizar(nota.medicamentos.all(), filas, lambda: MedicamentoAplicado(nota=nota), CAMPOS_MEDICAMENTO)


def serializar_enfermeria(n):
    data = {
        'id': f'n-{n.pk}', 'source': 'nursing', 'tipo': 'Notas de enfermeria', 'titulo': n.titulo,
        'nursingNoteKind': n.tipo, 'medico': '', **_auditoria(n),
        'painScale': _o_vacio(n.dolor), 'downtonScore': _o_vacio(n.downton),
        'ecogNumber': _o_vacio(n.ecog), 'karnofskyNumber': _o_vacio(n.karnofsky),
        'comentarios': n.reporte,
        'admissionWeightKg': _o_vacio(n.peso_kg), 'admissionHeightCm': _o_vacio(n.talla_cm),
        'admissionTreatmentCycle': n.ciclo, 'admissionAllergiesNote': n.alergias,
        'admissionFloorSuite': n.piso_suite, 'admissionIsolation': n.aislamiento,
        'admissionCareModality': n.modalidad_atencion,
    }
    if n.tipo == NotaEnfermeria.VALORACION_INICIAL:
        data['assessmentAnswers'] = [
            {'id': r.pk, 'pattern': r.patron, 'question': r.pregunta, 'answer': r.respuesta, 'detail': r.detalle}
            for r in n.respuestas.all()]
        return data
    data.update({'glasgowMotor': n.glasgow_motor, 'glasgowVerbal': n.glasgow_verbal,
                 'glasgowOcular': n.glasgow_ocular, 'glasgowResult': n.glasgow_total})
    for key, field, _ in CAMPOS_DOWNTON + CAMPOS_PREVENCION:
        data[key] = getattr(n, field)
    for key, field, _ in CAMPOS_REGISTRO:
        data[key] = getattr(n, field)
    news = next((s for s in n.signos.all() if s.tipo == SignoVitalEnfermeria.NEWS), None)
    data['newsVitals'] = {
        'time': news.hora, 'pas': news.pas, 'pad': news.pad, 'fc': news.fc, 'fr': news.fr,
        'temp': news.temperatura, 'sat': news.saturacion, 'consciousness': news.conciencia,
        'newsScore': news.news,
    } if news else {}
    data['manualVitalSigns'] = [
        {'id': s.pk, 'hora': s.hora, 'pas': s.pas, 'pad': s.pad, 'fc': s.fc, 'fr': s.fr,
         'temp': s.temperatura, 'sat': s.saturacion, 'peso': s.peso, 'talla': s.talla}
        for s in n.signos.all() if s.tipo == SignoVitalEnfermeria.MANUAL]
    data['appliedMedications'] = [
        {'id': m.pk, 'medicationName': m.medicamento, 'doseText': m.dosis, 'route': m.via, 'time': m.hora,
         'doubleCheckVerification1': m.doble_verificacion_1, 'doubleCheckVerification2': m.doble_verificacion_2}
        for m in n.medicamentos.all()]
    return data


@csrf_exempt
@login_required
@require_POST
def enfermeria_crear(request, patient_id):
    if es_rol_recepcion(request.user):
        return _prohibido()
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    payload = _body(request)
    tipo = payload.get('nursingNoteKind')
    nota = NotaEnfermeria(paciente=paciente, created_by=request.user, updated_by=request.user,
                          tipo=tipo if tipo in dict(NotaEnfermeria.TIPOS) else NotaEnfermeria.REGISTRO_CLINICO)
    _aplicar(nota, payload, CAMPOS_INGRESO, solo_presentes=False)
    if not nota.alergias:
        nota.alergias = 'Sin alergias conocidas'
    if nota.tipo == NotaEnfermeria.REGISTRO_CLINICO:
        _aplicar(nota, payload, CAMPOS_ESCALAS + CAMPOS_DOWNTON + CAMPOS_REGISTRO, solo_presentes=False)
        # Prevención de caídas: marcadas salvo que el formulario diga lo contrario.
        _aplicar(nota, payload, CAMPOS_PREVENCION, solo_presentes=True)
    with transaction.atomic():
        nota.save()
        _guardar_tablas(nota, payload, solo_presentes=False)
    return _json(serializar_enfermeria(nota))


@csrf_exempt
@login_required
@require_POST
def enfermeria_editar(request, rec_id):
    if es_rol_recepcion(request.user):
        return _prohibido()
    nota = _nota_visible(request, NotaEnfermeria, rec_id)
    if not nota:
        return _no_encontrado()
    payload = _body(request)
    _aplicar(nota, payload, CAMPOS_INGRESO, solo_presentes=True)
    if nota.tipo == NotaEnfermeria.REGISTRO_CLINICO:
        _aplicar(nota, payload, CAMPOS_ESCALAS + CAMPOS_DOWNTON + CAMPOS_REGISTRO + CAMPOS_PREVENCION,
                 solo_presentes=True)
    nota.updated_by = request.user
    with transaction.atomic():
        nota.save()
        _guardar_tablas(nota, payload, solo_presentes=True)
    return _json(serializar_enfermeria(nota))


@require_GET
@login_required
def preguntas_valoracion(request):
    return _json([{'pattern': p, 'question': q} for p, q in PREGUNTAS_VALORACION])


# ── Nota de Oncología Médica ──────────────────────────────────────────────

def _texto_a_html(texto):
    """Texto de un <textarea> → HTML que conserva los saltos de línea; el
    frontend lo vuelve a convertir en texto (htmlToTextareaValue)."""
    return escape(_texto(texto)).replace('\n', '<br>')


def _fecha_local(value):
    naive = parse_datetime(value) if isinstance(value, str) and value else None
    if naive and timezone.is_naive(naive):
        return timezone.make_aware(naive)
    return naive


def serializar_oncologia(n):
    from .documentos import documentos_de_nota  # documentos importa este módulo

    ingreso = n.fecha_ingreso and timezone.localtime(n.fecha_ingreso)
    return {
        'id': f'o-{n.pk}', 'consultation_id': n.pk, 'source': 'consultation',
        'tipo': 'Nota de oncología médica', 'titulo': 'Nota de oncología médica',
        'medico': _nombre(n.medico), **_auditoria(n),
        'admissionDatetime': ingreso.strftime('%Y-%m-%dT%H:%M') if ingreso else '',
        'treatmentCycle': n.ciclo, 'allergiesNote': n.alergias,
        'analisis': n.analisis, 'indicaciones': n.indicaciones,
        'diagnosticos': [{'codigo': d.diagnostico, 'tipo': d.tipo, 'cie11_diagnosis_id': d.cie_id or False,
                          'comment': d.comentario} for d in n.diagnosticos.all()],
        'recetas': [{'nombre': r.nombre, 'indicaciones': r.indicaciones, 'notas': r.notas} for r in n.recetas.all()],
        'linkedDocuments': documentos_de_nota(n),
    }


def _aplicar_oncologia(nota, payload, solo_presentes):
    if not solo_presentes or 'admissionDatetime' in payload:
        nota.fecha_ingreso = _fecha_local(payload.get('admissionDatetime'))
    if not solo_presentes or 'treatmentCycle' in payload:
        nota.ciclo = _texto_plano(payload.get('treatmentCycle'), 120)
    if not solo_presentes or 'allergiesNote' in payload:
        nota.alergias = _texto_plano(payload.get('allergiesNote'), 500) or 'Sin alergias conocidas'
    if not solo_presentes or 'analisis' in payload:
        nota.analisis = limpiar_html(payload.get('analisis'))
    if not solo_presentes or 'indicaciones' in payload:
        nota.indicaciones = _texto_a_html(payload.get('indicaciones'))
    # Médico asignado actual del paciente (se actualiza al editar).
    nota.medico = nota.paciente.doctor_asignado or nota.medico


def _guardar_detalle_oncologia(nota, payload, solo_presentes):
    if not solo_presentes or 'diagnosticos' in payload:
        filas = [f for f in _filas(payload, 'diagnosticos') if _texto(f.get('codigo'))]
        validos = set(DiagnosticoCIE.objects.filter(
            pk__in=[_int(f.get('cie11_diagnosis_id')) for f in filas]).values_list('pk', flat=True))
        tipos = dict(DiagnosticoNotaOncologia.TIPOS)
        nota.diagnosticos.all().delete()
        DiagnosticoNotaOncologia.objects.bulk_create([DiagnosticoNotaOncologia(
            nota=nota, diagnostico=_texto_plano(f.get('codigo'), 520),
            tipo=f.get('tipo') if f.get('tipo') in tipos else 'Principal',
            cie_id=_int(f.get('cie11_diagnosis_id')) if _int(f.get('cie11_diagnosis_id')) in validos else None,
            comentario=_texto_plano(f.get('comment'), 500)) for f in filas])
    if not solo_presentes or 'recetas' in payload:
        nota.recetas.all().delete()
        RecetaNotaOncologia.objects.bulk_create([RecetaNotaOncologia(
            nota=nota, nombre=_texto_plano(f.get('nombre'), 250),
            indicaciones=_texto_plano(f.get('indicaciones'), 500), notas=_texto_plano(f.get('notas'), 500))
            for f in _filas(payload, 'recetas') if _texto(f.get('nombre'))])


@csrf_exempt
@login_required
@require_POST
def oncologia_crear(request, patient_id):
    if notas_solo_lectura(request.user):
        return _prohibido()
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    payload = _body(request)
    nota = NotaOncologia(paciente=paciente, created_by=request.user, updated_by=request.user)
    _aplicar_oncologia(nota, payload, solo_presentes=False)
    with transaction.atomic():
        nota.save()
        _guardar_detalle_oncologia(nota, payload, solo_presentes=False)
    return _json(serializar_oncologia(nota))


@csrf_exempt
@login_required
@require_POST
def oncologia_editar(request, rec_id):
    if notas_solo_lectura(request.user):
        return _prohibido()
    nota = _nota_visible(request, NotaOncologia, rec_id)
    if not nota:
        return _no_encontrado()
    payload = _body(request)
    _aplicar_oncologia(nota, payload, solo_presentes=True)
    nota.updated_by = request.user
    with transaction.atomic():
        nota.save()
        _guardar_detalle_oncologia(nota, payload, solo_presentes=True)
    return _json(serializar_oncologia(nota))


# ── Lista de notas del paciente y borrado ─────────────────────────────────

# source → (modelo, quién no puede borrarla). Cada fase del expediente agrega
# aquí sus notas.
FUENTES = {
    'vitals': (SignosVitales, es_rol_recepcion),
    'nursing': (NotaEnfermeria, es_rol_recepcion),
    'consultation': (NotaOncologia, notas_solo_lectura),
}


@require_GET
@login_required
def consultas(request, patient_id):
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    filas = []
    signos = SignosVitales.objects.filter(paciente=paciente).select_related('created_by', 'updated_by')
    filas += [(s.created_at, serializar_signos(s)) for s in signos]
    notas = (NotaEnfermeria.objects.filter(paciente=paciente).select_related('created_by', 'updated_by')
             .prefetch_related('respuestas', 'signos', 'medicamentos'))
    filas += [(n.created_at, serializar_enfermeria(n)) for n in notas]
    onco = (NotaOncologia.objects.filter(paciente=paciente).select_related('created_by', 'updated_by', 'medico')
            .prefetch_related('diagnosticos', 'recetas'))
    filas += [(n.created_at, serializar_oncologia(n)) for n in onco]
    filas.sort(key=lambda f: f[0], reverse=True)
    return _json([f[1] for f in filas])


@csrf_exempt
@login_required
@require_http_methods(['POST'])
def consulta_borrar(request, source, rec_id):
    fuente = FUENTES.get(source)
    if not fuente:
        return _json({'error': 'invalid_source'}, status=400)
    modelo, sin_permiso = fuente
    if sin_permiso(request.user):
        return _prohibido()
    nota = _nota_visible(request, modelo, rec_id)
    if nota:
        nota.delete()
    return _json({'ok': True})
