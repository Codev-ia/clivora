"""Catálogo CIE-10 / CIE-11: normalización de texto, carga y buscador."""
import csv
import io
import re
import unicodedata
from pathlib import Path

from django.db import connection

DATA_DIR = Path(__file__).resolve().parent / 'data'

_NO_ALFANUM = re.compile(r'[^a-z0-9]+')
# Palabras que no ayudan a distinguir un diagnóstico de otro.
_STOPWORDS = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'a', 'al',
              'en', 'con', 'sin', 'por', 'para', 'un', 'una'}
# Algo que parece código ("5A11", "C50", "1A00.0").
_CODIGO = re.compile(r'^[0-9a-z]{1,5}(\.[0-9a-z]{0,2})?$', re.IGNORECASE)
# Similitud mínima entre una palabra escrita y una del diagnóstico para
# tomarlas como la misma con faltas de ortografía ("diabetis" ≈ "diabetes").
_SIMILITUD = 0.5
# Entre coincidencias parecidas, primero el diagnóstico más corto (el más
# general): con el CIE-11 completo, "diabetis tipo 2" encontraba antes
# "Síndrome del recién nacido de madre diabética tipo 1 o 2…" que "Diabetes
# mellitus tipo 2" (por trigramas "diabetis" se parece más a "diabética").
_PENALIZACION_LARGO = 0.003


def normalizar(texto):
    """Minúsculas, sin acentos y solo letras/números separados por un espacio
    ("Neumonía, no especificada" → "neumonia no especificada")."""
    texto = unicodedata.normalize('NFKD', texto or '')
    texto = ''.join(c for c in texto if not unicodedata.combining(c)).lower()
    return _NO_ALFANUM.sub(' ', texto).strip()


_TUMOR_MALIGNO = re.compile(r'^tumor maligno', re.IGNORECASE)
_NEOPLASIA_MALIGNA = re.compile(r'^neoplasias? malignas?', re.IGNORECASE)


def sinonimos_cie10(nombre):
    """La edición de la OPS nombra las neoplasias "Tumor maligno de…": se
    agregan "Cáncer de…" y "Neoplasia maligna de…" para encontrarlas como las
    escriben los médicos (y como las nombra el CIE-11)."""
    m = _TUMOR_MALIGNO.match(nombre)
    if not m:
        return ''
    resto = nombre[m.end():]
    return '\n'.join(['Cáncer' + resto, 'Neoplasia maligna' + resto])


def sinonimos_cie11(nombre):
    """El CIE-11 las nombra "Neoplasia(s) maligna(s) de…": "Cáncer de…" y
    "Tumor maligno de…" (como en el CIE-10)."""
    m = _NEOPLASIA_MALIGNA.match(nombre)
    if not m:
        return ''
    resto = nombre[m.end():]
    return '\n'.join(['Cáncer' + resto, 'Tumor maligno' + resto])


# ── CIE-11 desde la tabulación de la OMS ─────────────────────────────────

# Capítulos de diagnósticos. Fuera: 26 (medicina tradicional), V (evaluación
# del funcionamiento) y X (códigos de extensión, que complementan a otro
# código y no son un diagnóstico por sí mismos).
CAPITULOS_CIE11 = {f'{n:02d}' for n in range(1, 26)}


def _titulo(valor):
    """"- - - Diabetes mellitus tipo 2" → "Diabetes mellitus tipo 2"."""
    return re.sub(r'^[\s"-]+|"$', '', valor or '').strip()


def filas_cie11(tabulacion):
    """Filas (code, name, chapter) de la "Simple Tabulation" del CIE-11 MMS
    de la OMS (texto separado por tabuladores, ya leído como str): las
    categorías con código de los capítulos 01–25, con el título en español
    (o en inglés si la OMS aún no lo traduce)."""
    lineas = csv.DictReader(io.StringIO(tabulacion.lstrip('\ufeff')), delimiter='\t')
    capitulos, filas = {}, []
    for r in lineas:
        titulo = _titulo(r.get('Title')) or _titulo(r.get('TitleEN'))
        if r.get('ClassKind') == 'chapter':
            capitulos[r['ChapterNo']] = f"{r['ChapterNo']} {titulo}"
        elif r.get('ClassKind') == 'category' and r.get('Code') and r.get('ChapterNo') in CAPITULOS_CIE11:
            filas.append({'code': r['Code'], 'name': titulo, 'chapter': r['ChapterNo']})
    for f in filas:
        f['chapter'] = capitulos.get(f['chapter'], f['chapter'])
    return filas


def escribir_csv(filas, destino):
    with open(destino, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['code', 'name', 'chapter'])
        w.writeheader()
        w.writerows(filas)


