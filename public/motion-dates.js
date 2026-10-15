/**
 * Date-range pairs: reject an end time that is not after the start time.
 *
 * The server enforces this too and reports it as a form error, but catching it
 * here saves a round trip on a typo. Declare a pair by putting
 * data-after="<id of the start input>" on the end input; add
 * data-after-error="<id of a message element>" to show the message inline.
 * An inverted range silently exports nothing, which is easier to misread than
 * an explicit message.
 */
(function () {
  'use strict';

  function setupPair(endInput) {
    var startInput = document.getElementById(endInput.getAttribute('data-after'));
    if (!startInput) return;

    var errorId = endInput.getAttribute('data-after-error');
    var errorBox = errorId ? document.getElementById(errorId) : null;
    var message = endInput.getAttribute('data-after-message') || 'The end date must be after the start date.';

    // Mirror the floor onto the end input so the picker itself discourages an
    // inverted range. `min` on a datetime-local input compares as wall time,
    // which is how the value is submitted.
    function syncMin() {
      if (startInput.value) {
        endInput.min = startInput.value;
      } else {
        endInput.removeAttribute('min');
      }
    }

    function validate() {
      endInput.setCustomValidity('');
      if (errorBox) {
        errorBox.textContent = '';
        errorBox.style.display = 'none';
      }

      if (!startInput.value || !endInput.value) return true;
      if (endInput.value > startInput.value) return true;

      endInput.setCustomValidity(message);
      if (errorBox) {
        errorBox.textContent = message;
        errorBox.style.display = '';
      }
      return false;
    }

    startInput.addEventListener('change', function () {
      syncMin();
      validate();
    });

    endInput.addEventListener('input', validate);
    endInput.addEventListener('change', validate);

    var form = endInput.form;
    if (form) {
      form.addEventListener('submit', function (e) {
        syncMin();
        if (!validate()) {
          e.preventDefault();
          endInput.focus();
        }
      });
    }

    syncMin();
  }

  function init() {
    document.querySelectorAll('[data-after]').forEach(setupPair);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
