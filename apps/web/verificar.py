"""Segundo paso del inicio de sesión (/clivora/login/verificar, ver
verificar.js): con la contraseña ya validada (login_submit deja al usuario
pendiente en la sesión), pide el código de la app de autenticación o un
código de recuperación y entonces abre la sesión."""
import json
import time

from django.contrib.auth import login
from django.http import JsonResponse
from django.shortcuts import redirect
from django.utils.html import escape
from django.views.decorators.csrf import csrf_exempt

from apps.accounts import dos_pasos
from apps.accounts.models import User

from .roles import has_app_access
from .views import SESION_DOS_PASOS, render_app_page

VIGENCIA_SEGUNDOS = 5 * 60  # tiempo para capturar el código
MAX_INTENTOS = 5


def _pendiente(request):
    """Usuario que espera el código, o None si no hay o ya venció."""
    data = request.session.get(SESION_DOS_PASOS)
    if not data or time.time() - data['t'] > VIGENCIA_SEGUNDOS or data['n'] >= MAX_INTENTOS:
        return None, data
    return User.objects.filter(pk=data['u'], is_active=True).first(), data


@csrf_exempt  # verificar.js no manda token CSRF (igual que el login)
def verificar(request):
    user, data = _pendiente(request)
    if request.method != 'POST':
        if not user:
            request.session.pop(SESION_DOS_PASOS, None)
            return redirect('/clivora/login')
        estado = {'name': user.get_full_name() or user.username, 'dias': dos_pasos.DIAS_EQUIPO_CONFIABLE}
        return render_app_page('verificar.html',
                               ['assets/css/styles.css', 'assets/css/clivora-theme.css', 'assets/js/verificar.js'],
                               {'__VERIFY_STATE__': escape(json.dumps(estado))})
    if not user or not has_app_access(user):
        request.session.pop(SESION_DOS_PASOS, None)
        return JsonResponse({'ok': False, 'error': 'expired'})
    if not dos_pasos.verificar(user, request.POST.get('code')):
        data['n'] += 1
        request.session[SESION_DOS_PASOS] = data
        if data['n'] >= MAX_INTENTOS:
            request.session.pop(SESION_DOS_PASOS, None)
            return JsonResponse({'ok': False, 'error': 'expired'})
        return JsonResponse({'ok': False, 'error': 'invalid', 'remaining': MAX_INTENTOS - data['n']})
    request.session.pop(SESION_DOS_PASOS, None)
    login(request, user, backend=data['b'])
    response = JsonResponse({'ok': True, 'name': user.get_full_name() or user.username, 'redirect': data['r']})
    if request.POST.get('remember') in ('1', 'true', 'on'):
        response.set_cookie(dos_pasos.COOKIE_EQUIPO, dos_pasos.cookie_equipo(dos_pasos.registro(user)),
                            max_age=dos_pasos.DIAS_EQUIPO_CONFIABLE * 86400, httponly=True, samesite='Lax',
                            secure=request.is_secure(), path='/clivora')
    return response
