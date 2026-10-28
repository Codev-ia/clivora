"""Pestaña Compartir del expediente: con qué médico se compartió. Crear y
quitar requiere el rol "Compartir Expediente" (canShare de /api/me)."""
from django.contrib.auth.decorators import login_required
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods, require_POST

from apps.accounts.models import User
from apps.accounts.roles import ROLES
from apps.core.html import limpiar as limpiar_html
from apps.web.roles import has_role

from .compat import _body, _json, visible_pacientes
from .models import ExpedienteCompartido


def puede_compartir(user):
    return has_role(user, 'group_compartir_expediente')


def _nombre(user):
    return (user.get_full_name() or user.username) if user else ''


def serializar(rec):
    return {
        'id': rec.pk, 'doctor_id': rec.medico_id, 'doctor_name': _nombre(rec.medico),
        'shared_by_name': _nombre(rec.compartido_por), 'note': rec.nota,
        'create_date': rec.created_at.isoformat(),
        # Compartir archivos sueltos se hace por WhatsApp/Facebook desde
        # Archivos: aquí siempre es el expediente completo.
        'file_titles': [],
    }


@csrf_exempt  # app.js no manda token CSRF en estas rutas
@login_required
@require_http_methods(['GET', 'POST'])
def compartidos(request, patient_id):
    paciente = visible_pacientes(request.user).filter(pk=patient_id).first()
    if not paciente:
        return _json({'error': 'not_found'}, status=404)
    if request.method == 'GET':
        qs = paciente.compartidos.select_related('medico', 'compartido_por')
        return _json([serializar(r) for r in qs])
    if not puede_compartir(request.user):
        return _json({'error': 'forbidden'}, status=403)
    payload = _body(request)
    medicos = [ROLES['group_medicos'], ROLES['group_medico_externo']]
    medico = User.objects.filter(pk=payload.get('doctor_id') if str(payload.get('doctor_id', '')).isdigit() else None,
                                 is_active=True, groups__name__in=medicos).first()
    if not medico:
        return _json({'error': 'missing_doctor'}, status=400)
    rec = ExpedienteCompartido.objects.create(paciente=paciente, medico=medico, compartido_por=request.user,
                                              nota=limpiar_html(payload.get('note')))
    return _json(serializar(rec))


@csrf_exempt
@login_required
@require_POST
def compartido_borrar(request, share_id):
    """Quitar el registro le quita el acceso al médico externo."""
    if not puede_compartir(request.user):
        return _json({'error': 'forbidden'}, status=403)
    ExpedienteCompartido.objects.filter(pk=share_id, paciente__in=visible_pacientes(request.user)).delete()
    return _json({'ok': True})
