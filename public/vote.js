(function() {
  var overlay = document.getElementById('confirmOverlay');
  var confirmChoice = document.getElementById('confirmChoice');
  var confirmBtn = document.getElementById('confirmBtn');
  var cancelBtn = document.getElementById('cancelBtn');
  var voteOptions = document.getElementById('voteOptions');
  var choiceInput = document.getElementById('choiceInput');
  var voteForm = document.getElementById('voteForm');

  if (!overlay) return;

  document.querySelectorAll('.vote-button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var choice = this.getAttribute('data-choice');
      confirmChoice.textContent = choice;
      choiceInput.value = choice;
      overlay.style.display = 'block';
      voteOptions.style.display = 'none';
      overlay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  cancelBtn.addEventListener('click', function() {
    overlay.style.display = 'none';
    voteOptions.style.display = 'flex';
    choiceInput.value = '';
  });

  confirmBtn.addEventListener('click', function() {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Submitting...';
    voteForm.submit();
  });
})();
