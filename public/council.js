/**
 * Council member page: edit modal + delete confirmation.
 *
 * The CSP is `script-src 'self'` (no 'unsafe-inline'), so the modal cannot be
 * driven by inline onclick attributes -- those are dead in a compliant browser.
 * Everything is wired here instead.
 */
(function () {
  'use strict';

  var modal = null;

  // Element that had focus before the modal opened, so it can be restored.
  var lastFocused = null;

  function focusable() {
    if (!modal) return [];
    return Array.prototype.slice.call(
      modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (el) {
      return el.offsetParent !== null;
    });
  }

  function openEditModal(id, name, email, unit, whatsapp) {
    if (!modal) return;

    document.getElementById('editForm').action = '/admin/council/' + encodeURIComponent(id) + '/edit';
    document.getElementById('edit_name').value = name || '';
    document.getElementById('edit_email').value = email || '';
    document.getElementById('edit_unit_number').value = unit || '';
    document.getElementById('edit_whatsapp').value = whatsapp || '';

    lastFocused = document.activeElement;

    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Move focus to the first field so keyboard and screen-reader users land
    // inside the dialog rather than staying on the button behind it.
    var first = document.getElementById('edit_name');
    if (first) first.focus();
  }

  function closeEditModal() {
    if (!modal || modal.style.display === 'none') return;

    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      closeEditModal();
      return;
    }

    // Trap Tab inside the dialog while it is open.
    if (e.key !== 'Tab' || !modal || modal.style.display === 'none') return;

    var items = focusable();
    if (items.length === 0) return;

    var first = items[0];
    var last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function init() {
    modal = document.getElementById('editModal');
    if (!modal) return;

    // Edit buttons
    document.querySelectorAll('.js-edit-member').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEditModal(
          btn.dataset.id,
          btn.dataset.name,
          btn.dataset.email,
          btn.dataset.unit,
          btn.dataset.whatsapp
        );
      });
    });

    // Delete forms — confirm before submitting
    document.querySelectorAll('.js-delete-member-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm('Delete this council member? This will not affect existing tokens.')) {
          e.preventDefault();
        }
      });
    });

    // Close modal on backdrop click
    modal.addEventListener('click', function (e) {
      if (e.target === this) closeEditModal();
    });

    // Any element marked data-close-modal (close button, Cancel button)
    document.querySelectorAll('[data-close-modal]').forEach(function (el) {
      el.addEventListener('click', function () {
        closeEditModal();
      });
    });

    document.addEventListener('keydown', onKeydown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
