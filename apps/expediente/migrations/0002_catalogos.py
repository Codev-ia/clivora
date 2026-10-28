from django.db import migrations

from apps.expediente.cie import cargar_catalogo

PRONOSTICOS = ['Favorable', 'Reservado', 'Desfavorable', 'Ligado a evolución']


def cargar(apps, schema_editor):
    Pronostico = apps.get_model('expediente', 'Pronostico')
    for i, name in enumerate(PRONOSTICOS):
        Pronostico.objects.get_or_create(name=name, defaults={'sequence': (i + 1) * 10})
    cargar_catalogo(apps.get_model('expediente', 'DiagnosticoCIE'))


class Migration(migrations.Migration):
    dependencies = [('expediente', '0001_historia_clinica')]
    operations = [migrations.RunPython(cargar, migrations.RunPython.noop)]
