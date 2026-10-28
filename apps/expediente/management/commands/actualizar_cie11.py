"""Actualiza el CIE-11 con la versión oficial de la OMS (CIE-11 MMS, títulos
en español): descarga la "Simple Tabulation" de la versión indicada, regenera
apps/expediente/data/cie11.csv y carga el catálogo. La OMS publica una
versión cada enero (https://icd.who.int/browse/latest-release/mms/es)."""
import io
import urllib.request
import zipfile
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.expediente.cie import DATA_DIR, cargar_catalogo, escribir_csv, filas_cie11
from apps.expediente.models import DiagnosticoCIE

URL = 'https://icdcdn.who.int/static/releasefiles/{version}/SimpleTabulation-ICD-11-MMS-es.zip'


class Command(BaseCommand):
    help = 'Descarga el CIE-11 de la OMS (versión AAAA-MM, p. ej. 2026-01), regenera data/cie11.csv y lo carga.'

    def add_arguments(self, parser):
        parser.add_argument('version', help='Versión de la OMS, p. ej. 2026-01.')
        parser.add_argument('--archivo', help='Usar un .zip o .txt ya descargado en lugar de descargarlo.')
        parser.add_argument('--solo-csv', action='store_true', help='Solo regenerar el CSV, sin cargarlo.')

    def handle(self, version, archivo=None, solo_csv=False, **options):
        datos = Path(archivo).read_bytes() if archivo else self._descargar(URL.format(version=version))
        if datos[:2] == b'PK':
            with zipfile.ZipFile(io.BytesIO(datos)) as z:
                nombre = next((n for n in z.namelist() if n.endswith('.txt') and 'SimpleTabulation' in n), None)
                if not nombre:
                    raise CommandError('El .zip no trae la tabulación (SimpleTabulation-…-es.txt).')
                datos = z.read(nombre)
        filas = filas_cie11(datos.decode('utf-8'))
        if len(filas) < 10000:
            raise CommandError(f'Solo se leyeron {len(filas)} diagnósticos: ¿es la tabulación del CIE-11 MMS?')
        escribir_csv(filas, DATA_DIR / 'cie11.csv')
        (DATA_DIR / 'cie11.version').write_text(f'{version}\n', encoding='utf-8')
        self.stdout.write(f'data/cie11.csv: {len(filas)} diagnósticos (CIE-11 MMS {version}).')
        if not solo_csv:
            creados, actualizados, desactivados = cargar_catalogo(DiagnosticoCIE)
            self.stdout.write(f'Catálogo CIE: {creados} creados, {actualizados} actualizados, '
                              f'{desactivados} desactivados.')

    def _descargar(self, url):
        self.stdout.write(f'Descargando {url}')
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                datos = r.read()
        except OSError as e:
            raise CommandError(f'No se pudo descargar: {e}')
        if datos[:2] != b'PK':
            raise CommandError('La OMS no tiene esa versión (la respuesta no es un .zip).')
        return datos
