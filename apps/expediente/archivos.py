"""Archivos del expediente (pestaña Archivos y "Archivos de HC")."""
import os

from django.contrib.auth.decorators import login_required
from django.core.files.base import ContentFile
from django.http import FileResponse, Http404
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.core.archivos import decodificar_data_url
from apps.core.html import limpiar as limpiar_html
from apps.pacientes.compat import visible_pacientes

from .compat import _body, _json, _nombre
from .models import ArchivoPaciente
from .notas import _decimal, _no_encontrado, _paciente, _texto_plano


def _iso(dt):
    return timezone.localtime(dt).replace(tzinfo=None).isoformat() if dt else ''


def serializar_archivo(a):
    return {
        'id': a.pk, 'title': a.titulo, 'comment': a.comentario, 'type': a.tipo, 'type_document': a.tipo,
        'treatment_primary': a.tratamiento_primario,
        'date_cycle': a.fecha_ciclo.isoformat() if a.fecha_ciclo else '', 'cycle': a.ciclo,
        'share_patient': a.compartir_paciente, 'fee': a.honorarios, 'fee_cycle': a.honorarios_ciclo,
        'uploaded_by': _nombre(a.created_by), 'version': 1, 'is_current_version': True,
        'create_date': _iso(a.created_at),
        'fileUrl': f'/clivora/patient_files/{a.pk}?download=false' if a.archivo else '',
        'mimetype': a.mimetype, 'origen': 'Clivora',
        # El desglose (venta) de un archivo de recetas queda fuera de alcance.
        'saleOrderId': False, 'saleOrderName': '',
    }


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_http_methods(['GET', 'POST'])
def archivos(request, patient_id):
    paciente = _paciente(request, patient_id)
    if not paciente:
        return _no_encontrado()
    if request.method == 'GET':
        qs = ArchivoPaciente.objects.filter(paciente=paciente, eliminado=False).select_related('created_by')
        return _json([serializar_archivo(a) for a in qs])

    payload = _body(request)
    titulo = _texto_plano(payload.get('title'), 255)
    if not titulo:
        return _json({'error': 'missing_title'}, status=400)
    mimetype = contenido = None
    if payload.get('file'):
        mimetype, contenido = decodificar_data_url(payload.get('file'))
        if contenido is None:
            return _json({'error': 'invalid_file'}, status=400)
        if len(contenido) > ArchivoPaciente.MAX_BYTES:
            return _json({'error': 'file_too_large', 'message': 'El archivo no puede pasar de 20 MB.'}, status=400)
    tipo = payload.get('type_document') or payload.get('type')
    fecha_ciclo = payload.get('date_cycle')
    archivo = ArchivoPaciente(
        paciente=paciente, created_by=request.user, updated_by=request.user,
        tipo=tipo if tipo in dict(ArchivoPaciente.TIPOS) else 'Otros', titulo=titulo,
        comentario=limpiar_html(payload.get('comment')), ciclo=_texto_plano(payload.get('cycle'), 60),
        fecha_ciclo=parse_date(fecha_ciclo) if isinstance(fecha_ciclo, str) and fecha_ciclo else None,
        tratamiento_primario=bool(payload.get('treatment_primary')),
        compartir_paciente=bool(payload.get('share_patient')), honorarios=bool(payload.get('fee')),
        honorarios_ciclo=_decimal(payload.get('fee_cycle')))
    if contenido is not None:
        extension = (mimetype.split('/')[-1] if '/' in mimetype else 'bin')[:10]
        archivo.nombre_archivo = f'{titulo}.{extension}'[:255]
        archivo.mimetype = mimetype
        archivo.tamano = len(contenido)
        archivo.archivo.save(f'archivo.{extension}', ContentFile(contenido), save=False)
    archivo.save()
    return _json(serializar_archivo(archivo))


@csrf_exempt
@login_required
@require_POST
def archivo_borrar(request, rec_id):
    ArchivoPaciente.objects.filter(pk=rec_id, paciente__in=visible_pacientes(request.user)).update(
        eliminado=True, updated_by=request.user, updated_at=timezone.now())
    return _json({'ok': True})


@xframe_options_sameorigin  # vista previa en un iframe de la misma app
@require_GET
@login_required
def archivo_descargar(request, rec_id):
    """Los archivos de pacientes nunca se sirven directo: pasan por aquí, que
    revisa sesión y que el usuario pueda ver al paciente."""
    archivo = ArchivoPaciente.objects.filter(pk=rec_id, eliminado=False,
                                             paciente__in=visible_pacientes(request.user)).first()
    if archivo is None or not archivo.archivo:
        raise Http404
    _, extension = os.path.splitext(archivo.archivo.name)
    nombre = archivo.nombre_archivo or f'{archivo.titulo}{extension}'
    return FileResponse(archivo.archivo.open('rb'), filename=nombre,
                        as_attachment=request.GET.get('download') == 'true',
                        content_type=archivo.mimetype or None)
