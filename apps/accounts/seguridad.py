"""Mi Perfil → Seguridad: activar y desactivar la verificación en dos pasos
y regenerar sus códigos de recuperación (ver dos_pasos.py). Activarla,
desactivarla o ver códigos nuevos pide la contraseña actual."""
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.cifrado import cifrar, descifrar

from . import dos_pasos

SESION_SECRETO = 'dos_pasos_secreto_nuevo'


def _pedir_contrasena(request):
    if not request.user.check_password(request.data.get('password') or ''):
        raise ValidationError({'detail': 'La contraseña no es correcta.'})


def estado(user):
    reg = dos_pasos.registro(user)
    return {
        'dos_pasos': bool(reg),
        'activado_en': timezone.localtime(reg.activado_en).isoformat() if reg else None,
        'codigos_restantes': len(reg.codigos_recuperacion) if reg else 0,
    }


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def seguridad(request):
    """GET /api/v1/me/seguridad/"""
    return Response(estado(request.user))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def iniciar(request):
    """POST /api/v1/me/dos_pasos/iniciar/ {password} — secreto nuevo y su QR.
    Queda en la sesión hasta que se confirme con un código de la app."""
    _pedir_contrasena(request)
    secreto = dos_pasos.nuevo_secreto()
    request.session[SESION_SECRETO] = cifrar(secreto, 'dos-pasos')
    uri = dos_pasos.uri(request.user, secreto)
    return Response({'qr': dos_pasos.qr_svg(uri), 'secreto': secreto, 'uri': uri})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def activar(request):
    """POST /api/v1/me/dos_pasos/activar/ {codigo} — confirma que la app
    quedó configurada; responde los códigos de recuperación (única vez)."""
    secreto = descifrar(request.session.get(SESION_SECRETO, ''), 'dos-pasos')
    if not secreto:
        raise ValidationError({'detail': 'Vuelve a empezar: escribe tu contraseña para generar el código QR.'})
    paso = dos_pasos.codigo_valido(secreto, request.data.get('codigo'))
    if paso is None:
        raise ValidationError({'detail': 'El código no es correcto. Revisa que la hora del teléfono esté bien y escribe el código actual.'})
    reg, codigos = dos_pasos.activar(request.user, secreto)
    reg.ultimo_paso = paso
    reg.save(update_fields=['ultimo_paso'])
    del request.session[SESION_SECRETO]
    return Response({**estado(request.user), 'codigos': codigos})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def desactivar(request):
    """POST /api/v1/me/dos_pasos/desactivar/ {password}"""
    _pedir_contrasena(request)
    dos_pasos.DosPasos.objects.filter(user=request.user).delete()
    return Response(estado(request.user))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def codigos(request):
    """POST /api/v1/me/dos_pasos/codigos/ {password} — códigos de
    recuperación nuevos (los anteriores dejan de servir)."""
    _pedir_contrasena(request)
    reg = dos_pasos.registro(request.user)
    if not reg:
        raise ValidationError({'detail': 'La verificación en dos pasos no está activa.'})
    return Response({**estado(request.user), 'codigos': dos_pasos.generar_codigos(reg)})
