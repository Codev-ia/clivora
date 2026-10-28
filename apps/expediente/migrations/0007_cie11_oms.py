from django.db import migrations


def cargar(apps, schema_editor):
    from apps.expediente.cie import cargar_catalogo
    cargar_catalogo(apps.get_model('expediente', 'DiagnosticoCIE'))


class Migration(migrations.Migration):
    """CIE-11 completo de la OMS (CIE-11 MMS 2026-01) en lugar de los 38
    diagnósticos de base; los códigos de base que no existen en la versión
    oficial quedan desactivados."""

    dependencies = [('expediente', '0006_archivos')]

    operations = [migrations.RunPython(cargar, migrations.RunPython.noop)]
