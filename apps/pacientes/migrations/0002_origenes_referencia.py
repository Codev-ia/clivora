from django.db import migrations

# Mismo catálogo que usa la pantalla de alta de Clivora: los que "piden médico"
# muestran el campo Médico de referencia.
ORIGENES = [
    ('Página Web', False), ('Facebook', False), ('Instagram', False), ('WhatsApp', False),
    ('Correo Electrónico', False), ('Conocido/Amigo', False), ('SGMM', False),
    ('Médico Externo', True), ('Médico Interno', True), ('Médico Referenciador', True),
    ('San José Valle Real', True),
]


def crear(apps, schema_editor):
    Origen = apps.get_model('pacientes', 'OrigenReferencia')
    for name, pide in ORIGENES:
        Origen.objects.get_or_create(name=name, defaults={'pide_medico': pide})


class Migration(migrations.Migration):
    dependencies = [('pacientes', '0001_initial')]
    operations = [migrations.RunPython(crear, migrations.RunPython.noop)]
