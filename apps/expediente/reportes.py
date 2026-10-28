"""Reportes PDF del expediente (botones "Imprimir" y "Descargar PDF"):
Historia Clínica, signos vitales, notas de enfermería, nota de oncología,
órdenes médicas y recetas. Se generan con WeasyPrint a partir de
templates/reportes/documento.html; cada función de abajo arma solo las
secciones con información, con los datos que guarda Clivora.

`?download=1` manda el PDF como descarga; sin él se abre en el navegador."""
import re
from pathlib import Path

from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_GET

from apps.core.clinica import active_clinica
from apps.core.html import limpiar as limpiar_html

from .compat import _nombre
from .models import (HistoriaClinica, NotaEnfermeria, NotaOncologia, OrdenMedica, Receta, SignosVitales,
                     SignoVitalEnfermeria)
from .notas import _no_encontrado, _paciente

FUENTES = Path(__file__).resolve().parent / 'reportes_fonts'

# Textos de las opciones del Registro Clínico de Enfermería, como los
# muestra el formulario (paciente-detail.html).
ETIQUETAS = {
    'aislamiento': {'ninguno': 'Ninguno', 'contacto': 'Contacto', 'gotas': 'Gotas', 'aereo': 'Aéreo',
                    'protector': 'Protector (Neutropénico)'},
    'conciencia': {'alerta': 'Alerta y orientado', 'orientado_3_esferas': 'Orientado en 3 esferas',
                   'lenguaje_claro': 'Lenguaje claro', 'sigue_instrucciones': 'Sigue instrucciones',
                   'moviliza_extremidades': 'Moviliza las 4 extremidades', 'somnoliento': 'Somnoliento',
                   'confuso': 'Confuso', 'otro': 'Otro'},
    'animo': {'tranquilo': 'Tranquilo / Colaborador', 'triste': 'Triste', 'euforico': 'Eufórico',
              'ansioso': 'Ansioso', 'agresivo': 'Agresivo', 'deprimido': 'Deprimido', 'otro': 'Otro'},
    'urinario': {'espontaneo': 'Espontáneo / Claro (sin alteración)', 'incontinencia_urinaria': 'Incontinencia',
                 'disuria': 'Disuria', 'retencion': 'Retención', 'hematuria': 'Hematuria',
                 'sonda': 'Sonda vesical', 'otro': 'Otro'},
    'gastrointestinal': {'normal': 'Ruidos peristálticos (+) (sin alteración)', 'estrenimiento': 'Estreñimiento',
                         'incontinencia_gi': 'Incontinencia', 'diarrea': 'Diarrea', 'nausea': 'Náusea',
                         'vomitos': 'Vómito', 'anorexia': 'Anorexia', 'distension': 'Distensión abdominal',
                         'otro': 'Otro'},
    'cardiorrespiratorio': {'normal': 'Buena ventilación (sin alteración)', 'palpitaciones': 'Palpitaciones',
                            'disnea': 'Disnea', 'parestesias': 'Parestesias', 'neuropatias': 'Neuropatías',
                            'edema': 'Edema', 'tos': 'Tos / Secreciones', 'otro': 'Otro'},
    'piel': {'integra': 'Piel íntegra / Hidratada', 'deshidratada': 'Deshidratada', 'ictericia': 'Ictericia',
             'palidez': 'Palidez', 'hiperpigmentacion': 'Hiperpigmentación', 'dermatitis': 'Dermatitis',
             'alopecia': 'Alopecia', 'mucositis': 'Mucositis', 'heridas': 'Heridas / Úlceras',
             'rash': 'Rash cutáneo', 'otro': 'Otro'},
    'eva_caracteristicas': {'sin_dolor': 'Sin dolor', 'colico': 'Cólico', 'quemante': 'Quemante / Urente',
                            'opresivo': 'Opresivo', 'punzante': 'Punzante', 'sordo': 'Sordo / Sostenido'},
}


# ── Utilidades ────────────────────────────────────────────────────────────

def _html(valor):
    """Texto guardado (HTML saneado o texto plano) listo para la plantilla."""
    return mark_safe(limpiar_html(valor)) if valor else ''


def _tiene(valor):
    """Un texto del editor vacío ("<p><br></p>") cuenta como vacío."""
    return bool(valor and re.sub(r'<[^>]*>|&nbsp;|\s', '', str(valor)))


