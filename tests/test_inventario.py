from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import TestCase

from apps.inventario import services
from apps.inventario.models import Location, Lot, StockMove, StockQuant

from . import factories as f


class InventarioTests(TestCase):
    def setUp(self):
        self.clinica = f.clinica()
        self.farmacia = f.location('Farmacia', clinica=self.clinica)
        self.almacen = f.location('Almacén', clinica=self.clinica)
        self.proveedor = f.location('Proveedores', Location.USAGE_SUPPLIER)
        self.paciente = f.location('Aplicación a paciente', Location.USAGE_PATIENT)
        self.prod = f.product()

    def move(self, src, dst, qty, **kw):
        return StockMove.objects.create(product=self.prod, location_from=src, location_to=dst,
                                        quantity=Decimal(qty), **kw)

    def qty(self, location, lot=None):
        q = StockQuant.objects.filter(product=self.prod, location=location, lot=lot).first()
        return q.quantity if q else Decimal('0')

    def test_entrada_salida_y_traslado(self):
        entrada = self.move(self.proveedor, self.almacen, '10')
        self.assertEqual(entrada.kind, StockMove.KIND_IN)
        services.confirm_move(entrada)
        services.confirm_move(self.move(self.almacen, self.farmacia, '4'))
        salida = self.move(self.farmacia, self.paciente, '1.5')
        self.assertEqual(salida.kind, StockMove.KIND_OUT)
        services.confirm_move(salida)
        self.assertEqual(self.qty(self.almacen), Decimal('6'))
        self.assertEqual(self.qty(self.farmacia), Decimal('2.5'))
        self.assertEqual(self.prod.qty_available, Decimal('8.5'))

    def test_pendiente_no_mueve_existencias(self):
        self.move(self.proveedor, self.almacen, '10')
        self.assertEqual(self.prod.qty_available, 0)

    def test_no_permite_negativos(self):
        with self.assertRaisesMessage(ValidationError, 'Existencia insuficiente'):
            services.confirm_move(self.move(self.farmacia, self.paciente, '1'))
        self.assertEqual(self.qty(self.farmacia), 0)

    def test_no_confirma_dos_veces_ni_cancela_hecho(self):
        m = services.confirm_move(self.move(self.proveedor, self.farmacia, '3'))
        with self.assertRaises(ValidationError):
            services.confirm_move(m)
        with self.assertRaises(ValidationError):
            services.cancel_move(m)
        self.assertEqual(self.qty(self.farmacia), Decimal('3'))

    def test_servicio_no_lleva_inventario(self):
        servicio = f.product('Consulta', type='service', track_inventory=False)
        m = StockMove.objects.create(product=servicio, location_from=self.proveedor, location_to=self.farmacia,
                                     quantity=1)
        with self.assertRaisesMessage(ValidationError, 'no controla inventario'):
            services.confirm_move(m)

    def test_lotes_obligatorios_y_por_separado(self):
        self.prod.track_lots = True
        self.prod.save()
        with self.assertRaisesMessage(ValidationError, 'requiere lote'):
            services.confirm_move(self.move(self.proveedor, self.farmacia, '5'))
        lot_a = Lot.objects.create(product=self.prod, name='A1')
        lot_b = Lot.objects.create(product=self.prod, name='B1')
        services.confirm_move(self.move(self.proveedor, self.farmacia, '5', lot=lot_a))
        services.confirm_move(self.move(self.proveedor, self.farmacia, '2', lot=lot_b))
        self.assertEqual(self.qty(self.farmacia, lot_a), Decimal('5'))
        self.assertEqual(self.qty(self.farmacia, lot_b), Decimal('2'))

    def test_ajuste_por_conteo(self):
        services.confirm_move(self.move(self.proveedor, self.farmacia, '10'))
        menos = services.set_quantity(self.prod, self.farmacia, '7')
        self.assertEqual(menos.kind, StockMove.KIND_ADJUSTMENT)
        self.assertEqual(self.qty(self.farmacia), Decimal('7'))
        services.set_quantity(self.prod, self.farmacia, '12')
        self.assertEqual(self.qty(self.farmacia), Decimal('12'))
        self.assertIsNone(services.set_quantity(self.prod, self.farmacia, '12'))
