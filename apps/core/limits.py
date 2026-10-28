"""Límites de la instalación (máximo de usuarios y de clínicas)."""
from rest_framework.exceptions import ValidationError

from .models import Clinica, SystemSettings


def usuarios_activos():
    from apps.accounts.models import User
    return User.objects.filter(is_active=True, is_superuser=False).count()


def clinicas_activas():
    return Clinica.objects.filter(active=True).count()


def uso():
    s = SystemSettings.get()
    return {
        'maxUsuarios': s.max_usuarios, 'usuarios': usuarios_activos(),
        'maxClinicas': s.max_clinicas, 'clinicas': clinicas_activas(),
    }


def check_usuario_nuevo(field='is_active'):
    """Antes de crear o reactivar un usuario (no superusuario)."""
    limit = SystemSettings.get().max_usuarios
    if limit is not None and usuarios_activos() >= limit:
        raise ValidationError({field: f'Se alcanzó el máximo de {limit} usuarios activos. '
                                      'Desactiva un usuario o pide al superusuario que amplíe el límite.'})


def check_clinica_nueva(field='active'):
    limit = SystemSettings.get().max_clinicas
    if limit is not None and clinicas_activas() >= limit:
        raise ValidationError({field: f'Se alcanzó el máximo de {limit} clínicas activas. '
                                      'Archiva una clínica o pide al superusuario que amplíe el límite.'})
