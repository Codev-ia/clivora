"""Rutas de la Agenda que consume el frontend (app.js).

"ubicacion" y "sala" llegan como ids de Configuración → Lugares y salas; en la
respuesta van el nombre (ubicacion/sala) y el id (lugarId/salaId).
"""
import datetime
import json
import re
from html import escape, unescape

from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from apps.accounts.models import Especialidad, User
from apps.accounts.roles import ROLES
from apps.web.roles import has_role, is_admin
from apps.web.views import render_app_page
from apps.core.archivos import decodificar_data_url
from apps.core.clinica import active_clinica
from apps.core.html import limpiar as limpiar_html
from apps.core.models import Clinica, Lugar, Sala
from apps.pacientes.compat import visible_pacientes
from apps.pacientes.models import Paciente

from . import services
from .models import Cita, CitaArchivo, MotivoCita, MotivoRechazo

FRECUENCIA_LABEL_TO_KEY = {'Primera vez': 'primera_vez', 'Subsecuente': 'subsecuente', 'Urgente': 'urgente'}
FRECUENCIA_KEY_TO_LABEL = {v: k for k, v in FRECUENCIA_LABEL_TO_KEY.items()}
TIPO_LABEL = {'consulta': 'Consulta', 'tratamiento': 'Tratamiento'}


def _json(data, status=200):
    return JsonResponse(data, safe=False, status=status, json_dumps_params={'ensure_ascii': False})


def _body(request):
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        return {}


def _nombre(user):
    return (user.get_full_name() or user.username) if user else ''


def _tipo_key(value):
    return 'consulta' if (value or '').strip().lower().startswith('consulta') else 'tratamiento'


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ── permisos (mismas reglas que /api/me y app.js) ─────────────────────────
def _puede_escribir(user, tipo):
    if is_admin(user) or has_role(user, 'group_jefa_enfermeria'):
        return True
    editores = ['group_enfermeria', 'group_recepcion', 'group_jefe_recepcion', 'group_cita_coordinacion',
                'group_medico_externo']
    if not any(has_role(user, r) for r in editores):
        return False  # Médicos "puros": Agenda en solo lectura
    solo_recepcion = (has_role(user, 'group_recepcion') or has_role(user, 'group_jefe_recepcion')) and not any(
        has_role(user, r) for r in ['group_enfermeria', 'group_cita_coordinacion'])
    if solo_recepcion and tipo == 'tratamiento':
        return False  # Recepción solo agenda Consultas
    return True


def _citas_visibles(request):
    qs = Cita.objects.filter(clinica=active_clinica(request))
    user = request.user
    if has_role(user, 'group_medico_externo') and not is_admin(user) and not has_role(user, 'group_medicos'):
        qs = qs.filter(paciente__doctor_asignado=user)
    return qs.select_related('motivo', 'paciente', 'doctor', 'enfermera', 'lugar', 'sala', 'motivo_rechazo',
                             'rechazada_por', 'created_by', 'check_in_by', 'check_out_by')


# ── serialización ─────────────────────────────────────────────────────────
def _nota_texto(html):
    text = re.sub(r'</p>|</div>|</li>|<br\s*/?>', '\n', html or '', flags=re.IGNORECASE)
    text = unescape(re.sub(r'<[^>]+>', '', text)).strip()
    return re.sub(r'\n{2,}', '\n', text)


