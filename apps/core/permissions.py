from rest_framework.permissions import DjangoModelPermissions


class ModelPermissions(DjangoModelPermissions):
    """Como DjangoModelPermissions, pero también exige el permiso "view" para
    leer (por defecto DRF deja leer a cualquier usuario autenticado)."""

    perms_map = {
        **DjangoModelPermissions.perms_map,
        'GET': ['%(app_label)s.view_%(model_name)s'],
        'HEAD': ['%(app_label)s.view_%(model_name)s'],
        'OPTIONS': [],
    }
