/**
 * CSV motion import: drag-and-drop zone plus client-side pre-checks.
 *
 * The size and type checks mirror the multer limits in server.js (500 KB,
 * .csv only). They exist to give an immediate, readable message rather than a
 * round trip that comes back as a bare multer error string.
 */
(function () {
  'use strict';

  var MAX_BYTES = 500 * 1024;

  function init() {
    var zone = document.getElementById('importZone');
    var input = document.getElementById('csv_file');
    var nameDisplay = document.getElementById('fileNameDisplay');
    var errorDisplay = document.getElementById('fileError');
    var submitBtn = document.getElementById('submitBtn');
    var form = document.getElementById('importForm');

    if (!zone || !input) return;

    function showError(message) {
      if (!errorDisplay) return;
      errorDisplay.textContent = message;
      errorDisplay.style.display = message ? '' : 'none';
    }

    function describe(file) {
      nameDisplay.textContent = file.name;
      nameDisplay.style.display = '';
      showError('');
    }

    // Validates a File and reports the problem, or returns true when acceptable.
    function validate(file) {
      var name = (file.name || '').toLowerCase();

      if (!name.endsWith('.csv') && file.type !== 'text/csv') {
        showError('"' + file.name + '" is not a CSV file. Choose a .csv file.');
        return false;
      }

      if (file.size > MAX_BYTES) {
        showError(
          'That file is ' + (file.size / 1024).toFixed(0) + ' KB. The limit is 500 KB.'
        );
        return false;
      }

      if (file.size === 0) {
        showError('That file is empty.');
        return false;
      }

      return true;
    }

    function accept(file) {
      if (!file) return;
      if (validate(file)) {
        describe(file);
      } else {
        input.value = '';
        nameDisplay.style.display = 'none';
      }
    }

    input.addEventListener('change', function () {
      accept(this.files && this.files[0]);
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

      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;

      // Only assign to the input once it passes, so an invalid drop cannot be
      // submitted by a second click on the button.
      if (validate(file)) {
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        describe(file);
      } else {
        input.value = '';
        nameDisplay.style.display = 'none';
      }
    });

    if (form && submitBtn) {
      form.addEventListener('submit', function (e) {
        var file = input.files && input.files[0];

        if (!file) {
          e.preventDefault();
          showError('Choose a CSV file first.');
          return;
        }

        if (!validate(file)) {
          e.preventDefault();
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Importing…';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