def serialize(c):
    ini, fin = timezone.localtime(c.inicio), timezone.localtime(c.fin)
    fmt = lambda dt: timezone.localtime(dt).strftime('%Y-%m-%d %H:%M') if dt else ''
    return {
        'id': c.pk, 'tipo': TIPO_LABEL[c.tipo], 'tipoId': c.tipo,
        'motivo': c.motivo.name if c.motivo_id else '', 'motivoId': c.motivo_id or False,
        'pacienteId': c.paciente_id or False,
        'paciente': c.paciente.nombre_completo if c.paciente_id else '',
        'pacienteExp': c.paciente.expediente if c.paciente_id else '',
        'doctorId': c.doctor_id or False, 'doctor': _nombre(c.doctor),
        'nurseId': c.enfermera_id or False, 'nurse': _nombre(c.enfermera),
        'ubicacion': c.lugar.name if c.lugar_id else '', 'lugarId': c.lugar_id or False,
        'sala': c.sala.name if c.sala_id else '', 'salaId': c.sala_id or False,
        'ciclo': c.ciclo, 'frecuencia': FRECUENCIA_KEY_TO_LABEL.get(c.frecuencia, ''),
        'fecha': ini.strftime('%Y-%m-%d'), 'hora': ini.strftime('%H:%M'),
        'fechaFin': fin.strftime('%Y-%m-%d'), 'horaFin': fin.strftime('%H:%M'),
        'nota': c.nota, 'notaTexto': _nota_texto(c.nota),
        'createdAt': fmt(c.created_at), 'createdBy': _nombre(c.created_by),
        'estado': c.estado,
        'solicitanteNombre': c.solicitante_nombre, 'solicitanteTelefono': c.solicitante_telefono,
        'solicitanteExpediente': c.solicitante_expediente, 'solicitanteRfc': c.solicitante_rfc,
        'rejectionReasonId': c.motivo_rechazo_id or False,
        'rejectionReason': c.motivo_rechazo.name if c.motivo_rechazo_id else '',
        'rejectionDate': c.rechazada_el.isoformat() if c.rechazada_el else '',
        'rejectedBy': _nombre(c.rechazada_por),
        'checkIn': bool(c.check_in_at), 'checkInAt': fmt(c.check_in_at), 'checkInBy': _nombre(c.check_in_by),
        'checkOut': bool(c.check_out_at), 'checkOutAt': fmt(c.check_out_at), 'checkOutBy': _nombre(c.check_out_by),
        'saleOrders': [],  # ventas: fuera de alcance por ahora
        'aplicacion': {'modo': 'manual', 'estado': c.estado_aplicacion, 'traslados': []},
        'stockAplicacion': c.stock_aplicacion,
        'anotacionesEnfermeria': c.anotaciones_enfermeria,
        'esquemaTratamiento': c.esquema_tratamiento,
    }


# ── payload → cita ────────────────────────────────────────────────────────
class PayloadError(Exception):
    def __init__(self, code, message='', status=400):
        super().__init__(message or code)
        self.code, self.message, self.status = code, message, status


def _aware(fecha, hora):
    try:
        naive = datetime.datetime.strptime(f'{fecha} {hora}', '%Y-%m-%d %H:%M')
    except (TypeError, ValueError):
        return None
    return timezone.make_aware(naive)


def _aplicar_payload(cita, payload, user, clinica, publico=False):
    tipo = _tipo_key(payload.get('tipo'))
    cita.tipo = tipo
    cita.clinica = clinica
    inicio = _aware(payload.get('fecha'), payload.get('hora') or '09:00')
    if not inicio:
        raise PayloadError('missing_fecha_hora')
    fin = _aware(payload.get('fechaFin'), payload.get('horaFin')) if payload.get('horaFin') else None
    cita.inicio = inicio
    cita.fin = fin if fin and fin > inicio else inicio + datetime.timedelta(hours=1)

    cita.motivo = MotivoCita.objects.filter(name=payload.get('motivo'), tipo=tipo).first()
    doctor_id = _int(payload.get('doctorId'))
    cita.doctor = User.objects.filter(pk=doctor_id).first() if doctor_id else None
    if not publico:
        nurse_id = _int(payload.get('nurseId'))
        cita.enfermera = User.objects.filter(pk=nurse_id).first() if nurse_id else None

    lugar_id, sala_id = _int(payload.get('ubicacion')), _int(payload.get('sala'))
    cita.lugar = Lugar.objects.filter(pk=lugar_id, clinica=clinica).first() if lugar_id else None
    cita.sala = Sala.objects.filter(pk=sala_id, lugar=cita.lugar).first() if sala_id and cita.lugar else None

    es_trat = tipo == 'tratamiento'
    cita.ciclo = (payload.get('ciclo') or '')[:60] if es_trat else ''
    cita.frecuencia = FRECUENCIA_LABEL_TO_KEY.get(payload.get('frecuencia'), '') if es_trat else ''
    if not publico:
        cita.nota = payload.get('nota') or ''
        cita.estado = payload.get('estado') or Cita.PENDIENTE
    enfermeria = has_role(user, 'group_enfermeria') or has_role(user, 'group_jefa_enfermeria')
    if 'anotacionesEnfermeria' in payload and enfermeria:
        cita.anotaciones_enfermeria = limpiar_html(payload.get('anotacionesEnfermeria'))
    if 'esquemaTratamiento' in payload and enfermeria:
        cita.esquema_tratamiento = (payload.get('esquemaTratamiento') or '').strip() if es_trat else ''
    if not es_trat:
        cita.estado_aplicacion, cita.stock_aplicacion = '', False
    else:
        if 'aplicacionEstado' in payload:
            value = payload.get('aplicacionEstado') or ''
            cita.estado_aplicacion = value if value in ('solicitado', 'preparacion', 'listo') else ''
        if 'stockAplicacion' in payload and has_role(user, 'group_farmacia'):
            cita.stock_aplicacion = bool(payload.get('stockAplicacion'))
    rechazo_id = _int(payload.get('rejectionReasonId'))
    if rechazo_id:
        cita.motivo_rechazo = MotivoRechazo.objects.filter(pk=rechazo_id).first()

    paciente_id = _int(payload.get('pacienteId'))
    if not publico:
        if paciente_id:
            paciente = visible_pacientes(user).filter(pk=paciente_id).first()
            if paciente is None:
                raise PayloadError('forbidden', 'No tienes acceso a ese paciente.', status=403)
            cita.paciente = paciente
        else:
            cita.paciente = None


