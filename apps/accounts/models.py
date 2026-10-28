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
