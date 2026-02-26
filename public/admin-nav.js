(function() {
  var toggle = document.getElementById('navToggle');
  var drawer = document.getElementById('navDrawer');
  if (toggle && drawer) {
    toggle.addEventListener('click', function() {
      var isOpen = drawer.classList.toggle('open');
      toggle.classList.toggle('open', isOpen);
      toggle.setAttribute('aria-expanded', isOpen);
    });
  }
})();