def _error_response(exc):
    if isinstance(exc, PayloadError):
        return _json({'error': exc.code, 'message': exc.message}, status=exc.status)
    message = ' '.join(exc.messages)
    code = 'sala_ocupada' if isinstance(exc, services.SalaOcupada) else 'invalid_transition'
    if message in ('not_aprobado', 'not_checked_in', 'invalid_tipo'):
        code = message
    return _json({'error': code, 'message': message}, status=400)


# ── vistas ────────────────────────────────────────────────────────────────
@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
def citas(request):
    if request.method == 'GET':
        return _json([serialize(c) for c in _citas_visibles(request).order_by('-inicio')])
    if request.method != 'POST':
        return _json({'error': 'method_not_allowed'}, status=405)
    clinica = active_clinica(request)
    if clinica is None:
        return _json({'error': 'sin_clinica', 'message': 'Da de alta una clínica primero.'}, status=400)
    payload = _body(request)
    if not _puede_escribir(request.user, _tipo_key(payload.get('tipo'))):
        return _json({'error': 'forbidden', 'message': 'Tu rol no puede agendar este tipo de cita.'}, status=403)
    cita = Cita(created_by=request.user)
    try:
        _aplicar_payload(cita, payload, request.user, clinica)
        cita.estado = Cita.PENDIENTE  # toda cita nueva nace pendiente
        services.guardar(cita, request.user, estado_anterior=None)
    except (PayloadError, ValidationError) as exc:
        return _error_response(exc)
    return _json(serialize(cita))


@csrf_exempt
@login_required
def cita_detalle(request, cita_id):
    cita = get_object_or_404(_citas_visibles(request), pk=cita_id)
    if request.method == 'GET':
        return _json(serialize(cita))
    if request.method != 'POST':
        return _json({'error': 'method_not_allowed'}, status=405)
    if cita.estado == Cita.RECHAZADO:
        return _json({'error': 'cita_rechazada'}, status=400)
    payload = _body(request)
    if not _puede_escribir(request.user, _tipo_key(payload.get('tipo') or cita.tipo)):
        return _json({'error': 'forbidden', 'message': 'Tu rol no puede modificar esta cita.'}, status=403)
    anterior = cita.estado
    try:
        _aplicar_payload(cita, payload, request.user, cita.clinica)
        services.guardar(cita, request.user, estado_anterior=anterior)
    except (PayloadError, ValidationError) as exc:
        return _error_response(exc)
    return _json(serialize(cita))


