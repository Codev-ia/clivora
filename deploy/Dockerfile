FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Pango para WeasyPrint (reportes PDF); DejaVu de respaldo para símbolos que no trae Urbanist.
RUN apt-get update && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN SECRET_KEY=build DATABASE_URL=sqlite:///tmp/build.db python manage.py collectstatic --noinput

RUN useradd --create-home clivora && mkdir -p /srv/clivora/media && chown -R clivora /app /srv/clivora
USER clivora

EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers ${GUNICORN_WORKERS:-3} --timeout 120"]
