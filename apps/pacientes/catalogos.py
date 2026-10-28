"""Catálogos fijos de pacientes."""

from apps.core.sat import REGIMEN_CODES, REGIMENES_FISCALES  # noqa: F401  (se reexportan)


# Texto del <select> de Clivora <-> clave guardada.
GENERO_LABEL_TO_KEY = {'Masculino': 'masculino', 'Femenino': 'femenino', 'Otro': 'otro',
                       'Prefiero no decirlo': 'no_decir'}
GENERO_KEY_TO_LABEL = {v: k for k, v in GENERO_LABEL_TO_KEY.items()}
ESTADO_CIVIL_LABEL_TO_KEY = {'Soltero': 'soltero', 'Casado': 'casado', 'Unión Libre': 'union_libre',
                             'Viudo': 'viudo', 'Divorciado': 'divorciado'}
ESTADO_CIVIL_KEY_TO_LABEL = {v: k for k, v in ESTADO_CIVIL_LABEL_TO_KEY.items()}
