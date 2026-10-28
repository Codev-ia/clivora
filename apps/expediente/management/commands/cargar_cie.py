from django.core.management.base import BaseCommand

from apps.expediente.cie import cargar_catalogo
from apps.expediente.models import DiagnosticoCIE


class Command(BaseCommand):
    help = 'Crea o actualiza el catálogo CIE-10 / CIE-11 desde apps/expediente/data/*.csv.'

    def handle(self, *args, **options):
        creados, actualizados, desactivados = cargar_catalogo(DiagnosticoCIE)
        self.stdout.write(f'Catálogo CIE: {creados} creados, {actualizados} actualizados, {desactivados} desactivados.')
