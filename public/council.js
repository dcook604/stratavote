function openEditModal(id, name, email, unit) {
  document.getElementById('editForm').action = '/admin/council/' + id + '/edit';
  document.getElementById('edit_name').value = name;
  document.getElementById('edit_email').value = email;
  document.getElementById('edit_unit_number').value = unit;
  document.getElementById('editModal').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeEditModal() {
  document.getElementById('editModal').style.display = 'none';
  document.body.style.overflow = '';
}

window.addEventListener('click', function(e) {
  if (e.target === document.getElementById('editModal')) closeEditModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeEditModal();
});
