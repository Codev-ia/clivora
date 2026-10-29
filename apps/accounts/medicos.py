"""Médicos y enfermería (datos profesionales y firma; a cada médico, su
especialidad y su enfermera asignada) y el catálogo de especialidades.

El personal clínico son los usuarios activos con rol Médicos o Médico Externo
(tipo "medico") o Enfermería o Jefa de Enfermería (tipo "enfermeria"; quien
tiene ambos cuenta como médico). Su perfil (PerfilMedico) se crea la primera
vez que se guarda. Quien tiene el permiso accounts.change_perfilmedico
(Administrador) ve y edita a todo el personal de sus clínicas; los demás solo
su propia ficha.
"""
from pathlib import Path

from django.contrib.auth.decorators import login_required
from django.db.models import Q
from django.http import FileResponse, Http404
from django.views.decorators.http import require_GET
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.clinica import allowed_clinicas
from apps.core.logos import procesar_imagen
from apps.core.permissions import ModelPermissions
from apps.web.roles import has_role, is_admin

from .models import Especialidad, PerfilMedico, User
from .roles import ROLES

ROLES_MEDICO = [ROLES['group_medicos'], ROLES['group_medico_externo']]
ROLES_ENFERMERIA = [ROLES['group_enfermeria'], ROLES['group_jefa_enfermeria']]
FIRMA_MAX_LADO = 800


def puede_administrar(user):
    return is_admin(user) or user.has_perm('accounts.change_perfilmedico')


def es_personal(user):
    return user.groups.filter(name__in=ROLES_MEDICO + ROLES_ENFERMERIA).exists()


def tipo_de(user):
    """'medico' o 'enfermeria' (usa los grupos ya cargados con prefetch)."""
    nombres = {g.name for g in user.groups.all()}
    return 'medico' if nombres & set(ROLES_MEDICO) else 'enfermeria'


def personal():
    return User.objects.filter(is_active=True, groups__name__in=ROLES_MEDICO + ROLES_ENFERMERIA).distinct()


def medicos():
    return User.objects.filter(is_active=True, groups__name__in=ROLES_MEDICO).distinct()


def enfermeras():
    return User.objects.filter(is_active=True, groups__name__in=ROLES_ENFERMERIA).distinct()


def perfil_de(user):
    """Perfil del médico sin crearlo (None si nunca se ha guardado)."""
    try:
        return user.perfil_medico
    except PerfilMedico.DoesNotExist:
        return None


def firma_url(perfil):
    """URL de la firma (cambia al cambiar el archivo, para no usar una copia vieja)."""
    if not perfil or not perfil.firma:
        return ''
    return f'/clivora/medico_firma/{perfil.user_id}?v={int(perfil.updated_at.timestamp())}'


def firma_path(user):
    """Ruta en disco de la firma (para los PDF), o '' si no tiene."""
    perfil = perfil_de(user) if user else None
    if not perfil or not perfil.firma:
        return ''
    try:
        return Path(perfil.firma.path).as_uri()
    except (ValueError, NotImplementedError):
        return ''


def _nombre(user):
    return (user.get_full_name() or user.username) if user else ''


# ── Especialidades ────────────────────────────────────────────────────────

class EspecialidadSerializer(serializers.ModelSerializer):
    medicos_count = serializers.SerializerMethodField()

    class Meta:
        model = Especialidad
        fields = ['id', 'name', 'active', 'medicos_count']

    def get_medicos_count(self, obj):
        return obj.medicos.filter(user__is_active=True).count()

    def validate_name(self, value):
        value = ' '.join(value.split())
        qs = Especialidad.objects.filter(name__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError('Ya existe esa especialidad.')
        return value


class EspecialidadViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                          mixins.UpdateModelMixin, viewsets.GenericViewSet):
    """Catálogo de especialidades. Leer: cualquier usuario con sesión (los
    médicos eligen la suya); dar de alta o cambiar: permisos del modelo. No se
    borran: se desactivan. Filtros: ?active=0|all."""

    serializer_class = EspecialidadSerializer
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_permissions(self):
        if self.action in ('list', 'retrieve'):
            return [IsAuthenticated()]
        return [ModelPermissions()]

    def get_queryset(self):
        qs = Especialidad.objects.all()
        active = self.request.query_params.get('active', '1')
        if self.action == 'list' and active != 'all':
            qs = qs.filter(active=active not in ('0', 'false'))
        return qs