def cargar_catalogo(DiagnosticoCIE):
    """Crea o actualiza (por código) el catálogo desde data/cie10.csv y
    data/cie11.csv. Los códigos que ya no vienen en el archivo se desactivan
    (no se borran: los diagnósticos guardados pueden apuntar a ellos). Recibe
    el modelo para poder usarse en migraciones."""
    creados = actualizados = desactivados = 0
    sinonimos_de = {'cie10': sinonimos_cie10, 'cie11': sinonimos_cie11}
    for catalogo, archivo in (('cie10', 'cie10.csv'), ('cie11', 'cie11.csv')):
        with open(DATA_DIR / archivo, encoding='utf-8', newline='') as f:
            filas = {r['code']: r for r in csv.DictReader(f) if r.get('code') and r.get('name')}
        existentes = {d.codigo: d for d in DiagnosticoCIE.objects.filter(catalogo=catalogo)}
        nuevos, cambiados = [], []
        for codigo, fila in filas.items():
            sinonimos = fila.get('synonyms') or sinonimos_de[catalogo](fila['name'])
            valores = {'nombre': fila['name'], 'capitulo': fila.get('chapter') or '', 'sinonimos': sinonimos,
                       'active': True}
            obj = existentes.get(codigo) or DiagnosticoCIE(catalogo=catalogo, codigo=codigo)
            if obj.pk and all(getattr(obj, k) == v for k, v in valores.items()):
                continue
            for k, v in valores.items():
                setattr(obj, k, v)
            obj.search_name = normalizar(f'{codigo} {obj.nombre}')
            obj.search_text = normalizar(f'{codigo} {obj.nombre} {obj.sinonimos}')
            (cambiados if obj.pk else nuevos).append(obj)
        DiagnosticoCIE.objects.bulk_create(nuevos, batch_size=1000)
        DiagnosticoCIE.objects.bulk_update(
            cambiados, ['nombre', 'capitulo', 'sinonimos', 'active', 'search_name', 'search_text'], batch_size=1000)
        creados += len(nuevos)
        actualizados += len(cambiados)
        desactivados += (DiagnosticoCIE.objects.filter(catalogo=catalogo, active=True)
                         .exclude(codigo__in=filas.keys()).update(active=False))
    return creados, actualizados, desactivados


def buscar(query, limit=20):
    """Ids de diagnósticos activos que coinciden con lo escrito, sin depender
    de acentos, mayúsculas ni ortografía exacta: cada palabra (menos "de",
    "la"…) debe aparecer igual o parecida en el código, la descripción o un
    sinónimo. Ordena por qué tan bien coincide (más peso a la descripción),
    con una pequeña ventaja para la descripción más corta (la más general)."""
    palabras = normalizar(query).split()
    palabras = [p for p in palabras if p not in _STOPWORDS] or palabras
    if not palabras:
        return []

    condiciones, params_where, puntajes, params_puntaje = [], [], [], []
    for p in palabras:
        if len(p) <= 2 or p.isdigit():
            # Números y palabras muy cortas ("2", "ii"): palabra completa.
            condiciones.append('search_text ~ %s')
            params_where.append(rf'\m{p}\M')
            puntajes.append('(search_name ~ %s)::int')
            params_puntaje.append(rf'\m{p}\M')
        else:
            condiciones.append('(search_text LIKE %s OR %s <%% search_text)')
            params_where += [f'%{p}%', p]
            puntajes.append('word_similarity(%s, search_text) + 0.5 * word_similarity(%s, search_name)')
            params_puntaje += [p, p]

    where = ' AND '.join(condiciones)
    raw = query.strip()
    if _CODIGO.match(raw) and any(c.isdigit() for c in raw):
        # Búsqueda por código: los que empiezan así primero, el exacto antes.
        where = f'({where}) OR codigo ILIKE %s'
        params_where.append(f'{raw}%')
        puntajes.append('(CASE WHEN upper(codigo) = upper(%s) THEN 20 WHEN codigo ILIKE %s THEN 10 ELSE 0 END)')
        params_puntaje += [raw, f'{raw}%']

    with connection.cursor() as cr:
        cr.execute('SET LOCAL pg_trgm.word_similarity_threshold = %s', [_SIMILITUD])
        cr.execute(f"""
            SELECT id FROM expediente_diagnosticocie
             WHERE active AND ({where})
             ORDER BY {' + '.join(puntajes)} - %s * length(nombre) DESC, length(nombre), codigo
             LIMIT %s
        """, params_where + params_puntaje + [_PENALIZACION_LARGO, limit])
        return [row[0] for row in cr.fetchall()]
