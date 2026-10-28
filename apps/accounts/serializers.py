from django.contrib.auth.models import Group
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from apps.core.clinica import allowed_clinicas
from apps.core.limits import check_usuario_nuevo
from apps.core.models import Clinica

from .models import User
from .roles import DESCRIPTIONS, ROLES


def app_roles():
    return Group.objects.filter(name__in=ROLES.values()).order_by('name')


class RoleSerializer(serializers.ModelSerializer):
    description = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = ['id', 'name', 'description']

    def get_description(self, obj):
        return DESCRIPTIONS.get(obj.name, '')


class UserSerializer(serializers.ModelSerializer):
    roles = serializers.PrimaryKeyRelatedField(source='groups', many=True, queryset=Group.objects.none(),
                                               required=False)
    clinicas = serializers.PrimaryKeyRelatedField(many=True, queryset=Clinica.objects.all(), required=False)
    password = serializers.CharField(write_only=True, required=False, allow_blank=True,
                                     style={'input_type': 'password'})
    full_name = serializers.SerializerMethodField()
    role_names = serializers.SerializerMethodField()
    clinica_names = serializers.SerializerMethodField()
    dos_pasos = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ['id', 'username', 'first_name', 'last_name', 'full_name', 'email', 'is_active', 'is_superuser',
                  'roles', 'role_names', 'clinicas', 'clinica_names', 'clinica_activa', 'password', 'last_login',
                  'date_joined', 'dos_pasos']
        read_only_fields = ['is_superuser', 'last_login', 'date_joined']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['roles'].child_relation.queryset = app_roles()

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    def get_role_names(self, obj):
        return sorted(g.name for g in obj.groups.all() if g.name in ROLES.values())

    def get_dos_pasos(self, obj):
        return hasattr(obj, 'dos_pasos')

    def get_clinica_names(self, obj):
        return [c.name for c in obj.clinicas.all()]

    def validate_username(self, value):
        value = value.strip()
        qs = User.objects.filter(username__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError('Ya existe un usuario con ese nombre de usuario.')
        return value

    def validate_clinicas(self, value):
        request = self.context['request']
        allowed = set(allowed_clinicas(request.user).values_list('pk', flat=True))
        if not request.user.is_superuser and any(c.pk not in allowed for c in value):
            raise serializers.ValidationError('Solo puedes asignar clínicas a las que tienes acceso.')
        return value

    def validate(self, attrs):
        request = self.context['request']
        if self.instance and self.instance.is_superuser and not request.user.is_superuser:
            raise serializers.ValidationError('Solo un superusuario puede modificar a otro superusuario.')
        password = attrs.get('password')
        if not self.instance and not password:
            raise serializers.ValidationError({'password': 'Escribe una contraseña inicial.'})
        if password:
            validate_password(password, self.instance)
        # Límite de usuarios activos (superusuarios no cuentan).
        becomes_active = attrs.get('is_active', True if not self.instance else self.instance.is_active)
        was_active = bool(self.instance and self.instance.is_active)
        if becomes_active and not was_active and not (self.instance and self.instance.is_superuser):
            check_usuario_nuevo()
        clinicas = attrs.get('clinicas')
        activa = attrs.get('clinica_activa')
        if clinicas is not None and activa and activa not in clinicas:
            raise serializers.ValidationError({'clinica_activa': 'Debe ser una de sus clínicas permitidas.'})
        return attrs

    def _save(self, instance, validated):
        password = validated.pop('password', None)
        groups = validated.pop('groups', None)
        clinicas = validated.pop('clinicas', None)
        for field, value in validated.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        if clinicas is not None and instance.clinica_activa_id and instance.clinica_activa not in clinicas:
            instance.clinica_activa = clinicas[0] if clinicas else None
        if clinicas and not instance.clinica_activa_id:
            instance.clinica_activa = clinicas[0]
        instance.save()
        if groups is not None:
            # Conserva los grupos que no son roles de Clivora (si los hubiera).
            others = instance.groups.exclude(name__in=ROLES.values())
            instance.groups.set(list(others) + list(groups))
        if clinicas is not None:
            if not self.context['request'].user.is_superuser:
                # No quita clínicas que el administrador no puede ver.
                hidden = instance.clinicas.exclude(pk__in=allowed_clinicas(self.context['request'].user))
                clinicas = list(clinicas) + list(hidden)
            instance.clinicas.set(clinicas)
        return instance

    def create(self, validated):
        return self._save(User(), validated)

    def update(self, instance, validated):
        return self._save(instance, validated)