@csrf_exempt
@login_required
@require_POST
def cita_borrar(request, cita_id):
    cita = _citas_visibles(request).filter(pk=cita_id).first()
    if cita:
        if not _puede_escribir(request.user, cita.tipo):
            return _json({'error': 'forbidden'}, status=403)
        cita.delete()
    return _json({'ok': True})


@csrf_exempt
@login_required
@require_POST
def cita_check(request, cita_id):
    cita = get_object_or_404(_citas_visibles(request), pk=cita_id)
    if not _puede_escribir(request.user, cita.tipo):
        return _json({'error': 'forbidden'}, status=403)
    try:
        cita = services.check(cita, _body(request).get('tipo'), request.user)
    except ValidationError as exc:
        return _error_response(exc)
    return _json(serialize(_citas_visibles(request).get(pk=cita.pk)))


def _usuarios_con(*role_keys):
    names = [ROLES[k] for k in role_keys]
    return User.objects.filter(is_active=True, groups__name__in=names).distinct()


def _lugares_payload(clinica):
    if clinica is None:
        return []
    return [{
        'id': l.pk, 'name': l.name,
        'salas': [{'id': s.pk, 'name': s.name, 'tipo': s.tipo} for s in l.salas.all() if s.active],
    } for l in Lugar.objects.filter(clinica=clinica, active=True).prefetch_related('salas')]


@require_GET
@login_required
def catalogos(request):
    return _json({
        'aplicacionModo': 'manual',
        'types': [{'id': k, 'name': v} for k, v in TIPO_LABEL.items()],
        'reasons': [{'id': m.pk, 'name': m.name, 'type': 'C' if m.tipo == 'consulta' else 'T'}
                    for m in MotivoCita.objects.filter(active=True)],
        'doctors': [{'id': u.pk, 'name': _nombre(u),
                     'specialtyId': getattr(getattr(u, 'perfil_medico', None), 'especialidad_id', None) or False}
                    for u in _usuarios_con('group_medicos').select_related('perfil_medico')],
        'nurses': [{'id': u.pk, 'name': _nombre(u)}
                   for u in _usuarios_con('group_enfermeria', 'group_jefa_enfermeria')],
        'rejectionReasons': [{'id': r.pk, 'name': r.name} for r in MotivoRechazo.objects.filter(active=True)],
        'specialties': [{'id': e.pk, 'name': e.name} for e in Especialidad.objects.filter(active=True)],
        # Nuevo: lugares y salas de la clínica activa (Configuración).
        'lugares': _lugares_payload(active_clinica(request)),
    })


# ── archivos de la cita ───────────────────────────────────────────────────
def _serialize_archivo(a):
    return {'id': a.pk, 'name': a.nombre, 'mimetype': a.mimetype, 'fileSize': a.tamano,
            'createDate': a.created_at.isoformat(), 'fileUrl': f'/clivora/cita_files/{a.pk}'}


@csrf_exempt
@login_required
def cita_archivos(request, cita_id):
    cita = get_object_or_404(_citas_visibles(request), pk=cita_id)
    if request.method == 'GET':
        return _json([_serialize_archivo(a) for a in cita.archivos.all()])
    if request.method != 'POST':
        return _json({'error': 'method_not_allowed'}, status=405)
    files = _body(request).get('files') or []
    disponibles = max(0, CitaArchivo.MAX_POR_CITA - cita.archivos.count())
    if disponibles <= 0:
        return _json({'error': 'max_files_reached', 'max': CitaArchivo.MAX_POR_CITA}, status=400)
    creados = []
    for f in files[:disponibles]:
        mimetype, content = decodificar_data_url(f.get('dataUrl'))
        if content is None:
            continue
        nombre = (f.get('name') or 'archivo')[:255]
        archivo = CitaArchivo(cita=cita, nombre=nombre, mimetype=mimetype, tamano=len(content),
                              created_by=request.user)
        archivo.archivo.save(nombre, ContentFile(content), save=True)
        creados.append(_serialize_archivo(archivo))
    return _json({'created': creados, 'skipped': max(0, len(files) - disponibles)})


