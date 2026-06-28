const ORDER_ID = document.body.dataset.orderId;
const backdrop = document.getElementById('dialog-backdrop');
const dialogTitle = document.getElementById('dialog-title');
const dialogDescription = document.getElementById('dialog-description');
const dialogBody = document.getElementById('dialog-body');
const dialogMessage = document.getElementById('dialog-message');
const dialogConfirm = document.getElementById('dialog-confirm');
const dialogCancel = document.getElementById('dialog-cancel');
const dialogClose = document.getElementById('dialog-close');
const workflowStatusElement = document.getElementById('workflow-status');
const paymentHeadingStatus = document.getElementById('payment-heading-status');
const archiveHeadingStatus = document.getElementById('archive-heading-status');
const deliveryHeadingStatus = document.getElementById('delivery-heading-status');
const workflowHelp = document.getElementById('workflow-help');
const fulfillButton = document.getElementById('btn-fulfill');
const progressButton = document.getElementById('btn-inprogress');
const holdButton = document.getElementById('btn-onhold');
const markPaidButton = document.getElementById('btn-mark-paid');
const refundButton = document.getElementById('btn-refund');
const cancelOrderButton = document.getElementById('btn-cancel-order');
const financialStatusElement = document.getElementById('financial-status');
const paymentHelp = document.getElementById('payment-help');
const cancellationDetails = document.getElementById('cancellation-details');
const lineItemsList = document.getElementById('line-items-list');
const fulfilledItemsCard = document.getElementById('fulfilled-items-card');
const fulfilledItemsList = document.getElementById('fulfilled-items-list');
const cancelFulfillmentButton = document.getElementById('btn-cancel-fulfillment');
const tagList = document.getElementById('tag-list');
let order = null;
let dialogBusy = false;
let confirmHandler = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  document.getElementById('toast-region').appendChild(element);
  setTimeout(() => element.remove(), 3800);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return body;
}

function setDialogBusy(busy, label = 'Save') {
  dialogBusy = busy;
  dialogConfirm.disabled = busy;
  dialogCancel.disabled = busy;
  dialogClose.disabled = busy;
  dialogConfirm.textContent = busy ? 'Working…' : label;
}

function closeDialog() {
  if (dialogBusy) return;
  backdrop.hidden = true;
  document.body.classList.remove('dialog-open');
  confirmHandler = null;
}

function openDialog({ title, description = '', body, confirmLabel = 'Save', onConfirm }) {
  dialogTitle.textContent = title;
  dialogDescription.textContent = description;
  dialogBody.innerHTML = body;
  dialogMessage.textContent = '';
  dialogMessage.className = 'form-message';
  dialogConfirm.textContent = confirmLabel;
  confirmHandler = onConfirm;
  backdrop.hidden = false;
  document.body.classList.add('dialog-open');
  setTimeout(() => dialogBody.querySelector('input, textarea, select')?.focus(), 0);
}

function showDialogError(error) {
  dialogMessage.textContent = error.message;
  dialogMessage.className = 'form-message error';
}

function workflowStatus(value) {
  return String(value || 'UNFULFILLED').toUpperCase();
}

const CANCEL_REASON_LABELS = {
  CUSTOMER: 'Customer request',
  INVENTORY: 'Inventory issue',
  FRAUD: 'Fraud',
  DECLINED: 'Payment declined',
  STAFF: 'Staff error',
  OTHER: 'Other'
};

const DATE_FORMAT = {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
};

function financialBadgeClass(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'PAID') return 'badge-paid';
  if (['REFUNDED', 'VOIDED'].includes(value)) return 'badge-cancelled';
  if (value === 'PARTIALLY_REFUNDED') return 'badge-partially-refunded';
  return 'badge-pending';
}

function badgeClass(status) {
  return `badge badge-${String(status || 'pending').toLowerCase().replaceAll('_', '-')}`;
}

function badgeLabel(status) {
  return String(status || '-').toUpperCase().replaceAll('_', ' ');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-US', DATE_FORMAT);
}

