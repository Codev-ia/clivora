from rest_framework import serializers

from .limits import check_clinica_nueva, clinicas_activas, usuarios_activos

from .models import Clinica, Lugar, Sala, SystemSettings


def logo_url(clinica):
    """URL del logo (cambia al cambiar el archivo, para no usar una copia vieja)."""
    if not clinica or not clinica.logo:
        return ''
    return f'/clivora/clinica_logo/{clinica.pk}?v={int(clinica.updated_at.timestamp())}'


class ClinicaSerializer(serializers.ModelSerializer):
    lugares_count = serializers.IntegerField(read_only=True, default=0)
    usuarios_count = serializers.IntegerField(read_only=True, default=0)
    logo_url = serializers.SerializerMethodField()
    regimen_fiscal_label = serializers.CharField(source='get_regimen_fiscal_display', read_only=True)
    tipo_persona = serializers.CharField(read_only=True)

    class Meta:
        model = Clinica
        fields = ['id', 'name', 'logo_url', 'phone', 'email', 'city', 'active',
                  'legal_name', 'rfc', 'tipo_persona', 'regimen_fiscal', 'regimen_fiscal_label', 'codigo_postal',
                  'calle', 'numero_exterior', 'numero_interior', 'colonia', 'municipio', 'estado', 'pais',
                  'lugares_count', 'usuarios_count']

    def get_logo_url(self, obj):
        return logo_url(obj)

    def to_internal_value(self, data):
        # El RFC se guarda en mayúsculas; se normaliza antes de validar su formato.
        if hasattr(data, 'copy') and data.get('rfc'):
            data = data.copy()
            data['rfc'] = str(data['rfc']).strip().upper()
        return super().to_internal_value(data)

    def validate(self, attrs):
        becomes_active = attrs.get('active', True if not self.instance else self.instance.active)
        if becomes_active and not (self.instance and self.instance.active):
            check_clinica_nueva()
        return attrs


class SalaSerializer(serializers.ModelSerializer):
    tipo_label = serializers.CharField(source='get_tipo_display', read_only=True)

    class Meta:
        model = Sala
        fields = ['id', 'lugar', 'name', 'tipo', 'tipo_label', 'sequence', 'active']


class LugarSerializer(serializers.ModelSerializer):
    clinica_name = serializers.CharField(source='clinica.name', read_only=True)
    salas = SalaSerializer(many=True, read_only=True)

    class Meta:
        model = Lugar
        fields = ['id', 'clinica', 'clinica_name', 'name', 'address', 'sequence', 'active', 'salas']


class SystemSettingsSerializer(serializers.ModelSerializer):
    usuarios = serializers.SerializerMethodField()
    clinicas = serializers.SerializerMethodField()
    updated_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SystemSettings
        fields = ['max_usuarios', 'max_clinicas', 'usuarios', 'clinicas', 'updated_at', 'updated_by_name']
        read_only_fields = ['updated_at']

    def get_usuarios(self, obj):
        return usuarios_activos()

    def get_clinicas(self, obj):
        return clinicas_activas()

    def get_updated_by_name(self, obj):
        return (obj.updated_by.get_full_name() or obj.updated_by.username) if obj.updated_by_id else ''

    def validate_max_usuarios(self, value):
        if value is not None and value < usuarios_activos():
            raise serializers.ValidationError(
                f'Hay {usuarios_activos()} usuarios activos; el máximo no puede ser menor. Desactiva usuarios primero.')
        return value

    def validate_max_clinicas(self, value):
        if value is not None and value < clinicas_activas():
            raise serializers.ValidationError(
                f'Hay {clinicas_activas()} clínicas activas; el máximo no puede ser menor. Archiva clínicas primero.')
        return value


class ProfileSerializer(serializers.Serializer):
    """Datos de la cuenta propia (Configuración → Sistema / perfil)."""

    username = serializers.CharField(max_length=150)
    first_name = serializers.CharField(max_length=150, allow_blank=True, required=False)
    last_name = serializers.CharField(max_length=150, allow_blank=True, required=False)
    email = serializers.EmailField(allow_blank=True, required=False)

    def validate_username(self, value):
        from apps.accounts.models import User
        value = value.strip()
        if User.objects.filter(username__iexact=value).exclude(pk=self.instance.pk).exists():
            raise serializers.ValidationError('Ya existe un usuario con ese nombre de usuario.')
        return value

    def update(self, instance, validated):
        for field, value in validated.items():
            setattr(instance, field, value)
        instance.save(update_fields=list(validated))
        return instance

    def to_representation(self, instance):
        return {'username': instance.username, 'first_name': instance.first_name, 'last_name': instance.last_name,
                'email': instance.email, 'is_superuser': instance.is_superuser}


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField()
    new_password = serializers.CharField(min_length=8)

    def validate_current_password(self, value):
        if not self.context['request'].user.check_password(value):
            raise serializers.ValidationError('La contraseña actual no es correcta.')
        return value

    def validate_new_password(self, value):
        from django.contrib.auth.password_validation import validate_password
        validate_password(value, self.context['request'].user)
        return value


class CorreoSerializer(serializers.ModelSerializer):
    """Servidor de correo (Configuración → Sistema). La contraseña nunca se
    devuelve: solo si hay una guardada. Vacía o ausente = conservar la actual."""

    smtp_password = serializers.CharField(write_only=True, required=False, allow_blank=True, max_length=255)
    smtp_password_guardada = serializers.SerializerMethodField()

    class Meta:
        model = SystemSettings
        fields = ['correo_activo', 'smtp_host', 'smtp_puerto', 'smtp_seguridad', 'smtp_usuario', 'smtp_password',
                  'smtp_password_guardada', 'remitente_nombre', 'remitente_correo']

    def get_smtp_password_guardada(self, obj):
        return bool(obj.smtp_password_cifrada)

    def validate_smtp_host(self, value):
        return value.strip()

    def validate(self, data):
        def valor(campo):
            return data.get(campo, getattr(self.instance, campo, ''))
        if valor('correo_activo') and not (valor('smtp_host') and valor('remitente_correo')):
            raise serializers.ValidationError(
                'Para activar el servidor de correo escribe el servidor SMTP y el correo del remitente.')
        return data

    def update(self, instance, validated_data):
        from .correo import cifrar

        password = validated_data.pop('smtp_password', '')
        if password:
            instance.smtp_password_cifrada = cifrar(password)
        return super().update(instance, validated_data)


class CorreoPruebaSerializer(serializers.Serializer):
    destinatario = serializers.EmailField()
