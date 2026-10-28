from django.db import migrations

# Catálogos iniciales de la Agenda.
MOTIVOS = [('Consulta médica', 'consulta')] + [(m, 'tratamiento') for m in [
    'Baaf', 'Biopsia', 'Broncoscopia', 'Colocacion de balon gastrico', 'Colonoscopia', 'Endoscopia',
    'Endoscopia y colonoscopia', 'Heparinización', 'Hidratación', 'Infusión', 'Infusión protocolo',
    'Paracentesis', 'Procedimiento ambulatorio', 'Reseccion', 'Toracocentesis', 'Vacuna', 'Vasectomia']]
RECHAZOS = ['Paciente no confirmó', 'Conflicto de horario', 'Doctor no disponible', 'Solicitud duplicada',
            'Datos incompletos o incorrectos', 'Otro']


def crear(apps, schema_editor):
    Motivo = apps.get_model('agenda', 'MotivoCita')
    Rechazo = apps.get_model('agenda', 'MotivoRechazo')
    for name, tipo in MOTIVOS:
        Motivo.objects.get_or_create(name=name, tipo=tipo)
    for name in RECHAZOS:
        Rechazo.objects.get_or_create(name=name)


class Migration(migrations.Migration):
    dependencies = [('agenda', '0001_initial')]
    operations = [migrations.RunPython(crear, migrations.RunPython.noop)]
