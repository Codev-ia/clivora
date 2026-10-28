"""Restablecer contraseña (/clivora/reset_password, ver reset_password.js):
pedir el enlace manda un correo; el enlace trae el token con el que se elige
la contraseña nueva.

El token es el de Django (default_token_generator): vence a las
PASSWORD_RESET_TIMEOUT segundos y deja de servir en cuanto la contraseña
cambia, así que cada enlace se usa una sola vez. No se guarda nada en la
base de datos."""
import json
import logging

from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.http import JsonResponse
from django.template.loader import render_to_string
from django.utils.encoding import force_bytes, force_str
from django.utils.html import escape, strip_tags
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from apps.accounts.models import User

from .roles import has_app_access
from .views import _resolve_user, render_app_page

log = logging.getLogger(__name__)

# Solicitudes de enlace por IP en la ventana de tiempo (evita usar la
# pantalla para mandar correos en masa).
MAX_SOLICITUDES = 5
VENTANA_SEGUNDOS = 15 * 60


def _token_para(user):
    return f'{urlsafe_base64_encode(force_bytes(user.pk))}.{default_token_generator.make_token(user)}'


def _usuario_del_token(token):
    uid, _, valor = (token or '').partition('.')
    try:
        user = User.objects.get(pk=force_str(urlsafe_base64_decode(uid)), is_active=True)
    except (ValueError, TypeError, OverflowError, User.DoesNotExist):
        return None
    return user if default_token_generator.check_token(user, valor) else None


def _nombre(user):
    return user.get_full_name() or user.username


@csrf_exempt  # reset_password.js no manda token CSRF
def reset_password(request):
    if request.method == 'POST':
        return solicitar(request)
    token = request.GET.get('token')
    estado = {'mode': 'request'}
    if token:
        user = _usuario_del_token(token)
        estado = {'mode': 'confirm', 'name': _nombre(user)} if user else {'mode': 'invalid'}
    return render_app_page('reset_password.html',
                           ['assets/css/styles.css', 'assets/css/clivora-theme.css', 'assets/js/reset_password.js'],
                           {'__RESET_STATE__': escape(json.dumps(estado))})


def _ip(request):
    return request.META.get('HTTP_X_REAL_IP') or request.META.get('REMOTE_ADDR', '')


@require_POST
def solicitar(request):
    """Siempre responde ok aunque el correo no exista, para no revelar qué
    cuentas hay."""
    login_value = (request.POST.get('login') or '').strip()
    if not login_value:
        return JsonResponse({'ok': False, 'error': 'missing'})
    llave = f'reset_password:{_ip(request)}'
    intentos = cache.get(llave, 0)
    if intentos >= MAX_SOLICITUDES:
        return JsonResponse({'ok': False, 'message': 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.'})
    cache.set(llave, intentos + 1, VENTANA_SEGUNDOS)

    user = User.objects.filter(username=_resolve_user(login_value), is_active=True).first()
    if not user or not user.email or not has_app_access(user):
        return JsonResponse({'ok': True})
    enlace = request.build_absolute_uri(f'/clivora/reset_password?token={_token_para(user)}')
    html = render_to_string('correos/restablecer_contrasena.html', {
        'nombre': _nombre(user), 'enlace': enlace, 'horas': settings.PASSWORD_RESET_TIMEOUT // 3600,
    })
    try:
        send_mail('Restablece tu contraseña de Clivora', strip_tags(html), settings.DEFAULT_FROM_EMAIL, [user.email],
                  html_message=html)
    except Exception:
        log.exception('No se pudo enviar el correo para restablecer la contraseña del usuario %s', user.pk)
        return JsonResponse({'ok': False, 'error': 'send_failed'})
    return JsonResponse({'ok': True})


@csrf_exempt
@require_POST
def confirmar(request):
    user = _usuario_del_token(request.POST.get('token'))
    if not user:
        return JsonResponse({'ok': False, 'error': 'invalid_token'})
    password = request.POST.get('password') or ''
    if not password or not request.POST.get('confirm_password'):
        return JsonResponse({'ok': False, 'error': 'missing'})
    if password != request.POST.get('confirm_password'):
        return JsonResponse({'ok': False, 'error': 'mismatch'})
    try:
        validate_password(password, user)
    except ValidationError as e:
        return JsonResponse({'ok': False, 'message': ' '.join(e.messages)})
    user.set_password(password)
    user.save(update_fields=['password'])
    return JsonResponse({'ok': True, 'login': user.email or user.username})
