"""Páginas del frontend de Clivora: login, página principal, cierre de sesión
y /api/me (perfil y permisos que usan login.js y app.js).
"""
import hashlib
import re
import time
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from apps.accounts import dos_pasos
from apps.accounts.models import User

from apps.core.clinica import active_clinica, allowed_clinicas
from apps.core.limits import uso as limits_uso
from apps.core.serializers import logo_url

from .roles import has_app_access, has_role, is_admin

APP_URL = '/clivora'
# Inicio de sesión que espera el código de la verificación en dos pasos.
SESION_DOS_PASOS = 'dos_pasos_pendiente'
STATIC_DIR = Path(settings.STATICFILES_DIRS[0])


@lru_cache(maxsize=64)
def _file_hash(relative, mtime):
    return hashlib.md5((STATIC_DIR / relative).read_bytes()).hexdigest()[:10]


def asset_version(relative):
    """Hash corto del archivo: la URL cambia solo
    cuando el archivo cambia, así el navegador nunca usa una copia vieja."""
    path = STATIC_DIR / relative
    return _file_hash(relative, path.stat().st_mtime)


def render_app_page(name, assets, replacements=None):
    html = (Path(settings.APP_TEMPLATES_DIR) / name).read_text(encoding='utf-8')
    for relative in assets:
        url = re.escape(f'{settings.STATIC_URL}{relative}')
        html = re.sub(rf'({url})(\?[^"]*)?', rf'\g<1>?v={asset_version(relative)}', html)
    for key, value in (replacements or {}).items():
        html = html.replace(key, value)
    response = HttpResponse(html, content_type='text/html; charset=utf-8')
    response['Cache-Control'] = 'no-cache'
    return response


def _safe_next_url(request, url):
    if url and url.startswith('/') and url_has_allowed_host_and_scheme(url, allowed_hosts={request.get_host()}):
        return url
    return None


def _resolve_user(login_value):
    """Usuario por nombre de usuario o correo, sin importar mayúsculas. Si hay
    más de uno, no adivina."""
    matches = list(User.objects.filter(username__iexact=login_value)[:2])
    if not matches:
        matches = list(User.objects.filter(email__iexact=login_value)[:2])
    return matches[0].username if len(matches) == 1 else login_value


@require_GET
def home(request):
    return redirect(APP_URL)


@csrf_exempt  # login.js no manda token CSRF
def login_page(request):
    if request.method == 'POST':
        return login_submit(request)
    if request.user.is_authenticated:
        if has_app_access(request.user):
            return redirect(_safe_next_url(request, request.GET.get('redirect')) or APP_URL)
        logout(request)
    return render_app_page('login.html', ['assets/css/styles.css', 'assets/css/clivora-theme.css', 'assets/js/login.js'])


@require_POST
def login_submit(request):
    """Responde JSON (no redirect): login.js muestra su animación de éxito o
    error y luego navega a `redirect`."""
    login_value = (request.POST.get('login') or '').strip()
    password = request.POST.get('password') or ''
    if not login_value or not password:
        return JsonResponse({'ok': False, 'error': 'missing'})
    user = authenticate(request, username=_resolve_user(login_value), password=password)
    if user is None:
        return JsonResponse({'ok': False, 'error': 'invalid'})
    if not has_app_access(user):
        return JsonResponse({'ok': False, 'error': 'forbidden'})
    destino = _safe_next_url(request, request.POST.get('redirect')) or APP_URL
    if dos_pasos.activa(user) and not dos_pasos.equipo_confiable(request, user):
        # La sesión se abre hasta capturar el código (ver verificar.py).
        request.session[SESION_DOS_PASOS] = {'u': user.pk, 'b': user.backend, 'r': destino,
                                             't': int(time.time()), 'n': 0}
        return JsonResponse({'ok': True, 'mfa': True, 'redirect': '/clivora/login/verificar'})
    login(request, user)
    return JsonResponse({
        'ok': True,
        'name': user.get_full_name() or user.username,
        'specialty': '',
        'redirect': destino,
    })