# ── Médicos y enfermería ──────────────────────────────────────────────────

PERFIL_TEXTOS = ['cedula_profesional', 'cedula_especialidad', 'universidad', 'telefono']


class MedicoSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    full_name = serializers.SerializerMethodField()
    username = serializers.CharField(read_only=True)
    email = serializers.EmailField(read_only=True)
    tipo = serializers.SerializerMethodField()
    es_externo = serializers.SerializerMethodField()
    # Campos del perfil: se escriben aquí y se leen en to_representation.
    especialidad = serializers.PrimaryKeyRelatedField(queryset=Especialidad.objects.all(), allow_null=True,
                                                      required=False, write_only=True)
    especialidad_name = serializers.SerializerMethodField()
    cedula_profesional = serializers.RegexField(r'^\d{0,20}$', required=False, allow_blank=True, write_only=True,
                                                error_messages={
        'invalid': 'La cédula profesional solo lleva números.'})
    cedula_especialidad = serializers.RegexField(r'^\d{0,20}$', required=False, allow_blank=True, write_only=True,
                                                 error_messages={
        'invalid': 'La cédula de especialidad solo lleva números.'})
    universidad = serializers.CharField(max_length=200, required=False, allow_blank=True, write_only=True)
    telefono = serializers.CharField(max_length=40, required=False, allow_blank=True, write_only=True)
    enfermera = serializers.PrimaryKeyRelatedField(queryset=User.objects.none(), allow_null=True, required=False,
                                                   write_only=True)
    enfermera_name = serializers.SerializerMethodField()
    medicos_asignados = serializers.SerializerMethodField()
    firma_url = serializers.SerializerMethodField()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['enfermera'].queryset = enfermeras()

    def _perfil(self, obj):
        return perfil_de(obj)

    def to_representation(self, obj):
        data = super().to_representation(obj)
        perfil = self._perfil(obj)
        data['especialidad'] = perfil.especialidad_id if perfil else None
        data['enfermera'] = perfil.enfermera_id if perfil else None
        for campo in PERFIL_TEXTOS:
            data[campo] = getattr(perfil, campo) if perfil else ''
        return data

    def get_full_name(self, obj):
        return _nombre(obj)

    def get_tipo(self, obj):
        return tipo_de(obj)

    def get_medicos_asignados(self, obj):
        """De una enfermera: los médicos que la tienen asignada."""
        return sorted(_nombre(p.user) for p in obj.medicos_asignados.all() if p.user.is_active)

    def get_es_externo(self, obj):
        return ROLES['group_medico_externo'] in {g.name for g in obj.groups.all()}

    def get_especialidad_name(self, obj):
        perfil = self._perfil(obj)
        return perfil.especialidad.name if perfil and perfil.especialidad else ''

    def get_enfermera_name(self, obj):
        perfil = self._perfil(obj)
        return _nombre(perfil.enfermera) if perfil and perfil.enfermera else ''

    def get_firma_url(self, obj):
        return firma_url(self._perfil(obj))

    def validate_especialidad(self, value):
        actual = getattr(self._perfil(self.instance), 'especialidad_id', None) if self.instance else None
        if value and not value.active and value.pk != actual:
            raise serializers.ValidationError('Esa especialidad está desactivada.')
        return value

    def validate(self, attrs):
        # Especialidad, cédula de especialidad y enfermera asignada son solo de médicos.
        if self.instance and tipo_de(self.instance) == 'enfermeria':
            for campo in ('especialidad', 'cedula_especialidad', 'enfermera'):
                if attrs.get(campo):
                    raise serializers.ValidationError({campo: 'Solo aplica a médicos.'})
        return attrs

    def update(self, instance, validated):
        perfil, _ = PerfilMedico.objects.get_or_create(user=instance)
        for campo, value in validated.items():
            setattr(perfil, campo, value.strip() if isinstance(value, str) else value)
        perfil.save()
        instance.perfil_medico = perfil
        return instance


class MedicoViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                    viewsets.GenericViewSet):
    """Médicos y enfermería de las clínicas permitidas (sin permiso de
    administrarlos, cada quien solo se ve a sí mismo). Se dan de alta en
    Usuarios y roles con su rol. Filtros: ?q=, ?tipo=medico|enfermeria,
    ?especialidad=<id>|none (none: médicos sin especialidad)."""

    permission_classes = [IsAuthenticated]
    serializer_class = MedicoSerializer
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def get_queryset(self):
        user = self.request.user
        qs = personal().prefetch_related('groups', 'medicos_asignados__user').select_related(
            'perfil_medico__especialidad', 'perfil_medico__enfermera')
        if not puede_administrar(user):
            if not es_personal(user):
                raise PermissionDenied
            return qs.filter(pk=user.pk)
        if not user.is_superuser:
            qs = qs.filter(clinicas__in=allowed_clinicas(user)).distinct()
        p = self.request.query_params
        if self.action == 'list':
            if p.get('q'):
                q = p['q'].strip()
                qs = qs.filter(Q(first_name__icontains=q) | Q(last_name__icontains=q) | Q(username__icontains=q)
                               | Q(perfil_medico__cedula_profesional__icontains=q))
            if p.get('tipo') == 'medico':
                qs = qs.filter(pk__in=medicos())
            elif p.get('tipo') == 'enfermeria':
                qs = qs.exclude(pk__in=medicos())
            if p.get('especialidad') == 'none':
                qs = qs.filter(Q(perfil_medico__isnull=True) | Q(perfil_medico__especialidad__isnull=True),
                               pk__in=medicos())
            elif p.get('especialidad'):
                qs = qs.filter(perfil_medico__especialidad=p['especialidad'])
        return qs.order_by('first_name', 'last_name', 'username')

    def _respuesta(self, medico):
        medico = self.get_queryset().get(pk=medico.pk)
        return Response(MedicoSerializer(medico, context=self.get_serializer_context()).data)

    @action(detail=True, methods=['post', 'delete'])
    def firma(self, request, pk=None):
        """POST {"firma": "data:image/png;base64,..."} sube/reemplaza la firma;
        DELETE la quita."""
        medico = self.get_object()
        content = None
        if request.method == 'POST':
            content = procesar_imagen(request.data.get('firma'), campo='firma', nombre='La firma',
                                      max_lado=FIRMA_MAX_LADO)
        perfil, _ = PerfilMedico.objects.get_or_create(user=medico)
        if perfil.firma:
            perfil.firma.delete(save=False)
        if content:
            perfil.firma.save(f'medico-{medico.pk}.png', content, save=False)
        else:
            perfil.firma = ''
        perfil.save()
        return self._respuesta(medico)

    @action(detail=False, methods=['get'])
    def enfermeras(self, request):
        """GET /api/v1/medicos/enfermeras/ — opciones de "Enfermera asignada"."""
        qs = enfermeras()
        if not request.user.is_superuser:
            qs = qs.filter(clinicas__in=allowed_clinicas(request.user)).distinct()
        return Response([{'id': u.pk, 'name': _nombre(u)}
                         for u in qs.order_by('first_name', 'last_name', 'username')])


@require_GET
@login_required
def firma(request, user_id):
    """La imagen de la firma, solo para quien puede ver la ficha del médico."""
    user = request.user
    if user.pk != user_id and not puede_administrar(user):
        raise Http404
    medico = personal().filter(pk=user_id).select_related('perfil_medico').first()
    perfil = perfil_de(medico) if medico else None
    if not perfil or not perfil.firma:
        raise Http404
    # Un administrador solo ve las firmas de los médicos de sus clínicas.
    if user.pk != user_id and not user.is_superuser \
            and not medico.clinicas.filter(pk__in=allowed_clinicas(user)).exists():
        raise Http404
    response = FileResponse(perfil.firma.open('rb'), content_type='image/png')
    response['Cache-Control'] = 'private, max-age=86400'
    return response


def resumen(user):
    """Especialidad y cédulas del médico, para catálogos y reportes."""
    perfil = perfil_de(user) if user else None
    if not perfil:
        return {'especialidad_id': None, 'especialidad': '', 'cedula_profesional': '', 'cedula_especialidad': ''}
    return {
        'especialidad_id': perfil.especialidad_id,
        'especialidad': perfil.especialidad.name if perfil.especialidad else '',
        'cedula_profesional': perfil.cedula_profesional,
        'cedula_especialidad': perfil.cedula_especialidad,
    }


def puede_ver_medicos(user):
    return puede_administrar(user) or any(
        has_role(user, key) for key in ('group_medicos', 'group_medico_externo', 'group_enfermeria',
                                        'group_jefa_enfermeria'))