def _fecha_hora(dt):
    return timezone.localtime(dt).strftime('%d/%m/%Y %H:%M') if dt else ''


def _fecha(d):
    return d.strftime('%d/%m/%Y') if d else ''


def _num(valor, formato='{:g}'):
    return formato.format(valor) if valor else ''


def campos(titulo, filas, cols=3, normal=False):
    """Cuadrícula etiqueta/valor con solo los campos que tienen información,
    sin huecos. filas: (etiqueta, valor) o (etiqueta, valor, 'wide')."""
    renglones, actual = [], []
    for item in filas:
        etiqueta, valor = item[0], item[1]
        if not _tiene(valor):
            continue
        celda = {'label': etiqueta, 'value': _html(valor) if isinstance(valor, str) else valor, 'span': 1}
        if len(item) > 2:
            if actual:
                renglones.append(actual)
                actual = []
            renglones.append([{**celda, 'span': cols}])
            continue
        actual.append(celda)
        if len(actual) == cols:
            renglones.append(actual)
            actual = []
    if actual:
        # La última celda ocupa lo que sobra del renglón.
        actual[-1]['span'] = cols - len(actual) + 1
        renglones.append(actual)
    return {'kind': 'fields', 'title': titulo, 'rows': renglones, 'normal': normal} if renglones else None


def texto(titulo, valor, pre=False):
    return {'kind': 'text', 'title': titulo, 'html': _html(valor), 'pre': pre} if _tiene(valor) else None


def tabla(titulo, encabezados, filas, anchos=None):
    """Tabla con las columnas que traen algún valor (la primera siempre)."""
    if not filas:
        return None
    usar = [i for i in range(len(encabezados)) if i == 0 or any(_tiene(f[i]) for f in filas)]
    return {
        'kind': 'table', 'title': titulo,
        'headers': [(encabezados[i], (anchos or {}).get(i)) for i in usar],
        'rows': [[_html(f[i]) if isinstance(f[i], str) else f[i] for i in usar] for f in filas],
    }


def vitales(titulo, ta='', fc=0, fr=0, temp=0, sat=0, peso=0, talla=0, sc=0, imc=0):
    """Tabla de signos vitales con solo las columnas capturadas; SC (DuBois)
    e IMC se calculan con peso y talla si no vienen."""
    if peso and talla:
        sc = sc or 0.007184 * peso ** 0.425 * talla ** 0.725
        imc = imc or peso / (talla / 100) ** 2
    columnas = [(nombre, valor) for nombre, valor in (
        ('T/A', ta and f'{ta} mmHg'), ('FC', fc and f'{fc} lpm'), ('FR', fr and f'{fr} rpm'),
        ('Temp.', temp and f'{temp:.1f} °C'), ('SatO₂', sat and f'{sat} %'), ('Peso', peso and f'{peso:.1f} kg'),
        ('Talla', talla and f'{talla:.1f} cm'), ('SC (DuBois)', sc and f'{sc:.2f} m²'),
        ('IMC', imc and f'{imc:.2f} kg/m²')) if valor]
    if not columnas:
        return None
    return {'kind': 'table', 'title': titulo, 'headers': [(c[0], None) for c in columnas],
            'rows': [[c[1] for c in columnas]]}


def _ta(sistolica, diastolica):
    return f'{sistolica}/{diastolica}' if sistolica or diastolica else ''


def _datos_paciente(paciente, *extra, inicio=()):
    return [
        ('Expediente', paciente.expediente), ('Paciente', paciente.nombre_completo), *inicio,
        ('Fecha de nacimiento', _fecha(paciente.fecha_nacimiento)),
        ('Edad', f'{paciente.edad} años' if paciente.edad is not None else ''), *extra,
    ]


def _diagnosticos(titulo, lineas, con_tipo=False):
    filas = [(d.cie.codigo if d.cie else '', d.cie.nombre if d.cie else d.diagnostico,
              d.tipo if con_tipo else '', d.comentario) for d in lineas]
    return tabla(titulo, ['Código CIE', 'Diagnóstico', 'Tipo', 'Comentario'], filas, {0: '16%'})