@csrf_exempt
@login_required
@require_POST
def cita_archivo_borrar(request, archivo_id):
    CitaArchivo.objects.filter(pk=archivo_id, cita__in=_citas_visibles(request)).delete()
    return _json({'ok': True})


@xframe_options_sameorigin  # vista previa en un iframe de la misma app
@require_GET
@login_required
def cita_archivo_descargar(request, archivo_id):
    """Los archivos de pacientes nunca se sirven directo: pasan por aquí, que
    revisa sesión y clínica."""
    archivo = CitaArchivo.objects.filter(pk=archivo_id, cita__in=_citas_visibles(request)).first()
    if archivo is None:
        raise Http404
    return FileResponse(archivo.archivo.open('rb'), filename=archivo.nombre, as_attachment=False,
                        content_type=archivo.mimetype or None)


# ── Tratamientos (lista y Kanban) ─────────────────────────────────────────
@require_GET
@login_required
def tratamientos(request):
    data = []
    for c in _citas_visibles(request).filter(tipo='tratamiento').order_by('-inicio'):
        data.append({
            'id': c.pk, 'pacienteId': c.paciente_id or False,
            'paciente': c.paciente.nombre_completo if c.paciente_id else c.solicitante_nombre,
            'doctor': _nombre(c.doctor),
            'fechaInicio': timezone.localtime(c.inicio).strftime('%Y-%m-%d %H:%M'),
            'fechaFin': timezone.localtime(c.fin).strftime('%Y-%m-%d %H:%M'),
            'sala': c.sala.name if c.sala_id else (c.lugar.name if c.lugar_id else ''),
            'ubicacion': c.lugar.name if c.lugar_id else '',
            'motivo': c.motivo.name if c.motivo_id else '', 'estado': c.estado,
            'checkIn': bool(c.check_in_at), 'medicamentoPreparado': False, 'validadoPor': '',
            'esquema': c.esquema_tratamiento, 'treatmentId': False, 'treatmentName': '',
            'saleOrderId': False, 'saleOrderName': '',
            'aplicacionEstado': c.estado_aplicacion, 'stockAplicacion': c.stock_aplicacion,
        })
    return _json(data)


@require_GET
@login_required
def actividad_pacientes(request):
    """Tarjetas de "Actividad clínica del mes" del Inicio: pacientes (visibles
    para el usuario) con al menos un registro de cada tipo este mes. Los
    protocolos llegan con su fase del expediente."""
    from apps.expediente.models import NotaEnfermeria, NotaOncologia, SignosVitales

    inicio_mes = timezone.localtime().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    visibles = visible_pacientes(request.user)

    def pacientes_con(Model):
        return sorted(set(Model.objects.filter(created_at__gte=inicio_mes, paciente__in=visibles)
                          .values_list('paciente_id', flat=True)))

    return _json({'oncologyPatientIds': pacientes_con(NotaOncologia),
                  'vitalsPatientIds': pacientes_con(SignosVitales),
                  'nursingPatientIds': pacientes_con(NotaEnfermeria), 'protocolPatientIds': []})


# ── Auto-agendado público (sin login) ─────────────────────────────────────
def _clinica_publica(request):
    """Clínica del enlace público (/clivora/agendar?clinica=<id>), que se
    recuerda en la sesión del visitante; sin ella, la primera clínica activa."""
    clinica_id = _int(request.GET.get('clinica')) or _int(request.session.get('clinica_publica'))
    qs = Clinica.objects.filter(active=True)
    return (qs.filter(pk=clinica_id).first() if clinica_id else None) or qs.first()


def agendar_publico(request):
    clinica = _clinica_publica(request)
    if clinica:
        request.session['clinica_publica'] = clinica.pk
    return render_app_page('public_booking.html', ['assets/css/styles.css', 'assets/css/clivora-theme.css', 'assets/js/public_booking.js'])


@require_GET
def catalogos_publicos(request):
    return _json({
        'types': [{'id': k, 'name': v} for k, v in TIPO_LABEL.items()],
        'reasons': [{'id': m.pk, 'name': m.name, 'type': 'C' if m.tipo == 'consulta' else 'T'}
                    for m in MotivoCita.objects.filter(active=True)],
        'doctors': [{'id': u.pk, 'name': _nombre(u)} for u in _usuarios_con('group_medicos')],
    })