def logout_view(request):
    logout(request)
    return redirect(settings.LOGIN_URL)


@ensure_csrf_cookie
def index(request):
    if not request.user.is_authenticated:
        return redirect(f'{settings.LOGIN_URL}?redirect={request.get_full_path()}')
    if not has_app_access(request.user):
        logout(request)
        return redirect(settings.LOGIN_URL)
    return render_app_page('index.html', ['assets/css/styles.css', 'assets/css/inventario.css', 'assets/css/clivora-theme.css',
                                           'assets/js/app.js', 'assets/js/app-ui.js', 'assets/js/inventario.js',
                                           'assets/js/config.js', 'assets/js/clivora-shell.js', 'assets/js/seguridad.js'])


@require_GET
@login_required
def api_me(request):
    """Perfil y banderas de permisos que usa app.js."""
    from apps.expediente.notas import es_rol_recepcion  # notas importa módulos que importan este

    user = request.user
    admin = is_admin(user)
    unrestricted_medico = admin or has_role(user, 'group_jefa_enfermeria')
    medicos = has_role(user, 'group_medicos')
    enfermeria = has_role(user, 'group_enfermeria') or has_role(user, 'group_jefa_enfermeria')
    recepcion = has_role(user, 'group_recepcion')
    jefe_recepcion = has_role(user, 'group_jefe_recepcion')
    clinica = active_clinica(request)
    return JsonResponse({
        'canShare': has_role(user, 'group_compartir_expediente'),
        'canEditHistorialCreateDate': has_role(user, 'group_historial_create_date_edit'),
        'canSkipRequiredFields': has_role(user, 'group_comercial'),
        'canEditStock': has_role(user, 'group_farmacia'),
        'canEditAnotacionesEnfermeria': enfermeria,
        'canSeeClinicMenu': admin or medicos or enfermeria,
        'isDoctorReadOnly': medicos and not unrestricted_medico,
        'isEnfermeriaLimited': enfermeria and not unrestricted_medico,
        'isRecepcionLimited': recepcion and not admin and not jefe_recepcion,
        'isJefeRecepcionLimited': jefe_recepcion and not admin,
        'canEditNursingVitals': not es_rol_recepcion(user),
        # Nuevas pantallas (productos, inventario, listas de precios).
        'canSeeInventory': admin or user.has_perm('inventario.view_product'),
        'canManageInventory': admin or user.has_perm('inventario.add_stockmove'),
        'canManageProducts': admin or user.has_perm('inventario.change_product'),
        'canManagePricelists': admin or user.has_perm('precios.change_pricelist'),
        # Configuración
        'canManageClinicas': admin or user.has_perm('core.change_clinica'),
        'canManageLugares': admin or user.has_perm('core.change_lugar'),
        'canManageUsers': admin or user.has_perm('accounts.change_user'),
        'isSuperuser': user.is_superuser,
        # Límites de la instalación y uso actual (Configuración → Sistema).
        'limites': limits_uso(),
        # Multiempresa: clínica activa y permitidas (selector del encabezado).
        'clinicaActiva': ({'id': clinica.pk, 'name': clinica.name, 'city': clinica.city, 'logoUrl': logo_url(clinica)}
                          if clinica else None),
        'clinicas': [{'id': c.pk, 'name': c.name, 'city': c.city} for c in allowed_clinicas(user)],
        'name': user.get_full_name() or user.username,
        'email': user.email or user.username,
        'function': '',
        'department': '',
    })


def api_not_implemented(request, path):
    """Rutas de Clivora que todavía no existen en esta plataforma (pacientes,
    agenda, etc.): 404 en JSON en vez de una página HTML, para que app.js
    lo trate como "sin datos" y no truene al leer la respuesta."""
    return JsonResponse({'error': 'not_implemented', 'path': path}, status=404)