def _encabezado(request, paciente):
    clinica = active_clinica(request) or paciente.clinica_registro
    if not clinica:
        return {'name': 'Clivora', 'lines': [], 'logo': ''}
    calle = ' '.join(p for p in (clinica.calle, clinica.numero_exterior,
                                 clinica.numero_interior and f'Int. {clinica.numero_interior}') if p)
    lugar = ', '.join(p for p in (clinica.colonia and f'Col. {clinica.colonia}', clinica.municipio or clinica.city,
                                  clinica.estado, clinica.codigo_postal and f'C.P. {clinica.codigo_postal}') if p)
    contacto = ' · '.join(p for p in (clinica.phone and f'T. {clinica.phone}', clinica.email) if p)
    logo = ''
    if clinica.logo:
        try:
            logo = Path(clinica.logo.path).as_uri()
        except (ValueError, NotImplementedError):
            logo = ''
    return {'name': clinica.name, 'lines': [l for l in (calle, lugar, contacto) if l], 'logo': logo}


def _pdf(request, paciente, titulo, folio, secciones, firma, nombre_archivo):
    from weasyprint import HTML  # carga pango solo al imprimir

    html = render_to_string('reportes/documento.html', {
        'clinica': _encabezado(request, paciente), 'titulo': titulo, 'folio': folio,
        'secciones': [s for s in secciones if s], 'firma': firma, 'fuentes': FUENTES.as_uri(),
        'generado': _fecha_hora(timezone.now()),
    })
    pdf = HTML(string=html, base_url=str(FUENTES)).write_pdf()
    response = HttpResponse(pdf, content_type='application/pdf')
    modo = 'attachment' if request.GET.get('download') in ('1', 'true') else 'inline'
    response['Content-Disposition'] = f'{modo}; filename="{nombre_archivo}-{paciente.expediente}-{folio}.pdf"'
    return response


def _firma_medico(medico, leyenda='Firma del médico'):
    return {'caption': leyenda, 'name': _nombre(medico)}


# ── Reportes ──────────────────────────────────────────────────────────────

@require_GET
@login_required
def historia_clinica(request, patient_id):
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    hc = HistoriaClinica.objects.filter(paciente=paciente).select_related('pronostico', 'created_by').first()
    hc = hc or HistoriaClinica(paciente=paciente)
    medico = paciente.doctor_asignado or hc.created_by
    familiares = '<br>'.join(
        limpiar_html(f.descripcion) + (' (finado)' if f.fallecido else '')
        for f in paciente.antecedentes_familiares.all() if _tiene(f.descripcion))
    medicamentos = '<br>'.join(limpiar_html(m.descripcion) for m in paciente.medicamentos_actuales.all())
    vital = SignosVitales.objects.filter(paciente=paciente).order_by('-created_at').first()
    es_femenino = paciente.genero == 'femenino'
    secciones = [
        campos(None, _datos_paciente(
            paciente, ('Sexo', paciente.get_genero_display()), ('Estado civil', paciente.get_estado_civil_display()),
            ('Ocupación', paciente.ocupacion),
            inicio=[('Fecha y hora', _fecha_hora(hc.created_at)), ('Médico que elabora', _nombre(medico))])),
        texto('Motivo de consulta', hc.motivo_consulta),
        campos('Antecedentes', [
            ('Heredo-familiares', familiares, 'wide'),
            ('Antecedentes importantes', hc.antecedentes_importantes, 'wide'),
            ('No patológicos', hc.no_patologicos),
            ('Quirúrgicos', hc.cirugias_obs), ('Transfusiones', hc.transfusiones_obs),
            ('Alergias', hc.alergias_obs), ('Medicamentos actuales', medicamentos),
            ('Otras enfermedades', hc.otras_enfermedades), ('Tabaco', hc.tabaquismo_obs),
            ('Vape', hc.vapeo_obs), ('Humo pasivo', hc.humo_pasivo_obs), ('Alcoholismo', hc.alcoholismo_obs),
            ('Drogas', hc.drogas_obs), ('Reproductivos', hc.reproductivos_obs),
            ('Gineco-obstétricos', hc.gineco_obs if es_femenino else '', 'wide')]),
        campos('Interrogatorio por aparatos y sistemas', [
            ('Respiratorio', hc.respiratorio), ('Cardiovascular', hc.cardiovascular),
            ('Digestivo', hc.digestivo), ('Genitourinario', hc.genitourinario), ('Endocrino', hc.endocrino),
            ('Musculoesquelético', hc.musculoesqueletico), ('Piel y anexos', hc.piel_anexos),
            ('Comentarios generales', hc.aparatos_comentarios, 'wide')]),
        vital and vitales(
            f'Exploración física — signos vitales del {_fecha_hora(vital.created_at)}',
            _ta(vital.sistolica, vital.diastolica), vital.fc, vital.fr, vital.temperatura, vital.saturacion,
            vital.peso, vital.talla, vital.superficie_corporal, vital.imc),
        campos('Exploración física', [
            ('Fecha y hora de la exploración', _fecha_hora(hc.exploracion_fecha), 'wide'),
            ('Cabeza', hc.exploracion_cabeza), ('Cuello', hc.exploracion_cuello), ('Tórax', hc.exploracion_torax),
            ('Abdomen', hc.exploracion_abdomen), ('Genitales', hc.exploracion_genitales),
            ('Extremidades', hc.exploracion_extremidades)], cols=2, normal=True),
        texto('Principio, evolución y estado actual (PEEA)', hc.peea),
        _diagnosticos('Diagnósticos', paciente.diagnosticos.select_related('cie')),
        texto('Análisis', hc.analisis),
        campos('Plan de tratamiento y pronóstico', [
            ('Plan de tratamiento', hc.plan_tratamiento), ('Pronóstico', str(hc.pronostico or ''))], cols=2),
    ]
    return _pdf(request, paciente, 'Historia clínica', hc.pk or '—', secciones, _firma_medico(medico),
                'Historia-clinica')


