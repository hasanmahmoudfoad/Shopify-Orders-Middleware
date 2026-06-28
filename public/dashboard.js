const tableBody = document.querySelector('#orders-table tbody');
const orderCount = document.getElementById('order-count');
const refreshButton = document.getElementById('refresh-orders');
const nextButton = document.getElementById('next-orders');
const prevButton = document.getElementById('prev-orders');
const backdrop = document.getElementById('dialog-backdrop');
const dialogTitle = document.getElementById('dialog-title');
const dialogDescription = document.getElementById('dialog-description');
const dialogBody = document.getElementById('dialog-body');
const dialogMessage = document.getElementById('dialog-message');
const dialogConfirm = document.getElementById('dialog-confirm');
const dialogCancel = document.getElementById('dialog-cancel');
const dialogClose = document.getElementById('dialog-close');
let orders = [];
let dialogBusy = false;
let confirmHandler = null;
let pageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
let pageRequest = { direction: '', cursor: '' };

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
  setTimeout(() => element.remove(), 3600);
}

function statusBadge(status) {
  const normalized = String(status || '-').toUpperCase();
  const css = normalized.toLowerCase().replaceAll('_', '-');
  return `<span class="badge badge-${css}">${escapeHtml(normalized.replaceAll('_', ' '))}</span>`;
}

function setDialogBusy(busy, label = 'Save') {
  dialogBusy = busy;
  dialogConfirm.disabled = busy;
  dialogCancel.disabled = busy;
  dialogClose.disabled = busy;
  dialogConfirm.textContent = busy ? 'Working...' : label;
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
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function ordersUrl() {
  const params = new URLSearchParams({ sync: '1' });
  if (pageRequest.direction && pageRequest.cursor) {
    params.set('pageDirection', pageRequest.direction);
    params.set('cursor', pageRequest.cursor);
  }
  return `/api/orders?${params.toString()}`;
}

function syncPagination() {
  prevButton.disabled = !pageInfo.hasPreviousPage;
  nextButton.disabled = !pageInfo.hasNextPage;
}

function orderDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

async function loadOrders(showLoading = false) {
  if (showLoading) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
  }
  try {
    const data = await api(ordersUrl());
    orders = data.orders || [];
    pageInfo = data.pageInfo || pageInfo;
    orderCount.textContent = data.total;
    syncPagination();
    tableBody.innerHTML = orders.length ? orders.map(order => `
      <tr>
        <td><a href="/orders/${encodeURIComponent(order.id)}"><strong>${escapeHtml(order.name || order.id)}</strong></a></td>
        <td>${escapeHtml(order.customer || '-')}</td>
        <td>${escapeHtml(order.email || '-')}</td>
        <td>${escapeHtml(order.total || '-')}</td>
        <td>${escapeHtml(orderDate(order.created_at))}</td>
        <td class="status-cell">${statusBadge(order.order_status)}</td>
        <td class="status-cell">${statusBadge(order.financial_status)}</td>
        <td class="status-cell">${statusBadge(order.fulfillment_status)}</td>
        <td class="status-cell">${statusBadge(order.delivery_status)}</td>
        <td><div class="actions">
          <button class="btn btn-small ${order.archived ? '' : 'btn-danger'}" data-action="${order.archived ? 'unarchive' : 'archive'}" data-id="${escapeHtml(order.id)}">${order.archived ? 'Unarchive' : 'Archive'}</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No orders loaded yet.</td></tr>';
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh';
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const order = orders.find(item => String(item.id) === String(button.dataset.id));
  if (!order) return;

  if (button.dataset.action === 'archive' || button.dataset.action === 'unarchive') {
    const archiving = button.dataset.action === 'archive';
    openDialog({
      title: `${archiving ? 'Archive' : 'Unarchive'} ${order.name}?`,
      description: 'This action updates the order state in Shopify Admin.',
      body: `<p>The dashboard will refresh this page after Shopify confirms the order was ${archiving ? 'closed' : 'opened'}.</p>`,
      confirmLabel: archiving ? 'Archive' : 'Unarchive',
      onConfirm: async () => {
        setDialogBusy(true, archiving ? 'Archive' : 'Unarchive');
        try {
          await api(`/api/orders/${encodeURIComponent(order.id)}/${archiving ? 'archive' : 'unarchive'}`, { method: 'POST' });
          setDialogBusy(false, archiving ? 'Archive' : 'Unarchive');
          closeDialog();
          toast(archiving ? 'Order archived' : 'Order unarchived');
          await loadOrders();
        } catch (error) {
          setDialogBusy(false, archiving ? 'Archive' : 'Unarchive');
          dialogMessage.textContent = error.message;
          dialogMessage.className = 'form-message error';
        }
      }
    });
  }
});

dialogConfirm.addEventListener('click', () => confirmHandler?.());
dialogCancel.addEventListener('click', closeDialog);
dialogClose.addEventListener('click', closeDialog);
backdrop.addEventListener('click', event => { if (event.target === backdrop) closeDialog(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDialog(); });
refreshButton.addEventListener('click', () => loadOrders(true));
nextButton.addEventListener('click', async () => {
  if (!pageInfo.hasNextPage) return;
  pageRequest = { direction: 'next', cursor: pageInfo.endCursor };
  await loadOrders(true);
});
prevButton.addEventListener('click', async () => {
  if (!pageInfo.hasPreviousPage) return;
  pageRequest = { direction: 'prev', cursor: pageInfo.startCursor };
  await loadOrders(true);
});

syncPagination();
loadOrders(true);
setInterval(() => { if (backdrop.hidden) loadOrders(); }, 5000);
