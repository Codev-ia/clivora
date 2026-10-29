"""Rutas de pacientes que consume el frontend (app.js)."""
import difflib
import json
import re

from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db.models import Q
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from rest_framework.exceptions import ValidationError as DRFValidationError

from apps.accounts.medicos import resumen as resumen_medico
from apps.accounts.models import Especialidad, User
from apps.accounts.roles import ROLES
from apps.web.roles import has_role, is_admin
from apps.core.clinica import active_clinica
from apps.core.logos import procesar_imagen
from apps.precios.models import Pricelist

from .catalogos import (ESTADO_CIVIL_KEY_TO_LABEL, ESTADO_CIVIL_LABEL_TO_KEY, GENERO_KEY_TO_LABEL,
                        GENERO_LABEL_TO_KEY, REGIMEN_CODES, REGIMENES_FISCALES)
from .models import OrigenReferencia, Paciente


def _json(data, status=200):
    return JsonResponse(data, safe=False, status=status, json_dumps_params={'ensure_ascii': False})


def _body(request):
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        return {}


def _text(payload, key, limit=None):
    value = (payload.get(key) or '')
    value = value.strip() if isinstance(value, str) else str(value)
    return value[:limit] if limit else value


def visible_pacientes(user):
    """Médico Externo (sin ser administrador): solo sus pacientes asignados
    y los que le compartieron (pestaña Compartir)."""
    qs = Paciente.objects.filter(active=True)
    if has_role(user, 'group_medico_externo') and not is_admin(user) and not has_role(user, 'group_medicos'):
        qs = qs.filter(Q(doctor_asignado=user) | Q(compartidos__medico=user)).distinct()
    return qs


def _doctor_by_name(name):
    name = (name or '').strip()
    if not name:
        return None
    for user in User.objects.filter(groups__name__in=[ROLES['group_medicos'], ROLES['group_medico_externo']]).distinct():
        if (user.get_full_name() or user.username).strip().lower() == name.lower():
            return user
    return None


def _apply_info_general(paciente, payload, partial=False):
    """Campos de "Información General" (alta y edición)."""
    simple = {
        'nombres': ('nombres', 150), 'primer_apellido': ('primerApellido', 100),
        'segundo_apellido': ('segundoApellido', 100), 'ocupacion': ('ocupacion', 120), 'curp': ('curp', 18),
        'email': ('email', 254), 'celular': ('celular', 30), 'telefono': ('telefono', 30),
        'tutor_legal': ('tutorLegal', 200), 'religion': ('religion', 80),
    }
    for field, (key, limit) in simple.items():
        if not partial or key in payload:
            setattr(paciente, field, _text(payload, key, limit))
    if not partial or 'fechaNacimiento' in payload:
        paciente.fecha_nacimiento = payload.get('fechaNacimiento') or None
    if 'genero' in payload:
        paciente.genero = GENERO_LABEL_TO_KEY.get(payload.get('genero'), paciente.genero)
    if 'estadoCivil' in payload:
        paciente.estado_civil = ESTADO_CIVIL_LABEL_TO_KEY.get(payload.get('estadoCivil'), paciente.estado_civil)
    if 'origenReferencia' in payload:
        paciente.origen_referencia = OrigenReferencia.objects.filter(name=payload.get('origenReferencia')).first()
    if 'medicoReferencia' in payload:
        paciente.medico_referencia = _text(payload, 'medicoReferencia', 200)
    if 'doctor' in payload:
        paciente.doctor_asignado = _doctor_by_name(payload.get('doctor'))


def _apply_domicilio(paciente, payload):
    for field, key in {'pais': 'pais', 'estado': 'estado', 'ciudad': 'ciudad', 'colonia': 'colonia',
                       'codigo_postal': 'codigoPostal', 'calle': 'calle', 'numero': 'numeroCasa'}.items():
        setattr(paciente, field, _text(payload, key, Paciente._meta.get_field(field).max_length))
    fiscal = payload.get('fiscal')
    if isinstance(fiscal, dict):
        for field, key in {'fiscal_pais': 'pais', 'fiscal_estado': 'estado', 'fiscal_ciudad': 'ciudad',
                           'fiscal_colonia': 'colonia', 'fiscal_codigo_postal': 'codigoPostal',
                           'fiscal_calle': 'calle', 'fiscal_numero': 'numeroCasa'}.items():
            if key in fiscal:
                setattr(paciente, field, _text(fiscal, key, Paciente._meta.get_field(field).max_length))
        # Lugar del domicilio fiscal en la factura (CFDI 4.0): 5 dígitos.
        if paciente.fiscal_codigo_postal and not re.fullmatch(r'\d{5}', paciente.fiscal_codigo_postal):
            raise ValidationError('El código postal fiscal debe tener 5 dígitos.')