@require_GET
@login_required
def signos_vitales(request, patient_id, rec_id):
    paciente = _paciente(request, patient_id)
    sv = paciente and SignosVitales.objects.filter(pk=rec_id, paciente=paciente).select_related('created_by').first()
    if not sv:
        return _no_encontrado()
    medico = paciente.doctor_asignado or sv.created_by
    secciones = [
        campos(None, _datos_paciente(paciente, ('Médico', _nombre(medico)), ('Registró', _nombre(sv.created_by)),
                                     inicio=[('Fecha y hora', _fecha_hora(sv.created_at))])),
        vitales('Signos vitales', _ta(sv.sistolica, sv.diastolica), sv.fc, sv.fr, sv.temperatura, sv.saturacion,
                sv.peso, sv.talla, sv.superficie_corporal, sv.imc),
        texto('Observaciones', sv.comentarios, pre=True),
    ]
    return _pdf(request, paciente, 'Signos vitales', sv.pk, secciones, _firma_medico(medico), 'Signos-vitales')


def _secciones_valoracion(nota):
    filas = []
    patron = None
    for r in nota.respuestas.all():
        if r.patron != patron:
            patron = r.patron
            filas.append({'group': patron})
        filas.append([r.pregunta, r.get_respuesta_display(), r.detalle])
    usar_detalle = any(isinstance(f, list) and f[2] for f in filas)
    return [
        campos('Datos de ingreso', [
            ('Talla', _num(nota.talla_cm, '{:g} cm')), ('Peso', _num(nota.peso_kg, '{:g} kg')),
            ('Ciclo', nota.ciclo), ('Piso / suite', nota.piso_suite),
            ('Aislamiento', ETIQUETAS['aislamiento'].get(nota.aislamiento, '')),
            ('Modalidad de atención', nota.modalidad_atencion), ('Alergias', nota.alergias, 'wide')]),
        filas and {'kind': 'table', 'title': 'Valoración por patrones funcionales de salud (Marjory Gordon)',
                   'headers': [('Pregunta', '55%' if usar_detalle else '75%'), ('Respuesta', None)]
                              + ([('Detalle', None)] if usar_detalle else []),
                   'rows': [f if isinstance(f, dict) else (f if usar_detalle else f[:2]) for f in filas]},
    ]


