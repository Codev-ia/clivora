"""Consulta de roles de Clivora (grupos de Django, ver apps/accounts/roles.py)."""
from apps.accounts.roles import ROLES


def _group_names(user):
    if not hasattr(user, '_app_group_names'):
        user._app_group_names = set(user.groups.values_list('name', flat=True))
    return user._app_group_names


def is_admin(user):
    """Superusuario o rol Administrador: tiene todos los roles."""
    if not user or not user.is_authenticated or not user.is_active:
        return False
    return user.is_superuser or ROLES['administrador'] in _group_names(user)


def has_role(user, key):
    """key = identificador interno del rol, p. ej. 'group_enfermeria'."""
    if not user or not user.is_authenticated:
        return False
    return is_admin(user) or ROLES[key] in _group_names(user)


def has_app_access(user):
    """Rol "Acceso a Clivora" (o administrador) y al menos una clínica permitida.
    El superusuario entra aunque no haya clínicas: es quien da de alta la
    primera en una instalación nueva."""
    from apps.core.clinica import allowed_clinicas
    if user and user.is_authenticated and user.is_active and user.is_superuser:
        return True
    return has_role(user, 'group_medical_portal') and allowed_clinicas(user).exists()
