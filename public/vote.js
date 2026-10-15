/**
 * Voting page: two-step confirmation.
 *
 * The option buttons are inert without this script, so views/vote.ejs ships a
 * <noscript> form with real submit buttons as a fallback. Nothing here may
 * assume it is the only path to submitting a vote.
 */
(function () {
  'use strict';

  function init() {
    var overlay = document.getElementById('confirmOverlay');
    if (!overlay) return;

    var confirmChoice = document.getElementById('confirmChoice');
    var confirmBtn = document.getElementById('confirmBtn');
    var cancelBtn = document.getElementById('cancelBtn');
    var voteOptions = document.getElementById('voteOptions');
    var choiceInput = document.getElementById('choiceInput');
    var voteForm = document.getElementById('voteForm');

    if (!confirmBtn || !cancelBtn || !voteOptions || !choiceInput || !voteForm) return;

    // The option button that opened the overlay, so focus can be restored.
    var lastChoice = null;

    document.querySelectorAll('.vote-button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var choice = this.getAttribute('data-choice');
        lastChoice = this;

        confirmChoice.textContent = choice;
        choiceInput.value = choice;

        overlay.style.display = 'block';
        voteOptions.style.display = 'none';

        // The dialog is visually an overlay but stays in the document flow, so
        // focus has to be moved into it explicitly or a screen reader would
        // stay parked on the now-hidden option button.
        confirmBtn.focus();
        overlay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    cancelBtn.addEventListener('click', function () {
      overlay.style.display = 'none';
      voteOptions.style.display = 'flex';
      choiceInput.value = '';

      if (lastChoice) {
        lastChoice.focus();
        lastChoice = null;
      }
    });

    // Escape cancels, matching the usual dialog convention.
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelBtn.click();
      }
    });

    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = 'Submitting...';
      voteForm.submit();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
