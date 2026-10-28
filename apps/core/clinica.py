"""Clínica activa (multiempresa).

Cada petición autenticada trae `request.clinica`: la clínica activa del
usuario, siempre una de sus clínicas permitidas (si la guardada ya no lo es,
se cambia a la primera permitida). Los superusuarios tienen todas.
Todo filtrado por clínica se hace en el servidor con estas funciones.
"""
from django.db.models import Q

from .models import Clinica


def allowed_clinicas(user):
    if not user or not user.is_authenticated:
        return Clinica.objects.none()
    qs = Clinica.objects.filter(active=True)
    return qs if user.is_superuser else qs.filter(usuarios=user)


def resolve_active_clinica(user):
    allowed = allowed_clinicas(user)
    if user.clinica_activa_id and allowed.filter(pk=user.clinica_activa_id).exists():
        return user.clinica_activa
    first = allowed.first()
    if first and user.clinica_activa_id != first.pk:
        user.clinica_activa = first
        user.save(update_fields=['clinica_activa'])
    return first


def active_clinica(request):
    """Clínica activa del usuario de la petición (Django o DRF), calculada una
    sola vez por petición. En DRF el usuario se identifica después de los
    middlewares, por eso no basta con lo que deja ClinicaMiddleware."""
    base = getattr(request, '_request', request)
    user = request.user
    cached = getattr(base, '_clinica_cache', None)
    if cached is not None and cached[0] == getattr(user, 'pk', None):
        return cached[1]
    clinica = resolve_active_clinica(user) if user and user.is_authenticated else None
    base._clinica_cache = (getattr(user, 'pk', None), clinica)
    return clinica


def shared_or_active(request, field='clinica'):
    """Registros de la clínica activa o sin clínica (compartidos)."""
    return Q(**{f'{field}__isnull': True}) | Q(**{field: active_clinica(request)})


class ClinicaMiddleware:
    """Deja request.clinica en las vistas normales de Django (páginas de Clivora)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.clinica = active_clinica(request) if request.user.is_authenticated else None
        return self.get_response(request)