def _apply_facturacion(paciente, payload):
    if 'rfc' in payload:
        paciente.rfc = _text(payload, 'rfc', 13)
    if 'regimenFiscal' in payload:
        code = payload.get('regimenFiscal') or ''
        paciente.regimen_fiscal = code if code in REGIMEN_CODES else ''
    if 'listaPreciosId' in payload:
        pl_id = payload.get('listaPreciosId')
        paciente.lista_precios = Pricelist.objects.filter(pk=pl_id).first() if pl_id else None


def _list_item(p):
    doctor = p.doctor_asignado
    return {
        'id': p.pk, 'name': p.nombre_completo, 'exp': p.expediente, 'email': p.email,
        'createDate': p.created_at.isoformat(), 'doctorId': doctor.pk if doctor else False,
        'doctorName': (doctor.get_full_name() or doctor.username) if doctor else '',
        'doctorSpecialty': '', 'doctorSpecialtyId': False,
    }


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_http_methods(['GET', 'POST'])
def patients(request):
    if request.method == 'GET':
        qs = visible_pacientes(request.user).select_related('doctor_asignado')
        return _json([_list_item(p) for p in qs])
    payload = _body(request)
    nombres, primer = _text(payload, 'nombres'), _text(payload, 'primerApellido')
    # El grupo Comercial puede guardar sin los obligatorios (igual que en Clivora).
    if (not nombres or not primer) and not has_role(request.user, 'group_comercial'):
        return _json({'error': 'missing_required_fields'}, status=400)
    paciente = Paciente(created_by=request.user, clinica_registro=active_clinica(request),
                        acepta_terminos=bool(payload.get('terminosCondiciones')))
    _apply_info_general(paciente, payload)
    paciente.genero = GENERO_LABEL_TO_KEY.get(payload.get('genero'), '')
    paciente.estado_civil = ESTADO_CIVIL_LABEL_TO_KEY.get(payload.get('estadoCivil'), '')
    _apply_domicilio(paciente, payload)
    _apply_facturacion(paciente, payload)
    if not paciente.nombres:
        paciente.nombres = 'SIN NOMBRE'
    paciente.save()
    return _json({'id': paciente.pk, 'name': paciente.nombre_completo, 'exp': paciente.expediente})


@require_GET
@login_required
def check_similar(request):
    """Posibles duplicados al dar de alta: nombre/apellido parecidos (≥80%),
    mismo celular o mismo RFC."""
    g = request.GET
    nombres = (g.get('nombres') or '').strip().lower()
    apellido = ' '.join(x for x in [(g.get('primerApellido') or '').strip(),
                                    (g.get('segundoApellido') or '').strip()] if x).lower()
    celular, rfc = (g.get('celular') or '').strip(), (g.get('rfc') or '').strip().upper()
    if not (nombres or apellido or celular or rfc):
        return _json([])
    results = []
    for p in visible_pacientes(request.user).only('id', 'nombres', 'primer_apellido', 'segundo_apellido',
                                                   'nombre_completo', 'expediente', 'celular', 'rfc'):
        reasons = []
        name_sim = difflib.SequenceMatcher(None, nombres, p.nombres.lower()).ratio() if nombres else 0
        existing = ' '.join(x for x in [p.primer_apellido, p.segundo_apellido] if x).lower()
        ape_sim = difflib.SequenceMatcher(None, apellido, existing).ratio() if apellido and existing else 0
        if name_sim >= 0.8:
            reasons.append('Nombre similar (%d%%)' % round(name_sim * 100))
            if ape_sim >= 0.8:
                reasons.append('Apellido similar (%d%%)' % round(ape_sim * 100))
        if celular and p.celular and celular == p.celular.strip():
            reasons.append('Mismo celular')
        if rfc and p.rfc and rfc == p.rfc:
            reasons.append('Mismo RFC')
        if reasons:
            exact = any(r in ('Mismo celular', 'Mismo RFC') for r in reasons)
            results.append({'id': p.pk, 'name': p.nombre_completo, 'exp': p.expediente, 'reasons': reasons,
                            'similarity': 100 if exact else round(max(name_sim, ape_sim) * 100)})
    results.sort(key=lambda r: r['similarity'], reverse=True)
    return _json(results[:5])


def _get_paciente(request, patient_id):
    return get_object_or_404(visible_pacientes(request.user), pk=patient_id)


