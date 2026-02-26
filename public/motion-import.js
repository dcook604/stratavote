(function () {
  var zone = document.getElementById('importZone');
  var input = document.getElementById('csv_file');
  var nameDisplay = document.getElementById('fileNameDisplay');
  var submitBtn = document.getElementById('submitBtn');

  if (!zone || !input) return;

  input.addEventListener('change', function () {
    if (this.files && this.files[0]) {
      nameDisplay.textContent = this.files[0].name;
      nameDisplay.style.display = '';
    }
  });

  zone.addEventListener('dragover', function (e) {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', function () {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      var dt = new DataTransfer();
      dt.items.add(e.dataTransfer.files[0]);
      input.files = dt.files;
      nameDisplay.textContent = e.dataTransfer.files[0].name;
      nameDisplay.style.display = '';
    }
  });

  var form = document.getElementById('importForm');
  if (form && submitBtn) {
    form.addEventListener('submit', function () {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Importing\u2026';
    });
  }
})();