function itemThumb(imageUrl, alt) {
  if (imageUrl) {
    return `<img class="item-thumb" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt || 'Product')}">`;
  }
  return '<div class="item-thumb item-thumb-placeholder" aria-hidden="true">No img</div>';
}

function lineItemRow(item, metaRight) {
  const sku = item.sku || '—';
  const barcode = item.barcode || '—';
  return `<div class="item-row-with-image">
    ${itemThumb(item.image_url, item.title)}
    <div class="item-details">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.variant_title || '')}</span>
      <div class="item-sku">SKU: ${escapeHtml(sku)} · Barcode: ${escapeHtml(barcode)}</div>
    </div>
    <div class="item-meta">${metaRight}</div>
  </div>`;
}

function renderLineItems() {
  const items = (order.line_items || []).filter(item => Number(item.currentQuantity ?? item.current_quantity ?? item.quantity) > 0);
  lineItemsList.innerHTML = items.length
    ? items.map(item => lineItemRow(
      item,
      `${escapeHtml(item.currentQuantity ?? item.current_quantity ?? item.quantity)} open / ${escapeHtml(item.quantity)} total`
    )).join('')
    : '<p class="muted">No unfulfilled items remain.</p>';
}

function successfulFulfillments() {
  return (order.fulfillments || [])
    .filter(fulfillment =>
      fulfillment.cancellable || String(fulfillment.status || '').toUpperCase() === 'SUCCESS'
    )
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function renderFulfilledItems() {
  const fulfilled = successfulFulfillments();
  cancelFulfillmentButton.hidden = !fulfilled.length;
  cancelFulfillmentButton.dataset.fulfillmentId = fulfilled[0]?.id || '';

  const byLineItem = new Map();
  for (const fulfillment of fulfilled) {
    const tracking = fulfillment.tracking?.number
      ? `${fulfillment.tracking.company || 'Carrier'}: ${fulfillment.tracking.number}`
      : 'No tracking';
    for (const node of fulfillment.lineItems || []) {
      const item = node.lineItem;
      if (!item) continue;
      const key = item.id;
      const existing = byLineItem.get(key) || {
        item: {
          title: item.title,
          variant_title: item.variant_title,
          sku: item.sku,
          barcode: '',
          image_url: item.image_url
        },
        quantity: 0,
        tracking: new Set()
      };
      existing.quantity += Number(node.quantity) || 0;
      existing.tracking.add(tracking);
      byLineItem.set(key, existing);
    }
  }

  const rows = [...byLineItem.values()]
    .filter(entry => entry.quantity > 0)
    .map(entry => lineItemRow(
      entry.item,
      `<div>${escapeHtml(entry.quantity)} fulfilled<br><span>${escapeHtml([...entry.tracking].join(', '))}</span></div>`
    ));

  fulfilledItemsList.innerHTML = rows.length
    ? rows.join('')
    : '<p class="muted">No fulfilled items yet.</p>';
}

cancelFulfillmentButton.addEventListener('click', async () => {
  const fulfillmentId = cancelFulfillmentButton.dataset.fulfillmentId;
  if (!fulfillmentId) return;
  if (!window.confirm('Cancel the latest successful fulfillment in Shopify?')) return;
  const original = cancelFulfillmentButton.textContent;
  cancelFulfillmentButton.disabled = true;
  cancelFulfillmentButton.textContent = 'Working...';
  try {
    const result = await api(
      `/api/orders/${encodeURIComponent(ORDER_ID)}/fulfillments/${encodeURIComponent(fulfillmentId)}/cancel`,
      { method: 'POST' }
    );
    order = result.order;
    renderOrder();
    toast('Fulfillment cancelled');
  } catch (error) {
    toast(error.message, true);
  } finally {
    cancelFulfillmentButton.disabled = false;
    cancelFulfillmentButton.textContent = original;
  }
});

async function removeTag(tag) {
  if (!window.confirm(`Remove tag "${tag}" from this order?`)) return;
  try {
    const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/tag`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [tag] })
    });
    order = result.order;
    renderOrder();
    toast('Tag removed');
  } catch (error) {
    toast(error.message, true);
  }
}

function renderTags() {
  const tags = Array.isArray(order.tags) ? order.tags : [];
  tagList.innerHTML = tags.length
    ? tags.map(tag => `<button type="button" class="chip-removable" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span aria-hidden="true">×</span></button>`).join('')
    : '<span class="muted">No tags</span>';
}

function syncHoldButton(held) {
  if (held) {
    holdButton.textContent = 'Release Hold';
    holdButton.className = 'btn btn-danger';
    holdButton.disabled = false;
  } else {
    holdButton.textContent = 'Mark as On Hold';
    holdButton.className = 'btn';
  }
}

function hasRefundableItems() {
  return (order.line_items || []).some(item => Number(item.refundable_quantity) > 0);
}

function renderOrder() {
  const status = workflowStatus(order.workflow_status);
  const cancelled = Boolean(order.cancelled_at);
  const financial = String(order.financial_status || '—').toUpperCase();
  const paid = financial === 'PAID';
  const financialLocked = ['PAID', 'REFUNDED', 'VOIDED'].includes(financial);
  const held = status === 'ON_HOLD';
  const fulfilled = status === 'FULFILLED';
  const inProgress = status === 'IN_PROGRESS';
  const workflowDisabled = cancelled;

  workflowStatusElement.textContent = cancelled ? 'CANCELLED' : status.replaceAll('_', ' ');
  workflowStatusElement.className = cancelled
    ? 'badge badge-cancelled'
    : `badge badge-${status.toLowerCase().replaceAll('_', '-')}`;
  paymentHeadingStatus.textContent = financial.replaceAll('_', ' ');
  paymentHeadingStatus.className = `badge ${financialBadgeClass(financial)}`;
  archiveHeadingStatus.textContent = order.closed_at ? 'ARCHIVED' : 'OPEN';
  archiveHeadingStatus.className = order.closed_at ? 'badge badge-archived' : 'badge badge-unfulfilled';
  deliveryHeadingStatus.textContent = badgeLabel(order.delivery_status);
  deliveryHeadingStatus.className = badgeClass(order.delivery_status || 'not_shipped');

  fulfillButton.disabled = workflowDisabled || held || fulfilled;
  progressButton.disabled = workflowDisabled || held || fulfilled || inProgress;
  syncHoldButton(held);
  holdButton.disabled = workflowDisabled || (!held && fulfilled);

  workflowHelp.textContent = cancelled
    ? 'This order has been cancelled. Workflow actions are disabled.'
    : held
      ? 'Release the hold before fulfilling items or marking the order in progress.'
      : fulfilled
        ? 'This order is fully fulfilled. Workflow actions are complete.'
        : inProgress
          ? 'Warehouse processing is in progress. Fulfillment and hold actions remain available.'
          : 'Select an action to update Shopify.';

  financialStatusElement.textContent = financial.replaceAll('_', ' ');
  financialStatusElement.className = `badge ${financialBadgeClass(financial)}`;
  markPaidButton.disabled = cancelled || paid || financialLocked;
  refundButton.disabled = cancelled || held || inProgress || financial === 'VOIDED' || !hasRefundableItems();
  cancelOrderButton.disabled = cancelled;
  paymentHelp.textContent = cancelled
    ? 'This order is cancelled.'
    : held || inProgress
      ? 'Refunds are disabled while the order is on hold or in progress.'
    : paid
      ? 'Payment actions are available without cancelling the order.'
      : 'Mark as paid, issue a refund, or cancel the order in Shopify.';

  if (cancelled) {
    cancellationDetails.hidden = false;
    document.getElementById('cancelled-at').textContent = formatDate(order.cancelled_at);
    document.getElementById('cancel-reason').textContent =
      CANCEL_REASON_LABELS[order.cancel_reason] || order.cancel_reason || '—';
    document.getElementById('cancel-note').textContent = order.cancel_note || '—';
  } else {
    cancellationDetails.hidden = true;
  }

  const createdAt = document.getElementById('created-at');
  const receivedAt = document.getElementById('received-at');
  const summaryFinancial = document.getElementById('summary-financial-status');
  if (createdAt) createdAt.textContent = formatDate(order.created_at);
  if (receivedAt) receivedAt.textContent = formatDate(order.received_at);
  if (summaryFinancial) summaryFinancial.textContent = order.financial_status || '—';

  renderLineItems();
  renderFulfilledItems();
  renderTags();
  document.getElementById('order-note').textContent = order.note || '—';
  document.getElementById('metafield-note').textContent = order.metafield?.value || '—';
}

async function refreshOrder() {
  const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}`);
  order = result.order;
  renderOrder();
  return order;
}

async function runWorkflow(button, url, body, successMessage) {
  const held = workflowStatus(order.workflow_status) === 'ON_HOLD';
  const originalLabel = held ? 'Release Hold' : button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  workflowHelp.className = 'form-message';
  workflowHelp.textContent = 'Updating Shopify…';
  try {
    const result = await api(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    order = result.order;
    renderOrder();
    toast(successMessage);
  } catch (error) {
    workflowHelp.className = 'form-message error';
    workflowHelp.textContent = error.message;
    toast(error.message, true);
  } finally {
    button.textContent = originalLabel;
    if (order) renderOrder();
  }
}

async function runPaymentAction(button, url, body, successMessage) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  paymentHelp.className = 'form-message';
  paymentHelp.textContent = 'Updating Shopify…';
  try {
    const result = await api(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    order = result.order;
    renderOrder();
    toast(successMessage);
  } catch (error) {
    paymentHelp.className = 'form-message error';
    paymentHelp.textContent = error.message;
    toast(error.message, true);
  } finally {
    button.textContent = original;
    if (order) renderOrder();
  }
}

function fulfillmentUnits() {
  const units = [];
  const byLineItemId = new Map((order.line_items || []).map(item => [item.id, item]));
  for (const fulfillmentOrder of order.fulfillmentOrders || []) {
    if (['CLOSED', 'CANCELLED', 'INCOMPLETE'].includes(String(fulfillmentOrder.status || '').toUpperCase())) continue;
    for (const lineItem of fulfillmentOrder.lineItems?.nodes || []) {
      const remainingQuantity = Number(lineItem.remainingQuantity) || 0;
      if (remainingQuantity <= 0) continue;
      const source = byLineItemId.get(lineItem.lineItem?.id) || {};
      for (let unit = 1; unit <= remainingQuantity; unit += 1) {
        units.push({
          fulfillmentOrderLineItemId: lineItem.id,
          productTitle: lineItem.productTitle,
          variantTitle: lineItem.variantTitle,
          image_url: source.image_url,
          unit,
          total: remainingQuantity
        });
      }
    }
  }
  return units;
}

fulfillButton.addEventListener('click', () => {
  const units = fulfillmentUnits();
  if (!units.length) return toast('No fulfillable units remain', true);
  openDialog({
    title: 'Select units to fulfill',
    description: 'Each checkbox represents one physical unit. Shopify will calculate partial or full fulfillment.',
    confirmLabel: 'Create fulfillment',
    body: `
      <label class="select-all-row"><input id="select-all" type="checkbox"> Select all (${units.length})</label>
      <div class="unit-list">${units.map(unit => `
        <label class="unit-row">
          <input class="unit-checkbox" type="checkbox" data-line-item-id="${escapeHtml(unit.fulfillmentOrderLineItemId)}">
          ${itemThumb(unit.image_url, unit.productTitle)}
          <div><strong>${escapeHtml(unit.productTitle)}${unit.total > 1 ? ` #${unit.unit}` : ''}</strong>
          <span>${escapeHtml(unit.variantTitle || 'Default variant')}</span></div>
        </label>`).join('')}</div>`,
    onConfirm: async () => {
      const selected = [...dialogBody.querySelectorAll('.unit-checkbox:checked')];
      if (!selected.length) {
        dialogMessage.textContent = 'Select at least one unit.';
        dialogMessage.className = 'form-message error';
        return;
      }
      const quantities = new Map();
      selected.forEach(input => {
        quantities.set(input.dataset.lineItemId, (quantities.get(input.dataset.lineItemId) || 0) + 1);
      });
      const items = [...quantities].map(([fulfillmentOrderLineItemId, quantity]) => ({
        fulfillmentOrderLineItemId,
        quantity
      }));
      setDialogBusy(true, 'Create fulfillment');
      try {
        const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/fulfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        order = result.order;
        setDialogBusy(false, 'Create fulfillment');
        closeDialog();
        renderOrder();
        toast('Fulfillment created');
      } catch (error) {
        setDialogBusy(false, 'Create fulfillment');
        showDialogError(error);
      }
    }
  });
  const selectAll = document.getElementById('select-all');
  const checkboxes = [...dialogBody.querySelectorAll('.unit-checkbox')];
  const syncSelectAll = () => {
    const count = checkboxes.filter(input => input.checked).length;
    selectAll.checked = count === checkboxes.length;
    selectAll.indeterminate = count > 0 && count < checkboxes.length;
  };
  selectAll.addEventListener('change', () => {
    checkboxes.forEach(input => { input.checked = selectAll.checked; });
    syncSelectAll();
  });
  checkboxes.forEach(input => input.addEventListener('change', syncSelectAll));
});

progressButton.addEventListener('click', () => runWorkflow(
  progressButton,
  `/api/orders/${encodeURIComponent(ORDER_ID)}/status`,
  { status: 'IN_PROGRESS' },
  'Order marked as in progress'
));

holdButton.addEventListener('click', () => {
  const held = workflowStatus(order.workflow_status) === 'ON_HOLD';
  if (held) {
    runWorkflow(holdButton, `/api/orders/${encodeURIComponent(ORDER_ID)}/release`, null, 'Fulfillment hold released');
    return;
  }
  runWorkflow(holdButton, `/api/orders/${encodeURIComponent(ORDER_ID)}/status`, { status: 'ON_HOLD' }, 'Fulfillment order placed on hold');
});

markPaidButton.addEventListener('click', () => runPaymentAction(
  markPaidButton,
  `/api/orders/${encodeURIComponent(ORDER_ID)}/mark-paid`,
  null,
  'Order marked as paid'
));

function newIdempotencyKey() {
  return window.crypto?.randomUUID?.()
    || `refund-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

refundButton.addEventListener('click', async () => {
  const refundable = (order.line_items || []).filter(item => Number(item.refundable_quantity) > 0);
  if (!refundable.length) return toast('No refundable items on this order', true);
  let refundRequest = null;
  let locations = [];
  try {
    const result = await api('/api/locations');
    locations = (result.locations || []).filter(location => location.isActive !== false);
  } catch (error) {
    toast(`Could not load restock locations: ${error.message}`, true);
  }
  const locationOptions = locations.map(location =>
    `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name || location.id)}</option>`
  ).join('');

  openDialog({
    title: 'Issue refund',
    description: 'Refund selected line items without cancelling the order. Amounts are calculated by Shopify.',
    confirmLabel: 'Issue refund',
    body: `
      <div class="unit-list">${refundable.map(item => `
        <label class="unit-row">
          <input class="refund-checkbox" type="checkbox" data-line-item-id="${escapeHtml(item.id)}">
          ${itemThumb(item.image_url, item.title)}
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.variant_title || 'Default variant')} - refundable ${escapeHtml(item.refundable_quantity)}</span>
          </div>
          <input class="form-control refund-qty" type="number" min="1" max="${escapeHtml(item.refundable_quantity)}" value="1" data-qty-for="${escapeHtml(item.id)}">
        </label>`).join('')}</div>
      <label class="select-all-row"><input id="refund-restock" type="checkbox" checked> Restock refunded items</label>
      <div id="refund-location-group" class="form-group">
        <label for="refund-location">Restock location</label>
        <select id="refund-location" class="form-control">
          <option value="">Use fulfillment location or first active location</option>
          ${locationOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="refund-note">Refund note</label>
        <textarea id="refund-note" class="form-control" placeholder="Reason or internal note for this refund"></textarea>
      </div>
      <p id="refund-preview" class="form-message"></p>`,
    onConfirm: async () => {
      const selected = [...dialogBody.querySelectorAll('.refund-checkbox:checked')];
      if (!selected.length) {
        dialogMessage.textContent = 'Select at least one item to refund.';
        dialogMessage.className = 'form-message error';
        return;
      }
      const items = selected.map(input => {
        const lineItemId = input.dataset.lineItemId;
        const qtyInput = dialogBody.querySelector(`[data-qty-for="${lineItemId}"]`);
        return { lineItemId, quantity: Number(qtyInput?.value || 1) };
      }).filter(item => item.quantity > 0);
      const restock = document.getElementById('refund-restock')?.checked !== false;
      const locationId = restock ? document.getElementById('refund-location')?.value || '' : '';
      const note = document.getElementById('refund-note')?.value.trim() || '';
      const fingerprint = JSON.stringify({ items, restock, locationId, note });
      if (!refundRequest || refundRequest.fingerprint !== fingerprint) {
        refundRequest = { fingerprint, idempotencyKey: newIdempotencyKey() };
      }

      setDialogBusy(true, 'Issue refund');
      try {
        const previewParams = new URLSearchParams({
          items: JSON.stringify(items),
          restock: String(restock)
        });
        if (locationId) previewParams.set('locationId', locationId);
        const preview = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/refund-preview?${previewParams.toString()}`);
        const previewEl = document.getElementById('refund-preview');
        if (previewEl && preview.preview) {
          previewEl.textContent = `Refund total: ${preview.preview.amount} ${preview.preview.currency || ''}`;
        }
        const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, restock, locationId, note, idempotencyKey: refundRequest.idempotencyKey })
        });
        order = result.order;
        setDialogBusy(false, 'Issue refund');
        closeDialog();
        renderOrder();
        toast('Refund issued');
      } catch (error) {
        setDialogBusy(false, 'Issue refund');
        showDialogError(error);
      }
    }
  });

  const restockCheckbox = document.getElementById('refund-restock');
  const locationGroup = document.getElementById('refund-location-group');
  restockCheckbox.addEventListener('change', () => {
    locationGroup.hidden = !restockCheckbox.checked;
  });
});

