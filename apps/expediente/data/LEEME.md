# Catálogos de diagnósticos

| Archivo | Contenido | Fuente |
|---|---|---|
| `cie10.csv` | CIE-10, 14,352 diagnósticos | Edición en español de la OPS |
| `cie11.csv` | CIE-11 MMS, capítulos 01–25 (sin códigos de extensión, sección de funcionamiento ni medicina tradicional) | Organización Mundial de la Salud, "Simple Tabulation" en español; la versión está en `cie11.version` |

Se cargan con la migración de datos o con `manage.py cargar_cie`.

## Actualizar el CIE-11

La OMS publica una versión cada enero:

```bash
.venv/bin/python manage.py actualizar_cie11 2027-01
```

Descarga la tabulación, regenera `cie11.csv` y `cie11.version` y carga el
catálogo. Los códigos que ya no existan se desactivan (los diagnósticos
guardados conservan su texto). Para que una instalación nueva lo tenga desde
el principio, guarda en el repositorio los archivos regenerados y agrega una
migración de datos como `0007_cie11_oms.py`.

## Licencia

CIE-11 © Organización Mundial de la Salud, bajo licencia
[CC BY-ND 3.0 IGO](https://creativecommons.org/licenses/by-nd/3.0/igo/).
Los títulos se usan tal como los publica la OMS (solo se les quitan los
guiones de sangría de la tabulación).
