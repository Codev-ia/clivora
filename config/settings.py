"""Configuración de Clivora (Codevia).

Todo lo que cambia entre ambientes (local, staging, producción en Hostinger u
otro servidor) se lee de variables de entorno o de un archivo .env en la raíz
del proyecto — ver .env.example.
"""
from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, False),
    ALLOWED_HOSTS=(list, ['localhost', '127.0.0.1']),
    CSRF_TRUSTED_ORIGINS=(list, []),
    TIME_ZONE=(str, 'America/Monterrey'),
)
environ.Env.read_env(BASE_DIR / '.env')

SECRET_KEY = env('SECRET_KEY')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = env('ALLOWED_HOSTS')
CSRF_TRUSTED_ORIGINS = env('CSRF_TRUSTED_ORIGINS')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'apps.core',
    'apps.accounts',
    'apps.inventario',
    'apps.precios',
    'apps.pacientes',
    'apps.agenda',
    'apps.expediente',
    'apps.web',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'apps.core.clinica.ClinicaMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

# Base de datos PostgreSQL.
# DATABASE_URL=postgres://usuario:contraseña@host:5432/clivora
DATABASES = {'default': env.db('DATABASE_URL')}
DATABASES['default']['ATOMIC_REQUESTS'] = True

AUTH_USER_MODEL = 'accounts.User'


AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'es-mx'
TIME_ZONE = env('TIME_ZONE')
USE_I18N = True
USE_TZ = True

# Prefijo de los archivos estáticos (/clivora/static/...): el HTML y el JS del
# frontend de Clivora (carpeta frontend/) usan esas rutas tal cual.
STATIC_URL = '/clivora/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_DIRS = [BASE_DIR / 'frontend' / 'static']
APP_TEMPLATES_DIR = BASE_DIR / 'frontend' / 'templates'

LOGIN_URL = '/clivora/login'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'},
}

# Archivos subidos (expedientes, adjuntos). Fuera de la carpeta pública: se
# sirven solo a través de vistas con permisos, nunca directo por Nginx.
MEDIA_ROOT = env.path('MEDIA_ROOT', default=BASE_DIR / 'media')
# Los archivos llegan dentro del JSON como base64 (≈ +33 %): mismo tope que
# client_max_body_size de deploy/nginx.conf.
DATA_UPLOAD_MAX_MEMORY_SIZE = 25 * 1024 * 1024

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Correo (citas, restablecer contraseña). El servidor se configura en
# Configuración → Sistema (apps/core/correo.py); mientras no esté activado
# ahí, se usa EMAIL_FALLBACK_BACKEND con las variables EMAIL_* (en
# desarrollo se imprimen en la consola).
EMAIL_BACKEND = 'apps.core.correo.ConfiguredEmailBackend'
EMAIL_FALLBACK_BACKEND = env('EMAIL_BACKEND', default='django.core.mail.backends.console.EmailBackend')
EMAIL_HOST = env('EMAIL_HOST', default='')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
DEFAULT_FROM_EMAIL = env('DEFAULT_FROM_EMAIL', default='Clivora <no-responder@localhost>')
# Vigencia del enlace para restablecer la contraseña (segundos).
PASSWORD_RESET_TIMEOUT = env.int('PASSWORD_RESET_TIMEOUT', default=2 * 60 * 60)

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_PAGINATION_CLASS': 'apps.core.pagination.Pagination',
    'PAGE_SIZE': 50,
    # Igual que el frontend: las pruebas mandan JSON (en formulario HTML una
    # casilla ausente cuenta como desmarcada).
    'TEST_REQUEST_DEFAULT_FORMAT': 'json',
}

# Producción detrás de Nginx con HTTPS.
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = env.int('SECURE_HSTS_SECONDS', default=0)

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': env('LOG_LEVEL', default='INFO')},
    # Al generar un PDF, WeasyPrint sube fontTools a DEBUG para capturar sus
    # avisos (los vuelve a registrar en el logger "weasyprint"): sin
    # propagate=False cada paso del recorte de fuentes salía en la consola.
    'loggers': {'fontTools': {'level': 'WARNING', 'propagate': False}},
}