def _secciones_registro(nota):
    e = ETIQUETAS
    tomas = [s for s in nota.signos.all() if s.pas or s.pad or s.fc or s.fr or s.temperatura or s.saturacion
             or s.peso or s.talla]
    secciones = [campos('Datos generales de ingreso', [
        ('Ciclo', nota.ciclo), ('Piso / suite', nota.piso_suite),
        ('Aislamiento', e['aislamiento'].get(nota.aislamiento, '')), ('Modalidad de atención', nota.modalidad_atencion),
        ('Alergias', nota.alergias),
        ('Estado de conciencia', e['conciencia'].get(nota.conciencia, ''))])]
    for s in tomas:
        detalle = ' · '.join(p for p in (
            s.get_tipo_display(), s.hora and f'Hora: {s.hora}',
            s.tipo == SignoVitalEnfermeria.NEWS and f'Consciencia: {s.get_conciencia_display()}',
            s.tipo == SignoVitalEnfermeria.NEWS and f'Puntaje NEWS: {s.news}') if p)
        secciones.append(vitales(f'Signos vitales — {detalle}', _ta(s.pas, s.pad), s.fc, s.fr, s.temperatura,
                                 s.saturacion, s.peso, s.talla))
    downton = [etiqueta for activo, etiqueta in (
        (nota.caidas_previas, 'Caídas previas'), (nota.sedantes, 'Sedantes'), (nota.diureticos, 'Diuréticos'),
        (nota.antihipertensivos, 'Antihipertensivos'), (nota.antiparkinsonianos, 'Antiparkinsonianos'),
        (nota.antidepresivos, 'Antidepresivos'), (nota.desorientado, 'Paciente desorientado'),
        (nota.deficit_visual, 'Déficit visual'), (nota.deficit_auditivo, 'Déficit auditivo'),
        (nota.deficit_extremidades, 'Déficit en extremidades'),
        (nota.marcha_segura_con_ayuda, 'Marcha segura con ayuda'),
        (nota.marcha_insegura, 'Marcha insegura con o sin ayuda'), (nota.marcha_imposible, 'Marcha imposible'))
        if activo]
    prevencion = [etiqueta for activo, etiqueta in (
        (nota.barandales, 'Barandales elevados'), (nota.freno, 'Freno de sillón / cama colocado'),
        (nota.brazalete_azul, 'Brazalete azul (alto riesgo)'), (nota.timbre, 'Timbre al alcance')) if activo]
    labs = [(n, v) for n, v in (('Hemoglobina (g/dL)', _num(nota.hemoglobina)), ('Leucocitos (/mm³)', _num(nota.leucocitos)),
                                ('Plaquetas (/mm³)', _num(nota.plaquetas)), ('Neutrófilos (/mm³)', _num(nota.neutrofilos)))
            if v]
    glasgow = [(n, v) for n, v in (('Respuesta motora', nota.glasgow_motor), ('Respuesta verbal', nota.glasgow_verbal),
                                   ('Respuesta ocular', nota.glasgow_ocular), ('Total', nota.glasgow_total)) if v]
    meds = [(m.medicamento, m.dosis, m.via, m.hora,
             ' / '.join(v for v in (m.doble_verificacion_1, m.doble_verificacion_2) if v))
            for m in nota.medicamentos.all()]
    secciones += [
        campos('Escalas de valoración clínica especializada', [
            ('Náuseas (0-5)', nota.nausea), ('Mucositis OMS (0-4)', nota.mucositis),
            ('Fatiga (10-2)', nota.fatiga), ('Neutropenia (0-4)', nota.neutropenia)], cols=4),
        labs and {'kind': 'table', 'title': 'Resultados de laboratorio recientes',
                  'headers': [(n, None) for n, _ in labs], 'rows': [[v for _, v in labs]]},
        glasgow and {'kind': 'table', 'title': 'Escala de Glasgow',
                     'headers': [(n, None) for n, _ in glasgow], 'rows': [[v for _, v in glasgow]]},
        campos('Escalas de valoración funcional (ECOG / Karnofsky / Downton)', [
            ('ECOG', _num(nota.ecog)), ('Karnofsky', _num(nota.karnofsky)), ('Downton', _num(nota.downton)),
            ('Factores de riesgo de caídas', ', '.join(downton), 'wide')]),
        campos('Valoración por aparatos y sistemas', [
            ('Estado anímico', e['animo'].get(nota.animo, '')), ('Sistema urinario', e['urinario'].get(nota.urinario, '')),
            ('Gastrointestinal', e['gastrointestinal'].get(nota.gastrointestinal, '')),
            ('Cardiorrespiratorio', e['cardiorrespiratorio'].get(nota.cardiorrespiratorio, '')),
            ('Piel y anexos', e['piel'].get(nota.piel, '')),
            ('Observaciones', nota.sistemas_observaciones, 'wide')], normal=True),
        campos('Valoración y seguimiento del dolor (escala EVA)', [
            ('Nivel de dolor (EVA 0-10)', str(nota.eva_nivel)),
            ('Características', e['eva_caracteristicas'].get(nota.eva_caracteristicas, '')),
            ('Localización', nota.eva_localizacion), ('Intervención', nota.eva_intervencion)], cols=2, normal=True),
        texto('Medidas de prevención de caídas aplicadas', ', '.join(prevencion)),
        tabla('Administración de medicamentos', ['Medicamento / solución', 'Dosis', 'Vía', 'Hora', 'Doble verificación'],
              meds, {0: '32%'}),
        texto('Medicamentos entregados al paciente al egreso', nota.medicamentos_egreso, pre=True),
        texto('Nota evolutiva de enfermería', nota.reporte, pre=True),
        campos('Personal responsable y egreso', [
            ('Enfermera responsable', nota.enfermera_1), ('Enfermera verificadora', nota.enfermera_2),
            ('Hora de egreso ambulatorio', nota.hora_egreso)]),
    ]
    return secciones