@require_GET
@login_required
def patient_detail(request, patient_id):
    from apps.expediente.compat import serializar_historia  # expediente importa este módulo

    p = _get_paciente(request, patient_id)
    doctor = p.doctor_asignado
    domicilio_fiscal = {
        'pais': p.fiscal_pais, 'estado': p.fiscal_estado, 'ciudad': p.fiscal_ciudad, 'colonia': p.fiscal_colonia,
        'codigoPostal': p.fiscal_codigo_postal, 'calle': p.fiscal_calle, 'numeroCasa': p.fiscal_numero,
    }
    return _json({
        'id': p.pk, 'name': p.nombre_completo, 'exp': p.expediente, 'photoUrl': foto_url(p),
        'info_general': {
            'primerApellido': p.primer_apellido, 'segundoApellido': p.segundo_apellido, 'nombres': p.nombres,
            'fechaNacimiento': p.fecha_nacimiento.isoformat() if p.fecha_nacimiento else '',
            'edad': p.edad if p.edad is not None else '',
            'genero': GENERO_KEY_TO_LABEL.get(p.genero, ''), 'ocupacion': p.ocupacion,
            'estadoCivil': ESTADO_CIVIL_KEY_TO_LABEL.get(p.estado_civil, ''),
            'origenReferencia': p.origen_referencia.name if p.origen_referencia else '',
            'medicoReferencia': p.medico_referencia, 'curp': p.curp,
            'email': p.email, 'celular': p.celular, 'telefono': p.telefono,
            'doctorId': doctor.pk if doctor else False,
            'doctorName': (doctor.get_full_name() or doctor.username) if doctor else '',
            'doctorSpecialty': resumen_medico(doctor)['especialidad'],
            'doctorSpecialtyId': resumen_medico(doctor)['especialidad_id'] or False,
            'doctorPartnerId': doctor.pk if doctor else False,
            'tutorLegal': p.tutor_legal,
        },
        'domicilio_personal': {
            'pais': p.pais, 'estado': p.estado, 'ciudad': p.ciudad, 'colonia': p.colonia,
            'codigoPostal': p.codigo_postal, 'calle': p.calle, 'numeroCasa': p.numero,
        },
        'facturacion': {
            'listaPreciosId': p.lista_precios_id or False,
            'listaPrecios': p.lista_precios.name if p.lista_precios else '',
            'rfc': p.rfc, 'regimenFiscal': p.regimen_fiscal,
        },
        'domicilio_fiscal': dict(domicilio_fiscal, rfc=p.rfc),
        'historia_clinica': serializar_historia(p),
    })


def foto_url(p):
    # ?v=: la URL cambia al cambiar la foto (el navegador no usa una vieja).
    return f'/clivora/patient_photo/{p.pk}?v={int(p.updated_at.timestamp())}' if p.foto else ''


@csrf_exempt
@login_required
@require_POST
def foto_guardar(request, patient_id):
    """Foto del paciente (botón de cámara de la ficha): PNG de máximo 512 px."""
    p = _get_paciente(request, patient_id)
    try:
        contenido = procesar_imagen(_body(request).get('photo'), campo='photo', nombre='La foto',
                                    max_bytes=10 * 1024 * 1024, max_lado=512)
    except DRFValidationError as exc:
        return _json({'error': 'invalid_image', 'message': exc.detail['photo']}, status=400)
    anterior = p.foto.name if p.foto else ''
    p.foto.save(f'paciente-{p.pk}.png', contenido, save=False)
    p.save()
    if anterior and anterior != p.foto.name:
        p.foto.storage.delete(anterior)
    return _json({'ok': True, 'photoUrl': foto_url(p)})


@require_GET
@login_required
def foto(request, patient_id):
    """La foto es un dato del paciente: solo la ve quien puede ver al paciente."""
    p = visible_pacientes(request.user).filter(pk=patient_id).first()
    if not p or not p.foto:
        raise Http404
    response = FileResponse(p.foto.open('rb'), content_type='image/png')
    response['Cache-Control'] = 'private, max-age=86400'
    return response


def _save_section(apply):
    @csrf_exempt
    @login_required
    @require_POST
    def view(request, patient_id):
        p = _get_paciente(request, patient_id)
        try:
            apply(p, _body(request))
        except ValidationError as exc:
            return _json({'error': 'invalid', 'message': ' '.join(exc.messages)}, status=400)
        p.save()
        return _json({'ok': True})
    return view


info_general_save = _save_section(lambda p, payload: _apply_info_general(p, payload, partial=True))
domicilio_save = _save_section(_apply_domicilio)
facturacion_save = _save_section(_apply_facturacion)


@require_GET
@login_required
def doctors(request):
    """Médicos (rol Médicos) y médicos externos (rol Médico Externo)."""
    medicos = ROLES['group_medicos']
    externos = ROLES['group_medico_externo']
    users = (User.objects.filter(is_active=True, groups__name__in=[medicos, externos])
             .prefetch_related('groups').select_related('perfil_medico__especialidad').distinct())
    data = []
    for u in users:
        names = {g.name for g in u.groups.all()}
        perfil = resumen_medico(u)
        data.append({'id': u.pk, 'name': u.get_full_name() or u.username,
                     'specialtyId': perfil['especialidad_id'] or False, 'specialtyName': perfil['especialidad'],
                     'isExternalReferral': externos in names, 'isInternalReferral': medicos in names})
    return _json(sorted(data, key=lambda d: d['name']))


@require_GET
@login_required
def doctor_specialties(request):
    return _json([{'id': e.pk, 'name': e.name} for e in Especialidad.objects.filter(active=True)])


@require_GET
@login_required
def fiscal_regimes(request):
    return _json([{'code': code, 'label': label} for code, label in REGIMENES_FISCALES])


@require_GET
@login_required
def patient_referrals(request):
    return _json([{'id': o.pk, 'name': o.name} for o in OrigenReferencia.objects.filter(active=True)])
