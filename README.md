# Clivora

Plataforma clínica de **Codevia**: expediente, agenda, tratamientos, farmacia e
inventario para clínicas, con base de datos propia (PostgreSQL) y lista para
correr en un VPS.

Hoy incluye:

- **Configuración**: clínicas (multiclínica), lugares de atención y sus salas,
  usuarios y roles, productos y listas de precios, límites del sistema.
- **Pacientes, Agenda y Tratamientos**, con auto-agendado público.
- **Expediente**: Historia Clínica y diagnósticos con catálogo CIE-10 / CIE-11.
- **Farmacia**: inventario (entradas, salidas, traslados, ajustes, lotes).

Sin ventas ni cotizaciones por ahora — ver [docs/ALCANCE.md](docs/ALCANCE.md).

## Multiclínica

Cada usuario tiene **clínicas permitidas** y una **clínica activa** (selector en
el encabezado). Los lugares y salas, el inventario y las listas de precios son
de una clínica (productos y listas pueden ser "de todas"); los pacientes y los
catálogos son compartidos. El filtrado se hace siempre en el servidor
(`apps/core/clinica.py`).

## Tecnologías

- Python 3.10+ · Django 5.2 · Django REST Framework
- PostgreSQL 14+ (con la extensión `pg_trgm`, que se activa al migrar)
- Gunicorn + Nginx (producción), WhiteNoise para archivos estáticos

## Instalación local

```bash
python3 -m virtualenv .venv          # o: python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
createdb clivora
cp .env.example .env                 # ajustar SECRET_KEY, DEBUG=True, DATABASE_URL
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_roles
.venv/bin/python manage.py createsuperuser
.venv/bin/python manage.py runserver 8001
```

- **Clivora**: http://localhost:8001/ (inicio de sesión en `/clivora/login`).
  El superusuario entra sin clínicas y da de alta la primera en Configuración.
- Panel de administración (soporte técnico): http://localhost:8001/admin/
- API navegable: http://localhost:8001/api/v1/

## Frontend

`frontend/` contiene las plantillas y los archivos estáticos, servidos en
`/clivora` (aplicación), `/clivora/login` y `/clivora/static/...`.

- `static/assets/css/styles.css`: estilos base; `clivora-theme.css`: colores,
  tipografía y componentes de la identidad de Clivora (se carga al final).
- `static/assets/js/app.js`: la aplicación; `app-ui.js`, `config.js` e
  `inventario.js`: Configuración y Farmacia.
- El frontend consume `/clivora/api/...`; una ruta que todavía no existe
  responde 404 en JSON y esa sección se ve vacía.

## Comandos

| Comando | Para qué |
|---|---|
| `manage.py seed_roles` | Crea/actualiza los roles y sus permisos. |
| `manage.py cargar_cie` | Crea/actualiza el catálogo CIE-10 / CIE-11 desde `apps/expediente/data/*.csv` (ya se carga solo al migrar). |
| `manage.py test tests` | Pruebas automáticas. |

## API

| Ruta | Descripción |
|---|---|
| `/api/v1/inventario/productos/` | Productos (`?q=`, `?type=`, `?category=`, `?track_inventory=1`, `?active=0`). Borrar = archivar. |
| `/api/v1/inventario/categorias/`, `unidades/`, `ubicaciones/`, `lotes/` | Catálogos. |
| `/api/v1/inventario/existencias/` | Existencias actuales, solo lectura (`?product=`, `?location=`, `?expiring_before=`). |
| `/api/v1/inventario/movimientos/` | Entradas, salidas, traslados. Se crean pendientes; `POST …/<id>/confirmar/` mueve el inventario, `…/<id>/cancelar/` los descarta. `POST …/ajuste/` = conteo físico. |
| `/api/v1/core/clinicas/`, `core/lugares/`, `core/salas/` | Clínicas, lugares de atención y salas. |
| `/api/v1/usuarios/`, `/api/v1/roles/` | Usuarios (roles y clínicas permitidas) y catálogo de roles. |
| `POST /api/v1/me/clinica/` | Cambia la clínica activa del usuario. |
| `/api/v1/precios/listas/`, `productos/?pricelist=`, `aseguradoras/` | Listas de precios y sus precios por producto. |
| `/api/v1/precios/calcular/?pricelist=&product=` | Precio de un producto en una lista. |
| `/clivora/api/...` | Rutas que usa el frontend (pacientes, agenda, expediente, farmacia…). |

Permisos por rol: **Administrador** configura todo (clínicas, lugares,
usuarios, productos, precios); **Farmacia** administra inventario;
**Comercial** administra listas de precios; **Acceso a Clivora** permite entrar.

## Listas de precios

Una lista tiene **precios fijos por producto** y, opcional, una **lista base**
con % de descuento. El precio de un producto sale de la lista; si no lo tiene,
de la lista base; si tampoco, de su precio de venta.

## Reglas de inventario

- Las existencias solo cambian al confirmar un movimiento; quedan registrados
  quién, cuándo y por qué.
- No se permite dejar una ubicación interna en negativo (salvo ajustes por conteo).
- Un movimiento hecho no se edita ni se cancela: se corrige con el inverso.
- Productos con control de lotes piden lote (con caducidad) en cada movimiento.

## Despliegue (VPS)

El hosting compartido no corre Python + PostgreSQL: se necesita un **VPS**.
Con Docker:

```bash
cp .env.example .env      # DEBUG=False, ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, SECRET_KEY
export POSTGRES_PASSWORD=…
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec web python manage.py seed_roles
docker compose -f deploy/docker-compose.yml exec web python manage.py createsuperuser
```

Después: HTTPS con certbot y respaldo diario con `deploy/backup.sh` (cron).

Sin Docker: instalar PostgreSQL y Nginx en el VPS, crear el virtualenv, y correr
`gunicorn config.wsgi:application --bind 127.0.0.1:8000` como servicio de systemd,
con Nginx como proxy (ver `deploy/nginx.conf`, cambiando `web:8000` por
`127.0.0.1:8000`).
