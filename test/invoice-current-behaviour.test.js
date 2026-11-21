'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var pricing = require('../lib/pricing');
var tax = require('../lib/tax');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');
var ledger = require('../lib/ledger');

function item(name, price, qty, hsn) {
  return { id: name, name: name, sku: name, price: price, qty: qty, hsn: hsn };
}

function storedOrder(items, coupon) {
  var totals = pricing.computeTotals(items, coupon || '');
  return {
    id: 7,
    date: '2026-01-02',
    customer: 'Test Customer',
    paymentMode: 'khata',
    items: items,
    coupon: coupon || '',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

test('regression - invoice matches checkout HSN rates and capped SAVE10 discount', function () {
  var order = storedOrder([item('Groundnut oil', 2240, 1, '1508')], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 2194.5);
  assert.equal(order.tax, 104.5);
  assert.equal(figures.total, order.total);
  assert.equal(figures.tax, order.tax);
  assert.equal(figures.discount, order.discount);
  assert.equal(figures.rows[0].gstPercent, 5);
});

test('CURRENT BEHAVIOUR - order pricing uses HSN slabs and splits intra-state GST equally', function () {
  var items = [item('Rice', 100, 1, '1006'), item('Coffee', 100, 1, '0901')];
  var totals = pricing.computeTotals(items, '');

  assert.deepEqual({
    subtotal: totals.subtotal,
    discount: totals.discount,
    taxable: totals.taxable,
    tax: totals.tax,
    cgst: totals.cgst,
    sgst: totals.sgst,
    total: totals.total
  }, { subtotal: 200, discount: 0, taxable: 200, tax: 23, cgst: 11.5, sgst: 11.5, total: 223 });
  assert.deepEqual(totals.lines.map(function (line) { return [line.gstPercent, line.tax]; }), [[5, 5], [18, 18]]);
});

test('CURRENT BEHAVIOUR - invoice uses HSN slabs and matches the amount billed', function () {
  var order = storedOrder([item('Rice', 100, 1, '1006'), item('Coffee', 100, 1, '0901')]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 223); // pricing total stored and charged to the customer
  assert.deepEqual([figures.subtotal, figures.tax, figures.cgst, figures.sgst, figures.total], [200, 23, 11.5, 11.5, 223]);
  assert.deepEqual(figures.rows.map(function (row) { return row.gstPercent; }), [5, 18]);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].delta, 0);
});

test('CURRENT BEHAVIOUR - percent coupon discount and tax match checkout totals', function () {
  var order = storedOrder([item('Rice', 100, 1, '1006'), item('Coffee', 100, 1, '0901')], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [200, 10, 21.85, 211.85]);
  assert.deepEqual([figures.subtotal, figures.discount, figures.tax, figures.total], [200, 10, 21.85, 211.85]);
});

test('CURRENT BEHAVIOUR - flat coupon invoice totals match checkout totals', function () {
  var items = [item('Rice', 200, 1, '1006'), item('Coffee', 200, 1, '0901')];
  var order = storedOrder(items, 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 40.25, 390.25]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 40.25, 390.25]);
});

test('CURRENT BEHAVIOUR - invoice GST split is CGST and SGST only, with no IGST field', function () {
  var figures = invoice.computeInvoiceFigures({ items: [item('Odd amount', 0.05, 1, '1006')] });

  assert.deepEqual([figures.tax, figures.cgst, figures.sgst], [0, 0, 0]);
  assert.equal(Object.hasOwn(figures, 'igst'), false);
});

test('CURRENT BEHAVIOUR - invoice follows checkout normalization for decimal gstRate values', function () {
  var figures = invoice.computeInvoiceFigures({
    items: [{ name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 }]
  });

  assert.deepEqual([figures.rows[0].gstPercent, figures.tax, figures.total], [5, 5, 105]);
  assert.equal(tax.getRateForItem({ gstRate: 0.05 }), 0.05);
});

test('CURRENT BEHAVIOUR - zero value lines remain and fractional HSN-tax lines round individually', function () {
  var figures = invoice.computeInvoiceFigures({
    items: [item('Zero', 0, 3, '1006'), item('Fraction A', 0.05, 1, '1006'), item('Fraction B', 0.05, 1, '1006')]
  });

  assert.deepEqual([figures.rows.length, figures.subtotal, figures.tax, figures.cgst, figures.sgst, figures.total], [3, 0.1, 0, 0, 0, 0.1]);
  assert.deepEqual(figures.rows.map(function (row) { return [row.line, row.lineTax]; }), [[0, 0], [0.05, 0], [0.05, 0]]);
});

test('CURRENT BEHAVIOUR - khata customer billed amount comes from stored order pricing total', function () {
  var order = storedOrder([item('Rice', 100, 1, '1006'), item('Coffee', 100, 1, '0901')]);
  var db = { customers: [{ id: 4, name: 'Test Customer', creditLimit: 1000, openingBalance: 0, totalBilled: 0, totalSettled: 0 }] };
  var result = ledger.chargeOrderToKhata(db, 4, order.total);

  assert.equal(result.ok, true);
  assert.equal(result.customer.totalBilled, 223);
  assert.equal(result.customer.totalBilled, invoice.computeInvoiceFigures(order).total);
});
