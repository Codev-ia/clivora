from django.db import migrations

DEFAULTS = [
    ('Proveedores', 'supplier'),
    ('Aplicación a pacientes', 'patient'),
    ('Ajustes de inventario', 'adjustment'),
    ('Merma', 'scrap'),
]


def create_defaults(apps, schema_editor):
    Location = apps.get_model('inventario', 'Location')
    for name, usage in DEFAULTS:
        if not Location.objects.filter(usage=usage, parent=None).exists():
            Location.objects.create(name=name, usage=usage)


class Migration(migrations.Migration):
    dependencies = [('inventario', '0001_initial')]
    operations = [migrations.RunPython(create_defaults, migrations.RunPython.noop)]