cancelOrderButton.addEventListener('click', () => {
  openDialog({
    title: 'Cancel order',
    description: 'This action is irreversible. The order will be cancelled in Shopify Admin.',
    confirmLabel: 'Cancel order',
    body: `
      <div class="form-group">
        <label for="cancel-reason-select">Reason</label>
        <select id="cancel-reason-select" class="form-control">
          <option value="CUSTOMER">Customer request</option>
          <option value="INVENTORY">Inventory issue</option>
          <option value="FRAUD">Fraud</option>
          <option value="DECLINED">Payment declined</option>
          <option value="STAFF">Staff error</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="cancel-hint">Cancellation note</label>
        <textarea id="cancel-hint" class="form-control" placeholder="e.g. Customer requested a size change"></textarea>
      </div>
      <div class="form-group">
        <label for="cancel-refund-select">Refund</label>
        <select id="cancel-refund-select" class="form-control">
          <option value="original">Refund to original payment method</option>
          <option value="none">Cancel without refund</option>
        </select>
      </div>`,
    onConfirm: async () => {
      const reason = document.getElementById('cancel-reason-select').value;
      const hint = document.getElementById('cancel-hint').value.trim();
      const refund = document.getElementById('cancel-refund-select').value;
      setDialogBusy(true, 'Cancel order');
      try {
        const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, hint, refund })
        });
        order = result.order;
        setDialogBusy(false, 'Cancel order');
        closeDialog();
        renderOrder();
        toast('Order cancelled');
      } catch (error) {
        setDialogBusy(false, 'Cancel order');
        showDialogError(error);
      }
    }
  });
});