@require_GET
@login_required
def nota_enfermeria(request, patient_id, rec_id):
    """Evaluación Inicial o Registro Clínico, según el tipo de la nota (las
    dos rutas, print y clinical_print, llegan aquí)."""
    paciente = _paciente(request, patient_id)
    nota = paciente and (NotaEnfermeria.objects.filter(pk=rec_id, paciente=paciente).select_related('created_by')
                         .prefetch_related('respuestas', 'signos', 'medicamentos').first())
    if not nota:
        return _no_encontrado()
    inicial = nota.tipo == NotaEnfermeria.VALORACION_INICIAL
    secciones = [campos(None, _datos_paciente(
        paciente, ('Médico tratante', _nombre(paciente.doctor_asignado)),
        inicio=[('Fecha y hora', _fecha_hora(nota.created_at))]))]
    secciones += _secciones_valoracion(nota) if inicial else _secciones_registro(nota)
    titulo = 'Evaluación inicial de enfermería' if inicial else 'Registro clínico de enfermería'
    firma = {'caption': 'Firma del personal de enfermería', 'name': _nombre(nota.created_by)}
    return _pdf(request, paciente, titulo, nota.pk, secciones, firma,
                'Evaluacion-inicial' if inicial else 'Registro-clinico-enfermeria')


@require_GET
@login_required
def nota_oncologia(request, patient_id, rec_id):
    paciente = _paciente(request, patient_id)
    nota = paciente and (NotaOncologia.objects.filter(pk=rec_id, paciente=paciente)
                         .select_related('medico', 'created_by').first())
    if not nota:
        return _no_encontrado()
    medico = nota.medico or nota.created_by
    # Signos vitales: la toma más reciente hasta la fecha de la nota.
    vital = SignosVitales.objects.filter(paciente=paciente, created_at__lte=nota.created_at).order_by('-created_at').first()
    recetas = [(r.nombre, r.indicaciones, r.notas) for r in nota.recetas.all()]
    secciones = [
        campos(None, _datos_paciente(
            paciente, ('Sexo', paciente.get_genero_display()), ('Fecha y hora de ingreso', _fecha_hora(nota.fecha_ingreso)),
            ('Médico', _nombre(medico)), ('Ciclo', nota.ciclo), ('Alergias', nota.alergias),
            inicio=[('Fecha y hora de la nota', _fecha_hora(nota.created_at))])),
        vital and vitales(f'Signos vitales — {_fecha_hora(vital.created_at)}', _ta(vital.sistolica, vital.diastolica),
                          vital.fc, vital.fr, vital.temperatura, vital.saturacion, vital.peso, vital.talla,
                          vital.superficie_corporal, vital.imc),
        texto('Evolución, análisis y plan (SOAP)', nota.analisis),
        _diagnosticos('Diagnósticos', nota.diagnosticos.select_related('cie'), con_tipo=True),
        texto('Indicaciones', nota.indicaciones),
        tabla('Receta', ['Medicamento', 'Dosis e indicaciones', 'Notas'], recetas, {0: '32%'}),
    ]
    return _pdf(request, paciente, 'Nota de evolución oncológica', nota.pk, secciones, _firma_medico(medico),
                'Nota-oncologia')


