function openEditModal(id, name, email, unit, whatsapp) {
  document.getElementById('editForm').action = '/admin/council/' + id + '/edit';
  document.getElementById('edit_name').value = name;
  document.getElementById('edit_email').value = email;
  document.getElementById('edit_unit_number').value = unit;
  document.getElementById('edit_whatsapp').value = whatsapp || '';
  document.getElementById('editModal').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeEditModal() {
  document.getElementById('editModal').style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', function () {
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
      if (!confirm('Delete this council member? This will not affect existing tokens.')) {
        e.preventDefault();
      }
    });
  });

  // Close modal on backdrop click
  document.getElementById('editModal').addEventListener('click', function (e) {
    if (e.target === this) closeEditModal();
  });

  // Close modal on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeEditModal();
  });

  // Close button inside modal
  var closeBtn = document.querySelector('.modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeEditModal);
});
