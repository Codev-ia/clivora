from django.contrib.auth.models import Group, Permission
from django.core.management.base import BaseCommand

from apps.accounts.roles import ROLE_PERMISSIONS, ROLES


class Command(BaseCommand):
    help = 'Crea/actualiza los roles de Clivora (grupos) y sus permisos.'

    def handle(self, *args, **options):
        valid = set(ROLES.values())
        for name in ROLES.values():
            group, created = Group.objects.get_or_create(name=name)
            codenames = ROLE_PERMISSIONS.get(name)
            if codenames is not None:
                perms = []
                for full in codenames:
                    app_label, codename = full.split('.')
                    perms.append(Permission.objects.get(content_type__app_label=app_label, codename=codename))
                group.permissions.set(perms)
            self.stdout.write(f'{"creado" if created else "ok"}: {name}')
        stale = Group.objects.exclude(name__in=valid)
        for group in stale:
            self.stdout.write(f'eliminado (ya no existe): {group.name}')
        stale.delete()