def _alergias_y_diagnostico(doc):
    """De la nota de oncología de origen o, si no hay, de la Historia Clínica."""
    nota = doc.nota_oncologia
    hc = HistoriaClinica.objects.filter(paciente=doc.paciente).first()
    alergias = (nota and nota.alergias) or (hc and hc.alergias_obs) or ''
    lineas = list(nota.diagnosticos.select_related('cie')) if nota else []
    lineas = lineas or list(doc.paciente.diagnosticos.select_related('cie'))
    diagnostico = ', '.join(' · '.join(p for p in (d.cie.codigo if d.cie else '', d.cie.nombre if d.cie else d.diagnostico)
                                       if p) for d in lineas)
    return alergias, diagnostico


@require_GET
@login_required
def orden_medica(request, patient_id, rec_id):
    paciente = _paciente(request, patient_id)
    orden = paciente and (OrdenMedica.objects.filter(pk=rec_id, paciente=paciente)
                          .select_related('medico', 'created_by', 'nota_oncologia').first())
    if not orden:
        return _no_encontrado()
    medico = orden.medico or orden.created_by
    alergias, diagnostico = _alergias_y_diagnostico(orden)
    secciones = [
        campos(None, _datos_paciente(paciente, ('Médico prescriptor', _nombre(medico)), ('Alergias', alergias),
                                     ('Diagnóstico', diagnostico),
                                     inicio=[('Fecha y hora', _fecha_hora(orden.created_at))])),
        texto('Estudios e indicaciones', orden.observaciones),
    ]
    return _pdf(request, paciente, 'Orden médica', orden.pk, secciones, _firma_medico(medico), 'Orden-medica')


@require_GET
@login_required
def receta(request, patient_id, rec_id):
    """Receta Médica u Oncológica según su tipo (rutas print y onco_print)."""
    paciente = _paciente(request, patient_id)
    r = paciente and (Receta.objects.filter(pk=rec_id, paciente=paciente)
                      .select_related('medico', 'created_by', 'nota_oncologia').prefetch_related('lineas').first())
    if not r:
        return _no_encontrado()
    medico = r.medico or r.created_by
    alergias, diagnostico = _alergias_y_diagnostico(r)
    lineas = [(ln.medicamento, ln.indicaciones, ln.notas) for ln in r.lineas.all()]
    firma = _firma_medico(medico, 'Firma del médico prescriptor')
    if r.tipo != Receta.ONCOLOGICA:
        secciones = [
            campos(None, _datos_paciente(paciente, ('Médico prescriptor', _nombre(medico)),
                                         ('Alergias', alergias, 'wide'),
                                         inicio=[('Fecha y hora', _fecha_hora(r.created_at))])),
            tabla('Medicamentos prescritos', ['Medicamento', 'Dosis e indicaciones', 'Notas'], lineas, {0: '32%'}),
            texto('Notas y recomendaciones', r.notas),
        ]
        return _pdf(request, paciente, 'Receta médica', r.pk, secciones, firma, 'Receta-medica')
    secciones = [
        campos(None, _datos_paciente(paciente, ('Médico prescriptor', _nombre(medico)), ('Alergias', alergias),
                                     ('Diagnóstico', r.diagnostico_general or diagnostico),
                                     inicio=[('Fecha y hora', _fecha_hora(r.created_at))])),
        campos('Datos del tratamiento', [
            ('Número de ciclo', r.ciclo), ('Aplicación', r.dia_aplicacion),
            ('Próximo tratamiento', _fecha(r.proxima_aplicacion))]),
        vitales('Signos vitales', r.presion, r.fc, r.fr, r.temperatura, r.saturacion, r.peso, r.talla,
                r.superficie_corporal, r.imc),
        tabla('Tratamiento oncológico', ['Medicamento / esquema', 'Dosis e indicaciones', 'Notas'], lineas, {0: '40%'}),
        texto('Premedicación', r.premedicacion),
        texto('Postmedicación', r.postmedicacion),
        texto('Notas', r.notas),
    ]
    return _pdf(request, paciente, 'Receta oncológica', r.pk, secciones, firma, 'Receta-oncologica')