document.getElementById('btn-tags').addEventListener('click', () => {
  const tags = order.tags || [];
  openDialog({
    title: 'Manage tags',
    description: 'Add new tags or remove existing ones.',
    confirmLabel: 'Add tags',
    body: `
      <div class="form-group"><span class="field-label">Existing tags</span>
        <div class="chip-list">${tags.length
    ? tags.map(tag => `<button type="button" class="chip-removable dialog-remove-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} ×</button>`).join('')
    : '<span class="muted">No tags</span>'}</div>
      </div>
      <div class="form-group"><label for="tags-input">New tags</label><input id="tags-input" class="form-control" placeholder="priority, warehouse"></div>`,
    onConfirm: async () => {
      const tagsToAdd = document.getElementById('tags-input').value.split(',');
      setDialogBusy(true, 'Add tags');
      try {
        const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/tag`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: tagsToAdd })
        });
        order = result.order;
        setDialogBusy(false, 'Add tags');
        closeDialog();
        renderOrder();
        toast('Tags updated');
      } catch (error) {
        setDialogBusy(false, 'Add tags');
        showDialogError(error);
      }
    }
  });

  dialogBody.querySelectorAll('.dialog-remove-tag').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      const tag = button.dataset.tag;
      if (!window.confirm(`Remove tag "${tag}"?`)) return;
      try {
        const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/tag`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: [tag] })
        });
        order = result.order;
        button.remove();
        if (!order.tags?.length) {
          dialogBody.querySelector('.chip-list').innerHTML = '<span class="muted">No tags</span>';
        }
        renderOrder();
        toast('Tag removed');
      } catch (error) {
        showDialogError(error);
      }
    });
  });
});

tagList.addEventListener('click', event => {
  const button = event.target.closest('.chip-removable');
  if (!button) return;
  removeTag(button.dataset.tag);
});

function openTextEditor({ title, description, currentValue, saveLabel, appendSeparator = '\n', normalize = value => value, save }) {
  openDialog({
    title,
    description,
    confirmLabel: saveLabel,
    body: `
      <div class="mode-row">
        <label><input type="radio" name="editor-mode" value="edit" checked> Edit</label>
        <label><input type="radio" name="editor-mode" value="append"> Append</label>
      </div>
      <div class="form-group"><label for="text-editor">Value</label><textarea id="text-editor" class="form-control">${escapeHtml(currentValue)}</textarea></div>`,
    onConfirm: async () => {
      const mode = document.querySelector('[name="editor-mode"]:checked').value;
      const entered = document.getElementById('text-editor').value;
      const value = normalize(mode === 'append' && currentValue ? `${currentValue}${appendSeparator}${entered}` : entered);
      setDialogBusy(true, saveLabel);
      try {
        await save(value);
        setDialogBusy(false, saveLabel);
        closeDialog();
        renderOrder();
        toast(`${title} saved`);
      } catch (error) {
        setDialogBusy(false, saveLabel);
        showDialogError(error);
      }
    }
  });
}

document.getElementById('btn-note').addEventListener('click', () => openTextEditor({
  title: 'Order note',
  description: 'Edit the Shopify note or append new text.',
  currentValue: order.note || '',
  saveLabel: 'Save note',
  save: async value => {
    const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/note`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: value })
    });
    order = result.order;
  }
}));

document.getElementById('btn-metafield').addEventListener('click', () => {
  const original = order.metafield || null;
  openTextEditor({
    title: 'Metafield note',
    description: 'A compare digest prevents accidentally overwriting a newer Shopify value.',
    currentValue: original?.value || '',
    saveLabel: 'Save metafield',
    appendSeparator: ' · ',
    normalize: value => value.replace(/\s+/g, ' ').trim(),
    save: async value => {
      const result = await api(`/api/orders/${encodeURIComponent(ORDER_ID)}/metafield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, compareDigest: original?.compareDigest ?? null })
      });
      order = result.order;
    }
  });
});

dialogConfirm.addEventListener('click', () => confirmHandler?.());
dialogCancel.addEventListener('click', closeDialog);
dialogClose.addEventListener('click', closeDialog);
backdrop.addEventListener('click', event => { if (event.target === backdrop) closeDialog(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDialog(); });

refreshOrder().catch(error => {
  workflowHelp.className = 'form-message error';
  workflowHelp.textContent = error.message;
  toast(error.message, true);
});
