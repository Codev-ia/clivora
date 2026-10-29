from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Usuario de Clivora. Los roles son grupos de Django (ver roles.py); las
    clínicas permitidas y la activa definen qué datos ve (ver core/clinica.py)."""

    password = models.CharField('contraseña', max_length=255)
    clinicas = models.ManyToManyField('core.Clinica', blank=True, related_name='usuarios',
                                      verbose_name='clínicas permitidas')
    clinica_activa = models.ForeignKey('core.Clinica', null=True, blank=True, on_delete=models.SET_NULL,
                                       related_name='+', verbose_name='clínica activa')

    class Meta:
        verbose_name = 'usuario'
        verbose_name_plural = 'usuarios'
        ordering = ['first_name', 'last_name', 'username']


class DosPasos(models.Model):
    """Verificación en dos pasos (TOTP, app de autenticación) de un usuario:
    si existe el registro, está activa. Ver apps/accounts/dos_pasos.py."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='dos_pasos', verbose_name='usuario')
    secreto_cifrado = models.TextField('secreto (cifrado)', editable=False)
    activado_en = models.DateTimeField('activada el', auto_now_add=True)
    # Paso de tiempo del último código aceptado: el mismo código no sirve dos veces.
    ultimo_paso = models.BigIntegerField(default=0, editable=False)
    # SHA-256 de los códigos de recuperación sin usar (los originales solo se
    # muestran una vez, al generarlos).
    codigos_recuperacion = models.JSONField(default=list, editable=False)

    class Meta:
        verbose_name = 'verificación en dos pasos'
        verbose_name_plural = 'verificación en dos pasos'

    def __str__(self):
        return f'Verificación en dos pasos de {self.user}'


class Especialidad(models.Model):
    """Catálogo de especialidades médicas (Configuración → Especialidades)."""

    name = models.CharField('nombre', max_length=120, unique=True)
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'especialidad'
        verbose_name_plural = 'especialidades'
        ordering = ['name']

    def __str__(self):
        return self.name


class PerfilMedico(models.Model):
    """Datos profesionales de un médico o enfermera (pantalla Médicos): cédulas
    y la firma que llevan sus documentos; de los médicos, además, especialidad
    y enfermera asignada."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='perfil_medico', verbose_name='médico')
    especialidad = models.ForeignKey(Especialidad, null=True, blank=True, on_delete=models.PROTECT,
                                     related_name='medicos', verbose_name='especialidad')
    cedula_profesional = models.CharField('cédula profesional', max_length=20, blank=True)
    cedula_especialidad = models.CharField('cédula de especialidad', max_length=20, blank=True)
    universidad = models.CharField('universidad', max_length=200, blank=True)
    telefono = models.CharField('teléfono', max_length=40, blank=True)
    enfermera = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='medicos_asignados',
                                  verbose_name='enfermera asignada')
    firma = models.ImageField('firma', upload_to='medicos/firmas/', blank=True)
    updated_at = models.DateTimeField('actualizado', auto_now=True)

    class Meta:
        verbose_name = 'perfil de médico'
        verbose_name_plural = 'perfiles de médicos'

    def __str__(self):
        return f'Perfil de {self.user}'