@csrf_exempt
@require_POST
def crear_cita_publica(request):
    payload = _body(request)
    if (payload.get('website') or '').strip():  # campo trampa para bots
        return _json({'ok': True, 'linked': False, 'trackingToken': ''})
    nombre = (payload.get('nombre') or '').strip()[:120]
    if not nombre:
        return _json({'error': 'missing_nombre'}, status=400)
    ip = request.META.get('REMOTE_ADDR') or None
    if ip and Cita.objects.filter(solicitante_ip=ip,
                                  created_at__gte=timezone.now() - datetime.timedelta(hours=1)).count() >= 5:
        return _json({'error': 'too_many_requests'}, status=429)
    clinica = _clinica_publica(request)
    if clinica is None:
        return _json({'error': 'sin_clinica'}, status=400)
    cita = Cita(estado=Cita.PENDIENTE, solicitante_nombre=nombre, solicitante_ip=ip,
                solicitante_telefono=(payload.get('telefono') or '').strip()[:60],
                solicitante_expediente=(payload.get('expediente') or '').strip()[:60],
                solicitante_rfc=(payload.get('rfc') or '').strip()[:60])
    try:
        _aplicar_payload(cita, payload, request.user, clinica, publico=True)
    except PayloadError as exc:
        return _error_response(exc)
    # Liga al paciente si dio un expediente o RFC que ya existe.
    paciente = None
    if cita.solicitante_expediente:
        paciente = Paciente.objects.filter(expediente=cita.solicitante_expediente, active=True).first()
    if not paciente and cita.solicitante_rfc:
        paciente = Paciente.objects.filter(rfc=cita.solicitante_rfc.upper(), active=True).first()
    cita.paciente = paciente
    try:
        services.guardar(cita, None, estado_anterior=None)
    except ValidationError:
        return _json({'error': 'doctor_no_disponible'}, status=400)
    return _json({'ok': True, 'linked': bool(paciente), 'trackingToken': cita.token_seguimiento})


ESTADO_PUBLICO = {
    'nuevo': ('Recibida — en revisión', '#2563eb'), 'pendiente': ('Pendiente de revisión', '#f97316'),
    'desfasado': ('Desfasada', '#db2777'), 'aprobado': ('Confirmada', '#10b981'),
    'rechazado': ('No confirmada', '#ef4444'), 'en_progreso': ('En progreso', '#8b5cf6'),
    'finalizado': ('Finalizada', '#64748b'),
}


def estado_publico(request, token):
    cita = Cita.objects.filter(token_seguimiento=token).select_related('motivo_rechazo', 'clinica').first()
    if cita is None:
        return HttpResponse('<html><body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">'
                            '<h2>Solicitud no encontrada</h2><p>Verifica el link que recibiste al agendar.</p>'
                            '</body></html>', status=404)
    label, color = ESTADO_PUBLICO.get(cita.estado, (cita.estado, '#64748b'))
    rechazo = (f'<p><strong>Motivo:</strong> {escape(cita.motivo_rechazo.name)}</p>'
               if cita.estado == Cita.RECHAZADO and cita.motivo_rechazo_id else '')
    html = f'''<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Estado de tu solicitud</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<style>body{{font-family:'Plus Jakarta Sans',sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#0F172A;}}
.card{{border:1px solid #E2E8F0;border-radius:16px;padding:28px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.03);}}
.badge{{display:inline-block;padding:6px 14px;border-radius:9999px;font-weight:700;font-size:13px;color:#fff;}}</style></head><body>
<h2>Estado de tu solicitud de cita</h2>
<div class="card">
<span class="badge" style="background:{color};">{label}</span>
<p style="margin-top:16px;"><strong>Fecha solicitada:</strong> {timezone.localtime(cita.inicio):%d/%m/%Y %H:%M}</p>
<p><strong>Tipo:</strong> {TIPO_LABEL[cita.tipo]}</p>
<p><strong>Clínica:</strong> {escape(cita.clinica.name)}</p>
{rechazo}
</div></body></html>'''
    return HttpResponse(html)
